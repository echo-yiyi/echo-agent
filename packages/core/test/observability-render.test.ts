import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/schedule/clock.ts";
import { AGENT_ENTRY_ID, ObservationRuntime, builtinOwner } from "../src/observability/runtime.ts";
import { loopFactDescriptor, type LoopFact, type LoopFactBody } from "../src/loop/observe.ts";
import { SqliteCanonicalObservationStore, observationDatabasePath } from "../src/observability/sqlite-store.ts";
import { sealAgentAssemblyObservation } from "../src/observability/assembly.ts";
import { buildRunObservationViewModel, renderRunObservation } from "../src/observability/render.ts";
import type { RunModelBinding } from "../src/admission/types.ts";
import type { AssistantMessage } from "../src/messages.ts";
import type { RunObservation } from "../src/observability/types.ts";

// renderer golden（硬门 3）：锁层级、相对顺序与 redaction，不锁 wall clock / 随机 ID——
// 所以 fixture 用 FakeClock + 固定 runId / runtimeId，经**真实** ObservationRuntime + SQLite 走一遍再渲染。
// 快照文件在 __snapshots__/；改了渲染结构要 `bun test --update-snapshots` 并在 review 里说明为什么。

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const binding: RunModelBinding = {
  bindingId: "b1",
  source: { kind: "user" },
  purpose: "foreground",
  catalogRevision: "standalone:1",
  provider: { id: "scripted", entryId: "echo:models", generation: "builtin" },
  model: { provider: "scripted", id: "only", api: "fake" },
  streamFunction: () => {
    throw new Error("unused");
  },
  thinkingLevel: "off",
  retryPolicy: { maxAttempts: 1, backoffMs: () => 0 } as unknown as RunModelBinding["retryPolicy"],
};

const identity = { agentId: "agent-default", agentInstanceId: "agent-default@fixed", sessionId: "s-1" };

function assistant(text: string, stopReason: AssistantMessage["stopReason"], at: number): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, usage: { inputTokens: 10, outputTokens: 5 }, at, model: { provider: "scripted", id: "only" } } as AssistantMessage;
}

/** 与循环真实执行节点同序的最小脚本：loop_started → turn 1（model + tool）→ turn 2（model）→ loop_ended。 */
function script(): readonly LoopFact[] {
  // 只约束 `kind`，载荷放宽：夹具消息是最小形状，载荷对不对由 golden 与时间线断言验
  const at = (t: number, f: { kind: LoopFactBody["kind"] } & Record<string, unknown>): LoopFact => ({ ...f, at: t }) as unknown as LoopFact;
  const m1 = assistant("call ping", "tool_use", 1_010);
  const m2 = assistant("done", "end_turn", 1_120);
  // 四层齐全（run-loop-layers.md：run ⊃ reply ⊃ turn ⊃ attempt）。turnId 是 loop 产的 `${replyId}#${n}`（loop/ids.ts）。
  // 第二个 turn 里塞一次**重试**：attempt 1 失败 → retry_scheduled → attempt 2 落地，好让 attempt span 的配对真被走到。
  const retryable = { source: "provider", code: "overloaded", retryable: true, message: "upstream busy" } as const;
  return [
    at(1_001, { kind: "loop_started" }),
    at(1_002, { kind: "reply_started", replyId: "run:fixed/1", source: "prompt" }),
    at(1_003, { kind: "turn_started", turnId: "run:fixed/1#1", replyId: "run:fixed/1", cause: "input", tools: ["ping"] }),
    at(1_004, { kind: "attempt_started", turnId: "run:fixed/1#1", attempt: 1 }),
    at(1_005, { kind: "generation_started" }),
    at(1_010, { kind: "message_committed", message: m1 }),
    at(1_011, { kind: "attempt_ended", turnId: "run:fixed/1#1", attempt: 1, result: { kind: "landed", message: m1 } }),
    at(1_012, { kind: "tool_started", toolCallId: "c1", toolName: "ping", params: { a: 1 } }),
    at(1_025, { kind: "tool_ended", toolCallId: "c1", toolName: "ping", result: { content: "pong", isError: false, images: [], metadata: null } }),
    at(1_030, { kind: "turn_ended", turnId: "run:fixed/1#1", result: { kind: "landed", message: m1 }, toolResultCount: 1 }),
    at(1_031, { kind: "turn_started", turnId: "run:fixed/1#2", replyId: "run:fixed/1", cause: "tool_use", tools: ["ping"] }),
    at(1_032, { kind: "attempt_started", turnId: "run:fixed/1#2", attempt: 1 }),
    at(1_033, { kind: "generation_started" }),
    at(1_040, { kind: "attempt_ended", turnId: "run:fixed/1#2", attempt: 1, result: { kind: "failed", error: retryable } }),
    at(1_041, { kind: "retry_scheduled", turnId: "run:fixed/1#2", attempt: 1, maxAttempts: 3, delayMs: 10, cause: "overloaded" }),
    at(1_060, { kind: "attempt_started", turnId: "run:fixed/1#2", attempt: 2 }),
    at(1_061, { kind: "generation_started" }),
    at(1_120, { kind: "message_committed", message: m2 }),
    at(1_121, { kind: "attempt_ended", turnId: "run:fixed/1#2", attempt: 2, result: { kind: "landed", message: m2 } }),
    at(1_122, { kind: "turn_ended", turnId: "run:fixed/1#2", result: { kind: "landed", message: m2 }, toolResultCount: 0 }),
    at(1_123, { kind: "reply_ended", replyId: "run:fixed/1", outcome: { kind: "completed" }, hasFinal: true, turns: 2 }),
    at(1_124, { kind: "loop_ended", outcome: { kind: "completed" } }),
  ];
}

