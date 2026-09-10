import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { openObservationReader, ObservationDatabaseMissingError } from "../src/index.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, errorTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { Provider } from "../src/provider/types.ts";
import { renderRunObservation, buildRunObservationViewModel } from "../src/observability/render.ts";
import { RUN_ASSEMBLY_RECORD } from "../src/observability/draft.ts";
import { ObservationRuntime } from "../src/observability/runtime.ts";
import { observationHostOf } from "../src/observability/host-wiring.ts";
import { SqliteCanonicalObservationStore, observationDatabasePath } from "../src/observability/sqlite-store.ts";
import { sealAgentAssemblyObservation } from "../src/observability/assembly.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import type { BoundedObservationDraft } from "../src/observability/draft.ts";
import type { RunModelBinding } from "../src/admission/types.ts";
import type { RunObservation } from "../src/observability/types.ts";
import { mkdtempSync } from "node:fs";

// **user 层要隔离**（2026-09-03）：`stateDir` 只管这一段 session 的目录，记忆与技能在 ECHO_HOME 下，
// 不设它就会读到开发机上真的 `~/.echo/skills`——实测过 skill 池莫名多出一条。
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

// O3a 的端到端判据：**committed send → getRun → render 出非空稳定文本**。
// 真 createEcho（真 FileDir + 真文件锁 + 真 bun:sqlite），scripted Provider + 进程内 builtin test Tool；
// completed / error / abort 三条路径都能按 runId 取到已 COMMIT 的 record 并渲染；Tool 抛错仍配对；压小 ring 产生
// canonical gap 时 integrity=partial 且 renderer 显示；离线 reader 在活 writer 旁边读到同一份。

const temps: string[] = [];
const running: Echo[] = [];

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-e2e-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const echo of running.splice(0)) await echo.stop().catch(() => {});
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

