import { test, expect, describe } from "bun:test";
import { FakeClock } from "../src/schedule/clock.ts";
import { InMemoryCanonicalObservationStore, ObservationCorruptionError, ObservationStoreUnavailableError, runIndexDigest } from "../src/observability/store.ts";
import {
  ObservationSequencer,
  DEFAULT_SEQUENCER_LIMITS,
  MAX_CLOSED_SINK_TOMBSTONES,
  MAX_SINK_GAPS,
  type ObservationSequencerOptions,
  type ObservationSubscribeItem,
  type ObservationSubscribeListener,
} from "../src/observability/sequencer.ts";
import { ObservationEncodingError } from "../src/observability/normalize.ts";
import { factSinkToIngest } from "../src/observability/fact-sink.ts";
import { ObservationIdentityError } from "../src/observability/identity.ts";
import { OBSERVATION_IDENTITY_LIMITS } from "../src/observability/types.ts";
import type { BoundaryObservationDraft, BoundedObservationDraft, RunAcceptedBodyV1 } from "../src/observability/draft.ts";
import type { Diagnostic } from "../src/errors.ts";
import type {
  CapabilityObservationSummary,
  EchoObservableState,
  ObservationEnvelope,
  ObservationGap,
  ObservationSnapshot,
  RunClosedBodyInput,
  RunClosedBodyV1,
  RunIndexEntryV1,
  SinkDeliveryGap,
} from "../src/observability/types.ts";

// Sequencer 契约。全部用 FakeClock + in-memory 参考 store：零 sleep、零真盘。

const RT = "rt-test";

type Harness = {
  clock: FakeClock;
  store: InMemoryCanonicalObservationStore;
  seq: ObservationSequencer;
  diags: Diagnostic[];
  flush: () => Promise<void>;
};

function harness(limits: Partial<ObservationSequencerOptions["limits"]> = {}): Harness {
  const clock = new FakeClock(1_000);
  const store = new InMemoryCanonicalObservationStore();
  const diags: Diagnostic[] = [];
  const seq = new ObservationSequencer({
    runtimeId: RT,
    runtimeGeneration: "gen-1",
    capturePolicy: "metadata",
    store,
    clock,
    limits,
    report: (d) => diags.push(d),
  });
  const delay = limits?.maxBatchDelayMs ?? DEFAULT_SEQUENCER_LIMITS.maxBatchDelayMs;
  return {
    clock,
    store,
    seq,
    diags,
    flush: async () => {
      clock.advance(delay);
      await seq.idle();
    },
  };
}

test("markLeaseLost()：进 lost-lease 终态——不 flush、之后 offer 丢弃、flushPending 直接返回、幂等（review 2026-09-07）", async () => {
  // 下游对 lost-lease 的判断早就写好了，此前只是没有入口：丢锁后 stop() 照样 flush 进已经归别人的状态根
  const h = harness();
  h.seq.offer(bounded({ a: 1 }));
  await h.flush();
  const committed = h.store.commitCount;
  h.seq.offer(bounded({ a: 2 })); // ring 里有没写完的
  h.seq.markLeaseLost(new Error("租约过期"));
  expect(h.seq.persistenceState.status).toBe("lost-lease");
  await h.seq.flushPending(); // 状态根已经不归本进程：不 flush
  h.seq.offer(bounded({ a: 3 })); // 之后的 offer 丢弃
  await h.flush();
  expect(h.store.commitCount).toBe(committed);
  h.seq.markLeaseLost(new Error("再来一次")); // 幂等
  expect(h.seq.persistenceState.status).toBe("lost-lease");
  expect(h.diags.filter((d) => d.code === "observation_writer_lost_lease")).toHaveLength(1);
});

/** 等异步回放（store 读是 Promise，不走 FakeClock）交付到位；最多等 `ticks` 个宏任务。 */
async function settle(done: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks && !done(); i++) await new Promise((r) => setTimeout(r, 0));
}

function bounded(body: unknown, over: Partial<BoundedObservationDraft> = {}): BoundedObservationDraft {
  return {
    lane: "bounded",
    occurredAt: 1_000,
    kind: "event",
    name: "test.event",
    scope: { runtimeId: RT },
    correlation: {},
    generation: { runtime: "gen-1" },
    owner: { status: "not-applicable" },
    instrumentation: { name: "test", version: "1" },
    attributes: {},
    body,
    ...over,
  } as BoundedObservationDraft;
}

function boundary(name: string, body: unknown, runId?: string, over: Partial<BoundaryObservationDraft> = {}): BoundaryObservationDraft {
  return {
    lane: "boundary",
    occurredAt: 1_000,
    kind: "event",
    name,
    scope: runId === undefined ? { runtimeId: RT } : { runtimeId: RT, runId },
    correlation: {},
    generation: { runtime: "gen-1" },
    owner: { status: "not-applicable" },
    instrumentation: { name: "test", version: "1" },
    attributes: {},
    body,
    ...over,
  } as BoundaryObservationDraft;
}

function acceptedBody(runId: string): RunAcceptedBodyV1 {
  return {
    header: {
      runId,
      source: { kind: "user" },
      runtimeId: RT,
      agentId: "agent-default",
      agentInstanceId: "agent-default#1",
      sessionId: "main",
      runtimeGeneration: "gen-1",
      capturePolicy: "metadata",
      acceptedAt: 1_000,
    },
  };
}

function closedBody(status: "completed" | "aborted" | "error" = "completed"): RunClosedBodyInput {
  return { outcome: { status }, finalSnapshot: null };
}

async function acceptRun(h: Harness, runId: string): Promise<ObservationEnvelope> {
  return h.seq.appendBoundary(boundary("run.accepted", acceptedBody(runId), runId));
}

describe("bounded lane：seq / identity / batch", () => {
  test("offer 三条 → 一个事务、seq 1..3、recordId = runtimeId:seq、observedAt 由 Sequencer 盖", async () => {
    const h = harness();
    h.seq.offer(bounded({ n: 1 }, { sourceSeq: 7 }));
    h.seq.offer(bounded({ n: 2 }));
    h.seq.offer(bounded({ n: 3 }));
    expect(h.seq.committedSeq).toBe(0); // 还没 flush：什么都没 committed
    await h.flush();
    expect(h.seq.committedSeq).toBe(3);
    expect(h.store.commitCount).toBe(1);
    const recs = h.seq.committedRecords();
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(recs[0]?.recordId).toBe(`${RT}:1`);
    expect(recs[0]?.observedAt).toBe(1_000);
    expect(recs[0]?.sourceSeq).toBe(7);
    expect(recs[0]?.generation.runtime).toBe("gen-1");
    expect(await h.store.readCommittedPrefix(RT)).toBe(3);
  });

  test("按 maxBatchRecords 分批，不是一条 record 一个事务", async () => {
    const h = harness({ maxBatchRecords: 2 });
    for (let i = 0; i < 5; i++) h.seq.offer(bounded({ i }));
    await h.flush();
    await h.flush();
    await h.flush();
    expect(h.seq.committedSeq).toBe(5);
    expect(h.store.commitCount).toBeGreaterThanOrEqual(3);
    expect(h.store.commitCount).toBeLessThan(5);
  });

  test("offer 在 flush 前不可见；flush 之前 store 里没有任何 record", async () => {
    const h = harness();
    h.seq.offer(bounded({ x: 1 }));
    expect(await h.store.readRecordBytesBySeq(RT, 1)).toBeNull();
    await h.flush();
    expect(await h.store.readRecordBytesBySeq(RT, 1)).not.toBeNull();
  });
});

describe("boundary lane：drain barrier", () => {
  test("appendBoundary 把 <B 的 bounded 尾巴与 B 同一事务提交，resolve 时 prefix >= B", async () => {
    const h = harness();
    h.seq.offer(bounded({ a: 1 }));
    h.seq.offer(bounded({ a: 2 }));
    const env = await h.seq.appendBoundary(boundary("checkpoint", { ok: true }));
    expect(env.seq).toBe(3);
    expect(env.lane).toBe("boundary");
    expect(h.seq.committedSeq).toBe(3);
    expect(h.store.commitCount).toBe(1);
  });

  test("boundary 之后 offer 的 record 排队，不抢在 barrier 前面被订阅者看见", async () => {
    const h = harness();
    const seen: number[] = [];
    h.seq.subscribe({ afterSeq: 0, listener: (i) => "recordId" in i && seen.push(i.seq) });
    h.seq.offer(bounded({ a: 1 }));
    const p = h.seq.appendBoundary(boundary("checkpoint", { ok: true }));
    h.seq.offer(bounded({ a: 3 }));
    await p;
    await h.flush();
    await Promise.resolve();
    expect(seen).toEqual([1, 2, 3]);
  });

  test("boundary 超过 deadline 未 durable → reject canonical_flush_timeout，persistence degraded", async () => {
    const h = harness({ boundaryDeadlineMs: 500 });
    h.store.failpoint = () => "hang";
    const p = h.seq.appendBoundary(boundary("checkpoint", { ok: true }));
    h.clock.advance(500);
    await expect(p).rejects.toBeInstanceOf(ObservationStoreUnavailableError);
    expect(h.seq.persistenceState.status).toBe("degraded");
    expect(h.diags.some((d) => d.code === "observation_flush_timeout")).toBe(true);
  });
});