async function fixtureRun(): Promise<RunObservation> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-render-"));
  temps.push(dir);
  const store = await SqliteCanonicalObservationStore.open({ path: observationDatabasePath(dir) });
  const clock = new FakeClock(1_000);
  const rt = new ObservationRuntime({
    runtimeId: "rt:fixed",
    runtimeGeneration: "boot",
    capturePolicy: "metadata",
    store,
    clock,
    assembly: sealAgentAssemblyObservation([
      { slot: "store", entryId: "echo:persistence-local", entryGeneration: "builtin", safeConfig: { kind: "file" } },
      { slot: "memory", entryId: "echo:memory", entryGeneration: "builtin", safeConfig: {} },
    ]),
  });
  try {
    let turnId: string | null = null;
    const sink = rt.capabilitySink(loopFactDescriptor, builtinOwner(AGENT_ENTRY_ID), () => ({ ...identity, runId: "run:fixed", ...(turnId !== null ? { turnId } : {}) }));
    rt.acceptRun({ runId: "run:fixed", source: { kind: "user" }, ...identity, modelBinding: binding });
    clock.advance(1);
    rt.startRun("run:fixed", identity);
    for (const f of script()) {
      // 与 Agent 的 scope 供给同一规则：turn 归属只在 turn 开着时补，用的就是事实里的 turnId（turn_ended 自带，之后清掉）
      if (f.kind === "turn_started") turnId = f.turnId;
      sink.offer(f);
      if (f.kind === "turn_ended") turnId = null;
    }
    clock.advance(130);
    await rt.closeRun(
      {
        runId: "run:fixed",
        outcome: { kind: "completed" },
        finalState: {
          runtime: { phase: "ready", status: "ready", observationPersistence: "healthy", generation: "boot", activeEntryCount: 0 },
          agent: { status: "generating", activeRunId: "run:fixed", activeTurnId: "run:fixed/1#2", iteration: 2, messageCount: 5 },
          capabilities: [],
          omittedCapabilitySummaryCount: 0,
        },
      },
      identity,
    );
    const lookup = await rt.observations.getRun("run:fixed");
    if (lookup.kind !== "found") throw new Error(`expected found, got ${lookup.kind}`);
    return lookup.observation;
  } finally {
    await rt.dispose();
  }
}

