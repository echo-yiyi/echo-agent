// 观测的默认存储：状态根里 `StorageDir` 上的一批 JSON 文档（决策：docs/decisions/implemented/2026-09-14-observation-document-store.md）。
//
// 目录（前缀 `observability/`）：
//   key.json                               记忆路径 HMAC key：首建写一次、永不改写；读面不读
//   batches/<runtimeId>/<nextPrefix>.json  一次提交一个文件——**提交点**（`StorageDir.write` 是临时文件 + rename）
//   runs/<runId>.json                      这个 run 的 RunIndex——派生
//   heads/<runtimeId>.json                 { committedPrefix }——派生
//
// 与 Sequencer 的契约（store.ts 头注）逐条落在文件上：一批几个 run 的记录与 RunIndex 在同一个批文件里，一次 rename 同时可见；
// 批文件已存在且逐字相同 = `already-committed-same`，不同 = corruption；head 与 RunIndex 的 CAS 对的是本实例内存里的值
// （每个进程的 runtimeId 是新的，写入只进自己的 `batches/<runtimeId>/`、自己 run 的 `runs/`、自己的 `heads/`，与别的进程不相交）。
// 派生文件写失败不影响已提交，留到下一次提交再写；进程在两者之间退出，那几个 run 就列不出来——观测不做崩溃恢复。
// **派生文件的写入顺序是约定**：先 `runs/`、后 `heads/`。head 走到哪，那之前每一批的 `runs/` 就都写成了——过期（expiry.ts）靠它判断批文件能不能删。
//
// 写入端只在观测线程里用（thread-host.ts），读面主线程与离线 reader 共用。写排一条队；读不排队，只读 rename 完成的文件。

import { join } from "node:path";
import { ObservationCorruptionError, runIndexDigest, type CanonicalObservationStore, type CommitBatchInput, type CommitBatchResult, type ReplayPage } from "./store.ts";
import type { RunIndexEntryV1 } from "./types.ts";
import type { StorageDir } from "../storage/types.ts";

/** 观测文档在状态根里的前缀。 */
export const OBSERVATION_STORE_DIR = "observability";
/** 记忆路径 HMAC key 的固定长度。 */
export const PATH_DIGEST_KEY_BYTES = 32;

const KEY_PATH = `${OBSERVATION_STORE_DIR}/key.json`;
const BATCHES = `${OBSERVATION_STORE_DIR}/batches/`;
const RUNS = `${OBSERVATION_STORE_DIR}/runs/`;
const HEADS = `${OBSERVATION_STORE_DIR}/heads/`;
const KEY_LOCK = `${OBSERVATION_STORE_DIR}/key`;
/** 批文件名里 nextPrefix 的位数：左补零，字典序即数值序。 */
const PREFIX_DIGITS = 12;

const BATCH_FILE = /^observability\/batches\/([^/]+)\/(\d{12})\.json$/;
const RUN_FILE = /^observability\/runs\/([^/]+)\.json$/;
const HEAD_FILE = /^observability\/heads\/([^/]+)\.json$/;

/**
 * 这个存储上有没有观测文档：以 `key.json` 为准（每个写入端开库时必建）。目录在但只有别的东西（比如旧的 `observations.sqlite`）不算。
 * key 在但坏了 → `ObservationCorruptionError`：reader 打开时就报，面板在扫会话那一步就能跳过这一段。
 */
export async function hasObservationStore(dir: StorageDir): Promise<boolean> {
  return (await readKey(dir)) !== null;
}

/** 一个状态根的观测目录在哪：`<stateRoot>/observability`。 */
export function observationStorePath(stateRoot: string): string {
  return join(stateRoot, OBSERVATION_STORE_DIR);
}

/** reader 打开时状态根里还没有观测目录：这个状态根还没记录过任何事实。与 corruption 分开——那是「有东西但坏了」。 */
export class ObservationStoreMissingError extends Error {
  readonly code = "observation_store_missing";
  constructor(readonly path: string) {
    super(`observation store not found: ${path}`);
    this.name = "ObservationStoreMissingError";
  }
}