function scripted(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

function pingTool(execute: ModelTool["execute"] = async () => toolOk("pong")): ModelTool {
  return {
    kind: "model",
    name: "ping",
    label: "ping",
    description: "回一个 pong",
    parameters: { type: "object", properties: {} },
    execute,
  };
}

/**
 * 缺省 `withoutMemory: true`：装了记忆的 Agent 在每个用户 run 之后会自动排一次 Dream run，它同样是 accepted run、
 * 同样进 journal（见下面「Dream run」那条），会让 lastRun / listRuns 的断言变成时序题。要它的测试显式打开。
 */
async function echoWith(opts: {
  stateDir: string;
  turns: ScriptedTurn[];
  tool?: ModelTool;
  withMemory?: boolean;
  capture?: "off" | "metadata" | "content";
}): Promise<Echo> {
  const echo = await createEcho({
    provider: scripted(opts.turns),
    allowNetwork: false,
    stateDir: opts.stateDir,
    extensionDirs: [],
    withoutMemory: opts.withMemory !== true,
    agent: { tools: [opts.tool ?? pingTool()] },
    ...(opts.capture !== undefined ? { observation: { capture: opts.capture } } : {}),
  });
  running.push(echo);
  await echo.agent.start();
  return echo;
}

function names(o: RunObservation): string[] {
  return o.records.map((r) => `${r.kind}:${r.name}`);
}

describe("send → getRun → render（completed）", () => {
  test("一次模型生成 + 一次 Tool 调用：三条边界、span 配对、summary、非空文本；JSON round-trip 后渲染不变", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [toolTurn("c1", "ping", {}), textTurn("done")] });

    const result = await echo.send("跑一次");
    expect(result.outcome.kind).toBe("completed");
    expect(result.runId).toMatch(/^run:/);
    expect(result.observation).toEqual({ runtimeId: expect.stringMatching(/^rt:/), runId: result.runId });
    expect(result.observationIntegrity).toBe("complete");
    expect(result.observationPersistence).toBe("stored");

    const lookup = await echo.observations.getRun(result.runId);
    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") throw new Error("unreachable");
    const o = lookup.observation;
    expect(o.status).toBe("completed");
    expect(o.integrity).toBe("complete");
    expect(o.persistence).toBe("stored");
    expect(o.source).toEqual({ kind: "user" });
    expect(o.sessionId).not.toBeNull();
    expect(o.startedAt).not.toBeNull();
    expect(o.endedAt).not.toBeNull();
    expect(o.outcome).toEqual({ status: "completed" });

    // 边界三条 + 装配快照，顺序固定；AgentEvent 投影出的 span 在中间
    const n = names(o);
    expect(n[0]).toBe("event:run.accepted");
    expect(n[1]).toBe(`snapshot:${RUN_ASSEMBLY_RECORD}`);
    expect(n[2]).toBe("event:run.started");
    expect(n[n.length - 1]).toBe("event:run.closed");
    expect(n).toContain("event:agent.loop.started");
    expect(n).toContain("event:agent.loop.ended");
    expect(n.filter((x) => x === "span_start:turn.execute").length).toBe(2);
    expect(n.filter((x) => x === "span_end:model.generate").length).toBe(2);
    expect(n).toContain("span_start:tool.execute");
    expect(n).toContain("span_end:tool.execute");
    // 每条 run 内记录都带 runId；turn 内的 model / tool span 带 turnId
    for (const r of o.records) expect(r.scope.runId).toBe(result.runId);
    // AgentEvent 经 tap 缓冲**严格按 seq** 释放（慢持久化时后到的 seq 不许抢先）：投影记录的 sourceSeq 随 canonical seq 单调递增
    const sourceSeqs = o.records.filter((r) => r.sourceSeq !== undefined).map((r) => r.sourceSeq!);
    expect(sourceSeqs.length).toBeGreaterThan(5);
    for (let i = 1; i < sourceSeqs.length; i++) expect(sourceSeqs[i]!).toBeGreaterThan(sourceSeqs[i - 1]!);
    expect(o.records.find((r) => r.name === "model.generate")?.scope.turnId).toBe(`${result.runId}/1#1`);
    expect(o.records.find((r) => r.name === "tool.execute")?.scope.toolCallId).toBe("c1");

    // 装配快照与 model binding 来自 run.assembly（withoutMemory：没有 memory 槽）
    expect(o.agentAssembly.slots.map((s) => s.slot)).toEqual(["inbox", "lock", "models", "schedule", "session", "skill", "store", "task"]);
    expect(o.modelBinding).toEqual({ providerId: "scripted", modelId: "only", catalogRevision: expect.stringMatching(/^standalone:/), configDigest: expect.any(String) });
    expect(o.finalSnapshot?.state.agent.activeRunId).toBe(result.runId);
    expect(o.finalSnapshot?.state.runtime.phase).toBe("ready");
    expect(o.gaps).toEqual([]);
    expect(o.summary.model.calls).toBe(2);
    expect(o.summary.tools).toEqual([expect.objectContaining({ toolId: "ping", calls: 1, successes: 1, errors: 0 })]);
    expect(o.summary.recordCount).toBe(o.records.length);

    const text = renderRunObservation(o, { format: "text" });
    expect(text.mediaType).toBe("text/plain");
    expect(text.content.length).toBeGreaterThan(200);
    expect(text.content.startsWith(`Run ${result.runId} · completed · observation complete · `)).toBe(true);
    expect(text.content).toContain("tool.execute");
    expect(text.content).toContain("ping calls=1 ok=1 err=0");
    expect(text.content).toContain("persistence stored");
    // JSON round-trip（canonical serializer 之后 renderer 结果不变）
    const round = JSON.parse(JSON.stringify(o)) as RunObservation;
    expect(renderRunObservation(round, { format: "text" }).content).toBe(text.content);
    const json = renderRunObservation(o, { format: "json" });
    expect(JSON.parse(json.content)).toEqual(JSON.parse(JSON.stringify(buildRunObservationViewModel(o))));

    // lastRun / listRuns / unknown
    const last = await echo.observations.lastRun();
    expect(last.kind === "found" && last.observation.runId).toBe(result.runId);
    const page = await echo.observations.listRuns();
    expect(page.items.map((h) => h.runId)).toEqual([result.runId]);
    expect(page.nextCursor).toBeNull();
    expect(await echo.observations.getRun("run:nope")).toEqual({ kind: "unknown" });

    // snapshot：ready、healthy、无活动 run
    const snap = await echo.observations.snapshot();
    expect(snap.phase).toBe("ready");
    expect(snap.status).toBe("ready");
    expect(snap.health.persistence.status).toBe("healthy");
    expect(snap.throughSeq).toBeGreaterThanOrEqual(o.records.length);
    expect(snap.activeRuns).toEqual([]);
  });

  test("两次 send 是两个 run，各自封口；listRuns 倒序；离线 reader 在活 writer 旁边读到同一份", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [textTurn("one"), textTurn("two")] });
    const a = await echo.send("a");
    const b = await echo.send("b");
    expect(a.runId).not.toBe(b.runId);
    const page = await echo.observations.listRuns({ limit: 1 });
    expect(page.items.map((h) => h.runId)).toEqual([b.runId]);
    expect(page.nextCursor).not.toBeNull();
    const page2 = await echo.observations.listRuns({ limit: 1, cursor: page.nextCursor! });
    expect(page2.items.map((h) => h.runId)).toEqual([a.runId]);

    const reader = await openObservationReader({ stateRoot: stateDir });
    try {
      const offline = await reader.getRun(a.runId);
      const live = await echo.observations.getRun(a.runId);
      expect(offline).toEqual(live);
      const last = await reader.lastRun();
      expect(last.kind === "found" && last.observation.runId).toBe(b.runId);
      expect((await reader.runtimeHeads()).length).toBe(1);
      expect(await reader.counts()).toEqual({ runs: 2, records: expect.any(Number) });
    } finally {
      await reader.close();
    }
  });
  test("记忆的后台活不再是 admission run：用户那条照常可查，run 列表里只有它", async () => {
    // **2026-09-08 翻向**：dream（与新加的提取）从 admission 挪进了各自的独立通道——
    // 走 maintenance 许可的代价是提取会被连续对话整段抢掉。代价是它们不再产生 run 级观测；
    // 记忆本身的动作仍然可查，那是 `memory.mutation.*` 那族事实（见 memory/observe.ts）。
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [textTurn("one")], withMemory: true });
    const user = await echo.send("a");
    expect(user.outcome.kind).toBe("completed");

    // 给后台通道一点时间：就算它跑了，也不该出现在 run 列表里
    await new Promise((r) => setTimeout(r, 50));
    const page = await echo.observations.listRuns({ limit: 5 });
    expect(page.items.map((h) => h.source.kind)).toEqual(["user"]);
    expect((await echo.observations.getRun(user.runId)).kind).toBe("found");
    // 装了记忆这件事仍然在装配快照里看得见
    const lookup = await echo.observations.getRun(user.runId);
    expect(lookup.kind === "found" && lookup.observation.agentAssembly.slots.map((s) => s.slot).includes("memory")).toBe(true);
  });


  test("stop 之后库已关；reader 仍能读；没记录过的 state root 打开 reader 是明确的 missing 错误", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [textTurn("one")] });
    const r = await echo.send("a");
    await echo.stop();
    const reader = await openObservationReader({ stateRoot: stateDir });
    const lookup = await reader.getRun(r.runId);
    expect(lookup.kind).toBe("found");
    await reader.close();

    const err = await openObservationReader({ stateRoot: join(await tmp(), "never") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservationDatabaseMissingError);
  });
});

