import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { openObservationReader, ObservationStoreMissingError } from "../src/index.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, errorTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { Provider } from "../src/provider/types.ts";
import { renderRunObservation, buildRunObservationViewModel } from "../src/observability/render.ts";
import { RUN_ASSEMBLY_RECORD } from "../src/observability/draft.ts";
import { ObservationRuntime } from "../src/observability/runtime.ts";
import { STALL_MS } from "../src/observability/thread.ts";
import type { LifecycleEvent } from "../src/events.ts";
import { expireObservations, type ObservationExpiryRule } from "../src/observability/expiry.ts";
import type { CapabilityFactDescriptor } from "../src/observability/fact-sink.ts";
import { DocumentObservationReader } from "../src/observability/document-store.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import type { StorageDir } from "../src/storage/types.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import type { RunModelBinding } from "../src/admission/types.ts";
import type { EchoObservableState, RunObservation } from "../src/observability/types.ts";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";

// **user 层要隔离**（2026-09-03）：`stateDir` 只管这一段 session 的目录，记忆与技能在 ECHO_HOME 下，
// 不设它就会读到开发机上真的 `~/.echo/skills`——实测过 skill 池莫名多出一条。
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

// O3a 的端到端判据：**committed send → getRun → render 出非空稳定文本**。
// 真 createEcho（真 FileDir + 真文件锁 + 真观测线程 + 真观测文档），scripted Provider + 进程内 builtin test Tool；
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
  observationStore?: StorageDir;
  start?: boolean;
  sessionId?: string;
}): Promise<Echo> {
  const echo = await createEcho({
    provider: scripted(opts.turns),
    allowNetwork: false,
    stateDir: opts.stateDir,
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
    extensionDirs: [],
    withoutMemory: opts.withMemory !== true,
    agent: { tools: [opts.tool ?? pingTool()] },
    observation: {
      ...(opts.capture === undefined ? {} : { capture: opts.capture }),
      ...(opts.observationStore === undefined ? {} : { store: opts.observationStore }),
    },
  });
  running.push(echo);
  if (opts.start !== false) await echo.agent.start();
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
    // send() 只给引用，不带观测写没写成（它不等观测线程）：写成与否读回来看
    expect(Object.keys(result).sort()).toEqual(["observation", "outcome", "runId"]);

    const lookup = await echo.observations.getRun(result.runId);
    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") throw new Error("unreachable");
    const o = lookup.observation;
    expect(o.status).toBe("completed");
    expect(o.integrity).toBe("complete");
    expect(o.source).toEqual({ kind: "user" });
    expect(o.sessionId).not.toBeNull();
    expect(o.startedAt).not.toBeNull();
    expect(o.endedAt).not.toBeNull();
    expect(o.outcome).toEqual({ status: "completed" });

    // 边界三条 + 装配快照，顺序固定；执行节点上的探针记下的 span 在中间
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
    // 观测不再骑在 AgentEvent 上：canonical seq 的顺序就是执行节点被走到的顺序。
    // 脚本化的 run 执行顺序是确定的，所以逐项比整段——不许被别的时刻（例如持久化完成的时刻）重排，也不许多一拍少一拍
    // run.started 之后紧跟 run 开头的整体状态快照，再进循环
    expect(n[3]).toBe("snapshot:agent.state");
    expect(n.slice(4, -1)).toEqual([
      "event:agent.loop.started",
      "span_start:reply.execute",
      "event:agent.message.appended", // 用户输入：在它引发的 turn 开始之前入账
      "span_start:turn.execute",
      "span_start:attempt.execute",
      "span_start:model.generate",
      "span_end:model.generate", // 轮 1 生成出 tool_use
      "span_end:attempt.execute",
      "span_start:tool.execute",
      "span_end:tool.execute",
      "event:agent.message.appended", // 工具结果入账
      "span_end:turn.execute",
      "span_start:turn.execute",
      "span_start:attempt.execute",
      "span_start:model.generate",
      "span_end:model.generate", // 轮 2 生成出最终回答
      "span_end:attempt.execute",
      "span_end:turn.execute",
      "span_end:reply.execute",
      "event:agent.loop.ended",
    ]);
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
  test("前台子 agent 是自己的 run：链回派出它的工具调用，turn 挂在自己的 runId 下不与父撞；lastRun 仍是用户那条", async () => {
    // 隔离子循环不进 admission（dream / 提取 / 子 agent 同一段 `runSubagent`），但在账本里各是一个 run
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({
      stateDir,
      turns: [toolTurn("c1", "subagent", { prompt: "child task", tools: [] }), textTurn("child reply"), textTurn("parent done")],
    });
    const user = await echo.send("a");
    expect(user.outcome.kind).toBe("completed");

    const page = await echo.observations.listRuns({ limit: 5 });
    const child = page.items.find((h) => h.source.kind === "subagent");
    expect(page.items.map((h) => h.runId).sort()).toEqual([child!.runId, user.runId].sort());
    expect(child?.source).toEqual({ kind: "subagent", parentRunId: user.runId, parentToolCallId: "c1", background: false });
    expect(child?.status).toBe("completed");
    expect(child?.integrity).toBe("complete");

    const childLookup = await echo.observations.getRun(child!.runId);
    const parentLookup = await echo.observations.getRun(user.runId);
    if (childLookup.kind !== "found" || parentLookup.kind !== "found") throw new Error("unreachable");
    const c = childLookup.observation;
    const p = parentLookup.observation;
    expect(names(c)).toContain("span_start:model.generate");
    expect(c.records.find((r) => r.name === "run.started")?.body).toEqual({ startedBy: "subloop" });
    expect(p.records.find((r) => r.name === "run.started")?.body).toEqual({ startedBy: "permit-executor" });
    // 子循环的每个 turn 都在自己的 runId 下；父 run 里一条都没有
    const childTurns = c.records.flatMap((r) => (r.scope.turnId === undefined ? [] : [r.scope.turnId]));
    expect(childTurns.length).toBeGreaterThan(0);
    expect(childTurns.every((t) => t.startsWith(`${child!.runId}/`))).toBe(true);
    expect(p.records.some((r) => r.scope.turnId?.startsWith(`${child!.runId}/`) === true)).toBe(false);
    // 父 run 里那次派出它的工具调用
    expect(p.records.some((r) => r.name === "tool.execute" && r.scope.toolCallId === "c1")).toBe(true);
    // 子 run 开头的状态：Agent 此刻开着的 admission run 是父
    const state = c.records.find((r) => r.name === "agent.state")?.body as { state: EchoObservableState } | undefined;
    expect(state?.state.agent.activeRunId).toBe(user.runId);
    expect(c.finalSnapshot).not.toBeNull();

    const last = await echo.observations.lastRun();
    expect(last.kind === "found" && last.observation.runId).toBe(user.runId);
  });

  test("记忆提取是自己的 run，它写的记忆事实挂在这个 run 上——不是空 run，也不是父 run（2026-09-14 实测此前 run_id 为空）", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({
      stateDir,
      withMemory: true,
      turns: [
        textTurn("好，记住了"),
        toolTurn("m1", "memory", { command: "create", path: "user/memory/obs-pref.md", file_text: "---\ndescription: 观测判据用的一条\n---\n\n内容" }),
        textTurn("记下了"),
      ],
    });
    const user = await echo.send("以后回答简短一点");
    expect(user.outcome.kind).toBe("completed");

    let extractRunId: string | undefined;
    for (let i = 0; i < 150 && extractRunId === undefined; i++) {
      const h = (await echo.observations.listRuns({ limit: 10 })).items.find((x) => x.source.kind === "extract" && x.status !== "running");
      extractRunId = h?.runId;
      if (extractRunId === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    expect(extractRunId, "提取 run 没有封口").toBeDefined();
    const lookup = await echo.observations.getRun(extractRunId!);
    if (lookup.kind !== "found") throw new Error("提取 run 没读回来");
    const mutation = lookup.observation.records.find((r) => r.name === "memory.mutation.committed");
    expect(mutation, "提取写的记忆事实不在提取 run 里").toBeDefined();
    expect(mutation?.scope.runId).toBe(extractRunId);
    const parent = await echo.observations.getRun(user.runId);
    if (parent.kind !== "found") throw new Error("父 run 没读回来");
    expect(parent.observation.records.some((r) => r.name.startsWith("memory.mutation"))).toBe(false);
  });

  test("后台子 agent 也是自己的 run：background 为 true，父 run 封口之后照样封口", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({
      stateDir,
      // 父的第二轮与后台子 agent 的那一轮并发取脚本，谁拿到哪条不确定——都是纯文本，断言不看正文
      turns: [toolTurn("c1", "subagent", { prompt: "child task", tools: [], background: true }), textTurn("t1"), textTurn("t2"), textTurn("t3"), textTurn("t4")],
    });
    const user = await echo.send("a");
    expect(user.outcome.kind).toBe("completed");

    let child: RunObservation["source"] | undefined;
    let status: string | undefined;
    for (let i = 0; i < 100 && status !== "completed"; i++) {
      const h = (await echo.observations.listRuns({ limit: 10 })).items.find((x) => x.source.kind === "subagent");
      child = h?.source;
      status = h?.status;
      if (status !== "completed") await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe("completed");
    expect(child).toEqual({ kind: "subagent", parentRunId: user.runId, parentToolCallId: "c1", background: true });
  });


  test("stop() 不等观测写完；observations.flush() 之后离线 reader 读得到；没记录过的 state root 打开 reader 是明确的 missing 错误", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [textTurn("one")] });
    const r = await echo.send("a");
    await echo.stop();
    await echo.observations.flush(); // 等的是收摊那一段：观测线程写完手上的
    const reader = await openObservationReader({ stateRoot: stateDir });
    const lookup = await reader.getRun(r.runId);
    expect(lookup.kind).toBe("found");
    await reader.close();

    const err = await openObservationReader({ stateRoot: join(await tmp(), "never") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObservationStoreMissingError);
  });

  test("整体运行状态：run 开头与结尾各一份同形快照——装备、上下文、工作目录、能力摘要；两份一比看得出 run 改了什么", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [toolTurn("c1", "ping", {}), textTurn("done")] });
    const result = await echo.send("跑一次");
    const lookup = await echo.observations.getRun(result.runId);
    if (lookup.kind !== "found") throw new Error("run 没读回来");
    const o = lookup.observation;
    const startRecord = o.records.find((r) => r.kind === "snapshot" && r.name === "agent.state");
    expect(startRecord?.scope.runId).toBe(result.runId);
    expect(startRecord?.attributes.moment).toBe("run_started");
    const start = (startRecord!.body as { state: EchoObservableState }).state;
    const end = o.finalSnapshot!.state;
    for (const st of [start, end]) {
      expect(st.agent.tools).toContain("ping");
      expect(st.agent.thinkingLevel).toBe(echo.agent.thinkingLevel);
      expect(typeof st.agent.workspace).toBe("string");
      expect(st.agent.activeSkills).toEqual([]);
      const ids = st.capabilities.map((c) => c.id);
      expect(ids).toContain("echo:agent"); // 收件箱是 echo:agent 的一部分
      expect(ids).toContain("echo:tasks");
      expect([...ids].sort()).toEqual(ids); // 按 id 排序（terminal 的物化规则，两份同一个校验器）
      for (const c of st.capabilities) expect(c.summary.stateDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // run 开头只有进来的消息，结尾多了模型回复与工具结果
    expect(end.agent.messageCount).toBeGreaterThan(start.agent.messageCount);
    await echo.stop();
  });

  test("生命周期相位在 Agent 自己迁移的节点上记下（run 之外）；stopped 进不了账本，最后一拍是 running→stopping", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [textTurn("one")] });
    await echo.send("a");
    await echo.stop();
    await echo.observations.flush();
    const reader = await openObservationReader({ stateRoot: stateDir });
    try {
      // recentActivity 只读 run 之外的记录，最新在前
      const phases = [...(await reader.recentActivity({ limit: 500 }))].reverse().filter((e) => e.name === "agent.phase.changed");
      expect(phases.map((e) => e.attributes)).toEqual([
        { from: "new", to: "starting" },
        { from: "starting", to: "restored", restoredReason: "deferred-start" },
        { from: "restored", to: "running" },
        // 观测是 stop 流程里被告知收摊的东西之一，`stopping → stopped` 在那之后才成立，观测线程已经不收它
        { from: "running", to: "stopping" },
      ]);
      for (const e of phases) expect(e.instrumentation.name).toBe("echo.agent");
    } finally {
      await reader.close();
    }
  });
});

