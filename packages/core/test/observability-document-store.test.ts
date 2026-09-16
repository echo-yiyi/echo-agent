import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/schedule/clock.ts";
import { ObservationCorruptionError, runIndexDigest, InMemoryCanonicalObservationStore, type CommitBatchInput } from "../src/observability/store.ts";
import {
  DocumentObservationExpiry,
  DocumentObservationReader,
  DocumentObservationStore,
  ObservationStoreMissingError,
  PATH_DIGEST_KEY_BYTES,
  compareRunIndex,
  isAfterRunIndex,
} from "../src/observability/document-store.ts";
import { expireObservations } from "../src/observability/expiry.ts";
import { DocumentEchoObservationReader } from "../src/observability/query.ts";
import { ObservationSequencer, type ObservationSubscribeItem } from "../src/observability/sequencer.ts";
import { encodeCanonical } from "../src/observability/normalize.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import type { StorageDir } from "../src/storage/types.ts";
import type { BoundaryObservationDraft, BoundedObservationDraft, RunAcceptedBodyV1 } from "../src/observability/draft.ts";
import type { RunIndexEntryV1, RunObservationHeader } from "../src/observability/types.ts";

// 观测的文档存储（决策：docs/decisions/implemented/2026-09-14-observation-document-store.md，
// 过期改成独立函数见 docs/decisions/implemented/2026-09-14-observation-off-main-loop.md）。
// 与 in-memory 参考实现同一套裁决，外加文档才有的几件：提交点是批文件的 rename、派生文件落后时下一次提交补上、
// 过期只凭盘上事实删（已封口的 run、head 之前的批）、回放跨过被删的批时交付 retention-gap。

const RT = "rt-doc";
const temps: string[] = [];

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-doc-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

function open(dir: StorageDir = new InMemoryDir()): Promise<DocumentObservationStore> {
  return DocumentObservationStore.open({ dir, path: "(test)" });
}

function bytesOf(v: unknown): Uint8Array {
  return encodeCanonical(v).bytes;
}

function header(runId: string, acceptedAt = 1_000): RunObservationHeader {
  return {
    schemaVersion: 1,
    runId,
    source: { kind: "user" },
    runtimeId: RT,
    agentId: "a",
    agentInstanceId: "a#1",
    sessionId: null,
    runtimeGeneration: "g",
    capturePolicy: "metadata",
    acceptedAt,
    startedAt: null,
    endedAt: null,
    status: "running",
    integrity: "complete",
  };
}

function index(runId: string, seq: number, acceptedAt = 1_000): RunIndexEntryV1 {
  return { schemaVersion: 1, runtimeId: RT, runId, acceptedRecordId: `${RT}:${seq}`, header: header(runId, acceptedAt), firstSeq: seq, lastSeq: seq };
}

/** `seqs` 连续；每条记录可以各属一个 run（`runs[i]`），不给就是 run 之外的记录。 */
function batch(seqs: readonly number[], over: Partial<CommitBatchInput> = {}, runs?: string | readonly (string | undefined)[], body?: (seq: number) => unknown): CommitBatchInput {
  const runOf = (i: number): string | undefined => (typeof runs === "string" ? runs : runs?.[i]);
  return {
    runtimeId: RT,
    expectedCommittedPrefix: (seqs[0] ?? 1) - 1,
    nextCommittedPrefix: seqs[seqs.length - 1] ?? 0,
    records: seqs.map((seq, i) => ({
      recordId: `${RT}:${seq}`,
      runtimeId: RT,
      seq,
      ...(runOf(i) === undefined ? {} : { runId: runOf(i)! }),
      canonicalEnvelopeBytes: bytesOf(body === undefined ? { seq, runId: runOf(i) ?? null } : body(seq)),
    })),
    runIndexMutations: [],
    ...over,
  };
}

/** 包一层：按路径前缀让写失败，模拟停在提交的某一步。`healed.value = true` 之后恢复。 */
function failingWrites(inner: StorageDir, prefix: string, healed = { value: false }): StorageDir {
  return {
    read: (p) => inner.read(p),
    write: (p, c) => (!healed.value && p.startsWith(prefix) ? Promise.reject(new Error(`disk gone: ${p}`)) : inner.write(p, c)),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    ...(inner.lock === undefined ? {} : { lock: (n: string, o?: { timeoutMs?: number }) => inner.lock!(n, o) }),
  };
}