describe("error / abort / Tool 抛错", () => {
  test("provider 不可重试错误 → outcome error；run.closed 仍 stored、outcome 只带 code + digest", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [errorTurn("boom", "provider exploded: secret=abc", false)] });
    const result = await echo.send("x");
    expect(result.outcome.kind).toBe("error");
    expect(result.observationPersistence).toBe("stored");
    const lookup = await echo.observations.getRun(result.runId);
    if (lookup.kind !== "found") throw new Error(`expected found, got ${lookup.kind}`);
    expect(lookup.observation.status).toBe("error");
    expect(lookup.observation.outcome?.status).toBe("error");
    expect(lookup.observation.outcome?.error?.code).toBe("boom");
    const text = renderRunObservation(lookup.observation, { format: "text" }).content;
    expect(text).toContain("· error · observation complete");
    expect(text).not.toContain("secret=abc"); // metadata：错误正文不进 canonical
  });

  test("Tool 抛错：tool.execute 仍配对（isError）、run 完整封口 completed", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({
      stateDir,
      turns: [toolTurn("c1", "ping", {}), textTurn("recovered")],
      tool: pingTool(async () => {
        throw new Error("tool crashed");
      }),
    });
    const result = await echo.send("x");
    expect(result.outcome.kind).toBe("completed");
    const lookup = await echo.observations.getRun(result.runId);
    if (lookup.kind !== "found") throw new Error(`expected found, got ${lookup.kind}`);
    const o = lookup.observation;
    expect(names(o).filter((n) => n === "span_end:tool.execute").length).toBe(1);
    expect(o.records.find((r) => r.kind === "span_end" && r.name === "tool.execute")?.attributes.isError).toBe(true);
    expect(o.summary.tools).toEqual([expect.objectContaining({ toolId: "ping", calls: 1, successes: 0, errors: 1 })]);
    expect(o.status).toBe("completed");
  });

  test("run 中 abort → outcome aborted；边界照样封口", async () => {
    const stateDir = join(await tmp(), "state");
    let echoRef: Echo | undefined;
    const echo = await echoWith({
      stateDir,
      turns: [toolTurn("c1", "ping", {}), textTurn("never")],
      tool: pingTool(async () => {
        echoRef?.agent.abort("test");
        return toolOk("pong");
      }),
    });
    echoRef = echo;
    const result = await echo.send("x");
    expect(result.outcome.kind).toBe("aborted");
    const lookup = await echo.observations.getRun(result.runId);
    if (lookup.kind !== "found") throw new Error(`expected found, got ${lookup.kind}`);
    expect(lookup.observation.status).toBe("aborted");
    expect(names(lookup.observation)[names(lookup.observation).length - 1]).toBe("event:run.closed");
    expect(renderRunObservation(lookup.observation, { format: "text" }).content).toContain("· aborted ·");
  });
});

