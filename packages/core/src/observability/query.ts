// 查询面（O3a）：live `EchoObservations` 与离线 `EchoObservationReader`。
//
// 两者共用同一套「先读 RunIndex、再按 `firstSeq..lastSeq` 取 records、再物化」的路径；差别只在
// live 面还能给 Sequencer 的 health / subscribe 与过期入口。读的都是状态根里 rename 完成的文档（document-store.ts）。
//
// 不做的：跨进程 interrupted recovery、离线 reader 的 runtime health 快照（health 不落盘，`snapshot()` fail-loud 而不是编一个）。

import { decodeObservationEnvelope, materializeRunObservation } from "./materialize.ts";
import type { ObservationSequencer } from "./sequencer.ts";
import { DocumentObservationReader, ObservationStoreMissingError, hasObservationStore, observationStorePath } from "./document-store.ts";
import { FileDir } from "../storage/file-dir.ts";
import type { ObservationEnvelope } from "./types.ts";
import type {
  EchoObservationReader,
  EchoObservationSnapshot,
  EchoObservations,
  ListRunsOptions,
  ObservationSubscribeOptions,
  RunLookupResult,
  RunObservationPage,
  RuntimePhase,
  SubmissionObservation,
} from "./types.ts";

const DEFAULT_PAGE = 20;
const MAX_PAGE = 200;

/** `listRunIndex` 的分页游标：`(acceptedAt, runId)` 倒序稳定分页。 */
export type RunIndexCursor = Readonly<{ acceptedAt: number; runId: string }>;

/** 每个 runtime 已提交到哪（`observe health` 用）。 */
export type RuntimeHeadRow = Readonly<{ runtimeId: string; committedPrefix: number }>;

/** live 与离线查询共用的只读面：按 RunIndex 取一个 run、分页列 run。 */
export type ObservationReadPort = Pick<DocumentObservationReader, "readRunIndex" | "readRunRecords" | "listRunIndex">;

/** opaque cursor 坏了 / 篡改了：fail-loud，不用可漂移的偏移量猜。 */
export class ObservationCursorError extends Error {
  readonly code = "observation_cursor_invalid";
  constructor(message: string) {
    super(message);
    this.name = "ObservationCursorError";
  }
}

/** O3a 未持久化的面（离线 reader 的 runtime health）：明说没有，不编。 */
export class ObservationNotPersistedError extends Error {
  readonly code = "observation_not_persisted";
  constructor(message: string) {
    super(message);
    this.name = "ObservationNotPersistedError";
  }
}

const CURSOR_VERSION = 1;

function encodeCursor(c: RunIndexCursor): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, a: c.acceptedAt, r: c.runId }), "utf8").toString("base64url");
}

function decodeCursor(raw: string): RunIndexCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ObservationCursorError("cursor 不是合法的 base64url JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new ObservationCursorError("cursor 不是对象");
  const c = parsed as { v?: unknown; a?: unknown; r?: unknown };
  if (c.v !== CURSOR_VERSION) throw new ObservationCursorError(`cursor 版本 ${String(c.v)} 不被支持（只认 ${CURSOR_VERSION}）`);
  if (typeof c.a !== "number" || !Number.isFinite(c.a) || typeof c.r !== "string" || c.r.length === 0) throw new ObservationCursorError("cursor 字段缺失或类型不对");
  return { acceptedAt: c.a, runId: c.r };
}

async function lookupRun(store: ObservationReadPort, runId: string): Promise<RunLookupResult> {
  const index = await store.readRunIndex(runId);
  if (index === null) return { kind: "unknown" };
  const bytes = await store.readRunRecords(index.runtimeId, runId, index.firstSeq, index.lastSeq);
  return { kind: "found", observation: materializeRunObservation(index, bytes.map(decodeObservationEnvelope)) };
}

async function listRuns(store: ObservationReadPort, options: ListRunsOptions | undefined): Promise<RunObservationPage> {
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(options?.limit ?? DEFAULT_PAGE)));
  const after = options?.cursor === undefined ? undefined : decodeCursor(options.cursor);
  // 多取一条判断有没有下一页，不用 COUNT
  const entries = await store.listRunIndex({ limit: limit + 1, ...(after === undefined ? {} : { after }) });
  const page = entries.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = entries.length > limit && last !== undefined ? encodeCursor({ acceptedAt: last.header.acceptedAt, runId: last.runId }) : null;
  return { items: page.map((e) => e.header), nextCursor };
}

/** 最近一次顶层 run：按 `(acceptedAt, runId)` 倒序翻页，跳过隔离子循环（source 带 `parentRunId`）。 */
async function lastRun(store: ObservationReadPort): Promise<RunLookupResult> {
  let after: RunIndexCursor | undefined;
  for (;;) {
    const entries = await store.listRunIndex({ limit: MAX_PAGE, ...(after === undefined ? {} : { after }) });
    const top = entries.find((e) => !("parentRunId" in e.header.source));
    if (top !== undefined) return lookupRun(store, top.runId);
    const last = entries[entries.length - 1];
    if (last === undefined || entries.length < MAX_PAGE) return { kind: "unknown" };
    after = { acceptedAt: last.header.acceptedAt, runId: last.runId };
  }
}