describe("open 与 key", () => {
  test("首建 key.json：32 字节，重开不改写；读面打开时状态根没有观测文档 → ObservationStoreMissingError", async () => {
    const root = await tmp();
    const store = await open(new FileDir(root));
    const key = store.readPathDigestKey();
    expect(key.byteLength).toBe(PATH_DIGEST_KEY_BYTES);
    const again = await open(new FileDir(root));
    expect(again.readPathDigestKey()).toEqual(key);
    expect(await again.readCommittedPrefix(RT)).toBe(0);
    expect(await again.readRunIndex("nope")).toBeNull();

    const err = await DocumentEchoObservationReader.open({ stateRoot: await tmp() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservationStoreMissingError);
  });
});

describe("commitBatchIfAbsent：与 in-memory 同一套裁决", () => {
  test("一批 records + RunIndex + head；读回逐字一致；按 run 取记录", async () => {
    const store = await open();
    const idx = { ...index("r1", 1), lastSeq: 3 };
    expect(await store.commitBatchIfAbsent(batch([1, 2, 3], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: idx }] }, "r1"))).toBe("committed");
    expect(await store.readCommittedPrefix(RT)).toBe(3);
    expect(await store.readRecordBytes(`${RT}:2`)).toEqual(bytesOf({ seq: 2, runId: "r1" }));
    expect(await store.readRecordBytes("nope")).toBeNull();
    expect(await store.readRunIndex("r1")).toEqual(idx);
    const recs = await store.readRunRecords(RT, "r1", 1, 3);
    expect(recs).toEqual([1, 2, 3].map((seq) => bytesOf({ seq, runId: "r1" })));
    expect(await store.countRecords()).toBe(3);
    expect(await store.countRuns()).toBe(1);
  });

  test("逐字重复提交 → already-committed-same；同一个批文件内容不同 → corruption", async () => {
    const store = await open();
    const input = batch([1, 2]);
    expect(await store.commitBatchIfAbsent(input)).toBe("committed");
    expect(await store.commitBatchIfAbsent(input)).toBe("already-committed-same");
    expect(await store.countRecords()).toBe(2);
    const evil = batch([1, 2]);
    (evil.records[0] as { canonicalEnvelopeBytes: Uint8Array }).canonicalEnvelopeBytes = bytesOf({ tampered: true });
    await expect(store.commitBatchIfAbsent(evil)).rejects.toBeInstanceOf(ObservationCorruptionError);
    expect(await store.readRecordBytes(`${RT}:1`)).toEqual(bytesOf({ seq: 1, runId: null }));
  });

  test("head CAS 失败、半批重叠、RunIndex digest 不符、RunIndex 引用不存在的记录 → corruption，什么都没落", async () => {
    const store = await open();
    await store.commitBatchIfAbsent(batch([1]));
    await expect(store.commitBatchIfAbsent(batch([2], { expectedCommittedPrefix: 0 }))).rejects.toBeInstanceOf(ObservationCorruptionError);
    await expect(store.commitBatchIfAbsent(batch([1, 2]))).rejects.toBeInstanceOf(ObservationCorruptionError);
    await expect(
      store.commitBatchIfAbsent(batch([2], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: "not-the-digest", nextRunIndex: index("r1", 2) }] }, "r1")),
    ).rejects.toBeInstanceOf(ObservationCorruptionError);
    const dangling = { ...index("r1", 2), acceptedRecordId: `${RT}:404` };
    await expect(store.commitBatchIfAbsent(batch([2], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: dangling }] }, "r1"))).rejects.toBeInstanceOf(
      ObservationCorruptionError,
    );
    expect(await store.readCommittedPrefix(RT)).toBe(1);
    expect(await store.readRunIndex("r1")).toBeNull();
    expect(await store.readRecordBytes(`${RT}:2`)).toBeNull();
  });

  test("与 in-memory 参考实现对同一串输入给出同样的结论", async () => {
    const doc = await open();
    const memory = new InMemoryCanonicalObservationStore();
    const idx = index("r1", 1);
    const steps: CommitBatchInput[] = [
      batch([1], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: idx }] }, "r1"),
      batch([1], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: idx }] }, "r1"),
      batch([2, 3], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: runIndexDigest(idx), nextRunIndex: { ...idx, lastSeq: 3 } }] }, "r1"),
      batch([4], { expectedCommittedPrefix: 0 }),
    ];
    for (const s of steps) {
      const a = await doc.commitBatchIfAbsent(s).catch((e: unknown) => (e instanceof ObservationCorruptionError ? "corruption" : "other"));
      const b = await memory.commitBatchIfAbsent(s).catch((e: unknown) => (e instanceof ObservationCorruptionError ? "corruption" : "other"));
      expect(a).toBe(b);
    }
    expect(await doc.readCommittedPrefix(RT)).toBe(await memory.readCommittedPrefix(RT));
    expect(await doc.readRunIndex("r1")).toEqual(await memory.readRunIndex("r1"));
  });
});