describe("hole 与 CanonicalObservationGap", () => {
  test("offer 编码失败：seq S 成 hole，S+1 是 gap，exclusive 区间精确覆盖，prefix 越过", async () => {
    const h = harness();
    h.seq.offer(bounded({ bad: NaN }));
    expect(h.seq.reservedSeq).toBe(2); // S=1 hole，gap 在 2，下一个 producer 拿到 3
    h.seq.offer(bounded({ ok: 1 }));
    await h.flush();
    const recs = h.seq.committedRecords();
    expect(recs.map((r) => r.seq)).toEqual([2, 3]);
    const gap = recs[0]!;
    expect(gap.name).toBe("observation.gap");
    expect(gap.kind).toBe("health");
    expect(gap.lane).toBe("boundary");
    const body = gap.body as ObservationGap;
    expect(body).toEqual({ afterSeq: 0, beforeSeq: 2, dropped: 1, reason: "encoding_error" });
    expect(body.dropped).toBe(body.beforeSeq - body.afterSeq - 1);
    expect(h.seq.committedSeq).toBe(3);
    expect(h.seq.health().capture.canonicalGapCount).toBe(1);
  });

  test("ring 满：第 N+1 条 offer 成 buffer_overflow hole + gap，offer 本身不抛", async () => {
    const h = harness({ ringCapacity: 2 });
    h.seq.offer(bounded({ i: 1 }));
    h.seq.offer(bounded({ i: 2 }));
    expect(() => h.seq.offer(bounded({ i: 3 }))).not.toThrow();
    await h.flush();
    const reasons = h.seq.committedRecords().filter((r) => r.name === "observation.gap").map((r) => (r.body as ObservationGap).reason);
    expect(reasons).toEqual(["buffer_overflow"]);
    expect(h.seq.committedSeq).toBe(4);
  });

  test("run-scoped gap 把 RunIndex integrity 置 partial，且同事务", async () => {
    const h = harness();
    const run = "run-1";
    await acceptRun(h, run);
    expect(h.seq.committedRunIndex(run)?.header.integrity).toBe("complete");
    h.seq.offer(bounded({ bad: Symbol("x") }, { scope: { runtimeId: RT, runId: run } }));
    await h.flush();
    const idx = h.seq.committedRunIndex(run)!;
    expect(idx.header.integrity).toBe("partial");
    expect(idx.lastSeq).toBe(3);
    expect((await h.store.readRunIndex(run))?.header.integrity).toBe("partial");
  });

  test("reserveOptionalProjectionGap：省略 slot 取真实 seq S，gap 在 S+1，subject 明确", async () => {
    const h = harness();
    const run = "run-2";
    await acceptRun(h, run);
    const { omittedSeq, gapSeq } = h.seq.reserveOptionalProjectionGap({ runId: run, subjectId: "run.final_snapshot", reason: "capture_limit" });
    expect(gapSeq).toBe(omittedSeq + 1);
    const closed = await h.seq.appendBoundary(boundary("run.closed", closedBody(), run));
    expect(closed.seq).toBe(gapSeq + 1);
    const gap = h.seq.committedRecords().find((r) => r.seq === gapSeq)!;
    expect(gap.subject).toEqual({ kind: "capture", id: "run.final_snapshot" });
    expect((gap.body as ObservationGap).reason).toBe("capture_limit");
    const idx = h.seq.committedRunIndex(run)!;
    expect(idx.header.integrity).toBe("partial");
    expect(idx.header.status).toBe("completed");
    expect(h.seq.persistenceState.status).toBe("healthy"); // 可选 snapshot 超限不进 degradation
  });
});

describe("run 边界：唯一 emission 与 RunIndex 物化", () => {
  test("accepted → running index；started → startedAt；bounded record → lastSeq；closed → 终态 + endedAt", async () => {
    const h = harness();
    const run = "run-3";
    const acc = await acceptRun(h, run);
    let idx = h.seq.committedRunIndex(run)!;
    expect(idx.acceptedRecordId).toBe(acc.recordId);
    expect(idx.header.status).toBe("running");
    expect(idx.header.persistence).toBe("stored");
    expect(idx.firstSeq).toBe(1);

    h.clock.advance(5);
    const started = await h.seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, run, { occurredAt: 1_005 }));
    idx = h.seq.committedRunIndex(run)!;
    expect(idx.startedRecordId).toBe(started.recordId);
    expect(idx.header.startedAt).toBe(1_005);

    h.seq.offer(bounded({ tool: "read" }, { scope: { runtimeId: RT, runId: run } }));
    await h.flush();
    expect(h.seq.committedRunIndex(run)!.lastSeq).toBe(3);

    const closed = await h.seq.appendBoundary(boundary("run.closed", closedBody("error"), run, { occurredAt: 1_050 }));
    idx = h.seq.committedRunIndex(run)!;
    expect(idx.terminalRecordId).toBe(closed.recordId);
    expect(idx.header.status).toBe("error");
    expect(idx.header.endedAt).toBe(1_050);
    expect(idx.header.integrity).toBe("complete");
    expect(idx.lastSeq).toBe(4);
    // store 里的是同一份（digest 相等）
    expect(runIndexDigest((await h.store.readRunIndex(run))!)).toBe(runIndexDigest(idx));
  });

  test("同一 runId 第二次 run.accepted 被拒且不消耗 seq；started/closed 缺前置也被拒", async () => {
    const h = harness();
    const run = "run-4";
    await acceptRun(h, run);
    const before = h.seq.reservedSeq;
    await expect(acceptRun(h, run)).rejects.toThrow(/已发过/);
    expect(h.seq.reservedSeq).toBe(before);
    await expect(h.seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, "never-accepted"))).rejects.toThrow(/尚未发/);
    await expect(h.seq.appendBoundary(boundary("run.closed", closedBody(), run))).resolves.toBeDefined();
    await expect(h.seq.appendBoundary(boundary("run.closed", closedBody(), run))).rejects.toThrow(/已发过/);
    expect(h.diags.filter((d) => d.code === "observation_boundary_rejected")).toHaveLength(3);
  });

  test("run.accepted 的 body.header.runId 必须与 scope 一致", async () => {
    const h = harness();
    await expect(h.seq.appendBoundary(boundary("run.accepted", acceptedBody("other"), "run-5"))).rejects.toThrow(/不一致/);
  });
});

describe("store 失败裁决", () => {
  test("瞬时失败（明确未落）→ 同 batch 原 ID/bytes 重试成功，不重复", async () => {
    const h = harness();
    let calls = 0;
    h.store.failpoint = () => (++calls === 1 ? "throw" : undefined);
    h.seq.offer(bounded({ a: 1 }));
    const env = await h.seq.appendBoundary(boundary("checkpoint", { ok: 1 }));
    expect(env.seq).toBe(2);
    expect(h.store.commitCount).toBe(1);
    expect(h.diags.some((d) => d.code === "observation_commit_retry")).toBe(true);
    expect(h.seq.persistenceState.status).toBe("healthy");
  });

  test("commit-unknown（写成功但抛错）→ read-after-error 判 committed，barrier 照常 resolve、不重复颁发", async () => {
    const h = harness();
    let calls = 0;
    h.store.failpoint = () => (++calls === 1 ? "unknown" : undefined);
    const env = await h.seq.appendBoundary(boundary("checkpoint", { ok: 1 }));
    expect(env.seq).toBe(1);
    expect(h.store.commitCount).toBe(1);
    expect(h.seq.committedSeq).toBe(1);
  });

  test("corruption（同 ID 不同 bytes）→ 立即 sealed；之后 appendBoundary 拒、offer 静默丢并报一次诊断", async () => {
    const h = harness();
    h.seq.offer(bounded({ a: 1 }));
    await h.flush();
    // 伪造一条同 recordId 不同 bytes 的记录去撞：直接让 store 在下一次 commit 抛 corruption
    h.store.failpoint = () => {
      throw new ObservationCorruptionError("injected");
    };
    await expect(h.seq.appendBoundary(boundary("checkpoint", { ok: 1 }))).rejects.toBeInstanceOf(ObservationStoreUnavailableError);
    expect(h.seq.persistenceState.status).toBe("sealed");
    await expect(h.seq.appendBoundary(boundary("checkpoint", { ok: 2 }))).rejects.toBeInstanceOf(ObservationStoreUnavailableError);
    expect(() => h.seq.offer(bounded({ a: 2 }))).not.toThrow();
    expect(() => h.seq.offer(bounded({ a: 3 }))).not.toThrow();
    expect(h.diags.filter((d) => d.code === "observation_offer_dropped")).toHaveLength(1);
  });

  test("重试耗尽（一直明确未落）→ sealed，barrier reject", async () => {
    const h = harness({ maxCommitAttempts: 2 });
    h.store.failpoint = () => "throw";
    await expect(h.seq.appendBoundary(boundary("checkpoint", { ok: 1 }))).rejects.toBeInstanceOf(ObservationStoreUnavailableError);
    expect(h.seq.persistenceState.status).toBe("sealed");
  });
});

