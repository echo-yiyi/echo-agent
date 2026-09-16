// 跨 session 的只读读取。观测**一段 session 一份**（状态根 = session 目录，2026-09-03），agent 集群里几段并行时
// 要一起看，就得扫会话根、每段开一个只读 reader、把各段的 run 合起来排。合并在这一层做，
// core 的 reader 仍是「一个状态根一个 reader」，不为面板加公共 API。
//
// 会话的出现与消失按 2s 缓存重扫：新出现且已有观测文档的开 reader，目录没了的关掉。`sessionId` 给了就只看那一段——
// 那时不要求它有 meta（点名的是目录），只要求观测文档存在。
//
// 旧格式（2026-09-14 之前的 `observability/observations.sqlite`）**不迁移、不读**：只有它的会话记进打不开的会话，
// 原因写明——`observe` 命令与面板的健康信息都会把它打出来，不静默当成「没有记录」。

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  describeAgentRef,
  FileDir,
  listSessions,
  ObservationStoreMissingError,
  observationStorePath,
  openObservationReader,
  resolveStateDir,
  type RunLookupResult,
  type RunObservation,
  type RunObservationHeader,
  type RunObservationPage,
  type SessionInfo,
  type DocumentEchoObservationReader,
} from "@echo-agent/core";

/** 2026-09-14 之前观测落在这个 SQLite 文件里；新版本不读它，只认出来告诉人。 */
const LEGACY_OBSERVATION_DATABASE = "observations.sqlite";
const LEGACY_REASON = `旧格式观测（${LEGACY_OBSERVATION_DATABASE}），已不再读取`;
import type { ObservationEnvelope } from "@echo-agent/core/observability";

/** 页面要的会话摘要：产品名、workspace、状态。不带 messageCount 之类会随 agent 写盘变化的东西——那是另一份真相。 */
export type SessionBrief = Readonly<{
  /** 哪个产品开的（2026-09-07：这个字段从前叫 `agent`，那个词现在归角色）。 */
  product: string;
  /** 挂的哪份 agent 定义，人读的那个名字（具名角色的名字 / `inline` / `default`）。 */
  agent: string;
  name: string;
  workspace: string;
  updatedAt: number;
  status: SessionInfo["status"];
}>;

/** `/api/runs` 的响应：合并后的一页 header + 这页引用到的会话。跨库没有游标，`nextCursor` 恒 null（一页最多 200 条）。 */
export type RunsResponse = RunObservationPage & Readonly<{ sessions: Readonly<Record<string, SessionBrief>> }>;

/** 一段会话的库健康：`observe health` 与 `/api/health` 共用。 */
export type SessionHealth = Readonly<{
  sessionId: string;
  path: string;
  heads: readonly Readonly<{ runtimeId: string; committedPrefix: number }>[];
  counts: Readonly<{ runs: number; records: number }>;
  last: RunObservationHeader | null;
}>;

/** run 之外的一条记录，带它来自哪段会话。 */
export type ActivityItem = Readonly<{ sessionId: string; record: ObservationEnvelope }>;

/** `RunObservation` 是 header 加 records 等大件；health 只要 header，逐字段挑出来，别把整条 run 塞进健康响应。 */
function headerOf(o: RunObservation): RunObservationHeader {
  return {
    schemaVersion: o.schemaVersion,
    runId: o.runId,
    ...(o.submissionId === undefined ? {} : { submissionId: o.submissionId }),
    source: o.source,
    runtimeId: o.runtimeId,
    agentId: o.agentId,
    agentInstanceId: o.agentInstanceId,
    sessionId: o.sessionId,
    runtimeGeneration: o.runtimeGeneration,
    capturePolicy: o.capturePolicy,
    acceptedAt: o.acceptedAt,
    startedAt: o.startedAt,
    endedAt: o.endedAt,
    status: o.status,
    integrity: o.integrity,
    persistence: o.persistence,
  };
}

/** session meta 每次都要扫目录；页面轮询 500ms 一次，缓存 2s 足够新鲜（会话不会秒级增删）。 */
export const SESSION_CACHE_MS = 2_000;

export type SessionObservationReadersOptions = Readonly<{
  /** 会话目录的上一层。 */
  sessionsRoot: string;
  /** 只看这一段。不给 = 全部有库的会话。 */
  sessionId?: string;
}>;