describe("提交点", () => {
  test("批文件写不成（rename 之前）：抛、不是 corruption；读面看不到这一批，head 没动", async () => {
    const inner = new InMemoryDir();
    const store = await open(failingWrites(inner, "observability/batches/"));
    const err = await store.commitBatchIfAbsent(batch([1, 2], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: index("r1", 1) }] }, "r1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ObservationCorruptionError);
    const reader = new DocumentObservationReader(inner, "(test)");
    expect(await reader.readCommittedPrefix(RT)).toBe(0);
    expect(await reader.readRecordBytes(`${RT}:1`)).toBeNull();
    expect(await reader.readRunIndex("r1")).toBeNull();
  });

  test("批文件写成、派生文件写不成：这批照样 committed，head 不越过它；下一次提交把落后的派生文件补上", async () => {
    const inner = new InMemoryDir();
    const healed = { value: false };
    const store = await open(failingWrites(inner, "observability/runs/", healed));
    const idx = { ...index("r1", 1), lastSeq: 2 };
    expect(await store.commitBatchIfAbsent(batch([1, 2], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: idx }] }, "r1"))).toBe("committed");
    const reader = new DocumentObservationReader(inner, "(test)");
    expect(await reader.readCommittedPrefix(RT)).toBe(2); // 批文件在：已提交
    expect(await reader.readRunIndex("r1")).toBeNull(); // 派生文件落后
    expect(await inner.read("observability/heads/rt-doc.json")).toBeNull(); // runs/ 没写成，head 不往前走（过期靠这条顺序）

    healed.value = true;
    await store.commitBatchIfAbsent(batch([3], { expectedCommittedPrefix: 2 }));
    expect(await reader.readRunIndex("r1")).toEqual(idx);
    expect((await reader.readRunRecords(RT, "r1", 1, 2)).length).toBe(2);
  });
});

