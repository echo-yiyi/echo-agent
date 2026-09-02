import { test, expect, describe } from "bun:test";
import { Agent } from "../src/agent.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { AgentEvent } from "../src/events.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import { MAX_PROJECTED_TEXT_BYTES, agentEventDescriptor, agentEventTapFor, estimatePayloadBytes, projectAgentEvent } from "../src/observability/agent-events.ts";
import { createInMemoryEngineObservationCollector } from "../src/observability/collector.ts";
import { factSinkToEngineTap, factSinkToIngest, noopFactSink, type CapabilityFactDescriptor } from "../src/observability/fact-sink.ts";
import { InMemoryCanonicalObservationStore } from "../src/observability/store.ts";
import { ObservationIdentityError } from "../src/observability/identity.ts";
import { ObservationSequencer } from "../src/observability/sequencer.ts";
import type { EngineObservationFact, EngineObservationTap } from "../src/observability/engine-tap.ts";
import type { Diagnostic } from "../src/errors.ts";
import { OBSERVATION_ENVELOPE_RESERVE, OBSERVATION_SYNC_LIMITS, type ObservationRecordKind } from "../src/observability/types.ts";

// §15.3.5 / §15.9 / §15.6 / OR2 / OR14：AgentEvent 的固定投影、custom event 的 generic 投影、
// `/engine` collector 与完整 Runtime ingest 两条路径看到**同一 descriptor / body**。

const ev = <T extends object>(seq: number, e: T): AgentEvent => ({ seq, at: 1_000 + seq, ...e }) as unknown as AgentEvent;

/** gap 只有在 run.accepted 成功、RunIndex 已建立之后才挂 runId（2026-08-27 review P0），所以要先建 run。 */
async function establishRun(seq: ObservationSequencer, runId: string, runtimeId = "rt", generation = "g", capturePolicy = "metadata"): Promise<void> {
  await seq.appendBoundary({
    lane: "boundary",
    occurredAt: 1_000,
    kind: "event",
    name: "run.accepted",
    scope: { runtimeId, runId },
    correlation: {},
    generation: { runtime: generation },
    owner: { status: "not-applicable" },
    instrumentation: { name: "t", version: "1" },
    attributes: {},
    body: {
      header: {
        runId,
        source: { kind: "user" },
        runtimeId,
        agentId: "a",
        agentInstanceId: "a#1",
        sessionId: "main",
        runtimeGeneration: generation,
        capturePolicy,
        acceptedAt: 1_000,
      },
    },
  } as never);
}

describe("CoreAgentEvent 逐 type 固定投影（metadata 档）", () => {
  const cases: [AgentEvent, ObservationRecordKind, string][] = [
    [ev(1, { type: "agent_start" }), "event", "agent.loop.started"],
    [ev(2, { type: "turn_start", iteration: 1 }), "span_start", "turn.execute"],
    [ev(3, { type: "message_start", role: "assistant" }), "span_start", "model.generate"],
    [ev(4, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: null, at: 1 } }), "span_end", "model.generate"],
    [ev(5, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "q" }], at: 1 } }), "event", "agent.message.appended"],
    [ev(6, { type: "tool_execution_start", toolCallId: "c1", toolName: "echo", params: { text: "x" } }), "span_start", "tool.execute"],
    [ev(7, { type: "tool_execution_end", toolCallId: "c1", toolName: "echo", result: { content: "ok", isError: false, metadata: null } }), "span_end", "tool.execute"],
    [ev(8, { type: "turn_end", iteration: 1, message: { role: "assistant", content: [], stopReason: "end_turn", usage: null, at: 1 }, toolResults: [] }), "span_end", "turn.execute"],
    [ev(9, { type: "compaction_start", reason: "auto" }), "span_start", "context.compact"],
    [ev(10, { type: "compaction_end", reason: "auto", compaction: { spans: [{ from: 0, to: 2, summary: "s" }], clearedBefore: 0 }, stages: ["summary"], contextTokens: 12 }), "span_end", "context.compact"],
    [ev(11, { type: "retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 10, cause: "rate_limit" }), "event", "model.retry.scheduled"],
    [ev(12, { type: "usage", usage: { inputTokens: 3, outputTokens: 4 } }), "event", "model.usage"],
    [ev(13, { type: "resource_changed", kind: "tool", action: "added", name: "x", source: "test" }), "event", "agent.resource.changed"],
    [ev(14, { type: "queue_update", queue: "inbox", size: 2 }), "event", "agent.queue.updated"],
    [ev(15, { type: "agent_end", outcome: { kind: "completed" } }), "event", "agent.loop.ended"],
  ];
  for (const [event, kind, name] of cases) {
    test(`${event.type} → ${kind} ${name}`, () => {
      const p = projectAgentEvent(event, "metadata")!;
      expect(p.kind).toBe(kind);
      expect(p.name).toBe(name);
      expect(p.occurredAt).toBe(event.at);
      expect(p.sourceSeq).toBe(event.seq);
    });
  }

  test("off 档一律不生成；metadata 档 message_update / tool_execution_update 不成记录", () => {
    expect(projectAgentEvent(ev(1, { type: "agent_start" }), "off")).toBeNull();
    const upd = ev(2, { type: "message_update", delta: { type: "text_delta", text: "a" }, message: { role: "assistant", content: [], stopReason: "end_turn", usage: null, at: 1 } });
    expect(projectAgentEvent(upd, "metadata")).toBeNull();
    expect(projectAgentEvent(upd, "content")?.name).toBe("model.generate.delta");
    const tupd = ev(3, { type: "tool_execution_update", toolCallId: "c", partial: "p" });
    expect(projectAgentEvent(tupd, "metadata")).toBeNull();
  });

  test("metadata 只出尺寸与计数，不出正文；content 才带 params / text / result", () => {
    const start = ev(1, { type: "tool_execution_start", toolCallId: "c1", toolName: "echo", params: { text: "secret-text" } });
    const meta = projectAgentEvent(start, "metadata")!.body as Record<string, unknown>;
    expect(JSON.stringify(meta)).not.toContain("secret-text");
    expect(typeof meta.argsBytes).toBe("number");
    const full = projectAgentEvent(start, "content")!.body as Record<string, unknown>;
    expect(full.params).toEqual({ text: "secret-text" });

    const end = ev(2, { type: "tool_execution_end", toolCallId: "c1", toolName: "echo", result: { content: "result-body", isError: false, metadata: { k: 1 } } });
    const metaEnd = projectAgentEvent(end, "metadata")!.body as Record<string, unknown>;
    expect(JSON.stringify(metaEnd)).not.toContain("result-body");
    expect(metaEnd.resultChars).toBe(11);
    expect(metaEnd.hasMetadata).toBe(true);
    expect((projectAgentEvent(end, "content")!.body as Record<string, unknown>).content).toBe("result-body");
  });

  test("agent_end error：metadata 带 code/source/retryable，不带 message；content 才带", () => {
    const e = ev(1, { type: "agent_end", outcome: { kind: "error", error: { source: "provider", code: "rate_limit", retryable: true, message: "429 secret" } } });
    const meta = projectAgentEvent(e, "metadata")!;
    expect(meta.attributes).toEqual({ status: "error", errorCode: "rate_limit", errorSource: "provider" });
    expect(JSON.stringify(meta.body)).not.toContain("429 secret");
    expect((projectAgentEvent(e, "content")!.body as Record<string, unknown>).errorMessage).toBe("429 secret");
  });
});

