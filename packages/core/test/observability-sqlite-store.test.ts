import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/schedule/clock.ts";
import { ObservationCorruptionError, runIndexDigest, InMemoryCanonicalObservationStore, type CommitBatchInput } from "../src/observability/store.ts";
import {
  SqliteCanonicalObservationStore,
  SqliteObservationReader,
  ObservationDatabaseMissingError,
  observationDatabasePath,
  OBSERVATION_DB_RELATIVE_PATH,
  PATH_DIGEST_KEY_BYTES,
} from "../src/observability/sqlite-store.ts";
import { ObservationSequencer } from "../src/observability/sequencer.ts";
import { encodeCanonical } from "../src/observability/normalize.ts";
import type { BoundaryObservationDraft, BoundedObservationDraft, RunAcceptedBodyV1 } from "../src/observability/draft.ts";
import type { RunIndexEntryV1, RunObservationHeader } from "../src/observability/types.ts";

// §15.4.2.2 / §15.4.2.3 的 SQLite store：与 in-memory 参考实现**同一套裁决**，外加 SQLite 才有的三件事——
// PRAGMA 验证、schema/key 建库与 reopen、read-only reader 在活 writer 旁边只见已 COMMIT 快照。

const RT = "rt-sqlite";
const temps: string[] = [];
const opened: { close(): void }[] = [];

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-sqlite-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const s of opened.splice(0)) s.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function openAt(stateRoot: string): Promise<SqliteCanonicalObservationStore> {
  const store = await SqliteCanonicalObservationStore.open({ path: observationDatabasePath(stateRoot) });
  opened.push(store);
  return store;
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
    persistence: "stored",
  };
}

function index(runId: string, seq: number, acceptedAt = 1_000): RunIndexEntryV1 {
  return {
    schemaVersion: 1,
    runtimeId: RT,
    runId,
    acceptedRecordId: `${RT}:${seq}`,
    header: header(runId, acceptedAt),
    firstSeq: seq,
    lastSeq: seq,
    bodyState: "retained",
  };
}

function batch(seqs: readonly number[], over: Partial<CommitBatchInput> = {}, runId?: string): CommitBatchInput {
  return {
    runtimeId: RT,
    expectedCommittedPrefix: (seqs[0] ?? 1) - 1,
    nextCommittedPrefix: seqs[seqs.length - 1] ?? 0,
    records: seqs.map((seq) => ({
      recordId: `${RT}:${seq}`,
      runtimeId: RT,
      seq,
      ...(runId === undefined ? {} : { runId }),
      canonicalEnvelopeBytes: bytesOf({ seq, runId: runId ?? null }),
    })),
    runIndexMutations: [],
    ...over,
  };
}