describe("读面", () => {
  /** 每条 run 一个批：seq 就是它的 firstSeq。 */
  async function writeRuns(store: DocumentObservationStore, entries: readonly RunIndexEntryV1[]): Promise<void> {
    for (const e of entries) {
      await store.commitBatchIfAbsent(
        batch([e.firstSeq], { expectedCommittedPrefix: e.firstSeq - 1, nextCommittedPrefix: e.firstSeq, runIndexMutations: [{ runId: e.runId, expectedRunIndexDigest: null, nextRunIndex: e }] }, e.runId),
      );
    }
  }

  test("listRunIndex 按 (acceptedAt ↓, runtimeId, firstSeq ↓) 稳定分页；正在写的临时文件不算", async () => {
    const root = await tmp();
    const store = await open(new FileDir(root));
    await writeRuns(store, [index("b", 1, 500), index("a", 2, 500), index("c", 3, 100)]);
    await Bun.write(join(root, "observability", "runs", "x.json.123.a.b.tmp"), "half");
    const reader = (await DocumentEchoObservationReader.open({ stateRoot: root })) as unknown as { store: DocumentObservationReader };
    const page1 = await reader.store.listRunIndex({ limit: 2 });
    expect(page1.map((e) => e.runId)).toEqual(["a", "b"]); // 同毫秒：后接受的（firstSeq 2）在前，与 runId 字典序无关
    const last = page1[page1.length - 1]!;
    expect((await reader.store.listRunIndex({ limit: 2, after: { acceptedAt: last.header.acceptedAt, runtimeId: last.runtimeId, firstSeq: last.firstSeq } })).map((e) => e.runId)).toEqual(["c"]);
    expect(await reader.store.readRuntimeHeads()).toEqual([{ runtimeId: RT, committedPrefix: 3 }]);
  });

  test("同一毫秒里的先后按接受顺序，不看随机 runId：逐页翻不重不漏（2026-09-15）", async () => {
    // 修复前：第二键是 `runId` 倒序，而 runId 是随机 UUID——同毫秒的先后是抛硬币
    // （observability-runtime 的「两次 send…listRuns 倒序」实测约 1/4 红）。这里 runId 的字典序与接受顺序**相反**：
    // 按 runId 倒序会得到 c,b,a，按接受顺序（firstSeq ↓）应当是 a,b,c。
    const root = await tmp();
    const store = await open(new FileDir(root));
    await writeRuns(store, [index("c", 1, 1_000), index("b", 2, 1_000), index("a", 3, 1_000)]);
    const reader = (await DocumentEchoObservationReader.open({ stateRoot: root })) as unknown as { store: DocumentObservationReader };
    expect((await reader.store.listRunIndex({ limit: 10 })).map((e) => e.runId)).toEqual(["a", "b", "c"]);

    const seen: string[] = [];
    let after: { acceptedAt: number; runtimeId: string; firstSeq: number } | undefined;
    for (;;) {
      const page = await reader.store.listRunIndex({ limit: 1, ...(after === undefined ? {} : { after }) });
      const e = page[0];
      if (e === undefined) break;
      seen.push(e.runId);
      after = { acceptedAt: e.header.acceptedAt, runtimeId: e.runtimeId, firstSeq: e.firstSeq };
    }
    expect(seen).toEqual(["a", "b", "c"]); // 一条不少、一条不重
  });

  test("跨 runtime 同毫秒：顺序任意但固定，且排序与游标是同一把尺（全序，分页不会成环）", async () => {
    // 跨 runtime 的 seq 各数各的、没有可比的先后，只要求**稳定**：同一组输入两次排序结果相同，
    // 且「排在 x 之后」与比较器一致——否则分页会重会漏。
    const mk = (runtimeId: string, runId: string, firstSeq: number, acceptedAt: number): RunIndexEntryV1 => ({
      ...index(runId, firstSeq, acceptedAt),
      runtimeId,
    });
    const all = [mk("rt-b", "x", 1, 1_000), mk("rt-a", "y", 5, 1_000), mk("rt-a", "z", 9, 1_000), mk("rt-b", "w", 2, 900)];
    const sorted = [...all].sort(compareRunIndex).map((e) => e.runId);
    expect([...all].reverse().sort(compareRunIndex).map((e) => e.runId)).toEqual(sorted); // 与输入顺序无关
    expect(sorted[sorted.length - 1]).toBe("w"); // 旧的那条永远在最后

    for (let i = 0; i < all.length; i++) {
      const cursor = [...all].sort(compareRunIndex)[i]!;
      const key = { acceptedAt: cursor.header.acceptedAt, runtimeId: cursor.runtimeId, firstSeq: cursor.firstSeq };
      const after = [...all].sort(compareRunIndex).filter((e) => isAfterRunIndex(e, key)).map((e) => e.runId);
      expect(after).toEqual(sorted.slice(i + 1)); // 「在它之后」恰好是排序里它后面那一段
    }
  });
});