describe("agent.custom_event（OR2 / §15.11）", () => {
  const custom = ev(9, { type: "memory_retrieval_hit", text: "private memory text", content: "more", unknownKey: { nested: true } });

  test("metadata：body 恒 {}，customEventType/payloadBytes/payloadTruncated 进 attributes，正文零泄露", () => {
    const p = projectAgentEvent(custom, "metadata")!;
    expect(p.name).toBe("agent.custom_event");
    expect(p.body).toEqual({});
    expect(p.attributes.customEventType).toBe("memory_retrieval_hit");
    expect(p.attributes.payloadTruncated).toBe(false);
    expect(typeof p.attributes.payloadBytes).toBe("number");
    expect(JSON.stringify(p)).not.toContain("private memory text");
  });

  test("off 不生成；content 才把其余字段交出去", () => {
    expect(projectAgentEvent(custom, "off")).toBeNull();
    const body = projectAgentEvent(custom, "content")!.body as Record<string, unknown>;
    expect(body.text).toBe("private memory text");
    expect("type" in body).toBe(false);
    expect("seq" in body).toBe(false);
  });

  test("payload 估算：超过同步上限只标 truncated 并给 lower bound；坏 shape 也不抛", () => {
    const big = estimatePayloadBytes({ s: "x".repeat(OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes) });
    expect(big.payloadTruncated).toBe(true);
    expect(big.payloadBytes).toBe(OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes);
    const bad = estimatePayloadBytes({ n: NaN });
    expect(bad.payloadTruncated).toBe(true);
    expect(estimatePayloadBytes({ a: 1 })).toEqual({ payloadBytes: 7, payloadTruncated: false }); // {"a":1}
  });
});

describe("collector：有界、no-throw、只读快照", () => {
  test("超过 capacity 只计 overflow + 一条诊断；快照是拷贝", () => {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata", capacity: 2 });
    const fact = (n: number): EngineObservationFact => ({ schemaVersion: 1, kind: "event", name: `f${n}`, occurredAt: n, scope: {}, attributes: {}, body: {} });
    c.tap.offer(fact(1));
    c.tap.offer(fact(2));
    expect(() => c.tap.offer(fact(3))).not.toThrow();
    expect(c.snapshot().map((f) => f.name)).toEqual(["f1", "f2"]);
    expect(c.overflowCount).toBe(1);
    expect(c.diagnostics.map((d) => d.code)).toEqual(["collector_overflow"]);
    const snap = c.snapshot();
    c.clear();
    expect(snap).toHaveLength(2);
    expect(c.snapshot()).toHaveLength(0);
  });
});