describe("open / migrate", () => {
  test("首次 open 建库：路径固定、WAL、五张表、schema v1、32 字节 path_digest_key；reopen 不改 key", async () => {
    const root = await tmp();
    const store = await openAt(root);
    expect(store.path).toBe(join(root, OBSERVATION_DB_RELATIVE_PATH));
    expect((await stat(store.path)).isFile()).toBe(true);
    const key1 = store.readPathDigestKey();
    expect(key1.byteLength).toBe(PATH_DIGEST_KEY_BYTES);
    store.close();

    const again = await openAt(root);
    expect(again.readPathDigestKey()).toEqual(key1);
    expect(await again.readCommittedPrefix(RT)).toBe(0);
    expect(await again.readRunIndex("nope")).toBeNull();
  });

  test("reader：文件不存在 → ObservationDatabaseMissingError（不是 corruption，也不建库）", async () => {
    const root = await tmp();
    const err = await SqliteObservationReader.openReadOnly({ path: observationDatabasePath(root) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservationDatabaseMissingError);
    expect(await stat(observationDatabasePath(root)).catch(() => null)).toBeNull();
  });

  test("close 幂等", async () => {
    const store = await openAt(await tmp());
    store.close();
    store.close();
  });
});

describe("commitBatchIfAbsent：与 in-memory 同一套裁决", () => {
  test("一批 records + RunIndex + head 同事务；读回逐字一致；run_id 列按 run 取记录", async () => {
    const store = await openAt(await tmp());
    const idx = index("r1", 1);
    expect(await store.commitBatchIfAbsent(batch([1, 2, 3], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: { ...idx, lastSeq: 3 } }] }, "r1"))).toBe(
      "committed",
    );
    expect(await store.readCommittedPrefix(RT)).toBe(3);
    expect(await store.readRecordBytes(`${RT}:2`)).toEqual(bytesOf({ seq: 2, runId: "r1" }));
    expect(await store.readRecordBytes("nope")).toBeNull();
    const got = await store.readRunIndex("r1");
    expect(got).toEqual({ ...idx, lastSeq: 3 });
    expect(runIndexDigest(got!)).toBe(runIndexDigest({ ...idx, lastSeq: 3 }));
    const recs = await store.readRunRecords(RT, "r1", 1, 3);
    expect(recs.length).toBe(3);
    expect(recs[0]).toEqual(bytesOf({ seq: 1, runId: "r1" }));
    expect(await store.countRecords()).toBe(3);
    expect(await store.countRuns()).toBe(1);
  });

  test("逐字重复提交 → already-committed-same，不重复写", async () => {
    const store = await openAt(await tmp());
    const input = batch([1, 2]);
    expect(await store.commitBatchIfAbsent(input)).toBe("committed");
    expect(await store.commitBatchIfAbsent(input)).toBe("already-committed-same");
    expect(await store.countRecords()).toBe(2);
  });

  test("同 recordId 不同 bytes → corruption；事务回滚，什么都没落", async () => {
    const store = await openAt(await tmp());
    await store.commitBatchIfAbsent(batch([1]));
    const evil = batch([1, 2]);
    (evil.records[0] as { canonicalEnvelopeBytes: Uint8Array }).canonicalEnvelopeBytes = bytesOf({ tampered: true });
    await expect(store.commitBatchIfAbsent({ ...evil, expectedCommittedPrefix: 1 })).rejects.toBeInstanceOf(ObservationCorruptionError);
    expect(await store.readRecordBytes(`${RT}:2`)).toBeNull();
    expect(await store.readCommittedPrefix(RT)).toBe(1);
  });

  test("半批已存在 → corruption", async () => {
    const store = await openAt(await tmp());
    await store.commitBatchIfAbsent(batch([1]));
    await expect(store.commitBatchIfAbsent(batch([1, 2]))).rejects.toThrow(/半批/);
  });

  test("head CAS 失败 → corruption；RunIndex expected digest 不符 → corruption", async () => {
    const store = await openAt(await tmp());
    await store.commitBatchIfAbsent(batch([1]));
    await expect(store.commitBatchIfAbsent(batch([2], { expectedCommittedPrefix: 0 }))).rejects.toThrow(/CAS/);
    const idx = index("r1", 2);
    await expect(
      store.commitBatchIfAbsent(batch([2], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: "not-the-digest", nextRunIndex: idx }] }, "r1")),
    ).rejects.toThrow(/digest 漂移/);
    expect(await store.readCommittedPrefix(RT)).toBe(1);
    expect(await store.readRunIndex("r1")).toBeNull();
  });

  test("重复提交但 head / index 与 next 不等价 → corruption（不是 same）", async () => {
    const store = await openAt(await tmp());
    const idx = index("r1", 1);
    await store.commitBatchIfAbsent(batch([1], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: idx }] }, "r1"));
    await expect(store.commitBatchIfAbsent(batch([1], { nextCommittedPrefix: 5 }, "r1"))).rejects.toThrow(/head=1/);
    await expect(
      store.commitBatchIfAbsent(batch([1], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: { ...idx, lastSeq: 9 } }] }, "r1")),
    ).rejects.toThrow(/不等价/);
  });

  test("RunIndex 引用不存在的 record（deferred FK）→ COMMIT 失败、整批回滚", async () => {
    const store = await openAt(await tmp());
    const dangling = { ...index("r1", 1), acceptedRecordId: "rt-sqlite:404" };
    const err = await store.commitBatchIfAbsent(batch([1], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: dangling }] }, "r1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await store.readCommittedPrefix(RT)).toBe(0);
    expect(await store.readRecordBytes(`${RT}:1`)).toBeNull();
    expect(await store.readRunIndex("r1")).toBeNull();
  });

  test("与 in-memory 参考实现对同一串输入给出同样的结论", async () => {
    const sqlite = await openAt(await tmp());
    const memory = new InMemoryCanonicalObservationStore();
    const idx = index("r1", 1);
    const steps: CommitBatchInput[] = [
      batch([1], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: idx }] }, "r1"),
      batch([1], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: idx }] }, "r1"),
      batch([2, 3], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: runIndexDigest(idx), nextRunIndex: { ...idx, lastSeq: 3 } }] }, "r1"),
      batch([4], { expectedCommittedPrefix: 0 }),
    ];
    for (const s of steps) {
      const a = await sqlite.commitBatchIfAbsent(s).catch((e: unknown) => (e instanceof ObservationCorruptionError ? "corruption" : "other"));
      const b = await memory.commitBatchIfAbsent(s).catch((e: unknown) => (e instanceof ObservationCorruptionError ? "corruption" : "other"));
      expect(a).toBe(b);
    }
    expect(await sqlite.readCommittedPrefix(RT)).toBe(await memory.readCommittedPrefix(RT));
    expect(await sqlite.readRunIndex("r1")).toEqual(await memory.readRunIndex("r1"));
  });
});