describe("error / abort / Tool 抛错", () => {
  test("provider 不可重试错误 → outcome error；run.closed 仍 stored、outcome 只带 code + digest", async () => {
    const stateDir = join(await tmp(), "state");
    const echo = await echoWith({ stateDir, turns: [errorTurn("boom", "provider exploded: secret=abc", false)] });
    const result = await echo.send("x");
    expect(result.outcome.kind).toBe("error");
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
  /** 测试用探针：每个事实一条 run 内记录。 */
  const numbered: CapabilityFactDescriptor<number> = {
    instrumentation: { name: "test", version: "1" },
    project: (n) => ({ kind: "event", name: "test.event", occurredAt: 1_000 + n, scope: { runId: "run:gap" }, attributes: {}, body: { n } }),
  };

  test("人为压小 ring → observation.gap；index integrity=partial；renderer 显示 gap；run.closed 仍 stored", async () => {
    const stateDir = join(await tmp(), "state");
    const clock = new FakeClock(1_000);
    const rt = new ObservationRuntime({
      runtimeId: "rt:gap",
      runtimeGeneration: "boot",
      capturePolicy: "metadata",
      store: new FileDir(stateDir),
      storePath: stateDir,
      clock,
      assembly: [],
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
      const sink = rt.capabilitySink(numbered, { status: "not-applicable" });
      rt.acceptRun({ runId: "run:gap", source: { kind: "user" }, ...identity, modelBinding: binding });
      rt.startRun("run:gap", identity, "permit-executor", {
        runtime: { phase: "ready", generation: "boot", activeEntryCount: 0 },
        agent: { status: "generating", activeRunId: "run:gap", activeTurnId: null, iteration: 0, messageCount: 1 } as never,
        capabilities: [],
      });
      // ring 容量 2，delayed flush 不会触发：不管边界那几次提交落在哪一拍，20 条里总有溢出 → canonical gap（boundary lane）
      for (let i = 0; i < 20; i++) sink.offer(i);
      rt.closeRun({ runId: "run:gap", outcome: { kind: "completed" }, finalState: null }, identity);

      const lookup = await rt.observations.getRun("run:gap");
      if (lookup.kind !== "found") throw new Error(`expected found, got ${lookup.kind}`);
      const o = lookup.observation;
      expect(o.integrity).toBe("partial");
      expect(o.status).toBe("completed");
      expect(o.gaps.length).toBeGreaterThanOrEqual(1);
      expect(o.gaps.every((g) => g.reason === "buffer_overflow")).toBe(true);
      expect(o.summary.canonicalGapCount).toBe(o.gaps.length);
      const text = renderRunObservation(o, { format: "text" }).content;
      expect(text).toContain("observation partial");
      expect(text).toContain("buffer_overflow(");
      expect(text).toContain("observation.gap");
      expect((await rt.observations.snapshot()).health.persistence.status).toBe("healthy");
    } finally {
      await rt.dispose();
    }
  });
});

describe("过期归产品：agent 里没有过期，产品自己调 expireObservations（2026-09-14）", () => {
  test("跑完、停下、再起都一条不删；产品在活着的 agent 旁边按规则删，删的是盘上已封口的 run", async () => {
    const stateDir = join(await tmp(), "state");
    const first = await echoWith({ stateDir, turns: [textTurn("one"), textTurn("two")] });
    const a = await first.send("a");
    const b = await first.send("b");
    const sessionId = first.agent.state.sessionId!;
    await first.stop();
    await first.observations.flush();

    const second = await echoWith({ stateDir, turns: [textTurn("three"), textTurn("four")], sessionId });
    const c = await second.send("c");
    expect((await second.observations.listRuns()).items.map((h) => h.runId).sort()).toEqual([a.runId, b.runId, c.runId].sort());

    const keepNewest: ObservationExpiryRule = (runs) => ({ runs: runs.slice(1).map((h) => h.runId) });
    const result = await expireObservations({ stateRoot: stateDir, rule: keepNewest });
    expect([...result.removedRuns].sort()).toEqual([a.runId, b.runId].sort());
    expect((await second.observations.listRuns()).items.map((h) => h.runId)).toEqual([c.runId]);
    expect((await second.observations.getRun(a.runId)).kind).toBe("unknown");
    // 活着的 agent 照常跑、照常记
    const d = await second.send("d");
    expect(d.outcome.kind).toBe("completed");
  });
});

describe("观测不在主流程上（2026-09-14 硬规矩）", () => {
  /** 一个可以卡住的存储：卡着的时候读、写、列一律不返回，`release()` 之后放行。 */
  function stallable(inner: StorageDir): { dir: StorageDir; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const later = <T>(fn: () => Promise<T>): Promise<T> => gate.then(fn);
    return {
      dir: {
        read: (p) => later(() => inner.read(p)),
        write: (p, c) => later(() => inner.write(p, c)),
        remove: (p) => later(() => inner.remove(p)),
        list: (p) => later(() => inner.list(p)),
      },
      release,
    };
  }

  test("观测存储完全卡住：createEcho、start、send、stop 都不等它；放行之后该写的照样写进去", async () => {
    const stateDir = join(await tmp(), "state");
    const inner = new InMemoryDir();
    const stall = stallable(inner);
    try {
      const t0 = performance.now();
      const echo = await echoWith({ stateDir, turns: [toolTurn("c1", "ping", {}), textTurn("done"), textTurn("again")], observationStore: stall.dir });
      const a = await echo.send("a");
      const b = await echo.send("b");
      await echo.stop();
      const elapsed = performance.now() - t0;
      expect(a.outcome.kind).toBe("completed");
      expect(b.outcome.kind).toBe("completed");
      // 此前 admission 要等 run.closed 落盘（最多 500ms）才放行下一个 run：两次 send 至少 1s。现在什么都不等
      expect(elapsed).toBeLessThan(900);
      expect(await inner.list("observability/")).toEqual([]); // 卡着：一个字都还没写

      stall.release();
      await echo.observations.flush();
      const reader = new DocumentObservationReader(inner, "(test)");
      expect((await reader.readRunIndex(a.runId))?.header.status).toBe("completed");
      expect((await reader.readRunIndex(b.runId))?.header.status).toBe("completed");
    } finally {
      stall.release();
    }
  });

  test("观测丢数据不往外报：content 档的大工具结果截断照记，存储写不动也不发任何通知（2026-09-14：观测本身就是日志）", async () => {
    const huge: ModelTool = { ...pingTool(async () => toolOk("x".repeat(200_000))), name: "huge", label: "huge" };
    const echo = await echoWith({ stateDir: join(await tmp(), "state"), turns: [toolTurn("c1", "huge", {}), textTurn("done")], tool: huge, capture: "content" });
    const notices: string[] = [];
    echo.agent.subscribeLifecycle((e: LifecycleEvent) => {
      if (e.type === "notification") notices.push(e.message);
    });
    const r = await echo.send("跑");
    const lookup = await echo.observations.getRun(r.runId);
    if (lookup.kind !== "found") throw new Error("run 没读回来");
    const end = lookup.observation.records.find((x) => x.kind === "span_end" && x.name === "tool.execute");
    expect((end?.body as { resultTruncated?: boolean } | undefined)?.resultTruncated).toBe(true);
    expect(lookup.observation.gaps).toEqual([]);

    const inner = new InMemoryDir();
    const broken: StorageDir = {
      read: (p) => inner.read(p),
      write: (p, c) => (p.startsWith("observability/batches/") ? Promise.reject(new Error("disk gone")) : inner.write(p, c)),
      remove: (p) => inner.remove(p),
      list: (p) => inner.list(p),
    };
    const second = await echoWith({ stateDir: join(await tmp(), "state"), turns: [textTurn("one")], observationStore: broken });
    second.agent.subscribeLifecycle((e: LifecycleEvent) => {
      if (e.type === "notification") notices.push(e.message);
    });
    await second.send("a");
    expect((await second.observations.snapshot()).health.persistence.status).not.toBe("healthy"); // 写不动只在健康状态里
    expect(notices).toEqual([]);
  });

  test("观测存储卡死：进程最多再等 STALL_MS 就退出，没写完的观测放弃，exit 监听照常运行", async () => {
    const dir = await tmp();
    const marker = join(dir, "exit-marker");
    const script = [
      `import { appendFileSync, mkdtempSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { tmpdir } from "node:os";`,
      `import { createEcho } from ${JSON.stringify(join(import.meta.dir, "../src/create-echo.ts"))};`,
      `import { createProvider } from ${JSON.stringify(join(import.meta.dir, "../src/provider/models.ts"))};`,
      `import { createProviderStreams } from ${JSON.stringify(join(import.meta.dir, "../src/provider/dialect.ts"))};`,
      `import { scriptedDialect, textTurn } from ${JSON.stringify(join(import.meta.dir, "../src/testing.ts"))};`,
      `import { InMemoryDir } from ${JSON.stringify(join(import.meta.dir, "../src/storage/in-memory-dir.ts"))};`,
      `process.env.ECHO_HOME = mkdtempSync(join(tmpdir(), "echo-stall-home-"));`,
      `process.on("exit", () => appendFileSync(${JSON.stringify(marker)}, "exit\\n"));`,
      `const inner = new InMemoryDir();`,
      `const never = new Promise(() => {});`,
      `const stuck = { read: (p) => inner.read(p), write: (p) => never, remove: (p) => inner.remove(p), list: (p) => inner.list(p) };`,
      `const provider = createProvider({ id: "s", auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } }, models: [{ id: "only", api: "fake" }], api: createProviderStreams(scriptedDialect([textTurn("hi")])) });`,
      `const echo = await createEcho({ provider, stateDir: ${JSON.stringify(join(dir, "state"))}, allowNetwork: false, withoutMemory: true, extensionDirs: [], observation: { store: stuck } });`,
      `await echo.agent.start();`,
      `const r = await echo.send("x");`,
      `await echo.stop();`,
      `console.log(r.outcome.kind);`,
    ].join("\n");
    const file = join(dir, "child.ts");
    await Bun.write(file, script);
    const t0 = performance.now();
    const child = Bun.spawn(["bun", file], { stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => child.kill(), STALL_MS + 20_000);
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(killer);
    const elapsed = performance.now() - t0;
    expect(code, err).toBe(0);
    expect(out.trim().split("\n").at(-1)).toBe("completed");
    expect(elapsed).toBeLessThan(STALL_MS + 10_000);
    expect(existsSync(marker) && readFileSync(marker, "utf8")).toBe("exit\n");
  }, 60_000);

  test("起观测线程同步抛错：createEcho、send、stop 照常，这个进程不记观测", async () => {
    // mock.module 会留在整个测试进程里，放进子进程跑（fixtures/observation-worker-unavailable.ts）
    const child = Bun.spawn(["bun", "test", join(import.meta.dir, "fixtures/observation-worker-unavailable.ts")], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, out + err).toBe(0);
    expect(out + err).toContain("1 pass");
  }, 60_000);

  test("观测存储写不动：send 照常 completed，下一次 send 也照跑，stop 不抛；写不动只进 persistence health", async () => {
    const stateDir = join(await tmp(), "state");
    // 模拟存储坏掉：建 key 照常，之后每次写批文件都抛，writer 会 seal
    const inner = new InMemoryDir();
    const broken: StorageDir = {
      read: (p) => inner.read(p),
      write: (p, c) => (p.startsWith("observability/batches/") ? Promise.reject(new Error("disk gone")) : inner.write(p, c)),
      remove: (p) => inner.remove(p),
      list: (p) => inner.list(p),
    };
    const echo = await echoWith({ stateDir, turns: [textTurn("one"), textTurn("two")], observationStore: broken });

    const a = await echo.send("a");
    expect(a.outcome.kind).toBe("completed");
    expect((await echo.observations.snapshot()).health.persistence.status).not.toBe("healthy");

    const b = await echo.send("b");
    expect(b.outcome.kind).toBe("completed");
    expect(echo.agent.messages.filter((m) => m.role === "assistant").length).toBe(2);
    await echo.stop();
  });

  test("进程在观测线程写完之后才退出，stop 不等；process.on(\"exit\") 照常运行", async () => {
    const dir = await tmp();
    const stateDir = join(dir, "state");
    const marker = join(dir, "exit-marker");
    const script = [
      `import { appendFileSync, mkdtempSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { tmpdir } from "node:os";`,
      `import { createEcho } from ${JSON.stringify(join(import.meta.dir, "../src/create-echo.ts"))};`,
      `import { createProvider } from ${JSON.stringify(join(import.meta.dir, "../src/provider/models.ts"))};`,
      `import { createProviderStreams } from ${JSON.stringify(join(import.meta.dir, "../src/provider/dialect.ts"))};`,
      `import { scriptedDialect, textTurn } from ${JSON.stringify(join(import.meta.dir, "../src/testing.ts"))};`,
      `process.env.ECHO_HOME = mkdtempSync(join(tmpdir(), "echo-exit-home-"));`,
      `process.on("exit", () => appendFileSync(${JSON.stringify(marker)}, "exit\\n"));`,
      `const provider = createProvider({ id: "s", auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } }, models: [{ id: "only", api: "fake" }], api: createProviderStreams(scriptedDialect([textTurn("hi")])) });`,
      `const echo = await createEcho({ provider, stateDir: ${JSON.stringify(stateDir)}, allowNetwork: false, withoutMemory: true, extensionDirs: [] });`,
      `await echo.agent.start();`,
      `const r = await echo.send("x");`,
      `await echo.stop();`,
      `console.log(r.runId);`,
    ].join("\n");
    const file = join(dir, "child.ts");
    await Bun.write(file, script);
    const child = Bun.spawn(["bun", file], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    const runId = out.trim().split("\n").at(-1)!;
    const reader = await openObservationReader({ stateRoot: stateDir });
    try {
      const lookup = await reader.getRun(runId);
      expect(lookup.kind === "found" && lookup.observation.status).toBe("completed");
    } finally {
      await reader.close();
    }
    expect(existsSync(marker) && readFileSync(marker, "utf8")).toBe("exit\n");
  }, 60_000);
});

// 投影的单测证明不了「读得回来」：思考还要穿过 canonical 编码、观测文档、reader 与视图模型。
// 这条走的正是面板读的那条路（buildRunObservationViewModel）。
describe("思考穿过整条链路：canonical → 观测文档 → reader → 视图模型", () => {
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