describe("engine fact 与 canonical 共用同一 admission boundary（review P1，两轮）", () => {
  const fact = (body: unknown): EngineObservationFact => ({ schemaVersion: 1, kind: "event", name: "big", occurredAt: 1, scope: {}, attributes: {}, body: body as never });
  const descriptorFor = (body: unknown): CapabilityFactDescriptor<unknown> => ({
    instrumentation: { name: "t", version: "1" },
    project: () => ({ kind: "event", name: "big", occurredAt: 1, scope: {}, attributes: {}, body }),
  });

  /** 同一条事实两条路各跑一遍，返回各自的裁决。 */
  async function bothVerdicts(body: unknown): Promise<{ engine: "accepted" | "rejected"; runtime: "accepted" | "gap" }> {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "content" });
    factSinkToEngineTap(descriptorFor(body), c.tap).offer({});
    const clock = new FakeClock(0);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "content", store: new InMemoryCanonicalObservationStore(), clock });
    factSinkToIngest(descriptorFor(body), seq, { runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "content", owner: { status: "not-applicable" } }).offer({});
    clock.advance(1_000);
    await seq.idle();
    const names = seq.committedRecords().map((r) => r.name);
    return { engine: c.snapshot().length === 1 ? "accepted" : "rejected", runtime: names.includes("observation.gap") ? "gap" : "accepted" };
  }

  test("review 复现的那条（body 65,248）：两面都拒——不再一个 accepted 一个 gap", async () => {
    expect(await bothVerdicts({ s: "x".repeat(65_248) })).toEqual({ engine: "rejected", runtime: "gap" });
  });

  test("engine 接受的，Runtime 一定接受（保留额兜住框架差）", async () => {
    // 贴着 projection 预算的下沿：engine 过得去，envelope 加上框架仍在 64 KiB 内
    const n = OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes - OBSERVATION_ENVELOPE_RESERVE.bytes - 512;
    expect(await bothVerdicts({ s: "x".repeat(n) })).toEqual({ engine: "accepted", runtime: "accepted" });
    expect(await bothVerdicts({ ok: 1 })).toEqual({ engine: "accepted", runtime: "accepted" });
  });

  test("超长 instrumentation.name：两条路都在构造期拒，不会一边收一边成 gap", () => {
    const oversized: CapabilityFactDescriptor<unknown> = {
      instrumentation: { name: "x".repeat(5_000), version: "1" },
      project: () => ({ kind: "event", name: "small", occurredAt: 1, scope: {}, attributes: {}, body: { ok: 1 } }),
    };
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    // review 复现：body 很小、instrumentation 5,000 字节 → engine 收下 "small"、runtime 成 gap
    expect(() => factSinkToEngineTap(oversized, c.tap)).toThrow(ObservationIdentityError);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", store: new InMemoryCanonicalObservationStore(), clock: new FakeClock(0) });
    expect(() => factSinkToIngest(oversized, seq, { runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", owner: { status: "not-applicable" } })).toThrow(ObservationIdentityError);
  });

  test("构造后再改 descriptor.instrumentation.name：两条路都用构造期冻结的副本，不受影响", async () => {
    const mutable = { name: "t", version: "1" };
    const d: CapabilityFactDescriptor<unknown> = {
      instrumentation: mutable,
      project: () => ({ kind: "event", name: "small", occurredAt: 1, scope: {}, attributes: {}, body: { ok: 1 } }),
    };
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    const engineSink = factSinkToEngineTap(d, c.tap);
    const clock = new FakeClock(0);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", store: new InMemoryCanonicalObservationStore(), clock });
    const ingestSink = factSinkToIngest(d, seq, { runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", owner: { status: "not-applicable" } });

    // 构造完再改成 9,000 字节——之前 /engine 照收、Runtime 成 gap
    mutable.name = "x".repeat(9_000);
    engineSink.offer({});
    ingestSink.offer({});
    clock.advance(1_000);
    await seq.idle();

    expect(c.snapshot().map((f) => f.name)).toEqual(["small"]);
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["small"]);
    expect(seq.committedRecords()[0]?.instrumentation).toEqual({ name: "t", version: "1" });
  });

  test("超长 owner.entryId 同样在构造期拒", () => {
    const d = descriptorFor({ ok: 1 });
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", store: new InMemoryCanonicalObservationStore(), clock: new FakeClock(0) });
    const owner = { status: "known", entryId: "x".repeat(5_000), entryGeneration: "1", via: "assembly" } as const;
    expect(() => factSinkToIngest(d, seq, { runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", owner })).toThrow(ObservationIdentityError);
  });

  test("9,000 字节 subject：两面都拒——subject 现在随 fact 一起走，并共用同一把尺", async () => {
    const withSubject: CapabilityFactDescriptor<unknown> = {
      instrumentation: { name: "t", version: "1" },
      project: () => ({ kind: "event", name: "small", occurredAt: 1, scope: {}, attributes: {}, body: { ok: 1 }, subject: { kind: "k", id: "x".repeat(9_000) } }),
    };
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    const diags: string[] = [];
    factSinkToEngineTap(withSubject, c.tap, { report: (d) => diags.push(d.code) }).offer({});
    expect(c.snapshot()).toHaveLength(0); // 之前这里会收下一条 "small"
    expect(diags).toEqual(["observation_fact_dropped"]);

    const clock = new FakeClock(0);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", store: new InMemoryCanonicalObservationStore(), clock });
    factSinkToIngest(withSubject, seq, { runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", owner: { status: "not-applicable" } }).offer({});
    clock.advance(1_000);
    await seq.idle();
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
  });

  test("合法 subject 随 fact 一起进 collector 快照", () => {
    const d: CapabilityFactDescriptor<unknown> = {
      instrumentation: { name: "t", version: "1" },
      project: () => ({ kind: "event", name: "ok", occurredAt: 1, scope: {}, attributes: {}, body: {}, subject: { kind: "memory", id: "people/alice" } }),
    };
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    factSinkToEngineTap(d, c.tap).offer({});
    expect(c.snapshot()[0]?.subject).toEqual({ kind: "memory", id: "people/alice" });
  });

  test("fact sink 的 reporter 抛错击穿不了 offer() 的 no-throw", () => {
    const bad: CapabilityFactDescriptor<unknown> = {
      instrumentation: { name: "t", version: "1" },
      project: () => ({ kind: "event", name: "x", occurredAt: 1, scope: {}, attributes: {}, body: { n: NaN } }),
    };
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    const sink = factSinkToEngineTap(bad, c.tap, {
      report: () => {
        throw new Error("reporter boom");
      },
    });
    expect(() => sink.offer({})).not.toThrow();
  });

  test("collector 直接 offer 超预算的 fact → 拒收 + 诊断，不入快照", () => {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "content", capacity: 1 });
    expect(() => c.tap.offer(fact({ s: "x".repeat(65_248) }))).not.toThrow();
    expect(c.snapshot()).toHaveLength(0);
    expect(c.rejectedCount).toBe(1);
    expect(c.diagnostics.map((d) => d.code)).toEqual(["collector_fact_rejected"]);
    c.tap.offer(fact({ ok: 1 }));
    expect(c.snapshot()).toHaveLength(1);
  });

  test("被拒的 fact 不撑大 diagnostics：5000 次拒收只留一条样本 + 计数；clear() 一并重置", () => {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "content" });
    const oversized = fact({ s: "x".repeat(65_248) });
    for (let i = 0; i < 5_000; i++) c.tap.offer(oversized);
    expect(c.snapshot()).toHaveLength(0);
    expect(c.rejectedCount).toBe(5_000);
    expect(c.diagnostics).toHaveLength(1); // 之前是 5000——「bounded」当场作废
    expect(c.diagnostics[0]?.message).not.toContain("xxxx");
    c.clear();
    expect(c.rejectedCount).toBe(0);
    expect(c.diagnostics).toHaveLength(0);
    c.tap.offer(fact({ ok: 1 }));
    expect(c.snapshot()).toHaveLength(1);
  });

  test("engine adapter 超限只丢 + 诊断，诊断不带原文", () => {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "content" });
    const diags: string[] = [];
    factSinkToEngineTap(descriptorFor({ s: "x".repeat(65_248) }), c.tap, { report: (d) => diags.push(`${d.code}:${d.message}`) }).offer({});
    expect(c.snapshot()).toHaveLength(0);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain("observation_fact_dropped");
    expect(diags[0]).not.toContain("xxxx");
  });
});

describe("fact sink 两条 adapter", () => {
  type Fact = { op: "write"; path: string; chars: number };
  const descriptor: CapabilityFactDescriptor<Fact> = {
    instrumentation: { name: "echo.memory", version: "1" },
    project: (f, policy) => ({
      kind: "event",
      name: "memory.mutation.committed",
      occurredAt: 5,
      scope: {},
      attributes: { operation: f.op },
      body: policy === "content" ? { chars: f.chars, path: f.path } : { chars: f.chars },
    }),
  };

  test("noop sink 永不抛；engine adapter 把 descriptor 投影成 fact；normalize 失败只丢 + 诊断", () => {
    expect(() => noopFactSink<Fact>().offer({ op: "write", path: "p", chars: 1 })).not.toThrow();
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    const diags: string[] = [];
    const sink = factSinkToEngineTap(descriptor, c.tap, { report: (d) => diags.push(d.code), scope: () => ({ agentId: "a1" }) });
    sink.offer({ op: "write", path: "people/alice.md", chars: 12 });
    const [f] = c.snapshot();
    expect(f?.name).toBe("memory.mutation.committed");
    expect(f?.scope).toEqual({ agentId: "a1" });
    expect(f?.body).toEqual({ chars: 12 });
    expect(JSON.stringify(f)).not.toContain("alice");
    // 坏 body：descriptor 返回 NaN → 只丢这一条
    const badDesc: CapabilityFactDescriptor<Fact> = { ...descriptor, project: () => ({ kind: "event", name: "x", occurredAt: 1, scope: {}, attributes: {}, body: { n: NaN } }) };
    expect(() => factSinkToEngineTap(badDesc, c.tap, { report: (d) => diags.push(d.code) }).offer({ op: "write", path: "p", chars: 0 })).not.toThrow();
    expect(diags).toEqual(["observation_fact_dropped"]);
    expect(c.snapshot()).toHaveLength(1);
  });

  test("同一事实经 collector 与经 Sequencer，name / kind / attributes / body 完全相同（O3a 门 9 的两路对齐）", async () => {
    const fact: Fact = { op: "write", path: "projects/echo.md", chars: 40 };
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    factSinkToEngineTap(descriptor, c.tap).offer(fact);

    const clock = new FakeClock(0);
    const store = new InMemoryCanonicalObservationStore();
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", store, clock });
    factSinkToIngest(descriptor, seq, { runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", owner: { status: "known", entryId: "echo:memory", entryGeneration: "1", via: "assembly" } }).offer(fact);
    clock.advance(1_000);
    await seq.idle();

    const engineFact = c.snapshot()[0]!;
    const canonical = seq.committedRecords()[0]!;
    expect(canonical.name).toBe(engineFact.name);
    expect(canonical.kind).toBe(engineFact.kind);
    expect(canonical.attributes).toEqual(engineFact.attributes);
    expect(canonical.body).toEqual(engineFact.body);
    expect(canonical.instrumentation).toEqual({ name: "echo.memory", version: "1" });
    expect(canonical.owner).toEqual({ status: "known", entryId: "echo:memory", entryGeneration: "1", via: "assembly" });
  });
});

describe("真 Agent + scripted provider + builtin 工具：tap 看见完整一次执行，且不改 outcome", () => {
  const echo: ModelTool = {
    kind: "model",
    name: "echo",
    label: "回声",
    description: "把输入原样返回",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    execute: async (params) => toolOk(`echo:${String((params as { text: string }).text)}`),
  };
  const turns = () => [toolTurn("c1", "echo", { text: "hi" }), textTurn("done")];

  test("collector 收到 loop / turn / model / tool 的 span 与事件，顺序按 seq", async () => {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn(turns()), tools: [echo], observationTap: agentEventTapFor(c.tap) });
    const result = await agent.prompt("说 hi");
    expect(result.outcome.kind).toBe("completed");
    const names = c.snapshot().map((f) => `${f.kind}:${f.name}`);
    // prompt() 先把用户消息 append（单一 append 路径），再发 agent_start
    expect(names[0]).toBe("event:agent.message.appended");
    expect(names.indexOf("event:agent.loop.started")).toBeLessThan(names.indexOf("span_start:turn.execute"));
    expect(names).toContain("span_start:turn.execute");
    expect(names).toContain("span_start:model.generate");
    expect(names).toContain("span_end:model.generate");
    expect(names).toContain("span_start:tool.execute");
    expect(names).toContain("span_end:tool.execute");
    expect(names.at(-1)).toBe("event:agent.loop.ended");
    const seqs = c.snapshot().map((f) => f.sourceSeq!);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    const tool = c.snapshot().find((f) => f.name === "tool.execute" && f.kind === "span_end")!;
    expect(tool.scope.toolCallId).toBe("c1");
    expect((tool.body as { isError: boolean }).isError).toBe(false);
  });

  test("装 tap 与不装 tap、以及 tap 抛错，三种情况 outcome 与 transcript 完全相同", async () => {
    const run = async (tap?: Parameters<typeof agentEventTapFor>[0]) => {
      const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn(turns()), tools: [echo], ...(tap === undefined ? {} : { observationTap: agentEventTapFor(tap) }) });
      const r = await agent.prompt("说 hi");
      return { outcome: r.outcome, roles: agent.messages.map((m) => m.role), text: agent.messages.map((m) => JSON.stringify((m as { content?: unknown }).content)) };
    };
    const bare = await run();
    const withTap = await run(createInMemoryEngineObservationCollector({ capturePolicy: "content" }).tap);
    const throwing = await run({
      capturePolicy: "metadata",
      offer: () => {
        throw new Error("tap boom");
      },
    });
    expect(withTap).toEqual(bare);
    expect(throwing).toEqual(bare);
    expect(bare.outcome.kind).toBe("completed");
  });

  test("descriptor 与 tap adapter 是同一份投影：agentEventDescriptor.project === projectAgentEvent", () => {
    expect(agentEventDescriptor.project).toBe(projectAgentEvent);
  });
});