describe("reader", () => {
  test("read-only connection 在活 writer 旁边只见已 COMMIT 的；同一 run 的记录按 seq 取回", async () => {
    const root = await tmp();
    const writer = await openAt(root);
    const idx = index("r1", 1);
    await writer.commitBatchIfAbsent(batch([1, 2], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: { ...idx, lastSeq: 2 } }] }, "r1"));

    const reader = await SqliteObservationReader.openReadOnly({ path: observationDatabasePath(root) });
    opened.push(reader);
    expect(await reader.readCommittedPrefix(RT)).toBe(2);
    expect(await reader.readRunIndex("r1")).toEqual({ ...idx, lastSeq: 2 });
    expect((await reader.readRunRecords(RT, "r1", 1, 2)).length).toBe(2);
    expect(await reader.readRuntimeHeads()).toEqual([{ runtimeId: RT, committedPrefix: 2 }]);

    // writer 再写一批，reader 下一次查询看得到（WAL：新快照）
    await writer.commitBatchIfAbsent(batch([3], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: runIndexDigest({ ...idx, lastSeq: 2 }), nextRunIndex: { ...idx, lastSeq: 3 } }] }, "r1"));
    expect(await reader.readCommittedPrefix(RT)).toBe(3);
    expect((await reader.readRunRecords(RT, "r1", 1, 3)).length).toBe(3);
  });

  test("listRunIndex 按 (acceptedAt, runId) 倒序稳定分页", async () => {
    const store = await openAt(await tmp());
    // acceptedAt 相同的两条按 runId 倒序；另一条更早
    const entries = [index("b", 1, 500), index("a", 2, 500), index("c", 3, 100)];
    let prefix = 0;
    for (const e of entries) {
      await store.commitBatchIfAbsent(batch([e.firstSeq], { expectedCommittedPrefix: prefix, nextCommittedPrefix: e.firstSeq, runIndexMutations: [{ runId: e.runId, expectedRunIndexDigest: null, nextRunIndex: e }] }, e.runId));
      prefix = e.firstSeq;
    }
    const page1 = await store.listRunIndex({ limit: 2 });
    expect(page1.map((e) => e.runId)).toEqual(["b", "a"]);
    const last = page1[page1.length - 1]!;
    const page2 = await store.listRunIndex({ limit: 2, after: { acceptedAt: last.header.acceptedAt, runId: last.runId } });
    expect(page2.map((e) => e.runId)).toEqual(["c"]);
    const page3 = await store.listRunIndex({ limit: 2, after: { acceptedAt: 100, runId: "c" } });
    expect(page3).toEqual([]);
  });

  test("RunIndex 行被进程外改过（列与 digest 不符）→ reader 判 corruption，不修复", async () => {
    const root = await tmp();
    const store = await openAt(root);
    await store.commitBatchIfAbsent(batch([1], { runIndexMutations: [{ runId: "r1", expectedRunIndexDigest: null, nextRunIndex: index("r1", 1) }] }, "r1"));
    store.close();
    const { Database } = await import("bun:sqlite");
    const raw = new Database(observationDatabasePath(root));
    raw.run("UPDATE observation_run_index SET last_seq = 99 WHERE run_id = 'r1'");
    raw.close();
    const reopened = await openAt(root);
    await expect(reopened.readRunIndex("r1")).rejects.toBeInstanceOf(ObservationCorruptionError);
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

  test("accepted → bounded ×2 → started → closed：RunIndex 终态在 SQLite，run 的记录能按 run 取回，drain 后无残留", async () => {
    const store = await openAt(await tmp());
    const clock = new FakeClock(1_000);
    const seq = new ObservationSequencer({ runtimeId: RT, runtimeGeneration: "g", capturePolicy: "metadata", store, clock });
    const accepted: RunAcceptedBodyV1 = {
      header: { runId: "r1", source: { kind: "user" }, runtimeId: RT, agentId: "a", agentInstanceId: "a#1", sessionId: null, runtimeGeneration: "g", capturePolicy: "metadata", acceptedAt: 1_000 },
    };
    await seq.appendBoundary(boundary("run.accepted", accepted, "r1"));
    seq.offer(bounded({ n: 1 }, "r1"));
    seq.offer(bounded({ n: 2 }, "r1"));
    await seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, "r1"));
    await seq.appendBoundary(boundary("run.closed", { outcome: { status: "completed" }, finalSnapshot: null }, "r1"));
    seq.offer(bounded({ n: 3 }, "r1")); // 封口后到达：被拒 → 不进 run
    await seq.flushPending();

    const idx = await store.readRunIndex("r1");
    expect(idx?.header.status).toBe("completed");
    expect(idx?.header.persistence).toBe("stored");
    expect(idx?.terminalRecordId).toBe(`${RT}:5`);
    expect([idx?.firstSeq, idx?.lastSeq]).toEqual([1, 5]);
    const recs = await store.readRunRecords(RT, "r1", idx!.firstSeq, idx!.lastSeq);
    expect(recs.length).toBe(5);
    expect(await store.readCommittedPrefix(RT)).toBe(seq.committedSeq);
    expect(seq.persistenceState.status).toBe("healthy");
  });
});