describe("过期：只凭盘上的事实删", () => {
  const MUT = (e: RunIndexEntryV1, prev?: RunIndexEntryV1) => ({ runId: e.runId, expectedRunIndexDigest: prev === undefined ? null : runIndexDigest(prev), nextRunIndex: e });

  /** 三批：A 只有 r1；B 混着 r1（在这里封口）与 r2；C 只有 r2（在这里封口）。 */
  async function threeBatches(store: DocumentObservationStore, closeR2 = true): Promise<void> {
    const r1 = index("r1", 1);
    const r2 = index("r2", 4, 2_000);
    await store.commitBatchIfAbsent(batch([1, 2], { runIndexMutations: [MUT({ ...r1, lastSeq: 2 })] }, "r1"));
    await store.commitBatchIfAbsent(batch([3, 4], { runIndexMutations: [MUT({ ...r1, lastSeq: 3, terminalRecordId: `${RT}:3` }, { ...r1, lastSeq: 2 }), MUT(r2)] }, ["r1", "r2"]));
    await store.commitBatchIfAbsent(batch([5], { runIndexMutations: [MUT({ ...r2, lastSeq: 5, ...(closeR2 ? { terminalRecordId: `${RT}:5` } : {}) }, r2)] }, "r2"));
  }

  test("删一个已封口的 run：getRun 不再有、只含它的批文件回收、与别的 run 共用的留着；再删另一个，剩下的一起回收", async () => {
    const inner = new InMemoryDir();
    const store = await open(inner);
    await threeBatches(store);
    const expiry = new DocumentObservationExpiry(inner, "(test)");
    const batches = async () => (await inner.list("observability/batches/")).filter((p) => p.endsWith(".json")).map((p) => p.split("/").pop());

    expect(await expiry.remove({ runs: ["r1"] })).toEqual({ removedRuns: ["r1"], openRuns: [], removedBatches: 1 });
    expect(await store.readRunIndex("r1")).toBeNull();
    expect(await batches()).toEqual(["000000000004.json", "000000000005.json"]);
    expect((await store.readRunRecords(RT, "r2", 4, 5)).length).toBe(2);

    expect(await expiry.remove({ runs: ["r2"] })).toEqual({ removedRuns: ["r2"], openRuns: [], removedBatches: 2 });
    expect(await batches()).toEqual([]);
    expect(await store.readCommittedPrefix(RT)).toBe(5); // head 不回退
  });

  test("盘上还没封口的 run 不删（列进 openRuns）；不给 run 也不给 activityBefore 时什么都不动", async () => {
    const inner = new InMemoryDir();
    const store = await open(inner);
    await threeBatches(store, false);
    const expiry = new DocumentObservationExpiry(inner, "(test)");
    expect(await expiry.remove({ runs: ["r2", "nope"] })).toEqual({ removedRuns: [], openRuns: ["r2"], removedBatches: 0 });
    expect(await store.readRunIndex("r2")).not.toBeNull();
    expect(await expiry.remove({})).toEqual({ removedRuns: [], openRuns: [], removedBatches: 0 });
    expect(await store.countRecords()).toBe(5);
  });

  test("run 之外的记录：早于 activityBefore 的批回收，晚于的留着；不给 activityBefore 一条不删", async () => {
    const inner = new InMemoryDir();
    const store = await open(inner);
    await store.commitBatchIfAbsent(batch([1], {}, undefined, () => ({ observedAt: 500 })));
    await store.commitBatchIfAbsent(batch([2], {}, undefined, () => ({ observedAt: 2_000 })));
    const expiry = new DocumentObservationExpiry(inner, "(test)");
    expect((await expiry.remove({ runs: [] })).removedBatches).toBe(0);
    expect((await expiry.remove({ activityBefore: 1_000 })).removedBatches).toBe(1);
    expect((await store.readActivity(10)).length).toBe(1);
  });

  test("head 之后的批（它那一批的 runs/ 还没写成）不回收，哪怕里面的记录都够老", async () => {
    const inner = new InMemoryDir();
    const store = await open(failingWrites(inner, "observability/runs/"));
    const idx = { ...index("r1", 1), terminalRecordId: `${RT}:1` };
    await store.commitBatchIfAbsent(batch([1], { runIndexMutations: [MUT(idx)] }, "r1"));
    await store.commitBatchIfAbsent(batch([2], { expectedCommittedPrefix: 1 }, undefined, () => ({ observedAt: 1 })));
    const expiry = new DocumentObservationExpiry(inner, "(test)");
    // runs/r1.json 从没写成：盘上看 r1 不在，但 head 没越过这两批——写者可能正要写，不能动
    expect(await expiry.remove({ activityBefore: 10_000 })).toEqual({ removedRuns: [], openRuns: [], removedBatches: 0 });
    expect(await store.countRecords()).toBe(2);
  });

  test("回放页如实带出被删的 seq 区间（exclusive）：批与批接不上的那一段", async () => {
    const inner = new InMemoryDir();
    const store = await open(inner);
    await threeBatches(store);
    await new DocumentObservationExpiry(inner, "(test)").remove({ runs: ["r1"] }); // 回收的是 seq 1..2 那一批
    const page = await store.readRecordsAfter(RT, 0, 10);
    expect(page.removed).toEqual([{ afterSeq: 0, beforeSeq: 3 }]);
    expect(page.records.length).toBe(3);
  });

  test("expireObservations：规则拿到全部 run 的 header（新的在前）与 now，按它的决定删；状态根目录与注入存储两种给法", async () => {
    const inner = new InMemoryDir();
    await threeBatches(await open(inner));
    const seen: { runs: string[]; now: number }[] = [];
    const result = await expireObservations({
      store: inner,
      now: 7,
      rule: (runs, now) => {
        seen.push({ runs: runs.map((h) => h.runId), now });
        return { runs: runs.slice(1).map((h) => h.runId) }; // 留最新的一个
      },
    });
    expect(seen).toEqual([{ runs: ["r2", "r1"], now: 7 }]);
    expect(result).toEqual({ removedRuns: ["r1"], openRuns: [], removedBatches: 1 });

    const root = await tmp();
    await threeBatches(await open(new FileDir(root)));
    expect((await expireObservations({ stateRoot: root, rule: () => ({ runs: ["r1", "r2"] }) })).removedBatches).toBe(3);
    // 没有观测目录的状态根：规则拿到空表，什么都不删
    expect(await expireObservations({ stateRoot: await tmp(), rule: (runs) => ({ runs: runs.map((h) => h.runId) }) })).toEqual({ removedRuns: [], openRuns: [], removedBatches: 0 });
  });
});