describe("descriptor.project 抛错：canonical 路径必须留 hole + gap（2026-08-27 review P1）", () => {
  const boom = (): CapabilityFactDescriptor<unknown> => ({
    instrumentation: { name: "t", version: "1" },
    project: () => {
      throw new Error("projection boom");
    },
  });

  async function offerThrough(scope?: () => { runId?: string }, establish?: string): Promise<{ seq: ObservationSequencer; diags: string[] }> {
    const clock = new FakeClock(0);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", store: new InMemoryCanonicalObservationStore(), clock });
    if (establish !== undefined) await establishRun(seq, establish);
    const diags: string[] = [];
    factSinkToIngest(boom(), seq, {
      runtimeId: "rt",
      runtimeGeneration: "g",
      capturePolicy: "metadata",
      owner: { status: "not-applicable" },
      report: (d) => diags.push(d.code),
      ...(scope === undefined ? {} : { scope }),
    }).offer({});
    clock.advance(1_000);
    await seq.idle();
    return { seq, diags };
  }

  test("review 复现：投影抛错不再只剩一条诊断，committed 里有 observation.gap", async () => {
    const { seq, diags } = await offerThrough();
    // 修复前实测：diagnostics=["observation_fact_dropped"]、committed=0、canonicalGapCount=0
    expect(diags).toEqual(["observation_fact_dropped"]);
    expect(seq.health().capture.canonicalGapCount).toBe(1);
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
  });

  test("gap body 恰好覆盖失败身份那一个 seq，reason 归 encoding_error", async () => {
    const { seq } = await offerThrough();
    const gap = seq.committedRecords()[0]!;
    const body = gap.body as { afterSeq: number; beforeSeq: number; dropped: number; reason: string };
    expect(body.dropped).toBe(1);
    expect(body.reason).toBe("encoding_error");
    expect(body.beforeSeq - body.afterSeq).toBe(2); // 中间恰好盖住 1 个 seq
    expect(gap.seq).toBe(body.beforeSeq);
  });

  test("gap 挂在调用时刻的 runId 上——scope 供给在 project 之前读", async () => {
    const { seq } = await offerThrough(() => ({ runId: "run-7" }), "run-7");
    expect(seq.committedRecords()[0]?.scope.runId).toBe("run-7");
  });

  test("scope 供给自己抛错也不吞掉 gap，只是没有 runId", async () => {
    const { seq, diags } = await offerThrough(() => {
      throw new Error("scope boom");
    });
    expect(diags).toEqual(["observation_fact_dropped"]);
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
    expect(seq.committedRecords()[0]?.scope.runId).toBeUndefined();
  });

  test("`/engine` 那条路没有 canonical journal，仍然只丢记录 + 诊断", () => {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    const diags: string[] = [];
    factSinkToEngineTap(boom(), c.tap, { report: (d) => diags.push(d.code) }).offer({});
    expect(c.snapshot()).toEqual([]);
    expect(diags).toEqual(["observation_fact_dropped"]);
  });

  test("project 返回 null 是正常省略，不产生 gap", async () => {
    const clock = new FakeClock(0);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", store: new InMemoryCanonicalObservationStore(), clock });
    factSinkToIngest({ instrumentation: { name: "t", version: "1" }, project: () => null }, seq, {
      runtimeId: "rt",
      runtimeGeneration: "g",
      capturePolicy: "metadata",
      owner: { status: "not-applicable" },
    }).offer({});
    clock.advance(1_000);
    await seq.idle();
    expect(seq.health().capture.canonicalGapCount).toBe(0);
    expect(seq.committedRecords()).toEqual([]);
  });
});