describe("renderRunObservation", () => {
  test("text golden：六块结构、层级、相对时间、summary、health", async () => {
    const o = await fixtureRun();
    const text = renderRunObservation(o, { format: "text" });
    expect(text).toMatchObject({ rendererVersion: 1, format: "text", mediaType: "text/plain" });
    expect(text.content).toMatchSnapshot();
  });

  test("includeBody + maxTimelineRecords：截断行与 body 行", async () => {
    const o = await fixtureRun();
    const text = renderRunObservation(o, { format: "text", includeBody: true, maxTimelineRecords: 4 }).content;
    expect(text).toContain("body {");
    expect(text).toContain(`… ${o.records.length - 4} more records`);
  });

  test("json 是 ViewModel 的 canonical JSON；ViewModel 确定性（两次构建逐字相等）", async () => {
    const o = await fixtureRun();
    const a = buildRunObservationViewModel(o);
    const b = buildRunObservationViewModel(JSON.parse(JSON.stringify(o)) as RunObservation);
    expect(a).toEqual(b);
    const json = renderRunObservation(o, { format: "json" });
    expect(json.mediaType).toBe("application/json");
    expect(JSON.parse(json.content)).toEqual(JSON.parse(JSON.stringify(a)));
    // 四层的结构深度：run 0 · reply 与 agent 级事件 1 · turn 2 · attempt 与 turn 里的 model / tool 3
    expect(a.timeline.map((t) => [t.name, t.depth])).toEqual([
      ["run.accepted", 0],
      ["run.assembly", 0],
      ["run.started", 0],
      ["agent.loop.started", 1],
      ["reply.execute", 1],
      ["turn.execute", 2],
      ["attempt.execute", 3],
      ["model.generate", 3],
      ["model.generate", 3],
      ["attempt.execute", 3],
      ["tool.execute", 3],
      ["tool.execute", 3],
      ["turn.execute", 2],
      ["turn.execute", 2],
      ["attempt.execute", 3],
      ["model.generate", 3],
      ["attempt.execute", 3],
      ["model.retry.scheduled", 3], // 排在同一 turn 的两个 attempt 之间，归 turn 而不是 agent 级
      ["attempt.execute", 3],
      ["model.generate", 3],
      ["model.generate", 3],
      ["attempt.execute", 3],
      ["turn.execute", 2],
      ["reply.execute", 1],
      ["agent.loop.ended", 1],
      ["run.closed", 0],
    ]);
    // 两次落地的生成：turn1 的 5ms（1_005→1_010）+ turn2 第二个 attempt 的 59ms（1_061→1_120）
    expect(a.summary.model).toEqual({ calls: 2, inputTokens: 20, outputTokens: 10, totalDurationMs: 64 });
    expect(a.summary.tools[0]).toMatchObject({ toolId: "ping", calls: 1, successes: 1, totalDurationMs: 13 });
    expect(a.finalStateAbsence).toBe("captured");
    expect(a.health).toEqual({ canonicalGaps: [], persistence: "stored", redacted: true });
  });

  test("off policy 的空领域字段显示 not captured by policy；缺 run.assembly 显示 not captured", () => {
    const o: RunObservation = {
      schemaVersion: 1,
      runId: "run:off",
      source: { kind: "user" },
      runtimeId: "rt:off",
      agentId: "a",
      agentInstanceId: "a#1",
      sessionId: null,
      runtimeGeneration: "boot",
      capturePolicy: "off",
      acceptedAt: 1_000,
      startedAt: 1_001,
      endedAt: 1_050,
      status: "completed",
      integrity: "complete",
      persistence: "stored",
      agentAssembly: { digest: "not-captured", slots: [] },
      modelBinding: { providerId: "not-captured", modelId: "not-captured", catalogRevision: "not-captured", configDigest: "not-captured" },
      outcome: { status: "completed" },
      records: [],
      finalSnapshot: null,
      activeEntries: [],
      turnWorksets: [],
      gaps: [],
      summary: { durationMs: 50, recordCount: 0, canonicalGapCount: 0, model: { calls: 0, inputTokens: 0, outputTokens: 0, totalDurationMs: 0 }, tools: [] },
    };
    const text = renderRunObservation(o, { format: "text" }).content;
    expect(text).toContain("Final State         not captured by policy");
    expect(text).toContain("Tool Analysis       not captured by policy");
    expect(text).toContain("assembly not captured");
    expect(buildRunObservationViewModel(o).finalStateAbsence).toBe("not-captured-by-policy");
  });
});