describe("Sequencer 之下", () => {
  function boundary(name: string, body: unknown, runId?: string): BoundaryObservationDraft {
    return {
      lane: "boundary",
      occurredAt: 1_000,
      kind: "event",
      name,
      scope: runId === undefined ? { runtimeId: RT } : { runtimeId: RT, runId },
      correlation: {},
      generation: { runtime: "g" },
      owner: { status: "not-applicable" },
      instrumentation: { name: "test", version: "1" },
      attributes: {},
      body,
    } as BoundaryObservationDraft;
  }
  function bounded(body: unknown, runId: string): BoundedObservationDraft {
    return { ...boundary("test.event", body, runId), lane: "bounded" } as BoundedObservationDraft;
  }
  const accepted = (runId: string): RunAcceptedBodyV1 => ({
    header: { runId, source: { kind: "user" }, runtimeId: RT, agentId: "a", agentInstanceId: "a#1", sessionId: null, runtimeGeneration: "g", capturePolicy: "metadata", acceptedAt: 1_000 },
  });

  async function oneRun(seq: ObservationSequencer, runId: string): Promise<void> {
    await seq.appendBoundary(boundary("run.accepted", accepted(runId), runId));
    seq.offer(bounded({ n: 1 }, runId));
    await seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, runId));
    await seq.appendBoundary(boundary("run.closed", { outcome: { status: "completed" }, finalSnapshot: null }, runId));
    await seq.flushPending();
  }

  test("accepted → bounded → started → closed：RunIndex 终态在文档里，run 的记录能按 run 取回", async () => {
    const store = await open();
    const seq = new ObservationSequencer({ runtimeId: RT, runtimeGeneration: "g", capturePolicy: "metadata", store, clock: new FakeClock(1_000) });
    await seq.appendBoundary(boundary("run.accepted", accepted("r1"), "r1"));
    seq.offer(bounded({ n: 1 }, "r1"));
    seq.offer(bounded({ n: 2 }, "r1"));
    await seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, "r1"));
    await seq.appendBoundary(boundary("run.closed", { outcome: { status: "completed" }, finalSnapshot: null }, "r1"));
    await seq.flushPending();

    const idx = await store.readRunIndex("r1");
    expect(idx?.header.status).toBe("completed");
    expect(idx?.terminalRecordId).toBe(`${RT}:5`);
    expect((await store.readRunRecords(RT, "r1", idx!.firstSeq, idx!.lastSeq)).length).toBe(5);
    expect(await store.readCommittedPrefix(RT)).toBe(seq.committedSeq);
    expect(seq.persistenceState.status).toBe("healthy");
  });

  test("订阅回放早于内存窗口、跨过被过期删掉的 run：交付 retention-gap，之后的记录照常到", async () => {
    const inner = new InMemoryDir();
    const store = await open(inner);
    const seq = new ObservationSequencer({ runtimeId: RT, runtimeGeneration: "g", capturePolicy: "metadata", store, clock: new FakeClock(1_000), limits: { replayWindowRecords: 1 } });
    await oneRun(seq, "r1"); // seq 1..4
    await oneRun(seq, "r2"); // seq 5..8
    await new DocumentObservationExpiry(inner, "(test)").remove({ runs: ["r1"] });

    const items: ObservationSubscribeItem[] = [];
    await seq.subscribe({ afterSeq: 0, sinkId: "late", listener: (i) => void items.push(i) });
    for (let i = 0; i < 50 && items.length < 5; i++) await new Promise((r) => setTimeout(r, 5));
    const first = items[0];
    expect(first !== undefined && "kind" in first && first.kind === "retention-gap" ? first.gap : null).toEqual({ afterSeq: 0, beforeSeq: 5, dropped: 4, reason: "retention" });
    const seqs = items.flatMap((i) => ("recordId" in i ? [i.seq] : []));
    expect(seqs).toEqual([5, 6, 7, 8]);
  });
});
