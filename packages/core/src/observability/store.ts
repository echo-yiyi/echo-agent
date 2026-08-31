// CanonicalObservationStore（§15.4.2 / §15.4.2.3）：Sequencer 之下唯一的持久层 seam。
//
// V0 生产实现是 `bun:sqlite`（O3a）；这里的 in-memory 实现**只供 O2a reference conformance**，
// 不能装进 `createEcho()`，用户配置也不能替换 canonical store。两个实现共用同一套裁决：
//   · 一批 records + 受影响 RunIndex + runtime head 在同一事务里要么全见、要么全不见；
//   · recordId 已存在且 bytes、head、index 全部逐字等价 → `already-committed-same`（幂等重试）；
//   · 同 recordId 不同 bytes、部分存在、index digest 漂移 → corruption，立即抛，调用方 seal writer。

import { canonicalDigest, encodeCanonical } from "./normalize.ts";
import type { ObservationPersistenceState, RunIndexEntryV1 } from "./types.ts";

export class ObservationCorruptionError extends Error {
  readonly code = "observation_corruption";
  constructor(message: string) {
    super(message);
    this.name = "ObservationCorruptionError";
  }
}

/** §15.12：admission 时 canonical store 不可写 / writer 已 sealed。 */
export class ObservationStoreUnavailableError extends Error {
  readonly code = "observation_store_unavailable";
  readonly persistence: ObservationPersistenceState;
  constructor(message: string, persistence: ObservationPersistenceState) {
    super(message);
    this.name = "ObservationStoreUnavailableError";
    this.persistence = persistence;
  }
}

export type CanonicalRecordCandidate = Readonly<{
  recordId: string;
  runtimeId: string;
  seq: number;
  canonicalEnvelopeBytes: Uint8Array;
}>;

export type RunIndexMutation = Readonly<{
  runId: string;
  /** null 只用于 accepted/create：要求 index 原先不存在。 */
  expectedRunIndexDigest: string | null;
  nextRunIndex: RunIndexEntryV1;
}>;

export type CommitBatchInput = Readonly<{
  runtimeId: string;
  expectedCommittedPrefix: number;
  nextCommittedPrefix: number;
  records: readonly CanonicalRecordCandidate[];
  runIndexMutations: readonly RunIndexMutation[];
}>;

export type CommitBatchResult = "committed" | "already-committed-same";

export interface CanonicalObservationStore {
  commitBatchIfAbsent(input: CommitBatchInput): Promise<CommitBatchResult>;
  readRecordBytes(recordId: string): Promise<Uint8Array | null>;
  readRunIndex(runId: string): Promise<RunIndexEntryV1 | null>;
  /** commit-unknown 的 read-after-error 与 boundary resolve 都要 read-back head（§15.4.2.3）。 */
  readCommittedPrefix(runtimeId: string): Promise<number>;
}