describe("AgentEvent projector 自己也在同步预算内（2026-08-27 review P1）", () => {
  /** 只暴露 length 与下标的 content：数一数投影到底碰了多少个 block。 */
  function countingBlocks(total: number, make: (i: number) => unknown): { blocks: never; reads: () => number } {
    let reads = 0;
    // target 必须真是数组：`messageBody()` 先过 `Array.isArray()` 才认这条 content
    const proxy = new Proxy(
      [] as unknown[],
      {
        get(t, k) {
          if (k === "length") return total;
          if (typeof k === "string" && /^\d+$/.test(k)) {
            reads += 1;
            return make(Number(k));
          }
          return Reflect.get(t, k);
        },
      },
    );
    return { blocks: proxy as never, reads: () => reads };
  }

  const assistantEnd = (content: unknown): AgentEvent =>
    ev(1, { type: "message_end", message: { role: "assistant", content, stopReason: "end_turn", usage: null, at: 1 } });

  test("metadata 档：50 万个 tool_use 只走有界扫描，不建中间数组", () => {
    const { blocks, reads } = countingBlocks(500_000, (i) => ({ type: "tool_use", id: `c${i}`, name: "t", input: { i } }));
    const body = projectAgentEvent(assistantEnd(blocks), "metadata")!.body as Record<string, unknown>;
    // 修复前：整条 content 被遍历 + toolUsesOf() 建 50 万项数组，只为取 .length
    expect(reads()).toBeLessThanOrEqual(1_024);
    expect(body.contentBlocks).toBe(500_000);
    expect(body.contentTruncated).toBe(true);
    expect(body.contentBlocksScanned).toBe(1_024);
    expect(body.toolUses).toBe(1_024); // 已扫描范围内的计数，truncated 标志已说明它不是全量
  });

  test("metadata 档不产生正文：textChars 是计数，body 里没有 text", () => {
    const { blocks } = countingBlocks(2_000, () => ({ type: "text", text: "x".repeat(1_000) }));
    const body = projectAgentEvent(assistantEnd(blocks), "metadata")!.body as Record<string, unknown>;
    expect(body.text).toBeUndefined();
    expect(body.textChars).toBe(1_024 * 1_000);
  });

  test("content 档：正文按上限截断并标 textTruncated，不做无界拼接", () => {
    const { blocks, reads } = countingBlocks(500_000, () => ({ type: "text", text: "x".repeat(1_000) }));
    const body = projectAgentEvent(assistantEnd(blocks), "content")!.body as Record<string, unknown>;
    expect(reads()).toBeLessThanOrEqual(1_024);
    expect((body.text as string).length).toBe(MAX_PROJECTED_TEXT_BYTES);
    expect(body.textTruncated).toBe(true);
    expect(body.contentTruncated).toBe(true);
  });

  test("content 档只扫一遍：同一个 block 不被读第二次", () => {
    const { blocks, reads } = countingBlocks(10, (i) => (i % 2 === 0 ? { type: "text", text: "ab" } : { type: "tool_use", id: `c${i}`, name: "t", input: {} }));
    const body = projectAgentEvent(assistantEnd(blocks), "content")!.body as Record<string, unknown>;
    // 修复前：metadata 两遍（textOf + toolUsesOf）+ content 再两遍 = 40 次下标读
    expect(reads()).toBe(10);
    expect(body.text).toBe("ababababab");
    expect((body.toolUseBlocks as unknown[]).length).toBe(5);
  });

  test("没超上限时不标 truncated，计数与正文都是全量", () => {
    const body = projectAgentEvent(assistantEnd([{ type: "text", text: "hi" }, { type: "tool_use", id: "c", name: "t", input: {} }]), "content")!.body as Record<string, unknown>;
    expect(body.contentTruncated).toBeUndefined();
    expect(body.textTruncated).toBeUndefined();
    expect(body.textChars).toBe(2);
    expect(body.toolUses).toBe(1);
    expect(body.text).toBe("hi");
  });

  test("非 assistant message 的 body 同样有界（agent.message.appended）", () => {
    const { blocks, reads } = countingBlocks(500_000, () => ({ type: "text", text: "y" }));
    const e = ev(2, { type: "message_end", message: { role: "user", content: blocks, at: 1 } });
    const body = projectAgentEvent(e, "metadata")!.body as Record<string, unknown>;
    expect(reads()).toBeLessThanOrEqual(1_024);
    expect(body.contentTruncated).toBe(true);
    expect(body.chars).toBe(1_024);
  });

  test("string content 也按上限截断", () => {
    const e = ev(3, { type: "message_end", message: { role: "user", content: "z".repeat(200_000), at: 1 } });
    const body = projectAgentEvent(e, "content")!.body as Record<string, unknown>;
    expect(body.chars).toBe(200_000); // 计数是全量（读 .length 是 O(1)）
    expect((body.text as string).length).toBe(MAX_PROJECTED_TEXT_BYTES);
    expect(body.textTruncated).toBe(true);
  });
});