describe("live 扇出", () => {
  test("严格 COMMIT 之后、按 seq；offer 与 barrier 之间不触发 listener", async () => {
    const h = harness();
    const seen: number[] = [];
    h.seq.subscribe({ afterSeq: 0, listener: (i) => "recordId" in i && seen.push(i.seq) });
    h.seq.offer(bounded({ a: 1 }));
    h.seq.offer(bounded({ a: 2 }));
    await Promise.resolve();
    expect(seen).toEqual([]);
    await h.flush();
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
  });

  test("subscribe(afterSeq) 先回放 committed 再接 live，无重复无漏窗", async () => {
    const h = harness();
    h.seq.offer(bounded({ a: 1 }));
    h.seq.offer(bounded({ a: 2 }));
    await h.flush();
    const seen: number[] = [];
    h.seq.subscribe({ afterSeq: 1, listener: (i) => "recordId" in i && seen.push(i.seq) });
    h.seq.offer(bounded({ a: 3 }));
    await h.flush();
    await Promise.resolve();
    expect(seen).toEqual([2, 3]);
  });

  test("回放窗口有界：早于窗口的从 store 分页读，先旧后新、无重复无漏；窗口之外的不再占内存", async () => {
    const h = harness({ replayWindowRecords: 3 });
    for (let i = 1; i <= 8; i++) h.seq.offer(bounded({ i }));
    await h.seq.flushPending();
    expect(h.seq.committedSeq).toBe(8);
    expect(h.seq.committedRecords().map((r) => r.seq)).toEqual([6, 7, 8]); // 内存里只剩最近 3 条
    const seen: number[] = [];
    h.seq.subscribe({ afterSeq: 0, listener: (i) => "recordId" in i && seen.push(i.seq) });
    h.seq.offer(bounded({ i: 9 })); // 回放还没开始就来的 live 记录：要排在旧记录之后
    await h.flush();
    await settle(() => seen.length >= 9);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const sink = h.seq.health().sinks[0]!;
    expect(sink.status).toBe("healthy");
    expect(sink.lastDeliveredSeq).toBe(9);
    expect(sink.gaps).toHaveLength(0);
  });

  test("回放读 store 失败：该 sink 出 replay_unavailable gap 并降级，live 照常；canonical 与诊断都如实", async () => {
    const h = harness({ replayWindowRecords: 2 });
    for (let i = 1; i <= 5; i++) h.seq.offer(bounded({ i }));
    await h.flush();
    h.store.readRecordsAfter = async () => {
      throw new Error("disk gone");
    };
    const items: ObservationSubscribeItem[] = [];
    h.seq.subscribe({ afterSeq: 0, sinkId: "late", listener: (i) => items.push(i) });
    await settle(() => items.length >= 3);
    expect(items[0]).toMatchObject({ sinkId: "late", afterSeq: 0, beforeSeq: 4, dropped: 3, reason: "replay_unavailable" });
    expect(items.slice(1).map((i) => ("recordId" in i ? i.seq : -1))).toEqual([4, 5]); // 窗口内的照常交付
    h.seq.offer(bounded({ i: 6 }));
    await h.flush();
    await settle(() => items.length >= 4);
    expect("recordId" in items[3]! ? items[3].seq : -1).toBe(6);
    const sink = h.seq.health().sinks.find((s) => s.sinkId === "late")!;
    expect(sink.status).toBe("degraded");
    expect(sink.gaps).toHaveLength(1);
    expect(h.diags.some((d) => d.code === "observation_replay_failed")).toBe(true);
    expect(h.seq.health().capture.canonicalGapCount).toBe(0);
  });

  test("慢订阅者：队列满只出 SinkDeliveryGap（exclusive 区间），canonical 不受影响", async () => {
    const h = harness({ subscriberQueueCapacity: 1 });
    const items: (ObservationEnvelope | SinkDeliveryGap)[] = [];
    h.seq.subscribe({ afterSeq: 0, sinkId: "slow", listener: (i) => items.push(i) });
    for (let i = 0; i < 4; i++) h.seq.offer(bounded({ i }));
    await h.flush();
    // 同一个 microtask 内入队 4 条：第 1 条进队列，2..4 被丢；drain 后队列空，再来一条会先收到 gap
    h.seq.offer(bounded({ i: 5 }));
    await h.flush();
    await Promise.resolve();
    const gaps = items.filter((i): i is SinkDeliveryGap => !("recordId" in i));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ sinkId: "slow", afterSeq: 1, beforeSeq: 5, dropped: 3, reason: "subscriber_slow" });
    expect(gaps[0]!.dropped).toBe(gaps[0]!.beforeSeq - gaps[0]!.afterSeq - 1);
    expect(h.seq.committedSeq).toBe(5);
    expect(h.seq.health().capture.canonicalGapCount).toBe(0);
    expect(h.seq.health().sinks[0]?.status).toBe("degraded");
  });

  test("listener 抛错：该订阅关闭、记 sink_failure，Sequencer 与其他订阅者不受影响", async () => {
    const h = harness();
    const good: number[] = [];
    h.seq.subscribe({ afterSeq: 0, sinkId: "good", listener: (i) => "recordId" in i && good.push(i.seq) });
    h.seq.subscribe({
      afterSeq: 0,
      sinkId: "bad",
      listener: () => {
        throw new Error("boom");
      },
    });
    h.seq.offer(bounded({ a: 1 }));
    h.seq.offer(bounded({ a: 2 }));
    await h.flush();
    await Promise.resolve();
    expect(good).toEqual([1, 2]);
    // 关掉的 sink 留 tombstone：status:"closed" 与 lastErrorDigest 在 health 里仍可见（review P1）
    const sinks = h.seq.health().sinks;
    expect(sinks.map((s) => `${s.sinkId}:${s.status}`).sort()).toEqual(["bad:closed", "good:healthy"]);
    // digest 就得是 digest：第三方异常的原文不进可查询的 health，也不进诊断（review P1 实测泄过凭据）
    const bad = sinks.find((s) => s.sinkId === "bad")!;
    expect(bad.lastErrorDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sinks)).not.toContain("boom");
    const diag = h.diags.find((d) => d.code === "observation_subscriber_failed")!;
    expect(diag.message).toContain("Error@");
    expect(diag.message).not.toContain("boom");
  });

  test("凭据出现在 listener 异常里也不会落进 health 或诊断", async () => {
    const h = harness();
    const secret = "Authorization: Bearer sk-secret-123";
    h.seq.subscribe({
      afterSeq: 0,
      sinkId: "leaky",
      listener: () => {
        throw new Error(secret);
      },
    });
    h.seq.offer(bounded({ a: 1 }));
    await h.flush();
    await Promise.resolve();
    expect(JSON.stringify(h.seq.health())).not.toContain("sk-secret");
    expect(JSON.stringify(h.diags)).not.toContain("sk-secret");
  });

  test("按 runId 过滤订阅", async () => {
    const h = harness();
    // record 引用的 run 必须已建立（2026-08-27 review P0），先发 accepted
    await acceptRun(h, "r1");
    await acceptRun(h, "r2");
    await h.flush();
    const seen: string[] = [];
    h.seq.subscribe({ afterSeq: h.seq.committedSeq, runId: "r1", listener: (i) => "recordId" in i && seen.push(i.name) });
    h.seq.offer(bounded({ a: 1 }, { name: "in", scope: { runtimeId: RT, runId: "r1" } }));
    h.seq.offer(bounded({ a: 2 }, { name: "out", scope: { runtimeId: RT, runId: "r2" } }));
    await h.flush();
    await Promise.resolve();
    expect(seen).toEqual(["in"]);
  });
});