/** RunIndex 的 CAS 键：canonical bytes 的 SHA-256。两个实现必须算得一样。 */
export function runIndexDigest(entry: RunIndexEntryV1): string {
  return canonicalDigest(encodeCanonical(entry).bytes);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 测试用故障注入：在某次 commit 之前决定它怎么坏。
 *  · `"throw"`：什么都不写，抛错（瞬时失败，重试应成功）
 *  · `"unknown"`：**写成功但抛错**（commit-unknown：调用方必须 read-after-error 才知道已 committed）
 *  · `"hang"`：永不 settle（boundary deadline 路径）
 */
export type StoreFailpoint = (input: CommitBatchInput, attempt: number) => "throw" | "unknown" | "hang" | undefined;

export class InMemoryCanonicalObservationStore implements CanonicalObservationStore {
  private readonly records = new Map<string, Uint8Array>();
  private readonly seqIndex = new Map<string, string>(); // `${runtimeId}#${seq}` → recordId
  private readonly heads = new Map<string, number>();
  private readonly runIndex = new Map<string, RunIndexEntryV1>();
  private commits = 0;
  failpoint: StoreFailpoint | undefined;
  /** 每笔成功事务的 record 数（测试断言 batch 上限对 boundary 与 gap 也生效）。 */
  readonly batchSizes: number[] = [];
  /** 每笔成功事务的 canonical 字节数（同上，按字节的那一半）。 */
  readonly batchBytes: number[] = [];

  /** 已成功落库的事务数（测试断言「不是一条 record 一个事务」）。 */
  get commitCount(): number {
    return this.commits;
  }

  async commitBatchIfAbsent(input: CommitBatchInput): Promise<CommitBatchResult> {
    const mode = this.failpoint?.(input, this.commits);
    if (mode === "hang") return new Promise<CommitBatchResult>(() => {});
    if (mode === "throw") throw new Error("store failure (injected)");

    const head = this.heads.get(input.runtimeId) ?? 0;
    const states = input.records.map((r) => {
      const existing = this.records.get(r.recordId);
      if (existing === undefined) return "absent" as const;
      return bytesEqual(existing, r.canonicalEnvelopeBytes) ? ("same" as const) : ("mismatch" as const);
    });
    if (states.some((s) => s === "mismatch")) {
      throw new ObservationCorruptionError("recordId 已存在但 canonical bytes 不同（ID collision / corruption）");
    }
    const allSame = states.length > 0 && states.every((s) => s === "same");
    const allAbsent = states.every((s) => s === "absent");
    if (!allSame && !allAbsent) throw new ObservationCorruptionError("同一批 records 部分存在：半批可见");

    if (allSame) {
      // 幂等重试：head 与全部 next index 也必须逐字等价，否则是漂移
      if (head !== input.nextCommittedPrefix) {
        throw new ObservationCorruptionError(`records 已在但 head=${head} ≠ next=${input.nextCommittedPrefix}`);
      }
      for (const m of input.runIndexMutations) {
        const cur = this.runIndex.get(m.runId);
        if (cur === undefined || runIndexDigest(cur) !== runIndexDigest(m.nextRunIndex)) {
          throw new ObservationCorruptionError(`records 已在但 RunIndex(${m.runId}) 与 next 不等价`);
        }
      }
      return "already-committed-same";
    }

    if (head !== input.expectedCommittedPrefix) {
      throw new ObservationCorruptionError(`committed prefix CAS 失败：期望 ${input.expectedCommittedPrefix}，实际 ${head}`);
    }
    for (const m of input.runIndexMutations) {
      const cur = this.runIndex.get(m.runId);
      const curDigest = cur === undefined ? null : runIndexDigest(cur);
      if (curDigest !== m.expectedRunIndexDigest) {
        throw new ObservationCorruptionError(`RunIndex(${m.runId}) digest 漂移：期望 ${String(m.expectedRunIndexDigest)}，实际 ${String(curDigest)}`);
      }
    }
    // 校验全过再写：内存实现的「事务」就是先验后改、中间不让出
    for (const r of input.records) {
      this.records.set(r.recordId, r.canonicalEnvelopeBytes);
      this.seqIndex.set(`${r.runtimeId}#${r.seq}`, r.recordId);
    }
    for (const m of input.runIndexMutations) this.runIndex.set(m.runId, m.nextRunIndex);
    this.heads.set(input.runtimeId, input.nextCommittedPrefix);
    this.commits += 1;
    this.batchSizes.push(input.records.length);
    this.batchBytes.push(input.records.reduce((n, r) => n + r.canonicalEnvelopeBytes.byteLength, 0));
    if (mode === "unknown") throw new Error("commit result unknown (injected)");
    return "committed";
  }

  async readRecordBytes(recordId: string): Promise<Uint8Array | null> {
    return this.records.get(recordId) ?? null;
  }

  async readRunIndex(runId: string): Promise<RunIndexEntryV1 | null> {
    return this.runIndex.get(runId) ?? null;
  }

  async readCommittedPrefix(runtimeId: string): Promise<number> {
    return this.heads.get(runtimeId) ?? 0;
  }

  /** 测试助手：按 seq 读回。是否进正式 seam（replay / getRun 的按 seq 读）待拍，见 §15 待拍板。 */
  async readRecordBytesBySeq(runtimeId: string, seq: number): Promise<Uint8Array | null> {
    const id = this.seqIndex.get(`${runtimeId}#${seq}`);
    return id === undefined ? null : (this.records.get(id) ?? null);
  }
}