describe("scope 供给失败不许静默丢 run 归属（2026-08-27 review P1）", () => {
  const okDescriptor: CapabilityFactDescriptor<unknown> = {
    instrumentation: { name: "t", version: "1" },
    project: () => ({ kind: "event", name: "fine", occurredAt: 1, scope: {}, attributes: {}, body: { ok: 1 } }),
  };

  async function offerWithScope(scope: () => never | object, establish?: string): Promise<{ seq: ObservationSequencer; diags: string[]; threw: boolean }> {
    const clock = new FakeClock(0);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "metadata", store: new InMemoryCanonicalObservationStore(), clock });
    if (establish !== undefined) await establishRun(seq, establish);
    const diags: string[] = [];
    const sink = factSinkToIngest(okDescriptor, seq, {
      runtimeId: "rt",
      runtimeGeneration: "g",
      capturePolicy: "metadata",
      owner: { status: "not-applicable" },
      report: (d) => diags.push(d.code),
      scope: scope as () => Record<string, string>,
    });
    let threw = false;
    try {
      sink.offer({});
    } catch {
      threw = true;
    }
    clock.advance(1_000);
    await seq.idle();
    return { seq, diags, threw };
  }

  test("review 复现①：scope() 抛错不再被当成 `{}` 正常记成 runtime-scoped，而是开 gap", async () => {
    // 修复前实测：gaps=0、diags=[]，事实照记，原 run 仍可能显示 complete
    const { seq, diags, threw } = await offerWithScope(() => {
      throw new Error("scope boom");
    });
    expect(threw).toBe(false);
    expect(diags).toEqual(["observation_fact_dropped"]);
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
    expect(seq.health().capture.canonicalGapCount).toBe(1);
  });

  test("review 复现②：scope 是 Proxy 时 offer() 不许抛出——值取自 descriptor，get trap 根本不执行", async () => {
    // 修复前：读取 callScope.runId 那行在外层 try 之外，get trap 一抛就击穿 never-throw 契约。
    // 现在值取自 descriptor，这个 trap 没有被调用的机会，事实照常记下且 runId 是 descriptor 的真值。
    let getCalls = 0;
    const hostile = new Proxy(
      { runId: "r1" },
      {
        get(_t, k) {
          getCalls += 1;
          if (k === "runId") throw new Error("runId trap");
          return undefined;
        },
      },
    );
    const { seq, diags, threw } = await offerWithScope(() => hostile, "r1");
    expect(threw).toBe(false);
    expect(getCalls).toBe(0);
    expect(diags).toEqual([]);
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["run.accepted", "fine"]);
    expect(seq.committedRecords().find((r) => r.name === "fine")?.scope.runId).toBe("r1");
  });

  test("getOwnPropertyDescriptor trap 抛错的 scope：offer() 仍不抛，开 runtime-scoped gap", async () => {
    const hostile = new Proxy(
      { runId: "r1" },
      {
        getOwnPropertyDescriptor(): never {
          throw new Error("descriptor trap");
        },
      },
    );
    const { seq, diags, threw } = await offerWithScope(() => hostile);
    expect(threw).toBe(false);
    expect(diags).toEqual(["observation_fact_dropped"]);
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
    expect(seq.committedRecords()[0]?.scope.runId).toBeUndefined(); // 连键集都读不出来才退成 runtime-scoped
  });

  test("review 复现③：scope() 返回 null / undefined 也是失败，不再落回「没配供给」那条合法路径", async () => {
    // 修复前实测：records=["fine"]、gaps=0、diags=[]——和「只有没配供给才是合法空 scope」这句注释打架
    for (const empty of [null, undefined]) {
      const { seq, diags } = await offerWithScope(() => empty as unknown as Record<string, string>);
      expect(diags).toEqual(["observation_fact_dropped"]);
      expect(seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
    }
    // 要表达「这条事实确实没有 scope」，供给必须显式返回 {}
    const { seq, diags } = await offerWithScope(() => ({}));
    expect(diags).toEqual([]);
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["fine"]);
  });

  test("坏字段不连坐好字段：runId 合法时 gap 一律挂对 run（review P1 的四种输入）", async () => {
    const accessor = { runId: "run-9" };
    Object.defineProperty(accessor, "sessionId", { get: () => "s", enumerable: true, configurable: true });
    const nonEnum = { runId: "run-9" };
    Object.defineProperty(nonEnum, "sessionId", { value: "s", enumerable: false, configurable: true });
    const symbolKey = { runId: "run-9", [Symbol("s")]: 1 };
    const cases: Record<string, unknown>[] = [{ runId: "run-9", nope: "x" }, accessor, nonEnum, symbolKey];
    for (const bad of cases) {
      const { seq } = await offerWithScope(() => bad as Record<string, string>, "run-9");
      const gap = seq.committedRecords().find((r) => r.name === "observation.gap")!;
      expect(gap.name).toBe("observation.gap");
      expect(gap.scope.runId).toBe("run-9");
    }
  });

  test("scope 里别的字段坏了、runId 还好：gap 仍挂到正确的 run 上", async () => {
    const { seq } = await offerWithScope(() => ({ runId: "run-9", sessionId: 123 }) as unknown as Record<string, string>, "run-9");
    const gap = seq.committedRecords().find((r) => r.name === "observation.gap")!;
    expect(gap.name).toBe("observation.gap");
    expect(gap.scope.runId).toBe("run-9");
  });

  test("连 runId 都读不出来才退成 runtime-scoped gap", async () => {
    const { seq } = await offerWithScope(() => new Map([["runId", "run-9"]]) as unknown as Record<string, string>);
    const gap = seq.committedRecords()[0]!;
    expect(gap.name).toBe("observation.gap");
    expect(gap.scope.runId).toBeUndefined();
  });

  test("未登记键 / class 实例一律判失败，不被洗成空 scope", async () => {
    class Scoped {
      runId = "run-1";
    }
    for (const bad of [{ nope: "x" }, new Scoped()]) {
      const { seq } = await offerWithScope(() => bad as unknown as Record<string, string>);
      expect(seq.committedRecords().map((r) => r.name)).toEqual(["observation.gap"]);
    }
  });

  test("正常 scope 仍照走，不产生 gap", async () => {
    const { seq, diags } = await offerWithScope(() => ({ runId: "run-1", sessionId: "s1" }), "run-1");
    expect(diags).toEqual([]);
    expect(seq.committedRecords().map((r) => r.name)).toEqual(["run.accepted", "fine"]);
    expect(seq.committedRecords().find((r) => r.name === "fine")?.scope.runId).toBe("run-1");
  });

  test("`/engine` 侧同一把尺：scope 物化失败即拒，不静默记成无 scope 的 fact", () => {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "metadata" });
    const diags: string[] = [];
    factSinkToEngineTap(okDescriptor, c.tap, {
      report: (d) => diags.push(d.code),
      scope: () => {
        throw new Error("scope boom");
      },
    }).offer({});
    expect(c.snapshot()).toEqual([]);
    expect(diags).toEqual(["observation_fact_dropped"]);
  });
});