describe("review 修复：sink 隔离、尾部 gap、batch 上限", () => {
  test("async listener reject 不逃逸成 unhandled rejection；该 sink 关闭、记 sink_failure、tombstone 可见", async () => {
    const h = harness();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      h.seq.subscribe({
        afterSeq: 0,
        sinkId: "async",
        listener: (async () => {
          throw new Error("boom");
        }) as unknown as ObservationSubscribeListener,
      });
      h.seq.offer(bounded({ a: 1 }));
      await h.flush();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      const sink = h.seq.health().sinks.find((s) => s.sinkId === "async")!;
      expect(sink.status).toBe("closed");
      expect(sink.lastErrorDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(sink.gaps.map((g) => g.reason)).toEqual(["sink_failure"]);
      expect(h.seq.committedSeq).toBe(1); // Sequencer 不受影响
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("连续 hole 也不绕过 batch 上限：hole+gap 装不下就停在 hole 之前，让下一批从它开始", async () => {
    const h = harness({ maxBatchRecords: 2 });
    h.seq.offer(bounded({ ok: 1 })); // seq 1
    h.seq.offer(bounded({ bad: NaN })); // hole 2 + gap 3
    h.seq.offer(bounded({ bad: Symbol("x") })); // hole 4 + gap 5
    await h.seq.appendBoundary(boundary("checkpoint", { ok: true })); // seq 6
    // 之前 mustReach 会把 gap 强塞进当前批，实测撑成 [3,1]
    expect(h.store.batchSizes).toEqual([2, 2]);
    expect(h.seq.committedSeq).toBe(6);
    expect(h.seq.committedRecords().map((r) => r.seq)).toEqual([1, 3, 5, 6]);
  });

  test("字节上限同样不被 hole+gap 撑破：每笔事务都不超过 maxBatchBytes（除非单条本身就超）", async () => {
    const h = harness({ maxBatchRecords: 1_000, maxBatchBytes: 900 });
    for (let i = 0; i < 3; i++) {
      h.seq.offer(bounded({ ok: i }));
      h.seq.offer(bounded({ bad: NaN }));
    }
    await h.seq.appendBoundary(boundary("checkpoint", { ok: true }));
    expect(h.store.batchBytes.length).toBeGreaterThan(1);
    for (const [i, n] of h.store.batchBytes.entries()) {
      if (h.store.batchSizes[i] === 1) continue; // 单条超限只能自己走一笔
      expect(n).toBeLessThanOrEqual(900);
    }
  });

  test("超长 runtimeId / generation 在构造期就被拒，不留到编码期变成 gap", () => {
    const over = "x".repeat(OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes + 1);
    const base = { capturePolicy: "metadata" as const, store: new InMemoryCanonicalObservationStore(), clock: new FakeClock(0) };
    expect(() => new ObservationSequencer({ ...base, runtimeId: over, runtimeGeneration: "g" })).toThrow(ObservationIdentityError);
    expect(() => new ObservationSequencer({ ...base, runtimeId: "rt", runtimeGeneration: over })).toThrow(ObservationIdentityError);
    expect(() => new ObservationSequencer({ ...base, runtimeId: "rt", runtimeGeneration: "g" })).not.toThrow();
  });

  test("listener 抛出恶意对象（toString 会抛）也不逃逸：sink 关闭，Sequencer 照跑", async () => {
    const h = harness();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      h.seq.subscribe({
        afterSeq: 0,
        sinkId: "hostile",
        listener: () => {
          throw {
            toString(): string {
              throw new Error("toString boom");
            },
          };
        },
      });
      h.seq.offer(bounded({ a: 1 }));
      await h.flush();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      expect(h.seq.health().sinks.find((s) => s.sinkId === "hostile")?.status).toBe("closed");
      expect(h.seq.committedSeq).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("可注入的 reporter 抛错也击穿不了 offer() / appendBoundary() 的 no-throw 契约", async () => {
    const clock = new FakeClock(1_000);
    const seq = new ObservationSequencer({
      runtimeId: RT,
      runtimeGeneration: "gen-1",
      capturePolicy: "metadata",
      store: new InMemoryCanonicalObservationStore(),
      clock,
      report: () => {
        throw new Error("reporter boom");
      },
    });
    // 这几条都会走 report()：hole 诊断、ring 满、boundary 被拒
    expect(() => seq.offer(bounded({ bad: NaN }))).not.toThrow();
    expect(() => seq.offer(bounded({ ok: 1 }))).not.toThrow();
    await expect(seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, "never"))).rejects.toThrow(/尚未发/);
    clock.advance(DEFAULT_SEQUENCER_LIMITS.maxBatchDelayMs);
    await seq.idle();
    expect(seq.committedSeq).toBeGreaterThan(0);
  });

  test("subscriber 的 gap 账本有界：100 轮 overflow 后只留最新 MAX_SINK_GAPS，丢弃条数记进 droppedGapCount", async () => {
    const h = harness({ subscriberQueueCapacity: 1 });
    h.seq.subscribe({ afterSeq: 0, sinkId: "slow", listener: () => {} });
    for (let round = 0; round < 100; round++) {
      for (let i = 0; i < 3; i++) h.seq.offer(bounded({ round, i }));
      await h.flush();
      await Promise.resolve();
    }
    const sink = h.seq.health().sinks.find((s) => s.sinkId === "slow")!;
    // 之前每轮永久追加一条，常驻跑下去无界增长
    expect(sink.gaps.length).toBeLessThanOrEqual(MAX_SINK_GAPS);
    expect(sink.droppedGapCount).toBeGreaterThan(0);
  });

  test("超长 subject 在 bounded lane 成 hole + gap（与 producer 侧同一把尺）；links 超条数同样", async () => {
    const h = harness();
    const over = "x".repeat(OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes + 1);
    h.seq.offer(bounded({ ok: 1 }, { subject: { kind: "memory", id: over } }));
    h.seq.offer(bounded({ ok: 2 }, { correlation: { links: Array.from({ length: OBSERVATION_IDENTITY_LIMITS.maxLinks + 1 }, () => ({ runtimeId: RT, recordId: "r" })) } }));
    await h.flush();
    const gaps = h.seq.committedRecords().filter((r) => r.name === "observation.gap");
    expect(gaps).toHaveLength(2);
    expect(gaps.every((g) => (g.body as ObservationGap).reason === "encoding_error")).toBe(true);
  });

  test("boundary 不绕过 batch 上限：maxBatchRecords=2，5 条 bounded + boundary → 事务 [2,2,2]", async () => {
    const h = harness({ maxBatchRecords: 2 });
    for (let i = 0; i < 5; i++) h.seq.offer(bounded({ i }));
    const env = await h.seq.appendBoundary(boundary("checkpoint", { ok: true }));
    expect(env.seq).toBe(6);
    expect(h.store.batchSizes).toEqual([2, 2, 2]);
    expect(h.seq.committedSeq).toBe(6);
  });

  test("慢订阅者的尾部丢弃：队列排空即物化并交付 gap，不等下一条 record；health 同步可见", async () => {
    const h = harness({ subscriberQueueCapacity: 1 });
    const items: ObservationSubscribeItem[] = [];
    h.seq.subscribe({ afterSeq: 0, sinkId: "slow", listener: (i) => items.push(i) });
    for (let i = 0; i < 4; i++) h.seq.offer(bounded({ i }));
    await h.flush();
    await Promise.resolve();
    const gaps = items.filter((i): i is SinkDeliveryGap => !("recordId" in i));
    expect(gaps).toEqual([{ sinkId: "slow", afterSeq: 1, beforeSeq: 5, dropped: 3, reason: "subscriber_slow" }]);
    expect(h.seq.health().sinks[0]?.gaps).toEqual(gaps);
    expect(h.seq.health().sinks[0]?.status).toBe("degraded");
  });

  test("unsubscribe 留 closed tombstone，且 tombstone 有界", () => {
    const h = harness();
    for (let i = 0; i < MAX_CLOSED_SINK_TOMBSTONES + 8; i++) {
      const off = h.seq.subscribe({ afterSeq: 0, sinkId: `s${i}`, listener: () => {} });
      off();
    }
    const sinks = h.seq.health().sinks;
    expect(sinks).toHaveLength(MAX_CLOSED_SINK_TOMBSTONES);
    expect(sinks.every((s) => s.status === "closed")).toBe(true);
    expect(sinks[0]?.sinkId).toBe("s8"); // 最旧的先出
  });
});

describe("run.closed preflight（review P1：超限自动降级、仍 stored、下一 admission 可继续）", () => {
  const summary = (i: number): CapabilityObservationSummary => ({ schemaVersion: 1, stateDigest: `d${i}`, counters: { n: i }, detailBytes: 0, detailTruncated: false });
  const snapshotWith = (n: number, agentStatus = "idle"): ObservationSnapshot<EchoObservableState> => ({
    throughSeq: 0,
    at: 1_000,
    state: {
      runtime: { phase: "ready", status: "ready", observationPersistence: "healthy", generation: "g", activeEntryCount: 0 },
      agent: { status: agentStatus, activeRunId: null, activeTurnId: null, iteration: 1, messageCount: 2 },
      capabilities: Array.from({ length: n }, (_, i) => ({ id: `cap-${String(i).padStart(3, "0")}`, digest: "x", summary: summary(i) })),
      omittedCapabilitySummaryCount: 0,
    },
  });

  test("33 个 capability summary → 保留 32、capabilities gap、integrity partial、run.closed 仍 stored、healthy", async () => {
    const h = harness();
    const run = "run-p1";
    await acceptRun(h, run);
    const before = h.seq.reservedSeq;
    const closed = await h.seq.appendBoundary(
      boundary("run.closed", { outcome: { status: "completed" }, finalSnapshot: snapshotWith(33), captureGapCountBeforeClose: 999, captureGapDigest: "caller-old-digest" }, run),
    );
    const body = closed.body as RunClosedBodyV1;
    expect(body.finalSnapshot?.state.capabilities).toHaveLength(32);
    expect(body.finalSnapshot?.state.omittedCapabilitySummaryCount).toBe(1);
    // 计数与 digest 同源，都来自 Sequencer 的 gap 账本；caller 塞的 999 / caller-old-digest 一并丢弃
    expect(body.captureGapCountBeforeClose).toBe(1);
    expect(body.captureGapDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.seq).toBe(before + 3); // 省略 slot S、gap S+1、run.closed S+2
    const gap = h.seq.committedRecords().find((r) => r.name === "observation.gap" && r.subject?.id === "run.final_snapshot.capabilities")!;
    expect((gap.body as ObservationGap).reason).toBe("capture_limit");
    const idx = h.seq.committedRunIndex(run)!;
    expect(idx.header.status).toBe("completed");
    expect(idx.header.integrity).toBe("partial");
    expect(idx.header.persistence).toBe("stored");
    expect(h.seq.persistenceState.status).toBe("healthy");
  });

  test("零 gap 时不写 digest 字段；有 gap 时 count 与 digest 同源、随 gap 集合变化", async () => {
    const h = harness();
    const clean = "run-clean";
    await acceptRun(h, clean);
    const closed = await h.seq.appendBoundary(boundary("run.closed", closedBody(), clean));
    const body = closed.body as RunClosedBodyV1;
    expect(body.captureGapCountBeforeClose).toBe(0);
    expect("captureGapDigest" in body).toBe(false);

    const dirty = "run-dirty";
    await acceptRun(h, dirty);
    h.seq.offer(bounded({ bad: NaN }, { scope: { runtimeId: RT, runId: dirty } }));
    await h.flush();
    const d1 = (await h.seq.appendBoundary(boundary("run.closed", closedBody(), dirty))).body as RunClosedBodyV1;
    expect(d1.captureGapCountBeforeClose).toBe(1);
    expect(d1.captureGapDigest).toMatch(/^[0-9a-f]{64}$/);

    const dirtier = "run-dirtier";
    await acceptRun(h, dirtier);
    h.seq.offer(bounded({ bad: NaN }, { scope: { runtimeId: RT, runId: dirtier } }));
    h.seq.offer(bounded({ bad: Symbol("x") }, { scope: { runtimeId: RT, runId: dirtier } }));
    await h.flush();
    const d2 = (await h.seq.appendBoundary(boundary("run.closed", closedBody(), dirtier))).body as RunClosedBodyV1;
    expect(d2.captureGapCountBeforeClose).toBe(2);
    expect(d2.captureGapDigest).not.toBe(d1.captureGapDigest);
  });

  test("700 个 gap 的长 run 仍能封口：capture 状态是常量空间，不在封口时重编数组", async () => {
    const h = harness();
    const run = "run-long";
    await acceptRun(h, run);
    for (let i = 0; i < 700; i++) h.seq.offer(bounded({ bad: NaN }, { scope: { runtimeId: RT, runId: run } }));
    await h.flush();
    expect(h.seq.captureStateOf(run)?.count).toBe(700);
    // 之前把 {seq,reason} 存成数组、封口时整体重编，700 条就 nodes_exceeded，run 永远封不了口
    const closed = await h.seq.appendBoundary(boundary("run.closed", closedBody(), run));
    const body = closed.body as RunClosedBodyV1;
    expect(body.captureGapCountBeforeClose).toBe(700);
    expect(body.captureGapDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(h.seq.committedRunIndex(run)?.header.status).toBe("completed");
    expect(h.seq.persistenceState.status).toBe("healthy");
  });

  test("封口落库后释放 per-run capture 状态", async () => {
    const h = harness();
    const run = "run-release";
    await acceptRun(h, run);
    h.seq.offer(bounded({ bad: NaN }, { scope: { runtimeId: RT, runId: run } }));
    await h.flush();
    expect(h.seq.captureStateOf(run)?.count).toBe(1);
    await h.seq.appendBoundary(boundary("run.closed", closedBody(), run));
    expect(h.seq.captureStateOf(run)).toBeUndefined();
  });

  test("digest 吃的是 exact canonical bytes：同 seq、只有 subject 不同，digest 也必须不同", async () => {
    // 两个全新 Sequencer ⇒ seq 完全一致，差异只剩 subject——这正是之前只存 {seq,reason} 分辨不出的那一对
    // gap 只有在 run.accepted 成功、RunIndex 已建立之后才挂 runId（2026-08-27 review P0），所以先建 run
    const mk = async (subjectId: "run.final_snapshot" | "run.final_snapshot.capabilities"): Promise<string> => {
      const h = harness();
      await acceptRun(h, "r");
      h.seq.reserveOptionalProjectionGap({ runId: "r", subjectId, reason: "capture_limit" });
      return h.seq.captureStateOf("r")!.rolling;
    };
    expect(await mk("run.final_snapshot")).not.toBe(await mk("run.final_snapshot.capabilities"));
  });

  test("snapshot 自报存量 omission（本次没新省略）也必须有 gap 覆盖，不能「省略但 complete」", async () => {
    const h = harness();
    const run = "run-legacy-omission";
    await acceptRun(h, run);
    const snap = snapshotWith(2);
    const withLegacy: ObservationSnapshot<EchoObservableState> = { ...snap, state: { ...snap.state, omittedCapabilitySummaryCount: 5 } };
    await h.seq.appendBoundary(boundary("run.closed", { outcome: { status: "completed" }, finalSnapshot: withLegacy }, run));
    const gap = h.seq.committedRecords().find((r) => r.name === "observation.gap" && r.subject?.id === "run.final_snapshot.capabilities");
    expect(gap).toBeDefined();
    expect(h.seq.committedRunIndex(run)?.header.integrity).toBe("partial");
  });

  test("整个 snapshot 超 boundary 预算 → finalSnapshot:null + run.final_snapshot gap，仍 stored、healthy，下一 boundary 照常", async () => {
    const h = harness();
    const run = "run-p2";
    await acceptRun(h, run);
    const closed = await h.seq.appendBoundary(
      boundary("run.closed", { outcome: { status: "completed" }, finalSnapshot: snapshotWith(2, "s".repeat(70_000)) }, run),
    );
    expect((closed.body as RunClosedBodyV1).finalSnapshot).toBeNull();
    const gap = h.seq.committedRecords().find((r) => r.name === "observation.gap" && r.subject?.id === "run.final_snapshot")!;
    expect((gap.body as ObservationGap).reason).toBe("capture_limit");
    expect(h.seq.committedRunIndex(run)?.header.persistence).toBe("stored");
    expect(h.seq.persistenceState.status).toBe("healthy");
    await expect(h.seq.appendBoundary(boundary("checkpoint", { ok: true }))).resolves.toBeDefined();
  });

  test("required body 非法（finishReason 超 256 字节）→ 先裁决 hole/gap 再 reject；run 仍开着可重试", async () => {
    const h = harness();
    const run = "run-p3";
    await acceptRun(h, run);
    await expect(
      h.seq.appendBoundary(boundary("run.closed", { outcome: { status: "completed", finishReason: "r".repeat(300) }, finalSnapshot: null }, run)),
    ).rejects.toBeInstanceOf(ObservationEncodingError);
    await h.flush();
    expect(h.seq.committedRecords().some((r) => r.name === "observation.gap" && (r.body as ObservationGap).reason === "encoding_error")).toBe(true);
    await expect(h.seq.appendBoundary(boundary("run.closed", closedBody(), run))).resolves.toBeDefined();
  });
});

describe("offer() 的零抛错契约", () => {
  test("无论 body 多离谱、writer 什么状态，offer 都不抛、不返回 Promise", async () => {
    const h = harness();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const inputs = [NaN, undefined, () => 1, Symbol("s"), new Map(), cyc, { deep: { deeper: { deepest: 10n } } }];
    for (const body of inputs) {
      const r = h.seq.offer(bounded(body)) as unknown;
      expect(r).toBeUndefined();
    }
    await h.flush();
    // 每个非法 body 一个 hole + 一个 gap；最后那个是合法的
    const gaps = h.seq.committedRecords().filter((r) => r.name === "observation.gap");
    expect(gaps).toHaveLength(6);
    expect(h.diags.filter((d) => d.code === "observation_sequencer_internal")).toHaveLength(0);
  });
});

describe("writer terminal 之后：不再预留，也不再泄露成因（2026-08-27 review P1）", () => {
  const SECRET = "Authorization: Bearer sk-secret";

  /** 用 corruption 把 writer seal 掉，返回 harness。 */
  async function sealedHarness(cause = SECRET): Promise<ReturnType<typeof harness>> {
    const h = harness();
    h.seq.offer(bounded({ a: 1 }));
    await h.flush();
    h.store.failpoint = () => {
      throw new ObservationCorruptionError(cause);
    };
    await expect(h.seq.appendBoundary(boundary("checkpoint", { ok: 1 }))).rejects.toBeInstanceOf(ObservationStoreUnavailableError);
    expect(h.seq.persistenceState.status).toBe("sealed");
    return h;
  }

  test("sealed 后反复 projection failure：走真实 fact-sink，reservedSeq / gapCount 一个都不动", async () => {
    // 修复前实测：before=1 → after=201、slots=201、gaps=100，而那些 gap 永远提交不了。
    // 判据用 **reservedSeq**（committedSeq 量不到预留，上一版拿它冒充是错的），
    // 并且走**真实 `factSinkToIngest`**，不是直接戳 Sequencer 的内部入口。
    const h = await sealedHarness();
    const before = h.seq.health();
    const reservedBefore = h.seq.reservedSeq;
    const sinkDiags: Diagnostic[] = [];
    const sink = factSinkToIngest(
      {
        instrumentation: { name: "t", version: "1" },
        project: () => {
          throw new Error("projection boom");
        },
      },
      h.seq,
      { runtimeId: RT, runtimeGeneration: "gen-1", capturePolicy: "metadata", owner: { status: "not-applicable" }, report: (d) => sinkDiags.push(d) },
    );
    for (let i = 0; i < 100; i++) sink.offer({});
    expect(h.seq.reservedSeq).toBe(reservedBefore);
    expect(h.seq.health().capture.canonicalGapCount).toBe(before.capture.canonicalGapCount);
    // terminal 是持续状态不是逐条事件：100 次失败只报一次，诊断通道不能成为新的无界增长面
    // （修复前实测 101 条：sequencer 1 条 + fact-sink 每条 1 条）。
    expect(sinkDiags).toHaveLength(1);
    expect(sinkDiags[0]?.message).toContain("只报第一次");
  });

  test("terminal 之前同一个真实 fact-sink 仍然逐条开 gap", async () => {
    const h = harness();
    const sink = factSinkToIngest(
      {
        instrumentation: { name: "t", version: "1" },
        project: () => {
          throw new Error("projection boom");
        },
      },
      h.seq,
      { runtimeId: RT, runtimeGeneration: "gen-1", capturePolicy: "metadata", owner: { status: "not-applicable" } },
    );
    sink.offer({});
    sink.offer({});
    expect(h.seq.reservedSeq).toBe(4); // 两条失败各占「失败身份 + gap」两个 seq
    expect(h.seq.health().capture.canonicalGapCount).toBe(2);
  });

  test("terminal 之前正常预留：返回 gap-reserved 且真的产生 gap", async () => {
    const h = harness();
    expect(h.seq.reserveProjectionFailureGap({ runId: "r1" })).toBe("gap-reserved");
    await h.flush();
    expect(h.seq.health().capture.canonicalGapCount).toBe(1);
    expect(h.seq.committedRecords().map((r) => r.name)).toContain("observation.gap");
  });

  test("sealed 的 health 交出「什么时候、因为什么」，不再只有 reopenAttempts:0", async () => {
    const h = await sealedHarness();
    const p = h.seq.health().persistence;
    expect(p.status).toBe("sealed");
    expect(p.terminalSince).toBe(h.clock.now());
    expect(p.lastErrorDigest).toMatch(/^[0-9a-f]{64}$/); // health 存完整 digest
    expect(p.reopenAttempts).toBe(0);
  });

  test("seal 的成因先 redact：诊断与 boundary rejection 都只出 Name@digest 前缀，不含凭据", async () => {
    const h = await sealedHarness();
    const sealDiag = h.diags.find((d) => d.code === "observation_writer_sealed")!;
    expect(sealDiag.message).toMatch(/canonical writer sealed：ObservationCorruptionError@[0-9a-f]{8}$/);
    expect(sealDiag.message).not.toContain("sk-secret");
    expect(sealDiag.message).not.toContain("Authorization");
    // 所有诊断、以及 health 的任何字段，都不许出现原始正文
    expect(JSON.stringify(h.diags)).not.toContain("sk-secret");
    expect(JSON.stringify(h.seq.health())).not.toContain("sk-secret");
    // 尚未 settle 的 boundary waiter 走同一条 rejection 文案
    const h2 = harness();
    h2.seq.offer(bounded({ a: 1 }));
    await h2.flush();
    h2.store.failpoint = () => {
      throw new ObservationCorruptionError(SECRET);
    };
    await h2.seq.appendBoundary(boundary("checkpoint", { ok: 1 })).then(
      () => {
        throw new Error("should reject");
      },
      (e: Error) => {
        expect(e.message).not.toContain("sk-secret");
        expect(e.message).toMatch(/ObservationCorruptionError@[0-9a-f]{8}/);
      },
    );
  });

  test("healthy 直接进 terminal：只有 terminalSince，没有 degradedSince", async () => {
    // `degradedSince` 只在**经历过** degraded/recovering 时才有；直接掉进来就不该凭空造一个时间。
    // （degraded → sealed 那条路在本 harness 里够不到：`hang` failpoint 永不 resolve，flush 卡住后
    //  不会再有第二次 commit，而 degraded 只能由 boundary deadline 产生。
    //  等 O3a 的真实 store 才测得到——不为它写一个测不到真实路径的假测试。）
    const h = await sealedHarness();
    const p = h.seq.health().persistence;
    expect(p.terminalSince).toBe(h.clock.now());
    expect(p.degradedSince).toBeUndefined();
  });
});

describe("预留过的 seq 必须永远有裁决（2026-08-27 review P1）", () => {
  const hostileScope = (): Record<string, unknown> => ({
    runtimeId: RT,
    get runId(): string {
      throw new Error("runId trap");
    },
  });

  test("scope.runId getter 抛错：seq 当场成 hole+gap，prefix 照常推进", async () => {
    // 修复前实测：reserved=2、committed=0、gaps=0、records=0——writer 仍声称 healthy，journal 永久堵死
    const h = harness();
    h.seq.offer(bounded({ a: 1 }, { scope: hostileScope() as never }));
    h.seq.offer(bounded({ a: 2 }));
    await h.flush();
    expect(h.seq.committedSeq).toBe(h.seq.reservedSeq); // prefix 追上了预留，没有空洞
    expect(h.seq.health().capture.canonicalGapCount).toBe(1);
    expect(h.seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap", "test.event"]);
    expect(h.seq.persistenceState.status).toBe("healthy");
  });

  test("坏 scope 里 runId 读不出来 → runtime-scoped gap，但绝不留悬空 seq", async () => {
    const h = harness();
    h.seq.offer(bounded({ a: 1 }, { scope: hostileScope() as never }));
    await h.flush();
    const gap = h.seq.committedRecords()[0]!;
    expect(gap.name).toBe("observation.gap");
    expect(gap.scope.runId).toBeUndefined();
  });

  test("scope 里别的字段坏、runId 好：gap 仍挂对 run", async () => {
    const h = harness();
    await acceptRun(h, "r9"); // gap 挂 runId 的前提：RunIndex 已建立（review P0）
    const scope: Record<string, unknown> = { runtimeId: RT, runId: "r9" };
    Object.defineProperty(scope, "sessionId", {
      get: () => {
        throw new Error("trap");
      },
      enumerable: true,
      configurable: true,
    });
    h.seq.offer(bounded({ a: 1 }, { scope: scope as never }));
    await h.flush();
    expect(h.seq.committedRecords()[0]?.scope.runId).toBe("r9");
  });
});

describe("异步 subscriber 不许绕过 bounded queue（2026-08-27 review P1）", () => {
  test("永不 settle 的 listener：只允许一条在途，队列照常积压并出 gap", async () => {
    // 修复前实测：queue 容量 1，却同时挂了 100 个 in-flight Promise，
    // 没有一条真正完成，health 却声称 lastDeliveredSeq=100 且零 gap
    const h = harness({ subscriberQueueCapacity: 1, maxBatchDelayMs: 1 });
    let invoked = 0;
    h.seq.subscribe({
      afterSeq: 0,
      sinkId: "slow",
      listener: () => {
        invoked += 1;
        return new Promise<void>(() => {}) as unknown as void;
      },
    });
    for (let i = 0; i < 100; i++) {
      h.seq.offer(bounded({ i }));
      h.clock.advance(1);
      await h.seq.idle();
      await Promise.resolve();
    }
    const sink = h.seq.health().sinks.find((s) => s.sinkId === "slow")!;
    expect(invoked).toBe(1); // 只有第一条真正在途
    expect(sink.lastDeliveredSeq).toBe(0); // settle 之前不算 delivered
    expect(sink.status).toBe("degraded");
    expect(sink.gaps.length).toBeGreaterThan(0); // 慢 subscriber 必须产生 gap
  });

  test("async listener settle 之后才推进 lastDeliveredSeq 并继续 drain", async () => {
    const h = harness({ maxBatchDelayMs: 1 });
    const settle: (() => void)[] = [];
    h.seq.subscribe({
      afterSeq: 0,
      sinkId: "async",
      listener: () => new Promise<void>((r) => settle.push(r)) as unknown as void,
    });
    h.seq.offer(bounded({ a: 1 }));
    h.seq.offer(bounded({ a: 2 }));
    h.clock.advance(1);
    await h.seq.idle();
    await Promise.resolve();
    expect(h.seq.health().sinks.find((s) => s.sinkId === "async")?.lastDeliveredSeq).toBe(0);
    settle.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.seq.health().sinks.find((s) => s.sinkId === "async")?.lastDeliveredSeq).toBe(1);
    expect(settle).toHaveLength(1); // 第二条这时才被交付
  });
});

describe("O2a 不得提交悬空 BlobRef（2026-08-27 review P1）", () => {
  test("binary body → hole + gap，而不是一条指向不存在内容的 digest", async () => {
    // 修复前实测：记录 committed 成功、body 是 {digest,size}，而 store 没有任何 blob 面，
    // candidate 随 commit 释放后原始 bytes 永久消失（悬空 ref 是明禁的）
    const h = harness();
    h.seq.offer(bounded({ payload: new Uint8Array([1, 2, 3]) }));
    await h.flush();
    expect(h.seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
    expect(h.seq.health().capture.canonicalGapCount).toBe(1);
    expect(JSON.stringify(h.seq.committedRecords())).not.toContain("039058c6");
  });

  test("store 确实没有 blob seam——这条 fixture 就是「拒绝」的理由", () => {
    const store = new InMemoryCanonicalObservationStore();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((m) => m.toLowerCase().includes("blob"));
    expect(methods).toEqual([]);
  });
});

describe("重复 sinkId（2026-08-27 review P2）", () => {
  test("第二次 subscribe 同 ID 直接拒，旧句柄不会删掉新 subscriber", async () => {
    // 修复前实测：静默覆盖 + 按 ID 删除 → oldReceived=0、newReceived=0、health 只剩一个 closed tombstone
    const h = harness();
    const seenA: number[] = [];
    const unsubA = h.seq.subscribe({ afterSeq: 0, sinkId: "dup", listener: (i) => "recordId" in i && seenA.push(i.seq) });
    expect(() => h.seq.subscribe({ afterSeq: 0, sinkId: "dup", listener: () => {} })).toThrow(/sink id 重复/);
    h.seq.offer(bounded({ a: 1 }));
    await h.flush();
    await Promise.resolve();
    expect(seenA).toEqual([1]); // 原订阅照常工作，没被挤掉
    unsubA();
    expect(h.seq.health().sinks.filter((s) => s.sinkId === "dup" && s.status !== "closed")).toHaveLength(0);
  });

  test("关闭按身份比对：旧句柄 unsubscribe 不影响同 ID 的新订阅", async () => {
    const h = harness();
    const unsubOld = h.seq.subscribe({ afterSeq: 0, sinkId: "dup", listener: () => {} });
    unsubOld(); // 先正常关掉，ID 因此空出来
    const seenNew: number[] = [];
    h.seq.subscribe({ afterSeq: 0, sinkId: "dup", listener: (i) => "recordId" in i && seenNew.push(i.seq) });
    unsubOld(); // 旧句柄再调一次：不许把新 subscriber 删掉
    h.seq.offer(bounded({ a: 1 }));
    await h.flush();
    await Promise.resolve();
    expect(seenNew).toEqual([1]);
  });
});

describe("boundary 只用同一份物化快照（2026-08-27 review P0）", () => {
  test("name getter 变脸：只读一次，journal 与 registry/RunIndex 裁决同源", async () => {
    // 修复前实测：nameReads=3、journal=["run.accepted"]、runIndexHas=false
    // ——journal 落了 run.accepted，RunIndex 里却没有这条，OR4 的同事务一致当场破
    const h = harness();
    let reads = 0;
    // 用 runtime-scoped draft：本测试的焦点是「name 只读一次」，不需要牵扯 run 归属
    const draft = {
      ...boundary("checkpoint", { ok: 1 }),
      get name(): string {
        reads += 1;
        return reads === 2 ? "run.accepted" : "checkpoint";
      },
    };
    await h.seq.appendBoundary(draft as unknown as BoundaryObservationDraft);
    await h.flush();
    expect(reads).toBe(1); // 整条路径只读一次
    expect(h.seq.committedRecords().map((r) => r.name)).toEqual(["checkpoint"]);
    expect(await h.store.readRunIndex("r1")).toBeNull(); // checkpoint 不建 header，两边一致
  });

  test("body 变脸：RunIndex seed 取自已编码的 envelope body，不取 producer 原 body", async () => {
    // 修复前：canonical 记 agent-safe、RunIndex 记 agent-index-evil
    const h = harness();
    let reads = 0;
    const seed = (agentId: string): RunAcceptedBodyV1["header"] => ({ ...acceptedBody("r1").header, agentId });
    const body = new Proxy(
      { header: seed("agent-safe") },
      {
        getOwnPropertyDescriptor(): PropertyDescriptor {
          reads += 1;
          return { value: seed(reads === 1 ? "agent-safe" : "agent-index-evil"), writable: true, enumerable: true, configurable: true };
        },
      },
    );
    await h.seq.appendBoundary(boundary("run.accepted", body, "r1"));
    await h.flush();
    const rec = h.seq.committedRecords().find((r) => r.name === "run.accepted")!;
    const recAgent = (rec.body as { header: { agentId: string } }).header.agentId;
    const idx = await h.store.readRunIndex("r1");
    expect(idx).not.toBeNull();
    expect(idx?.header.agentId).toBe(recAgent); // 两边必须同源，不管 Proxy 返回什么
    expect(reads).toBeGreaterThan(0);
  });

  test("draft 自己的 getter 抛错：直接拒，不预留 seq", async () => {
    const h = harness();
    const draft = {
      ...boundary("checkpoint", { ok: 1 }),
      get body(): unknown {
        throw new Error("body trap");
      },
    };
    await expect(h.seq.appendBoundary(draft as unknown as BoundaryObservationDraft)).rejects.toBeInstanceOf(Error);
    expect(h.seq.reservedSeq).toBe(0);
  });
});

describe("subscriber 交付状态机（2026-08-27 review P1）", () => {
  test("尾部 gap 走同一条路径：它未 settle 时不许开始下一条 record", async () => {
    // 修复前：materializePendingDrop 直接调 listener 且不设 inFlight，实测 maxActive=2
    const h = harness({ subscriberQueueCapacity: 1, maxBatchDelayMs: 1 });
    let active = 0;
    let maxActive = 0;
    const settle: (() => void)[] = [];
    h.seq.subscribe({
      afterSeq: 0,
      sinkId: "s",
      listener: () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<void>((r) =>
          settle.push(() => {
            active -= 1;
            r();
          }),
        ) as unknown as void;
      },
    });
    // 先塞满并制造丢弃，再让第一条 settle：队列排空后尾部 gap 应当作为**在途那一条**交付
    for (let i = 0; i < 4; i++) {
      h.seq.offer(bounded({ i }));
      h.clock.advance(1);
      await h.seq.idle();
      await Promise.resolve();
    }
    settle.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    h.seq.offer(bounded({ tail: 1 }));
    h.clock.advance(1);
    await h.seq.idle();
    await Promise.resolve();
    expect(maxActive).toBe(1);
  });

  test("同步 resolve 的 thenable：回调恒异步，drain 不就地递归", async () => {
    // 修复前：直接调任意 thenable 的 .then()，同步 resolve 会让 drain 就地递归 —— 大批量下栈溢出，
    // 还会把健康 sink 当成 listener 抛错关掉
    const h = harness({ maxBatchDelayMs: 1 });
    const order: string[] = [];
    h.seq.subscribe({
      afterSeq: 0,
      sinkId: "sync-thenable",
      listener: () => {
        order.push("listener");
        return {
          then: (res: () => void) => {
            order.push("then-called");
            res(); // 同步 resolve
          },
        } as unknown as void;
      },
    });
    h.seq.offer(bounded({ a: 1 }));
    h.clock.advance(1);
    await h.seq.idle();
    await Promise.resolve();
    order.push("after-microtask");
    await new Promise((r) => setTimeout(r, 5));
    const sink = h.seq.health().sinks.find((s) => s.sinkId === "sync-thenable")!;
    expect(sink.status).not.toBe("closed"); // 没有被误当成抛错关掉
    expect(sink.lastDeliveredSeq).toBe(1);
  });

  test("大批量同步 thenable 不栈溢出，且 sink 不被误关", async () => {
    const h = harness({ maxBatchDelayMs: 1, subscriberQueueCapacity: 4096 });
    let got = 0;
    h.seq.subscribe({
      afterSeq: 0,
      sinkId: "bulk",
      listener: () => {
        got += 1;
        return { then: (res: () => void) => res() } as unknown as void;
      },
    });
    for (let i = 0; i < 20_000; i++) h.seq.offer(bounded({ i }));
    await h.flush();
    await new Promise((r) => setTimeout(r, 200));
    const sink = h.seq.health().sinks.find((s) => s.sinkId === "bulk")!;
    expect(sink.status).not.toBe("closed");
    expect(got).toBeGreaterThan(0);
    expect(h.diags.filter((d) => d.code === "observation_subscriber_failed")).toHaveLength(0);
  });
});

describe("诊断通道自己不能击穿主流程（2026-08-27 review P0）", () => {
  test("async reporter reject：Sequencer 不产生 unhandled rejection", async () => {
    let unhandled = 0;
    const on = (): void => {
      unhandled += 1;
    };
    process.on("unhandledRejection", on);
    const clock = new FakeClock(1_000);
    const seq = new ObservationSequencer({
      runtimeId: RT,
      runtimeGeneration: "gen-1",
      capturePolicy: "metadata",
      store: new InMemoryCanonicalObservationStore(),
      clock,
      report: (() => Promise.reject(new Error("reporter down"))) as unknown as (d: Diagnostic) => void,
    });
    seq.offer(bounded({ bad: NaN })); // 触发 hole + 诊断
    clock.advance(20);
    await seq.idle();
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", on);
    expect(unhandled).toBe(0);
    expect(seq.health().capture.canonicalGapCount).toBe(1); // 诊断坏了不影响裁决
  });
});

describe("boundary body 是固定 schema，不是 producer 的自由字段区（2026-08-27 review P1）", () => {
  const SECRET = "Authorization: Bearer sk-secret";

  async function accepted(h: Harness, runId: string): Promise<void> {
    await h.seq.appendBoundary(boundary("run.accepted", acceptedBody(runId), runId));
  }

  test("body getter 抛错：返回 rejected Promise，不是同步抛出", async () => {
    // 修复前：checkRunBoundary 在 try 之外读 body.header，getter 一抛就同步穿出 appendBoundary()
    const h = harness();
    const draft = {
      ...boundary("run.accepted", null, "r1"),
      get body(): unknown {
        throw new Error("header trap");
      },
    };
    let sync = false;
    try {
      await h.seq.appendBoundary(draft as unknown as BoundaryObservationDraft).catch(() => {});
    } catch {
      sync = true;
    }
    expect(sync).toBe(false);
  });

  test("非法 run.closed.outcome.status：hole + gap，且原值不进诊断与 rejection", async () => {
    // 修复前：在预留之前被拒（没有 hole+gap），且 `String(status)` 把整条凭据回显进诊断
    const h = harness();
    await accepted(h, "r1");
    const before = h.seq.health().capture.canonicalGapCount;
    let msg = "";
    await h.seq.appendBoundary(boundary("run.closed", { outcome: { status: SECRET }, finalSnapshot: null }, "r1")).catch((e: Error) => {
      msg = e.message;
    });
    await h.flush();
    expect(h.seq.health().capture.canonicalGapCount).toBe(before + 1);
    expect(msg).not.toContain("sk-secret");
    expect(JSON.stringify(h.diags)).not.toContain("sk-secret");
  });

  test("run.started 也验 body：未登记字段进不了 canonical journal", async () => {
    // 修复前：run.started 完全不验 body，metadata 档下 {authorization:"Bearer sk-secret"} 直接落库
    const h = harness();
    await accepted(h, "r2");
    const before = h.seq.health().capture.canonicalGapCount;
    await h.seq.appendBoundary(boundary("run.started", { authorization: SECRET }, "r2")).catch(() => {});
    await h.flush();
    expect(JSON.stringify(h.seq.committedRecords())).not.toContain("sk-secret");
    expect(h.seq.health().capture.canonicalGapCount).toBe(before + 1); // 数据失败 → 留痕
  });

  test("合法 run.started 照常通过", async () => {
    const h = harness();
    await accepted(h, "r3");
    const env = await h.seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, "r3"));
    expect(env.name).toBe("run.started");
  });

  test("run.accepted body 必须恰好是 { header }：多一个键就判红并留痕", async () => {
    const h = harness();
    const before = h.seq.health().capture.canonicalGapCount;
    await h.seq
      .appendBoundary(boundary("run.accepted", { ...acceptedBody("r4"), extra: SECRET }, "r4"))
      .catch((e: Error) => expect(e.message).not.toContain("sk-secret"));
    await h.flush();
    expect(h.seq.health().capture.canonicalGapCount).toBe(before + 1);
    expect(JSON.stringify(h.seq.committedRecords())).not.toContain("sk-secret");
  });

  test("生命周期错仍是 pre-reservation 拒（不留痕）——那是调用方协议错，不是数据失败", async () => {
    const h = harness();
    await accepted(h, "r5");
    const reservedBefore = h.seq.reservedSeq;
    await expect(h.seq.appendBoundary(boundary("run.accepted", acceptedBody("r5"), "r5"))).rejects.toThrow(/已发过/);
    expect(h.seq.reservedSeq).toBe(reservedBefore);
    expect(h.seq.health().capture.canonicalGapCount).toBe(0);
  });
});

describe("诊断通道不能成为资源放大器（2026-08-27 review P1）", () => {
  test("async reporter 返回 thenable 后立即停用：10,000 条诊断只调它一次", async () => {
    // 修复前实测：reporter calls=10000、pending promises=10000
    let calls = 0;
    const clock = new FakeClock(1_000);
    const seq = new ObservationSequencer({
      runtimeId: RT,
      runtimeGeneration: "gen-1",
      capturePolicy: "metadata",
      store: new InMemoryCanonicalObservationStore(),
      clock,
      report: (() => {
        calls += 1;
        return Promise.reject(new Error("reporter down"));
      }) as unknown as (d: Diagnostic) => void,
    });
    for (let i = 0; i < 10_000; i++) seq.offer(bounded({ bad: NaN }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(seq.health().capture.canonicalGapCount).toBe(10_000); // 诊断停了，裁决照常
  });
});

describe("run.accepted 的 header 是逐字段 exact schema（2026-08-27 review P0）", () => {
  const SECRET = "Bearer sk-secret";

  async function tryAccept(h: Harness, runId: string, header: unknown): Promise<void> {
    await h.seq.appendBoundary(boundary("run.accepted", { header }, runId)).catch(() => {});
    await h.flush();
  }

  test("缺必填字段：判红留痕，RunIndex 绝不出现", async () => {
    // 修复前实测：{header:{runId:"r1"}} 提交成功、RunIndex 标 stored/complete，
    // 却缺 source/runtimeId/agentId/capturePolicy/acceptedAt
    const h = harness();
    await tryAccept(h, "r1", { runId: "r1" });
    expect(h.seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
    expect(await h.store.readRunIndex("r1")).toBeNull();
  });

  test("header 里的未登记字段：canonical record 与 RunIndex 都进不去", async () => {
    // 修复前：authorization 会同时进 canonical record 与 RunIndex
    const h = harness();
    await tryAccept(h, "r2", { ...acceptedBody("r2").header, authorization: SECRET });
    const dump = JSON.stringify({ recs: h.seq.committedRecords(), idx: await h.store.readRunIndex("r2"), diags: h.diags });
    expect(dump).not.toContain("sk-secret");
    expect(await h.store.readRunIndex("r2")).toBeNull();
  });

  test("runtimeId / runtimeGeneration / capturePolicy 与 Runtime 不一致：一律拒", async () => {
    for (const [key, value] of [
      ["runtimeId", "other-rt"],
      ["runtimeGeneration", "other-gen"],
      ["capturePolicy", "content"],
    ] as const) {
      const h = harness();
      await tryAccept(h, "r3", { ...acceptedBody("r3").header, [key]: value });
      expect(await h.store.readRunIndex("r3")).toBeNull();
    }
  });

  test("逐字段验形：sessionId / acceptedAt / source 各自的非法取值都判红", async () => {
    const bad: unknown[] = [
      { ...acceptedBody("r4").header, sessionId: 123 },
      { ...acceptedBody("r4").header, acceptedAt: -1 },
      { ...acceptedBody("r4").header, acceptedAt: 1.5 },
      { ...acceptedBody("r4").header, source: { kind: "nope" } },
      { ...acceptedBody("r4").header, source: { kind: "user", extra: 1 } },
      { ...acceptedBody("r4").header, source: { kind: "extension", entryId: "e" } },
      { ...acceptedBody("r4").header, agentId: "" },
    ];
    for (const header of bad) {
      const h = harness();
      await tryAccept(h, "r4", header);
      expect(await h.store.readRunIndex("r4")).toBeNull();
    }
  });

  test("合法 header（含 sessionId:null 与 extension source）照常通过", async () => {
    const h = harness();
    const env = await h.seq.appendBoundary(
      boundary("run.accepted", { header: { ...acceptedBody("r5").header, sessionId: null, source: { kind: "extension", entryId: "e", sourceId: "s" } } }, "r5"),
    );
    await h.flush();
    expect(env.name).toBe("run.accepted");
    expect(await h.store.readRunIndex("r5")).not.toBeNull();
  });
});

describe("RunIndex 建立之前的 gap 必须是 runtime-scoped（2026-08-27 review P0）", () => {
  test("失败的 run.accepted：gap 不挂 runId，且不污染 capture 账本", async () => {
    // 修复前实测：gap.scope.runId="r1"、committedPrefix=2、RunIndex("r1")=null
    // ——违反「run-scoped gap 同事务更新 RunIndex」与「retention 窗口内 index 缺失即 corruption」
    const h = harness();
    await h.seq.appendBoundary(boundary("run.accepted", { header: { runId: "r1" } }, "r1")).catch(() => {});
    await h.flush();
    const gap = h.seq.committedRecords().find((r) => r.name === "observation.gap")!;
    expect(gap.scope.runId).toBeUndefined();
    expect(await h.store.readRunIndex("r1")).toBeNull();
    expect(h.seq.captureStateOf("r1")).toBeUndefined(); // runGaps 不留条目 → 不构成内存增长面
  });

  test("同 runId 重试成功后不被前一次失败污染", async () => {
    const h = harness();
    await h.seq.appendBoundary(boundary("run.accepted", { header: { runId: "r6" } }, "r6")).catch(() => {});
    await h.flush();
    await acceptRun(h, "r6");
    await h.flush();
    expect(await h.store.readRunIndex("r6")).not.toBeNull();
    expect(h.seq.captureStateOf("r6")).toBeUndefined(); // 新 run 一开始不该被标 partial
  });

  test("accepted 成功之后的失败才挂 runId", async () => {
    const h = harness();
    await acceptRun(h, "r7");
    h.seq.offer(bounded({ bad: NaN }, { scope: { runtimeId: RT, runId: "r7" } }));
    await h.flush();
    const gap = h.seq.committedRecords().find((r) => r.name === "observation.gap")!;
    expect(gap.scope.runId).toBe("r7");
    expect(h.seq.captureStateOf("r7")?.count).toBe(1);
  });
});

describe("record 不许引用不存在的 run（2026-08-27 review P0，双层防御）", () => {
  test("第一层：offer() 上未建立的 run → hole + runtime-scoped gap，绝不落 record", async () => {
    // 修复前实测：records=[{name:"x", scope:{runtimeId:"rt", runId:"ghost"}}]、index=null、prefix=1
    // ——「有 canonical record、无 RunIndex」，retention 之后查询面无从解释
    const h = harness();
    h.seq.offer(bounded({ a: 1 }, { name: "x", scope: { runtimeId: RT, runId: "ghost" } }));
    await h.flush();
    const recs = h.seq.committedRecords();
    expect(recs.map((r) => r.name)).toEqual(["observation.gap"]);
    expect(recs[0]?.scope.runId).toBeUndefined(); // gap 本身也是 runtime-scoped
    expect(await h.store.readRunIndex("ghost")).toBeNull();
    expect(h.seq.persistenceState.status).toBe("healthy"); // 不是 corruption，只是这条事实进不去
  });

  test("boundary lane 的普通 record（非 run boundary 名）同款拒绝", async () => {
    const h = harness();
    await expect(h.seq.appendBoundary(boundary("checkpoint", { ok: 1 }, "ghost"))).rejects.toThrow(/未建立或已封口的 run/);
    await h.flush();
    expect(h.seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
    expect(await h.store.readRunIndex("ghost")).toBeNull();
  });

  test("run.started / run.closed 在未建立的 run 上仍是 pre-reservation 拒，不留任何记录", async () => {
    for (const [name, body] of [
      ["run.started", { startedBy: "permit-executor" }],
      ["run.closed", { outcome: { status: "completed" }, finalSnapshot: null }],
    ] as const) {
      const h = harness();
      await expect(h.seq.appendBoundary(boundary(name, body, "ghost"))).rejects.toThrow(/尚未发/);
      await h.flush();
      expect(h.seq.committedRecords()).toEqual([]);
      expect(await h.store.readRunIndex("ghost")).toBeNull();
    }
  });

  test("第二层：commit input 里出现引用不存在 index 的 run effect → corruption + seal，不推进 head", async () => {
    // 第一层挡住之后这条走不到，所以直接把 candidate 的 indexEffect 改成 record 来验第二层是否真的在
    const h = harness();
    await acceptRun(h, "r1");
    await h.flush();
    const before = h.seq.committedSeq;
    h.seq.offer(bounded({ a: 1 }, { name: "x", scope: { runtimeId: RT, runId: "r1" } }));
    // 篡改内部状态：让这条 record 指向一个 index 里没有的 run
    const slots = (h.seq as unknown as { slots: Map<number, { runId?: string }> }).slots;
    const slot = slots.get(before + 1)!;
    slots.set(before + 1, { ...slot, runId: "ghost" } as never);
    await h.flush();
    expect(h.seq.persistenceState.status).toBe("sealed");
    expect(h.seq.committedSeq).toBe(before); // head 没被推进
    expect(await h.store.readRunIndex("ghost")).toBeNull();
  });

  test("正向：同一 batch 内 accepted → record 合法，index.lastSeq 跟着走", async () => {
    const h = harness();
    const p = h.seq.appendBoundary(boundary("run.accepted", acceptedBody("r2"), "r2"));
    h.seq.offer(bounded({ a: 1 }, { name: "x", scope: { runtimeId: RT, runId: "r2" } }));
    await p;
    await h.flush();
    expect(h.seq.committedRecords().map((r) => r.name)).toEqual(["run.accepted", "x"]);
    const idx = await h.store.readRunIndex("r2");
    expect(idx?.lastSeq).toBe(2);
    expect(h.seq.persistenceState.status).toBe("healthy");
  });

  test("正向：没有 runId 的 runtime-scoped record 完全不受影响", async () => {
    const h = harness();
    h.seq.offer(bounded({ a: 1 }, { name: "runtime-only" }));
    await h.flush();
    expect(h.seq.committedRecords().map((r) => r.name)).toEqual(["runtime-only"]);
  });
});

describe("封口是终态：run.closed 之后不再收任何记录（2026-08-27 review P0）", () => {
  async function closedRun(runId: string): Promise<Harness> {
    const h = harness();
    await acceptRun(h, runId);
    await h.seq.appendBoundary(boundary("run.closed", closedBody("completed"), runId));
    await h.flush();
    return h;
  }

  test("迟到的有效 record：不落 journal，index 的 lastSeq / status 一个都不动", async () => {
    // 修复前实测：seq 3 的 "late" 落在 terminalRecordId=rt:2、status=completed 之后，index.lastSeq 被推到 3
    const h = await closedRun("r1");
    const before = await h.store.readRunIndex("r1");
    h.seq.offer(bounded({ a: 1 }, { name: "late", scope: { runtimeId: RT, runId: "r1" } }));
    await h.flush();
    const after = await h.store.readRunIndex("r1");
    expect(h.seq.committedRecords().map((r) => r.name)).not.toContain("late");
    expect(after?.lastSeq).toBe(before?.lastSeq);
    expect(after?.terminalRecordId).toBe("rt-test:2");
    expect(after?.header.status).toBe("completed");
    expect(h.seq.persistenceState.status).toBe("healthy");
  });

  test("迟到记录被裁决成 runtime-scoped gap——留痕，但不挂到已封口的 run 上", async () => {
    const h = await closedRun("r2");
    h.seq.offer(bounded({ a: 1 }, { name: "late", scope: { runtimeId: RT, runId: "r2" } }));
    await h.flush();
    const gap = h.seq.committedRecords().find((r) => r.name === "observation.gap")!;
    expect(gap.scope.runId).toBeUndefined();
  });

  test("迟到且编码失败的 record：integrity 不被改回 partial，capture accumulator 不被重建", async () => {
    // 修复前实测：index 从 complete 改成 partial、lastSeq 变 4，
    // 且封口时已释放的 capture accumulator 被重新创建（既标错 partial 又是内存增长面）
    const h = await closedRun("r3");
    const before = await h.store.readRunIndex("r3");
    expect(before?.header.integrity).toBe("complete");
    h.seq.offer(bounded({ bad: NaN }, { name: "late-bad", scope: { runtimeId: RT, runId: "r3" } }));
    await h.flush();
    const after = await h.store.readRunIndex("r3");
    expect(after?.header.integrity).toBe("complete");
    expect(after?.lastSeq).toBe(before?.lastSeq);
    expect(h.seq.captureStateOf("r3")).toBeUndefined();
  });

  test("boundary lane 的普通 record 落在已封口的 run 上：同款拒绝", async () => {
    const h = await closedRun("r4");
    await expect(h.seq.appendBoundary(boundary("checkpoint", { ok: 1 }, "r4"))).rejects.toThrow(/已封口/);
    await h.flush();
    expect(h.seq.committedRecords().map((r) => r.name)).not.toContain("checkpoint");
  });

  test("第二层：commit input 里出现落在已封口 run 上的 effect → corruption + seal", async () => {
    const h = harness();
    await acceptRun(h, "r5");
    await h.seq.appendBoundary(boundary("run.closed", closedBody("completed"), "r5"));
    await h.flush();
    const before = h.seq.committedSeq;
    // 第一层挡住之后走不到这里，所以直接把 candidate 的 runId 塞回已封口的 run，验第二层真的在
    h.seq.offer(bounded({ a: 1 }, { name: "x" }));
    const slots = (h.seq as unknown as { slots: Map<number, { runId?: string; indexEffect?: unknown }> }).slots;
    const slot = slots.get(before + 1)!;
    slots.set(before + 1, { ...slot, runId: "r5", indexEffect: { kind: "record" } } as never);
    await h.flush();
    expect(h.seq.persistenceState.status).toBe("sealed");
    expect(h.seq.committedSeq).toBe(before);
  });

  test("正向：封口之前的 record 照常入库并推进 lastSeq", async () => {
    const h = harness();
    await acceptRun(h, "r6");
    h.seq.offer(bounded({ a: 1 }, { name: "mid", scope: { runtimeId: RT, runId: "r6" } }));
    await h.seq.appendBoundary(boundary("run.closed", closedBody("completed"), "r6"));
    await h.flush();
    expect(h.seq.committedRecords().map((r) => r.name)).toEqual(["run.accepted", "mid", "run.closed"]);
    expect((await h.store.readRunIndex("r6"))?.lastSeq).toBe(3);
  });
});

describe("RunIndex 的状态转换契约（2026-08-27 review P0）", () => {
  /** 绕过第一层：直接把 candidate 的 runId / indexEffect 换成指定 effect，验第二层是否真的挡得住。 */
  async function bypassOnClosedRun(runId: string, effect: unknown): Promise<{ h: Harness; before: RunIndexEntryV1 | null; head: number }> {
    const h = harness();
    await acceptRun(h, runId);
    await h.seq.appendBoundary(boundary("run.closed", closedBody("completed"), runId));
    await h.flush();
    const before = await h.store.readRunIndex(runId);
    const head = h.seq.committedSeq;
    h.seq.offer(bounded({ a: 1 }, { name: "x" }));
    const slots = (h.seq as unknown as { slots: Map<number, Record<string, unknown>> }).slots;
    const slot = slots.get(head + 1)!;
    slots.set(head + 1, { ...slot, runId, indexEffect: effect });
    await h.flush();
    return { h, before, head };
  }

  test("accepted 落在已存在的 index 上 → corruption + seal，终态不被重置", async () => {
    // 修复前实测：acceptedRecordId 变 rt:3、firstSeq/lastSeq 变 3、status 回到 running、
    // terminalRecordId 被抹成 null，而 persistence 还是 healthy——终态就这么没了
    const { h, before, head } = await bypassOnClosedRun("r1", { kind: "accepted", seed: acceptedBody("r1").header });
    expect(h.seq.persistenceState.status).toBe("sealed");
    expect(h.seq.committedSeq).toBe(head);
    expect(await h.store.readRunIndex("r1")).toEqual(before);
  });

  test("closed 落在已封口的 run 上 → corruption + seal，终态不被覆盖", async () => {
    // 修复前实测：terminalRecordId 变 rt:3、status 从 completed 变 error，persistence 仍 healthy
    const { h, before, head } = await bypassOnClosedRun("r2", { kind: "closed", body: { outcome: { status: "error" } } });
    expect(h.seq.persistenceState.status).toBe("sealed");
    expect(h.seq.committedSeq).toBe(head);
    expect(await h.store.readRunIndex("r2")).toEqual(before);
  });

  test("started 落在已封口的 run 上 → 同款 corruption + seal", async () => {
    const { h, before, head } = await bypassOnClosedRun("r3", { kind: "started" });
    expect(h.seq.persistenceState.status).toBe("sealed");
    expect(h.seq.committedSeq).toBe(head);
    expect(await h.store.readRunIndex("r3")).toEqual(before);
  });

  test("started 重复登记也是 corruption——index 上的 startedRecordId 只许写一次", async () => {
    const h = harness();
    await acceptRun(h, "r4");
    await h.seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, "r4"));
    await h.flush();
    const before = await h.store.readRunIndex("r4");
    const head = h.seq.committedSeq;
    h.seq.offer(bounded({ a: 1 }, { name: "x" }));
    const slots = (h.seq as unknown as { slots: Map<number, Record<string, unknown>> }).slots;
    const slot = slots.get(head + 1)!;
    slots.set(head + 1, { ...slot, runId: "r4", indexEffect: { kind: "started" } });
    await h.flush();
    expect(h.seq.persistenceState.status).toBe("sealed");
    expect(await h.store.readRunIndex("r4")).toEqual(before);
  });

  test("正向：accepted → started → closed 的合法链条不受影响", async () => {
    const h = harness();
    await acceptRun(h, "r5");
    await h.seq.appendBoundary(boundary("run.started", { startedBy: "permit-executor" }, "r5"));
    await h.seq.appendBoundary(boundary("run.closed", closedBody("completed"), "r5"));
    await h.flush();
    const idx = await h.store.readRunIndex("r5");
    expect(idx?.acceptedRecordId).toBe("rt-test:1");
    expect(idx?.startedRecordId).toBe("rt-test:2");
    expect(idx?.terminalRecordId).toBe("rt-test:3");
    expect(idx?.header.status).toBe("completed");
    expect(h.seq.persistenceState.status).toBe("healthy");
  });
});