/** 写入端开库失败（读或建 `key.json` 时的 I/O 错误）：完整 Runtime 装配失败，不进 READY。已有文件坏了是 corruption，不是这个。 */
export class ObservationStoreOpenError extends Error {
  readonly code = "observation_store_open_failed";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ObservationStoreOpenError";
  }
}

/** 一次提交写成的文件。`envelope` 是 canonical JSON 原文，读回逐字还原成字节。 */
type ObservationBatchFileV1 = Readonly<{
  schemaVersion: 1;
  runtimeId: string;
  expectedCommittedPrefix: number;
  nextCommittedPrefix: number;
  records: readonly Readonly<{ seq: number; recordId: string; runId?: string; envelope: string }>[];
  runIndex: readonly RunIndexEntryV1[];
}>;

type HeadFileV1 = Readonly<{ schemaVersion: 1; runtimeId: string; committedPrefix: number }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** runtimeId / runId 里有 `:`，不能直接进路径段。 */
function segment(id: string): string {
  return encodeURIComponent(id);
}

function batchPath(runtimeId: string, nextPrefix: number): string {
  return `${BATCHES}${segment(runtimeId)}/${String(nextPrefix).padStart(PREFIX_DIGITS, "0")}.json`;
}

function runPath(runId: string): string {
  return `${RUNS}${segment(runId)}.json`;
}