export class SessionObservationReaders {
  private readonly readers = new Map<string, DocumentEchoObservationReader>();
  private briefs: Record<string, SessionBrief> = {};
  /** 非 undefined = 这轮会话清单没读出来（坏 / 旧 meta）：run 照看，只是没有产品名与工作目录。 */
  private briefsError: string | undefined;
  private scannedAt = 0;
  /** runId → sessionId（listRuns 见过的），`getRun` 先查它再挨个库找。 */
  private readonly runOwner = new Map<string, string>();

  constructor(readonly opts: SessionObservationReadersOptions) {}

  /** 会话目录。 */
  stateRoot(sessionId: string): string {
    return resolveStateDir({ sessionsRoot: this.opts.sessionsRoot, sessionId });
  }

  /** 某段会话的观测目录（存不存在都算得出，报错文案用）。 */
  storePath(sessionId: string): string {
    return observationStorePath(this.stateRoot(sessionId));
  }

  /** 已开 reader 的会话数。0 = 一段都还没有观测记录。 */
  get size(): number {
    return this.readers.size;
  }

  private unreadableSessions: Readonly<Record<string, string>> = {};
  /** 有观测目录但读不了的会话（写坏了、或只有旧格式）→ 原因。`/api/health` 与 `observe health` 报它，其余会话照看。 */
  get unreadable(): Readonly<Record<string, string>> {
    return this.unreadableSessions;
  }

  /** 会话根下全部会话的摘要（不只是有库的）。 */
  /** 会话清单为什么没读出来；`undefined` = 读出来了。页面据此说清「为什么没有名字」。 */
  get sessionsProblem(): string | undefined {
    return this.briefsError;
  }

  get sessions(): Readonly<Record<string, SessionBrief>> {
    return this.briefs;
  }