describe("content 档正文按整条 fact 的剩余预算截断（2026-08-27 review P2）", () => {
  const assistantText = (chars: number, ch = "x"): AgentEvent =>
    ev(1, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ch.repeat(chars) }], stopReason: "end_turn", usage: null, at: 1 } });

  /** 穿过 `/engine` adapter：collector 收到 = 通过了整条 fact 的编码预算。 */
  function throughEngine(e: AgentEvent): { accepted: boolean; truncated: boolean } {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "content" });
    factSinkToEngineTap(agentEventDescriptor, c.tap).offer(e);
    const snap = c.snapshot();
    const body = snap[0]?.body as Record<string, unknown> | undefined;
    return { accepted: snap.length === 1, truncated: body?.textTruncated === true };
  }

  /** 穿过 Sequencer：committed 里是记录本身而不是 observation.gap。 */
  async function throughSequencer(e: AgentEvent): Promise<{ accepted: boolean; truncated: boolean }> {
    const clock = new FakeClock(0);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "content", store: new InMemoryCanonicalObservationStore(), clock });
    factSinkToIngest(agentEventDescriptor, seq, { runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "content", owner: { status: "not-applicable" } }).offer(e);
    clock.advance(1_000);
    await seq.idle();
    const rec = seq.committedRecords()[0];
    const body = rec?.body as Record<string, unknown> | undefined;
    return { accepted: rec?.name === "model.generate", truncated: body?.textTruncated === true };
  }

  test("review 复现的三个点：50k / 60k / 70k 现在都进得去，60k 与 70k 标 truncated", async () => {
    // 修复前实测：50,000 accepted、60,000 dropped、70,000 被 projector 截断后照样 dropped
    expect(throughEngine(assistantText(40_000))).toEqual({ accepted: true, truncated: false });
    expect(throughEngine(assistantText(50_000))).toEqual({ accepted: true, truncated: true }); // 50k > 预算，如实标 truncated
    expect(throughEngine(assistantText(60_000))).toEqual({ accepted: true, truncated: true });
    expect(throughEngine(assistantText(70_000))).toEqual({ accepted: true, truncated: true });
    expect(await throughSequencer(assistantText(70_000))).toEqual({ accepted: true, truncated: true });
  });

  test("textTruncated:true 的记录必须真能落库——这是这条修复的判据", async () => {
    for (const n of [MAX_PROJECTED_TEXT_BYTES + 1, 200_000, 2_000_000]) {
      expect(throughEngine(assistantText(n)).accepted).toBe(true);
      expect(await throughSequencer(assistantText(n))).toEqual({ accepted: true, truncated: true });
    }
  });

  test("最坏转义（控制字符 6 字节/单位）与多字节字符也过得去，不靠 ASCII 侥幸", async () => {
    for (const ch of ["", "中", "\u{1f600}"]) {
      expect(throughEngine(assistantText(200_000, ch)).accepted).toBe(true);
      expect((await throughSequencer(assistantText(200_000, ch))).accepted).toBe(true);
    }
  });

  test("正文截断按 canonical 字节算，不是 code unit", () => {
    const control = projectAgentEvent(assistantText(200_000, ""), "content")!.body as Record<string, unknown>;
    // 每个控制字符最坏占 6 字节，所以留下的 code unit 数远少于字节预算
    expect((control.text as string).length).toBeLessThanOrEqual(MAX_PROJECTED_TEXT_BYTES / 6);
    const ascii = projectAgentEvent(assistantText(200_000), "content")!.body as Record<string, unknown>;
    expect((ascii.text as string).length).toBe(MAX_PROJECTED_TEXT_BYTES);
  });
});

describe("代理区必须成对看（2026-08-27 review P1）", () => {
  const assistantText = (chars: number, ch: string): AgentEvent =>
    ev(1, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ch.repeat(chars) }], stopReason: "end_turn", usage: null, at: 1 } });

  function throughEngine(e: AgentEvent): { accepted: boolean; truncated: boolean } {
    const c = createInMemoryEngineObservationCollector({ capturePolicy: "content" });
    factSinkToEngineTap(agentEventDescriptor, c.tap).offer(e);
    const snap = c.snapshot();
    const body = snap[0]?.body as Record<string, unknown> | undefined;
    return { accepted: snap.length === 1, truncated: body?.textTruncated === true };
  }

  async function throughSequencer(e: AgentEvent): Promise<boolean> {
    const clock = new FakeClock(0);
    const seq = new ObservationSequencer({ runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "content", store: new InMemoryCanonicalObservationStore(), clock });
    factSinkToIngest(agentEventDescriptor, seq, { runtimeId: "rt", runtimeGeneration: "g", capturePolicy: "content", owner: { status: "not-applicable" } }).offer(e);
    clock.advance(1_000);
    await seq.idle();
    return seq.committedRecords()[0]?.name === "model.generate";
  }

  test("孤立 surrogate 不许击穿落库保证——JSON.stringify 把它转义成 6 字节", async () => {
    // 修复前：所有 surrogate code unit 一律按 3 字节算，孤立的实际占 6；低估直接导致
    // projectedTextLength=16384、textTruncated=true、accepted=0
    for (const ch of ["\ud800", "\udc00", "\udbff", "\udfff"]) {
      expect(JSON.stringify(ch).length).toBe(8); // "\udXXX" 加两个引号：确认前提没变
      expect(throughEngine(assistantText(200_000, ch))).toEqual({ accepted: true, truncated: true });
      expect(await throughSequencer(assistantText(200_000, ch))).toBe(true);
    }
  });

  test("孤立 surrogate 按 6 字节记：留下的 code unit 数是预算的六分之一", () => {
    const body = projectAgentEvent(assistantText(200_000, "\ud800"), "content")!.body as Record<string, unknown>;
    expect((body.text as string).length).toBe(Math.floor(MAX_PROJECTED_TEXT_BYTES / 6));
  });

  test("合法代理对按 4 字节记且整体推进，截断不会把一对切成孤立 surrogate", () => {
    const body = projectAgentEvent(assistantText(200_000, "\u{1f600}"), "content")!.body as Record<string, unknown>;
    const text = body.text as string;
    expect(text.length % 2).toBe(0); // 每个 emoji 两个 code unit，切在对中间就会是奇数
    expect(/[\ud800-\udbff]$/.test(text)).toBe(false); // 结尾不是落单的高代理
    expect(text.length).toBe(Math.floor(MAX_PROJECTED_TEXT_BYTES / 4) * 2);
  });

  test("高代理紧跟非低代理时按孤立算，不误当成对", () => {
    // "\ud800a" 里的 \ud800 是孤立的（后面不是低代理），必须按 6 记
    const body = projectAgentEvent(assistantText(100_000, "\ud800a"), "content")!.body as Record<string, unknown>;
    const text = body.text as string;
    // 每两个 code unit 花 6 + 1 = 7 字节
    expect(text.length).toBe(Math.floor(MAX_PROJECTED_TEXT_BYTES / 7) * 2);
    expect(throughEngine(assistantText(100_000, "\ud800a")).accepted).toBe(true);
  });
});