/** live：由 `createAgent()` 里的 ObservationRuntime 提供 Sequencer 与（同进程）store。 */
export class LiveEchoObservations implements EchoObservations {
  constructor(
    private readonly deps: Readonly<{
      runtimeId: string;
      sequencer: ObservationSequencer;
      store: ObservationReadPort;
      clock: Readonly<{ now(): number }>;
      phase: () => RuntimePhase;
      expire: () => Promise<void>;
    }>,
  ) {}

  getRun(runId: string): Promise<RunLookupResult> {
    return lookupRun(this.deps.store, runId);
  }

  /** O3a 没有 submission 账本（那是 O2b 的 Inbox / Extension source）：一律 null。 */
  async getSubmission(_submissionId: string): Promise<SubmissionObservation | null> {
    return null;
  }

  lastRun(): Promise<RunLookupResult> {
    return lastRun(this.deps.store);
  }

  listRuns(options?: ListRunsOptions): Promise<RunObservationPage> {
    return listRuns(this.deps.store, options);
  }

  async snapshot(): Promise<EchoObservationSnapshot> {
    const health = this.deps.sequencer.health();
    const phase = this.deps.phase();
    // 只查 running 的 index 行会需要一个 status 索引；O3a 单 permit，activeRuns 至多一条，从最近几条里挑
    const recent = await this.deps.store.listRunIndex({ limit: 8 });
    return {
      schemaVersion: 1,
      runtimeId: this.deps.runtimeId,
      phase,
      status: phase === "ready" && health.persistence.status !== "healthy" ? "degraded" : phase,
      throughSeq: this.deps.sequencer.committedSeq,
      at: this.deps.clock.now(),
      health,
      activeRuns: recent.filter((e) => e.runtimeId === this.deps.runtimeId && e.header.status === "running").map((e) => e.header),
      activeSubmissions: [],
    };
  }

  expire(): Promise<void> {
    return this.deps.expire();
  }

  async subscribe(options: ObservationSubscribeOptions): Promise<() => void> {
    // 交付 committed prefix 之后的 envelope、本 sink 自己的 SinkDeliveryGap，回放跨过被过期删掉的批时交付 ObservationReplayGap
    return this.deps.sequencer.subscribe({
      afterSeq: options.afterSeq,
      listener: options.listener,
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    });
  }
}

/** 离线 reader：只读状态根里的观测文档，不写、不取 StateLock、不起 Runtime。observe CLI 的唯一入口。 */
export class DocumentEchoObservationReader implements EchoObservationReader {
  private constructor(private readonly store: DocumentObservationReader) {}

  /** 状态根里还没有观测文档（没有 `observability/key.json`）→ `ObservationStoreMissingError`。 */
  static async open(options: Readonly<{ stateRoot: string }>): Promise<DocumentEchoObservationReader> {
    const dir = new FileDir(options.stateRoot);
    const path = observationStorePath(options.stateRoot);
    if (!(await hasObservationStore(dir))) throw new ObservationStoreMissingError(path);
    return new DocumentEchoObservationReader(new DocumentObservationReader(dir, path));
  }

  /** 观测目录的路径（health 输出用）。 */
  get path(): string {
    return this.store.path;
  }

  getRun(runId: string): Promise<RunLookupResult> {
    return lookupRun(this.store, runId);
  }

  async getSubmission(_submissionId: string): Promise<SubmissionObservation | null> {
    return null;
  }

  lastRun(): Promise<RunLookupResult> {
    return lastRun(this.store);
  }

  listRuns(options?: ListRunsOptions): Promise<RunObservationPage> {
    return listRuns(this.store, options);
  }

  /** O3a：runtime health 不落盘，离线 reader 给不出真实的 phase / sink health——fail-loud，不伪装实时。 */
  async snapshot(): Promise<EchoObservationSnapshot> {
    throw new ObservationNotPersistedError("runtime health snapshot is not persisted yet (O3b); use runtimeHeads() / listRuns() for what the store knows");
  }

  /** store 自己知道的事：每个 runtimeId 已裁决到的 seq。`observe health` 用。 */
  runtimeHeads(): Promise<readonly RuntimeHeadRow[]> {
    return this.store.readRuntimeHeads();
  }

  async counts(): Promise<Readonly<{ runs: number; records: number }>> {
    return { runs: await this.store.countRuns(), records: await this.store.countRecords() };
  }

  /**
   * run 之外的记录（runtime activity：inbox 收件 / ack / 封账本、闹钟投递与错过、重启恢复），最近 `limit` 条，新的在前。
   * `getRun()` 只回答「这条 run 里发生了什么」，agent 集群里「谁给谁发了消息、卡在哪」发生在 run 之间，只能从这里看。
   * 缺省 50 条，上限 500。
   */
  async recentActivity(options: Readonly<{ limit?: number }> = {}): Promise<readonly ObservationEnvelope[]> {
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 50)));
    return (await this.store.readActivity(limit)).map((bytes) => decodeObservationEnvelope(bytes));
  }

  /** 只读、不持有任何句柄：什么都不用关。保留是为了 `EchoObservationReader` 的用法（用完即 close）。 */
  async close(): Promise<void> {}
}

/**
 * observe CLI 与 SDK 的离线入口：只读已提交的 record / index（rename 完成的文档），活 writer 存在时仍可安全只读。
 * 状态根里还没有观测目录抛 `ObservationStoreMissingError`（这个状态根还没记录过任何事实）。
 */
export function openObservationReader(options: Readonly<{ stateRoot: string }>): Promise<DocumentEchoObservationReader> {
  return DocumentEchoObservationReader.open(options);
}
