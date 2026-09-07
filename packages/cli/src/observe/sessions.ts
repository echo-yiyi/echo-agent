// 跨 session 的只读读取。观测库**一段 session 一份**（状态根 = session 目录，2026-09-03），agent 集群里几段并行时
// 要一起看，就得扫会话根、每段开一个 read-only reader、把各段的 run 合起来排。合并在这一层做，
// core 的 reader 仍是「一个 journal 一个 reader」，不为面板加公共 API。
//
// 会话的出现与消失按 2s 缓存重扫：新出现且已有库的开 reader，目录没了的关掉。`sessionId` 给了就只看那一段——
// 那时不要求它有 meta（点名的是目录），只要求库文件存在。

import { existsSync } from "node:fs";
import {
  describeAgentRef,
  FileDir,
  listSessions,
  observationDatabasePath,
  openObservationReader,
  resolveStateDir,
  type RunLookupResult,
  type RunObservation,
  type RunObservationHeader,
  type RunObservationPage,
  type SessionInfo,
  type SqliteEchoObservationReader,
} from "@echo-agent/core";
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
  private readonly readers = new Map<string, SqliteEchoObservationReader>();
  private briefs: Record<string, SessionBrief> = {};
  private scannedAt = 0;
  /** runId → sessionId（listRuns 见过的），`getRun` 先查它再挨个库找。 */
  private readonly runOwner = new Map<string, string>();

  constructor(readonly opts: SessionObservationReadersOptions) {}

  /** 会话目录。 */
  stateRoot(sessionId: string): string {
    return resolveStateDir({ sessionsRoot: this.opts.sessionsRoot, sessionId });
  }

  /** 某段会话的库文件路径（存不存在都算得出，报错文案用）。 */
  databasePath(sessionId: string): string {
    return observationDatabasePath(this.stateRoot(sessionId));
  }

  /** 已开 reader 的会话数。0 = 一段都还没有观测记录。 */
  get size(): number {
    return this.readers.size;
  }

  /** 会话根下全部会话的摘要（不只是有库的）。 */
  get sessions(): Readonly<Record<string, SessionBrief>> {
    return this.briefs;
  }

  /** 重扫会话根。`force` 跳过 2s 缓存（命令行一次性用）。 */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.scannedAt < SESSION_CACHE_MS) return;
    const infos = await listSessions(new FileDir(this.opts.sessionsRoot));
    const briefs: Record<string, SessionBrief> = {};
    for (const s of infos) {
      briefs[s.id] = { product: s.product, agent: describeAgentRef(s.agent), name: s.name, workspace: s.workspace, updatedAt: s.updatedAt, status: s.status };
    }
    const wanted = this.opts.sessionId === undefined ? infos.map((s) => s.id) : [this.opts.sessionId];
    const seen = new Set<string>();
    for (const id of wanted) {
      if (!existsSync(this.databasePath(id))) continue; // 会话有了、agent 还没跑过一条 run：库还没建，不是错
      seen.add(id);
      if (!this.readers.has(id)) this.readers.set(id, await openObservationReader({ stateRoot: this.stateRoot(id) }));
    }
    for (const [id, reader] of this.readers) {
      if (seen.has(id)) continue;
      this.readers.delete(id);
      await reader.close();
    }
    this.briefs = briefs;
    this.scannedAt = Date.now();
  }

  /** 各段的最近 `limit` 条 run 合起来按 `(acceptedAt, runId)` 倒序，取前 `limit` 条。 */
  async listRuns(limit: number): Promise<RunsResponse> {
    await this.refresh();
    const all: RunObservationHeader[] = [];
    for (const [sessionId, reader] of this.readers) {
      const page = await reader.listRuns({ limit });
      for (const h of page.items) {
        all.push(h);
        this.runOwner.set(h.runId, sessionId);
      }
    }
    all.sort((a, b) => b.acceptedAt - a.acceptedAt || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
    const items = all.slice(0, limit);
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
      const at = lookup.kind === "found" ? lookup.observation.acceptedAt : lookup.kind === "pruned" ? lookup.header.acceptedAt : undefined;
      if (at === undefined) continue;
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
        last: last.kind === "found" ? headerOf(last.observation) : last.kind === "pruned" ? last.header : null,
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