describe("async EngineObservationTap 不许重新造出 unhandled rejection（2026-08-27 review P0）", () => {
  /** 声明返回 void，实际返回 reject 的 Promise——TypeScript 放行，运行期就是一颗雷。 */
  function asyncRejectingTap(): { tap: EngineObservationTap; calls: () => number } {
    let calls = 0;
    return {
      tap: {
        capturePolicy: "metadata",
        offer: (): void => {
          calls += 1;
          return Promise.reject(new Error("exporter down")) as unknown as void;
        },
      },
      calls: () => calls,
    };
  }

  async function countUnhandled(fn: () => Promise<void> | void): Promise<number> {
    let n = 0;
    const on = (): void => {
      n += 1;
    };
    process.on("unhandledRejection", on);
    await fn();
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", on);
    return n;
  }

  test("review 复现：adapter 接住 rejection，零 unhandled，且报脱敏诊断", async () => {
    // 修复前实测：{unhandled:1, reported:0}——`tap.offer()` 的返回值被丢掉，
    // 外层 Agent.deliverToTap() 只看得见本 sink 返回的 void，它那道 thenable 防护完全失效
    const t = asyncRejectingTap();
    const diags: Diagnostic[] = [];
    const sink = factSinkToEngineTap(agentEventDescriptor, t.tap, { report: (d) => diags.push(d) });
    const unhandled = await countUnhandled(() => {
      sink.offer(ev(1, { type: "agent_start" }));
    });
    expect(unhandled).toBe(0);
    expect(diags.map((d) => d.code)).toContain("observation_tap_failed");
    expect(JSON.stringify(diags)).not.toContain("exporter down"); // 只出 Name@digest
  });

  test("返回 thenable 后立刻停用该 tap：pending Promise 不会无界累积", async () => {
    const t = asyncRejectingTap();
    const diags: Diagnostic[] = [];
    const sink = factSinkToEngineTap(agentEventDescriptor, t.tap, { report: (d) => diags.push(d) });
    const unhandled = await countUnhandled(() => {
      for (let i = 0; i < 100; i++) sink.offer(ev(i + 1, { type: "agent_start" }));
    });
    expect(unhandled).toBe(0);
    expect(t.calls()).toBe(1); // 第一次之后不再调用它
  });

  test("真实 Agent + async rejecting tap：outcome 不变、零 unhandled", async () => {
    const run = async (tap?: EngineObservationTap): Promise<{ kind: string; text: string }> => {
      const agent = new Agent({
        model: FAKE_MODEL,
        streamFunction: scriptedStreamFn([textTurn("hi")]),
        ...(tap === undefined ? {} : { observationTap: agentEventTapFor(tap) }),
      });
      const r = await agent.prompt("说 hi");
      return { kind: r.outcome.kind, text: JSON.stringify(agent.messages.map((m) => (m as { content?: unknown }).content)) };
    };
    const bare = await run();
    let withTap: { kind: string; text: string } | undefined;
    const unhandled = await countUnhandled(async () => {
      withTap = await run(asyncRejectingTap().tap);
    });
    expect(unhandled).toBe(0);
    expect(withTap).toEqual(bare);
    expect(bare.kind).toBe("completed");
  });
});

describe("async tap 的「报一次」必须真的是一次（2026-08-27 review P1）", () => {
  async function drainMicrotasks(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
  }

  test("native rejecting Promise 只出一条诊断（修复前是 2 条）", async () => {
    const diags: Diagnostic[] = [];
    const sink = factSinkToEngineTap(
      agentEventDescriptor,
      { capturePolicy: "metadata", offer: () => Promise.reject(new Error("exporter down")) as unknown as void },
      { report: (d) => diags.push(d) },
    );
    sink.offer(ev(1, { type: "agent_start" }));
    await drainMicrotasks();
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe("observation_tap_failed");
    expect(JSON.stringify(diags)).not.toContain("exporter down");
  });

  test("自定义 thenable 把 reject 回调调 1000 次，仍然只出一条（修复前是 1001 条）", async () => {
    const diags: Diagnostic[] = [];
    const sink = factSinkToEngineTap(
      agentEventDescriptor,
      {
        capturePolicy: "metadata",
        offer: () =>
          ({
            then: (_res: unknown, rej: (e: unknown) => void) => {
              for (let i = 0; i < 1000; i++) rej(new Error(`boom-${i}`));
            },
          }) as unknown as void,
      },
      { report: (d) => diags.push(d) },
    );
    sink.offer(ev(1, { type: "agent_start" }));
    await drainMicrotasks();
    expect(diags).toHaveLength(1);
  });

  test("同步 resolve 的 thenable 也只出一条，且 tap 已停用", async () => {
    const diags: Diagnostic[] = [];
    let calls = 0;
    const sink = factSinkToEngineTap(
      agentEventDescriptor,
      {
        capturePolicy: "metadata",
        offer: () => {
          calls += 1;
          return { then: (res: () => void) => res() } as unknown as void;
        },
      },
      { report: (d) => diags.push(d) },
    );
    for (let i = 0; i < 10; i++) sink.offer(ev(i + 1, { type: "agent_start" }));
    await drainMicrotasks();
    expect(calls).toBe(1);
    expect(diags).toHaveLength(1);
  });
});

describe("async reporter 不许击穿主流程（2026-08-27 review P0）", () => {
  test("fact sink 的 reporter 返回 reject 的 Promise：零 unhandled rejection", async () => {
    let unhandled = 0;
    const on = (): void => {
      unhandled += 1;
    };
    process.on("unhandledRejection", on);
    const sink = factSinkToEngineTap(
      agentEventDescriptor,
      {
        capturePolicy: "metadata",
        offer: () => {
          throw new Error("tap boom");
        },
      },
      { report: (() => Promise.reject(new Error("reporter down"))) as unknown as (d: Diagnostic) => void },
    );
    sink.offer(ev(1, { type: "agent_start" }));
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", on);
    expect(unhandled).toBe(0);
  });
});

describe("永不 settle 的 tap 也必须可见（2026-08-27 review P1）", () => {
  test("tap 返回永久 pending 的 Promise：立刻报一条诊断并停用", async () => {
    // 修复前实测：calls=1、diagnostics=0——tap 被停用了，故障却完全不可见，
    // 因为诊断只写在 settle 回调里，而它永远不会 settle
    const diags: Diagnostic[] = [];
    let calls = 0;
    const sink = factSinkToEngineTap(
      agentEventDescriptor,
      {
        capturePolicy: "metadata",
        offer: () => {
          calls += 1;
          return new Promise<void>(() => {}) as unknown as void;
        },
      },
      { report: (d) => diags.push(d) },
    );
    sink.offer(ev(1, { type: "agent_start" }));
    sink.offer(ev(2, { type: "agent_start" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe("observation_tap_failed");
  });
});