  /** 重扫会话根。`force` 跳过 2s 缓存（命令行一次性用）。 */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.scannedAt < SESSION_CACHE_MS) return;
    // **会话清单读不出来不该让只读面板起不来**：`listSessions()` 对任何一段坏 / 旧 meta 都整体抛错
    // （那对 `--continue` / `--resume` 是对的：续错一段比不续更糟）。但观测是只读旁路，
    // 一段 2026-09-01 之前建的老 session 缺 `product`，不该连累其余会话的 run 一条都看不了。
    // 接住它，退成「没有会话摘要」——产品名与工作目录显示未上报，run 照看；原因交给 /api/health 与页面说清。
    let infos: SessionInfo[] = [];
    this.briefsError = undefined;
    try {
      infos = await listSessions(new FileDir(this.opts.sessionsRoot));
    } catch (e) {
      this.briefsError = e instanceof Error ? e.message : String(e);
    }
    const briefs: Record<string, SessionBrief> = {};
    for (const s of infos) {
      briefs[s.id] = { product: s.product, agent: describeAgentRef(s.agent), name: s.name, workspace: s.workspace, updatedAt: s.updatedAt, status: s.status };
    }
    // 清单读不出来时，直接扫会话根下有观测目录的子目录——run 仍然全都看得见，只是没有名字
    const discovered = this.briefsError === undefined ? infos.map((s) => s.id) : this.sessionDirsWithStore();
    const wanted = this.opts.sessionId === undefined ? discovered : [this.opts.sessionId];
    const seen = new Set<string>();
    const unreadable: Record<string, string> = {};
    for (const id of wanted) {
      if (!existsSync(this.storePath(id))) continue; // 会话有了、agent 还没起来过：观测目录还没建，不是错
      seen.add(id);
      if (this.readers.has(id)) continue;
      try {
        this.readers.set(id, await openObservationReader({ stateRoot: this.stateRoot(id) }));
      } catch (e) {
        seen.delete(id);
        if (e instanceof ObservationStoreMissingError) {
          // 目录在、新格式不在：只有旧库就说清楚，别的（目录刚建、key 还没写完）不是错
          if (existsSync(join(this.storePath(id), LEGACY_OBSERVATION_DATABASE))) unreadable[id] = LEGACY_REASON;
          continue;
        }
        // 一段的观测读不了（写坏）不该让整个只读面板对全部会话失败（review 2026-09-07）：
        // 记下原因、跳过它；点名 `--session` 看的就是这一段时照旧抛，让命令行如实报错
        if (this.opts.sessionId !== undefined) throw e;
        unreadable[id] = e instanceof Error ? e.message : String(e);
      }
    }
    this.unreadableSessions = unreadable;
    for (const [id, reader] of this.readers) {
      if (seen.has(id)) continue;
      this.readers.delete(id);
      await reader.close();
    }
    this.briefs = briefs;
    this.scannedAt = Date.now();
  }

  /** 会话清单读不出来时的兜底：会话根下每个「有观测目录」的子目录就是一段能看的会话。 */
  private sessionDirsWithStore(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.opts.sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    return names.filter((id) => existsSync(this.storePath(id)));
  }

  /**
   * 各段的最近 `limit` 条 run 合起来按 `acceptedAt` 倒序，取前 `limit` 条。
   *
   * 同一毫秒的先后：**同一段内保持它自己那一页的次序**（reader 已按接受顺序给出，见
   * `document-store.ts#symbol=RunIndexOrderKey`），跨段没有可比的先后，按 `sessionId` 定一个固定次序。
   * 早先这里按 `(acceptedAt, runId)` 重排，把段内已经排好的接受顺序又按随机 UUID 打散了。
   */
  async listRuns(limit: number): Promise<RunsResponse> {
    await this.refresh();
    const all: { h: RunObservationHeader; sessionId: string; rank: number }[] = [];
    for (const [sessionId, reader] of this.readers) {
      const page = await reader.listRuns({ limit });
      page.items.forEach((h, rank) => {
        all.push({ h, sessionId, rank });
        this.runOwner.set(h.runId, sessionId);
      });
    }
    all.sort((a, b) => b.h.acceptedAt - a.h.acceptedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.rank - b.rank));
    const items = all.slice(0, limit).map((e) => e.h);
    const used: Record<string, SessionBrief> = {};
    for (const h of items) {
      const brief = h.sessionId === null ? undefined : this.briefs[h.sessionId];
      if (h.sessionId !== null && brief !== undefined) used[h.sessionId] = brief;
    }
    return { items, nextCursor: null, sessions: used };
  }

  /** runId 全局唯一（uuid）：先查 listRuns 记下的归属，没有就挨个库问。 */
  async getRun(runId: string): Promise<RunLookupResult> {
    await this.refresh();
    const owner = this.runOwner.get(runId);
    const first = owner === undefined ? undefined : this.readers.get(owner);
    if (first !== undefined) {
      const r = await first.getRun(runId);
      if (r.kind !== "unknown") return r;
    }
    for (const [sessionId, reader] of this.readers) {
      if (sessionId === owner) continue;
      const r = await reader.getRun(runId);
      if (r.kind !== "unknown") {
        this.runOwner.set(runId, sessionId);
        return r;
      }
    }
    return { kind: "unknown" };
  }

  /** 全部会话里 acceptedAt 最大的那条。 */
  async lastRun(): Promise<RunLookupResult> {
    await this.refresh();
    let best: { at: number; lookup: RunLookupResult } | undefined;
    for (const reader of this.readers.values()) {
      const lookup = await reader.lastRun();
      if (lookup.kind !== "found") continue;
      const at = lookup.observation.acceptedAt;
      if (best === undefined || at > best.at) best = { at, lookup };
    }
    return best?.lookup ?? { kind: "unknown" };
  }

  /** 每段一条。 */
  async health(): Promise<readonly SessionHealth[]> {
    await this.refresh();
    const out: SessionHealth[] = [];
    for (const [sessionId, reader] of this.readers) {
      const last = await reader.lastRun();
      out.push({
        sessionId,
        path: reader.path,
        heads: await reader.runtimeHeads(),
        counts: await reader.counts(),
        last: last.kind === "found" ? headerOf(last.observation) : null,
      });
    }
    return out;
  }

  /** 各段 run 之外的记录合起来按 observedAt 倒序，取前 `limit` 条。 */
  async activity(limit: number): Promise<readonly ActivityItem[]> {
    await this.refresh();
    const all: ActivityItem[] = [];
    for (const [sessionId, reader] of this.readers) {
      for (const record of await reader.recentActivity({ limit })) all.push({ sessionId, record });
    }
    all.sort((a, b) => b.record.observedAt - a.record.observedAt || b.record.seq - a.record.seq);
    return all.slice(0, limit);
  }

  async close(): Promise<void> {
    for (const reader of this.readers.values()) await reader.close();
    this.readers.clear();
  }
}
