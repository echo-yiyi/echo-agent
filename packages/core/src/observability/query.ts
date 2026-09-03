// 查询面（§15.6 / §15.6.1，O3a）：live `EchoObservations` 与离线 `EchoObservationReader`。
//
// 两者共用同一套「先读 RunIndex、再按 `firstSeq..lastSeq` 取 retained records、再物化」的路径；差别只在
// live 面还能给 Sequencer 的 health / subscribe。每次查询都是一个短 SQLite 读：bytes 拷到进程内就结束，decode
// 与物化在事务之外（§15.6.1）。
//
// O3a 不做的（O3b）：retention（`pruned` 只在 index 已标 pruned 时返回）、跨进程 interrupted recovery、
// 离线 reader 的 runtime health 快照（health 尚未持久化，`snapshot()` fail-loud 而不是编一个）。

import { decodeObservationEnvelope, materializeRunObservation } from "./materialize.ts";
import type { ObservationSequencer } from "./sequencer.ts";
import { SqliteObservationReader, observationDatabasePath, type RunIndexCursor, type RuntimeHeadRow } from "./sqlite-store.ts";
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

/** opaque cursor 坏了 / 篡改了：fail-loud，不用可漂移的偏移量猜（§15.6.1）。 */
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

async function lookupRun(store: SqliteObservationReader, runId: string): Promise<RunLookupResult> {
  const index = await store.readRunIndex(runId);
  if (index === null) return { kind: "unknown" };
  if (index.bodyState === "pruned") {
    // body 已清但 header 仍在窗口内：只剩 index 的 header 与 retention gap（O3b 才会真的产生 pruned 行）
    const bytes = await store.readRunRecords(index.runtimeId, runId, index.firstSeq, index.lastSeq);
    const records = bytes.map(decodeObservationEnvelope);
    return { kind: "pruned", header: index.header, gaps: materializeRunObservation(index, records).gaps };
  }
  const bytes = await store.readRunRecords(index.runtimeId, runId, index.firstSeq, index.lastSeq);
  return { kind: "found", observation: materializeRunObservation(index, bytes.map(decodeObservationEnvelope)) };
}

async function listRuns(store: SqliteObservationReader, options: ListRunsOptions | undefined): Promise<RunObservationPage> {
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(options?.limit ?? DEFAULT_PAGE)));
  const after = options?.cursor === undefined ? undefined : decodeCursor(options.cursor);
  // 多取一条判断有没有下一页，不用 COUNT
  const entries = await store.listRunIndex({ limit: limit + 1, ...(after === undefined ? {} : { after }) });
  const page = entries.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = entries.length > limit && last !== undefined ? encodeCursor({ acceptedAt: last.header.acceptedAt, runId: last.runId }) : null;
  return { items: page.map((e) => e.header), nextCursor };
}

async function lastRun(store: SqliteObservationReader): Promise<RunLookupResult> {
  const [latest] = await store.listRunIndex({ limit: 1 });
  return latest === undefined ? { kind: "unknown" } : lookupRun(store, latest.runId);
}

/** live：由 `createAgent()` 里的 ObservationRuntime 提供 Sequencer 与（同进程）store。 */
export class LiveEchoObservations implements EchoObservations {
  constructor(
    private readonly deps: Readonly<{
      runtimeId: string;
      sequencer: ObservationSequencer;
      store: SqliteObservationReader;
      clock: Readonly<{ now(): number }>;
      phase: () => RuntimePhase;
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

  async subscribe(options: ObservationSubscribeOptions): Promise<() => void> {
    // 只交付 committed prefix 之后的 envelope 与本 sink 自己的 SinkDeliveryGap；O3a 没有 retention，因此没有 ObservationReplayGap
    return this.deps.sequencer.subscribe({
      afterSeq: options.afterSeq,
      listener: options.listener,
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    });
  }
}

/** 离线 reader：read-only SQLite connection，不取 StateLock、不起 Runtime。observe CLI 的唯一入口。 */
export class SqliteEchoObservationReader implements EchoObservationReader {
  private constructor(private readonly store: SqliteObservationReader) {}

  static async open(options: Readonly<{ stateRoot: string }>): Promise<SqliteEchoObservationReader> {
    return new SqliteEchoObservationReader(await SqliteObservationReader.openReadOnly({ path: observationDatabasePath(options.stateRoot) }));
  }

  /** 库文件路径（health 输出用）。 */
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

  /** O3a：runtime health 不落盘，离线 reader 给不出真实的 phase / sink health——fail-loud，不伪装实时（§15.7）。 */
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

  async close(): Promise<void> {
    this.store.close();
  }
}

/**
 * observe CLI 与 SDK 的离线入口（§15.6）：只读已 COMMIT 的 record / index，活 writer 存在时仍可安全只读。
 * 库不存在抛 `ObservationDatabaseMissingError`（这个 state root 还没记录过 run）。
 */
export function openObservationReader(options: Readonly<{ stateRoot: string }>): Promise<SqliteEchoObservationReader> {
  return SqliteEchoObservationReader.open(options);
}