describe("canonical gap（硬门 4）", () => {
  function bounded(rt: ObservationRuntime, runId: string, n: number): BoundedObservationDraft {
    return {
      lane: "bounded",
      occurredAt: 1_000 + n,
      kind: "event",
      name: "test.event",
      scope: { runtimeId: rt.runtimeId, runId },
      correlation: {},
      generation: { runtime: rt.runtimeGeneration },
      owner: { status: "not-applicable" },
      instrumentation: { name: "test", version: "1" },
      attributes: {},
      body: { n },
    } as BoundedObservationDraft;
  }

  test("人为压小 ring → observation.gap；index integrity=partial；renderer 显示 gap；run.closed 仍 stored", async () => {
    const stateDir = join(await tmp(), "state");
    const store = await SqliteCanonicalObservationStore.open({ path: observationDatabasePath(stateDir) });
    const clock = new FakeClock(1_000);
    const rt = new ObservationRuntime({
      runtimeId: "rt:gap",
      runtimeGeneration: "boot",
      capturePolicy: "metadata",
      store,
      clock,
      assembly: sealAgentAssemblyObservation([]),
      limits: { ringCapacity: 2, maxBatchDelayMs: 60_000 },
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
    const identity = { agentId: "a", agentInstanceId: "a#1", sessionId: null };
    try {
      rt.acceptRun({ runId: "run:gap", source: { kind: "user" }, ...identity, modelBinding: binding });
      rt.startRun("run:gap", identity);
      // ring 容量 2，delayed flush 不会触发：第三条起溢出 → canonical gap（boundary lane）
      for (let i = 0; i < 5; i++) rt.sequencer.offer(bounded(rt, "run:gap", i));
      await rt.closeRun({ runId: "run:gap", outcome: { kind: "completed" }, finalState: null }, identity);

      const lookup = await rt.observations.getRun("run:gap");
      if (lookup.kind !== "found") throw new Error(`expected found, got ${lookup.kind}`);
      const o = lookup.observation;
      expect(o.integrity).toBe("partial");
      expect(o.persistence).toBe("stored");
      expect(o.status).toBe("completed");
      expect(o.gaps.length).toBeGreaterThanOrEqual(1);
      expect(o.gaps[0]?.reason).toBe("buffer_overflow");
      expect(o.summary.canonicalGapCount).toBe(o.gaps.length);
      const text = renderRunObservation(o, { format: "text" }).content;
      expect(text).toContain("observation partial");
      expect(text).toContain("buffer_overflow(");
      expect(text).toContain("observation.gap");
      expect(rt.persistenceOf("run:gap")).toBe("stored");
      expect(rt.sequencer.persistenceState.status).toBe("healthy");
    } finally {
      await rt.dispose();
    }
  });
});

describe("观测层坏了不影响 agent 主线（2026-09-03 拍板：放弃 fail-closed admission）", () => {
  test("SQLite 在 run 之前被关掉：send 照常 completed、persistence 报 degraded；下一次 send 也照跑；stop 不抛", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [textTurn("one"), textTurn("two")] });
    const rt = observationHostOf(echo.agent)!.runtime;
    rt.store.close(); // 模拟 store 坏掉：之后每次 commit 都抛，writer 会 seal

    const a = await echo.send("a");
    expect(a.outcome.kind).toBe("completed");
    expect(a.observationPersistence).toBe("degraded");
    expect(a.observationIntegrity).toBe("partial");
    expect(rt.sequencer.persistenceState.status).not.toBe("healthy");

    // 修复前：run.accepted 落不下去 → admission 拒绝 → send() 抛 ObservationStoreUnavailableError
    const b = await echo.send("b");
    expect(b.outcome.kind).toBe("completed");
    expect(b.observationPersistence).toBe("degraded");
    expect(echo.agent.messages.filter((m) => m.role === "assistant").length).toBe(2);
    await echo.stop();
  });
});