function headPath(runtimeId: string): string {
  return `${HEADS}${segment(runtimeId)}.json`;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ObservationCorruptionError(`${what} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBatch(text: string, path: string): ObservationBatchFileV1 {
  const v = parseJson(text, path);
  if (
    !isRecord(v) ||
    v.schemaVersion !== 1 ||
    typeof v.runtimeId !== "string" ||
    typeof v.expectedCommittedPrefix !== "number" ||
    typeof v.nextCommittedPrefix !== "number" ||
    !Array.isArray(v.records) ||
    !Array.isArray(v.runIndex)
  ) {
    throw new ObservationCorruptionError(`${path} 不是批文件（schemaVersion 1）`);
  }
  return v as unknown as ObservationBatchFileV1;
}

function parseRunIndex(text: string, path: string): RunIndexEntryV1 {
  const v = parseJson(text, path);
  if (!isRecord(v) || v.schemaVersion !== 1 || typeof v.runId !== "string" || typeof v.runtimeId !== "string" || !isRecord(v.header)) {
    throw new ObservationCorruptionError(`${path} 不是 RunIndex（schemaVersion 1）`);
  }
  if (typeof v.firstSeq !== "number" || typeof v.lastSeq !== "number" || typeof (v.header as Record<string, unknown>).acceptedAt !== "number") {
    throw new ObservationCorruptionError(`${path} 的 RunIndex 缺 firstSeq / lastSeq / header.acceptedAt`);
  }
  return v as unknown as RunIndexEntryV1;
}

function envelopeBytes(envelope: string): Uint8Array {
  return encoder.encode(envelope);
}

/** `${runtimeId}:${seq}`（sequencer.ts 构造 recordId 的唯一形状）→ 两段。不是这个形状 = 不是本 runtime 写的。 */
function splitRecordId(recordId: string): Readonly<{ runtimeId: string; seq: number }> | undefined {
  const cut = recordId.lastIndexOf(":");
  if (cut <= 0) return undefined;
  const seq = Number(recordId.slice(cut + 1));
  return Number.isSafeInteger(seq) && seq > 0 ? { runtimeId: recordId.slice(0, cut), seq } : undefined;
}

type BatchName = Readonly<{ path: string; nextPrefix: number }>;

/**
 * run 列举顺序（`RUN_INDEX_ORDER`）的位置键：`(acceptedAt ↓, runtimeId, firstSeq ↓)`。分页游标带的就是这三个字段。
 *
 * **为什么不是 `(acceptedAt, runId)`**（2026-09-15）：`acceptedAt` 只到毫秒，而 `runId` 是随机 UUID
 * ——同一毫秒被接受的两个 run 谁在前是抛硬币（实测 `listRuns({limit:1})` 约 1/4 拿到的是前一个 run，
 * `lastRun()` 同病）。同一个 runtime 内 `run.accepted` 按到达顺序预留 seq，`firstSeq` 就是 admission 顺序，
 * 拿它当第二键既真实又唯一。跨 runtime 没有可比的先后（seq 各数各的），按 `runtimeId` 给一个任意但稳定的
 * 次序——一个状态根同时只有一个进程在写，同毫秒跨 runtime 实际碰不到。
 *
 * 三段**按这个次序逐级比较**，合起来是全序；不能写成「同 runtime 比 firstSeq、跨 runtime 比 runId」
 * ——那种比较不传递（三条记录能比出一个环），分页会重会漏。
 */
export type RunIndexOrderKey = Readonly<{ acceptedAt: number; runtimeId: string; firstSeq: number }>;

/** `RUN_INDEX_ORDER` 的比较器：新的在前。 */
export function compareRunIndex(a: RunIndexEntryV1, b: RunIndexEntryV1): number {
  if (a.header.acceptedAt !== b.header.acceptedAt) return b.header.acceptedAt - a.header.acceptedAt;
  if (a.runtimeId !== b.runtimeId) return a.runtimeId < b.runtimeId ? -1 : 1;
  return b.firstSeq - a.firstSeq;
}

/** `e` 是否严格排在位置 `after` 之后（分页 exclusive 游标；与 `compareRunIndex` 同一把尺）。 */
export function isAfterRunIndex(e: RunIndexEntryV1, after: RunIndexOrderKey): boolean {
  if (e.header.acceptedAt !== after.acceptedAt) return e.header.acceptedAt < after.acceptedAt;
  if (e.runtimeId !== after.runtimeId) return e.runtimeId > after.runtimeId;
  return e.firstSeq < after.firstSeq;
}

/**
 * 只读面：写入端与离线 reader 共用。只读 rename 完成的文件，不写任何东西、不取锁。
 */
export class DocumentObservationReader {
  constructor(
    protected readonly dir: StorageDir,
    /** 给人看的位置（`observe health` 输出用）。 */
    readonly path: string,
  ) {}

  /** 某个 runtime 的批文件，按 nextPrefix 升序。临时文件、锁目录都不算。 */
  protected async batchesOf(runtimeId: string): Promise<readonly BatchName[]> {
    const prefix = `${BATCHES}${segment(runtimeId)}/`;
    const out: BatchName[] = [];
    for (const p of await this.dir.list(prefix)) {
      const m = BATCH_FILE.exec(p);
      if (m !== null) out.push({ path: p, nextPrefix: Number(m[2]) });
    }
    return out.sort((a, b) => a.nextPrefix - b.nextPrefix);
  }

  /** 所有出现过批文件或 head 的 runtime。 */
  protected async runtimeIds(): Promise<readonly string[]> {
    const ids = new Set<string>();
    for (const p of await this.dir.list(BATCHES)) {
      const m = BATCH_FILE.exec(p);
      if (m !== null) ids.add(decodeURIComponent(m[1]!));
    }
    for (const p of await this.dir.list(HEADS)) {
      const m = HEAD_FILE.exec(p);
      if (m !== null) ids.add(decodeURIComponent(m[1]!));
    }
    return [...ids].sort();
  }

  protected async readBatch(path: string): Promise<ObservationBatchFileV1 | null> {
    const text = await this.dir.read(path);
    return text === null ? null : parseBatch(text, path);
  }

  protected async readHeadFile(runtimeId: string): Promise<number> {
    const path = headPath(runtimeId);
    const text = await this.dir.read(path);
    if (text === null) return 0;
    const v = parseJson(text, path);
    if (!isRecord(v) || v.schemaVersion !== 1 || typeof v.committedPrefix !== "number") throw new ObservationCorruptionError(`${path} 不是 head（schemaVersion 1）`);
    return v.committedPrefix;
  }

  async readRunIndex(runId: string): Promise<RunIndexEntryV1 | null> {
    const path = runPath(runId);
    const text = await this.dir.read(path);
    if (text === null) return null;
    const entry = parseRunIndex(text, path);
    if (entry.runId !== runId) throw new ObservationCorruptionError(`${path} 里的 runId 是 ${entry.runId}`);
    return entry;
  }

  /** 已提交到哪：head 文件与最新批文件取大——head 是派生的，可能落后一批；批文件可能被过期删掉，head 不回退。 */
  async readCommittedPrefix(runtimeId: string): Promise<number> {
    const batches = await this.batchesOf(runtimeId);
    const newest = batches[batches.length - 1]?.nextPrefix ?? 0;
    return Math.max(newest, await this.readHeadFile(runtimeId));
  }

  async readRecordBytes(recordId: string): Promise<Uint8Array | null> {
    const id = splitRecordId(recordId);
    if (id === undefined) return null;
    const covering = (await this.batchesOf(id.runtimeId)).find((b) => b.nextPrefix >= id.seq);
    if (covering === undefined) return null;
    const batch = await this.readBatch(covering.path);
    const record = batch?.records.find((r) => r.recordId === recordId);
    return record === undefined ? null : envelopeBytes(record.envelope);
  }

  /** 一个 run 在 `[firstSeq, lastSeq]` 内的全部记录，按 seq 升序。 */
  async readRunRecords(runtimeId: string, runId: string, firstSeq: number, lastSeq: number): Promise<readonly Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (const b of await this.batchesOf(runtimeId)) {
      if (b.nextPrefix < firstSeq) continue;
      const batch = await this.readBatch(b.path);
      if (batch === null) continue; // 读的这一刻被过期删了
      for (const r of batch.records) {
        if (r.runId === runId && r.seq >= firstSeq && r.seq <= lastSeq) out.push(envelopeBytes(r.envelope));
      }
      if (batch.nextCommittedPrefix >= lastSeq) break;
    }
    return out;
  }

  /**
   * 订阅回放的一页：某个 runtime 在 `seq > afterSeq` 之后按 seq 升序的前 `limit` 条，外加这一段里被过期删掉的 seq 区间。
   * 相邻批文件接不上（后一个的 expectedCommittedPrefix 比上一个的 nextCommittedPrefix 大）= 中间的批被删了。
   */
  async readRecordsAfter(runtimeId: string, afterSeq: number, limit: number): Promise<ReplayPage> {
    const records: Uint8Array[] = [];
    const removed: { afterSeq: number; beforeSeq: number }[] = [];
    let cursor = afterSeq;
    for (const b of await this.batchesOf(runtimeId)) {
      if (b.nextPrefix <= afterSeq) continue;
      const batch = await this.readBatch(b.path);
      if (batch === null) continue;
      if (batch.expectedCommittedPrefix > cursor) removed.push({ afterSeq: cursor, beforeSeq: batch.expectedCommittedPrefix + 1 });
      for (const r of batch.records) {
        if (r.seq <= afterSeq) continue;
        if (records.length >= limit) return { records, removed };
        records.push(envelopeBytes(r.envelope));
      }
      cursor = batch.nextCommittedPrefix;
    }
    const committed = await this.readHeadFile(runtimeId);
    if (records.length < limit && committed > cursor) removed.push({ afterSeq: cursor, beforeSeq: committed + 1 });
    return { records, removed };
  }

  /** 全部 RunIndex，按 `RUN_INDEX_ORDER` 排（新的在前）。 */
  async readAllRunIndex(): Promise<readonly RunIndexEntryV1[]> {
    const out: RunIndexEntryV1[] = [];
    for (const p of await this.dir.list(RUNS)) {
      if (!RUN_FILE.test(p)) continue;
      const text = await this.dir.read(p);
      if (text !== null) out.push(parseRunIndex(text, p)); // null：读的这一刻被过期删了
    }
    return out.sort(compareRunIndex);
  }

  /** 按 `RUN_INDEX_ORDER` 分页；`after` 是上一页最后一条的位置（exclusive）。 */
  async listRunIndex(opts: Readonly<{ limit: number; after?: RunIndexOrderKey }>): Promise<readonly RunIndexEntryV1[]> {
    const limit = Math.max(1, Math.floor(opts.limit));
    const all = await this.readAllRunIndex();
    const after = opts.after;
    const rest = after === undefined ? all : all.filter((e) => isAfterRunIndex(e, after));
    return rest.slice(0, limit);
  }

  /** run 之外的记录（`runId` 为空）最近 `limit` 条，按 observedAt 倒序（跨 runtime 的 seq 不可比）。 */
  async readActivity(limit: number): Promise<readonly Uint8Array[]> {
    const n = Math.max(1, Math.floor(limit));
    const found: { observedAt: number; seq: number; bytes: Uint8Array }[] = [];
    for (const runtimeId of await this.runtimeIds()) {
      let taken = 0;
      const batches = await this.batchesOf(runtimeId);
      for (let i = batches.length - 1; i >= 0 && taken < n; i--) {
        const batch = await this.readBatch(batches[i]!.path);
        if (batch === null) continue;
        for (let j = batch.records.length - 1; j >= 0 && taken < n; j--) {
          const r = batch.records[j]!;
          if (r.runId !== undefined) continue;
          const env = parseJson(r.envelope, `${batches[i]!.path} seq ${r.seq}`) as { observedAt?: unknown };
          found.push({ observedAt: typeof env.observedAt === "number" ? env.observedAt : 0, seq: r.seq, bytes: envelopeBytes(r.envelope) });
          taken += 1;
        }
      }
    }
    return found.sort((a, b) => b.observedAt - a.observedAt || b.seq - a.seq).slice(0, n).map((f) => f.bytes);
  }

  async readRuntimeHeads(): Promise<readonly Readonly<{ runtimeId: string; committedPrefix: number }>[]> {
    const out: { runtimeId: string; committedPrefix: number }[] = [];
    for (const runtimeId of await this.runtimeIds()) out.push({ runtimeId, committedPrefix: await this.readCommittedPrefix(runtimeId) });
    return out;
  }

  async countRuns(): Promise<number> {
    return (await this.dir.list(RUNS)).filter((p) => RUN_FILE.test(p)).length;
  }

  async countRecords(): Promise<number> {
    let n = 0;
    for (const runtimeId of await this.runtimeIds()) {
      for (const b of await this.batchesOf(runtimeId)) n += (await this.readBatch(b.path))?.records.length ?? 0;
    }
    return n;
  }
}

/**
 * 写入端：Sequencer 之下的唯一持久层（`CanonicalObservationStore`）。
 * 不关底下的 `StorageDir`：它是状态根的存储（或调用方注入的），dispose owner 不在这里。
 */
export class DocumentObservationStore extends DocumentObservationReader implements CanonicalObservationStore {
  /** 本实例提交过的 runtime 的 head（CAS 对的是它）。 */
  private readonly heads = new Map<string, number>();
  /** 本实例提交过的 RunIndex（CAS 对的是它）。 */
  private readonly index = new Map<string, RunIndexEntryV1>();
  /** 批文件已写、派生文件还没写成的：下一次提交时再写。 */
  private readonly pendingRuns = new Set<string>();
  private readonly pendingHeads = new Set<string>();
  /** 写操作的队：提交一条一条来。 */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    dir: StorageDir,
    path: string,
    private readonly pathDigestKey: Uint8Array,
  ) {
    super(dir, path);
  }

  /**
   * 读或建 `key.json`，其余什么都不写。建 key 在 `StorageDir.lock` 下读、没有才写（字节面没有锁原语时只能进程内串行）。
   */
  static async open(opts: Readonly<{ dir: StorageDir; path: string }>): Promise<DocumentObservationStore> {
    let key: Uint8Array;
    try {
      key = (await readKey(opts.dir)) ?? (await createKey(opts.dir));
    } catch (e) {
      if (e instanceof ObservationCorruptionError) throw e;
      throw new ObservationStoreOpenError(`open observation store failed: ${opts.path}`, { cause: e });
    }
    return new DocumentObservationStore(opts.dir, opts.path, key);
  }

  /** 本状态根的记忆路径 HMAC key。只供写入端的 projection，永不进 envelope / reader / export。 */
  readPathDigestKey(): Uint8Array {
    return this.pathDigestKey;
  }

  commitBatchIfAbsent(input: CommitBatchInput): Promise<CommitBatchResult> {
    return this.enqueue(() => this.commit(input));
  }

  /** 等队里的写全部做完。不关底下的 `StorageDir`（dispose owner 不在这里）。幂等。 */
  async close(): Promise<void> {
    await this.queue.catch(() => {});
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async commit(input: CommitBatchInput): Promise<CommitBatchResult> {
    const path = batchPath(input.runtimeId, input.nextCommittedPrefix);
    const content = serializeBatch(input);
    const existing = await this.dir.read(path);
    if (existing !== null) {
      if (existing !== content) throw new ObservationCorruptionError(`批文件 ${path} 已存在但内容不同（ID collision / corruption）`);
      // 上一次提交写成了批文件却在那之后抛了（commit-unknown）：内存与派生文件按已提交补上
      this.applyCommitted(input);
      await this.flushPendingDerived();
      return "already-committed-same";
    }
    const head = this.heads.get(input.runtimeId) ?? (await this.readCommittedPrefix(input.runtimeId));
    if (head !== input.expectedCommittedPrefix) {
      throw new ObservationCorruptionError(`committed prefix CAS 失败：期望 ${input.expectedCommittedPrefix}，实际 ${head}`);
    }
    const inBatch = new Set(input.records.map((r) => r.recordId));
    for (const m of input.runIndexMutations) {
      const cur = this.index.get(m.runId);
      const curDigest = cur === undefined ? null : runIndexDigest(cur);
      if (curDigest !== m.expectedRunIndexDigest) {
        throw new ObservationCorruptionError(`RunIndex(${m.runId}) digest 漂移：期望 ${String(m.expectedRunIndexDigest)}，实际 ${String(curDigest)}`);
      }
      // RunIndex 引用的记录必须真的在：要么就在这一批里，要么上一版已经引用过它（外键式的不变量）
      for (const field of ["acceptedRecordId", "startedRecordId", "terminalRecordId"] as const) {
        const id = m.nextRunIndex[field];
        if (id !== undefined && !inBatch.has(id) && cur?.[field] !== id) {
          throw new ObservationCorruptionError(`RunIndex(${m.runId}).${field} 引用了不存在的记录 ${id}`);
        }
      }
    }
    await this.dir.write(path, content); // 提交点
    this.applyCommitted(input);
    await this.flushPendingDerived();
    return "committed";
  }

  private applyCommitted(input: CommitBatchInput): void {
    this.heads.set(input.runtimeId, Math.max(this.heads.get(input.runtimeId) ?? 0, input.nextCommittedPrefix));
    this.pendingHeads.add(input.runtimeId);
    for (const m of input.runIndexMutations) {
      this.index.set(m.runId, m.nextRunIndex);
      this.pendingRuns.add(m.runId);
    }
  }

  /** 派生文件：写不成就留着下次再写，不让已提交的批判失败。 */
  private async flushPendingDerived(): Promise<void> {
    for (const runId of [...this.pendingRuns]) {
      const entry = this.index.get(runId);
      if (entry === undefined) {
        this.pendingRuns.delete(runId);
        continue;
      }
      try {
        await this.dir.write(runPath(runId), JSON.stringify(entry));
        this.pendingRuns.delete(runId);
      } catch {
        return;
      }
    }
    for (const runtimeId of [...this.pendingHeads]) {
      try {
        await this.writeHead(runtimeId, this.heads.get(runtimeId) ?? 0);
        this.pendingHeads.delete(runtimeId);
      } catch {
        return;
      }
    }
  }

  private async writeHead(runtimeId: string, committedPrefix: number): Promise<void> {
    const head: HeadFileV1 = { schemaVersion: 1, runtimeId, committedPrefix };
    await this.dir.write(headPath(runtimeId), JSON.stringify(head));
  }
}

/** 过期执行的结果。 */
export type ObservationExpiryResult = Readonly<{
  /** 删掉了 RunIndex 的 run。 */
  removedRuns: readonly string[];
  /** 规则点名了、但盘上还没封口（RunIndex 没有终态记录）的 run：没删。 */
  openRuns: readonly string[];
  /** 回收的批文件数。 */
  removedBatches: number;
}>;

/**
 * 过期的执行面（`expiry.ts` 的 `expireObservations()` 用）：按已经算好的决定删文件。
 * 不取锁、不需要写入端配合，活着的写者旁边做也安全，因为只凭盘上的事实判断：
 *   · run：只删盘上已封口的（RunIndex 有 `terminalRecordId`）——封口之后写者不再写这个 run 的任何文件；
 *   · 批文件：只删 `nextCommittedPrefix ≤ head` 的（它那一批的 `runs/` 已经写成，见头注的派生文件顺序），
 *     且里面出现过的 run 都已不在 `runs/`、run 之外的记录都早于 `activityBefore`（不给就不删带这类记录的批）。
 */
export class DocumentObservationExpiry extends DocumentObservationReader {
  async remove(decision: Readonly<{ runs?: readonly string[]; activityBefore?: number }>): Promise<ObservationExpiryResult> {
    const removedRuns: string[] = [];
    const openRuns: string[] = [];
    for (const runId of new Set(decision.runs ?? [])) {
      const entry = await this.readRunIndex(runId);
      if (entry === null) continue;
      if (entry.terminalRecordId === undefined) {
        openRuns.push(runId);
        continue;
      }
      if (await this.dir.remove(runPath(runId))) removedRuns.push(runId);
    }
    if (removedRuns.length === 0 && decision.activityBefore === undefined) return { removedRuns, openRuns, removedBatches: 0 };
    const live = new Set((await this.readAllRunIndex()).map((e) => e.runId));
    let removedBatches = 0;
    for (const runtimeId of await this.runtimeIds()) {
      const head = await this.readHeadFile(runtimeId);
      for (const b of await this.batchesOf(runtimeId)) {
        if (b.nextPrefix > head) break;
        const batch = await this.readBatch(b.path);
        if (batch === null || !collectable(batch, live, decision.activityBefore)) continue;
        if (await this.dir.remove(b.path)) removedBatches += 1;
      }
    }
    return { removedRuns, openRuns, removedBatches };
  }
}

/** 批文件能不能回收：出现过的 run 都已不在 `runs/`，run 之外的记录都早于 `activityBefore`。 */
function collectable(batch: ObservationBatchFileV1, live: ReadonlySet<string>, activityBefore: number | undefined): boolean {
  for (const entry of batch.runIndex) if (live.has(entry.runId)) return false;
  for (const r of batch.records) {
    if (r.runId !== undefined) {
      if (live.has(r.runId)) return false;
      continue;
    }
    if (activityBefore === undefined) return false;
    const env = parseJson(r.envelope, `batch ${batch.nextCommittedPrefix} seq ${r.seq}`) as { observedAt?: unknown };
    if (typeof env.observedAt !== "number" || env.observedAt >= activityBefore) return false;
  }
  return true;
}

function serializeBatch(input: CommitBatchInput): string {
  const batch: ObservationBatchFileV1 = {
    schemaVersion: 1,
    runtimeId: input.runtimeId,
    expectedCommittedPrefix: input.expectedCommittedPrefix,
    nextCommittedPrefix: input.nextCommittedPrefix,
    records: input.records.map((r) => ({
      seq: r.seq,
      recordId: r.recordId,
      ...(r.runId === undefined ? {} : { runId: r.runId }),
      envelope: decoder.decode(r.canonicalEnvelopeBytes),
    })),
    runIndex: input.runIndexMutations.map((m) => m.nextRunIndex),
  };
  return JSON.stringify(batch);
}

async function readKey(dir: StorageDir): Promise<Uint8Array | null> {
  const text = await dir.read(KEY_PATH);
  if (text === null) return null;
  const v = parseJson(text, KEY_PATH);
  if (!isRecord(v) || v.schemaVersion !== 1 || typeof v.pathDigestKey !== "string") throw new ObservationCorruptionError(`${KEY_PATH} 不是 key 文件（schemaVersion 1）`);
  const bytes = Uint8Array.from(Buffer.from(v.pathDigestKey, "base64"));
  if (bytes.byteLength !== PATH_DIGEST_KEY_BYTES) throw new ObservationCorruptionError(`path digest key 长度错误：${bytes.byteLength}`);
  return bytes;
}

/** 在锁下再读一次，没有才写：两个进程同时首建时只有一个 key 落盘。 */
async function createKey(dir: StorageDir): Promise<Uint8Array> {
  const release = dir.lock === undefined ? undefined : await dir.lock(KEY_LOCK);
  try {
    const again = await readKey(dir);
    if (again !== null) return again;
    const key = crypto.getRandomValues(new Uint8Array(PATH_DIGEST_KEY_BYTES));
    await dir.write(KEY_PATH, JSON.stringify({ schemaVersion: 1, pathDigestKey: Buffer.from(key).toString("base64") }));
    return key;
  } finally {
    await release?.();
  }
}