// 投影的单测证明不了「读得回来」：思考还要穿过 canonical 编码、SQLite、reader 与视图模型。
// 这条走的正是面板读的那条路（buildRunObservationViewModel）。
describe("思考穿过整条链路：canonical → SQLite → reader → 视图模型", () => {
  /** 一轮「先想、再答」：thinking 与 text 两块都进 done 的 message——preserved thinking 就是这个形状。 */
  const thinkTurn: ScriptedTurn = [
    { type: "start" },
    { type: "thinking_start" },
    { type: "thinking_delta", text: "先想一下" },
    { type: "thinking_end", signature: "reasoning_content" },
    { type: "text_start" },
    { type: "text_delta", text: "答案" },
    { type: "text_end" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先想一下", signature: "reasoning_content" },
          { type: "text", text: "答案" },
        ],
        stopReason: "end_turn",
        usage: null,
      },
    },
  ];

  async function generateBody(capture: "metadata" | "content"): Promise<Record<string, unknown>> {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [thinkTurn], capture });
    const result = await echo.send("想想看");
    expect(result.outcome.kind).toBe("completed");
    const lookup = await echo.observations.getRun(result.runId);
    if (lookup.kind !== "found") throw new Error("run 没读回来");
    const vm = buildRunObservationViewModel(lookup.observation);
    const end = vm.timeline.find((t) => t.kind === "span_end" && t.name === "model.generate");
    if (end === undefined) throw new Error("时间线里没有 model.generate 的 span_end");
    return (end.body ?? {}) as Record<string, unknown>;
  }

  test("metadata 档：计数落库读得回来，思考正文一个字都没进库", async () => {
    const body = await generateBody("metadata");
    expect(body.thinkingBlocks).toBe(1);
    expect(body.thinkingChars).toBe(4);
    expect(body.textChars).toBe(2);
    expect(JSON.stringify(body)).not.toContain("先想一下");
  });

  test("content 档：思考与回答分成两个字段读得回来", async () => {
    const body = await generateBody("content");
    expect(body.thinking).toBe("先想一下");
    expect(body.text).toBe("答案");
  });
});
