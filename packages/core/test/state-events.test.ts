// 公开状态的每一次变化都有事件（2026-09-18 用户拍板：载体是 AgentEvent）。
// 判据的形状每条一样：事件来了，而且订阅方收到它的那一刻读 `state` 已经是新值——
// 事件在前、状态在后，或者状态变了事件没来，壳子就得靠轮询或猜。

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import type { AgentEvent, LifecycleEvent } from "../src/events.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { registerTool, restrictTools } from "../src/tools/harness.ts";
import { activateSkill, addSkills } from "../src/skill/harness.ts";
import { createTasks } from "../src/task/harness.ts";
import { startBackground } from "../src/background/harness.ts";
import { SessionService } from "../src/session/service.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";

function tool(name: string): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => toolOk("ok") };
}

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => void events.push(e));
  return events;
}

function ofType<T extends AgentEvent["type"]>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

/** 让出事件循环几拍：事件的派发在 `processEvents()` 的 await 之后，视图变化按微任务合并。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

test("换模型 / 换思考档：equipment_changed 带新值，收到时 state 已是新值", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const seen: string[] = [];
  agent.subscribe((e) => {
    if (e.type !== "equipment_changed") return;
    if (e.field === "model") seen.push(`model:${e.model.id}:${agent.state.model.id}`);
    else seen.push(`thinking:${e.thinkingLevel}:${agent.state.thinkingLevel}`);
  });
  agent.model = { ...FAKE_MODEL, id: "other" };
  agent.thinkingLevel = "high";
  await settle();
  expect(seen).toEqual(["model:other:other", "thinking:high:high"]);
});

test("切工作目录：workspace_changed，收到时 state.workspace 已是新值；同一目录不发", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), workspace: "/repo" });
  const seen: string[] = [];
  agent.subscribe((e) => {
    if (e.type === "workspace_changed") seen.push(`${e.workspace}:${agent.state.workspace}`);
  });
  await agent.setWorkspace("/repo/wt");
  await agent.setWorkspace("/repo/wt");
  expect(seen).toEqual(["/repo/wt:/repo/wt"]);
});

test("切工作目录入账：同一段会话换个 Agent 续上，workspace 是切过去的那个（resume 以最后一条 workspace entry 为准）", async () => {
  const store = new InMemoryDir();
  const first = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), sessionService: new SessionService(store), sessionId: "s1", workspace: "/repo" });
  await first.start();
  await first.setWorkspace("/repo/wt");
  await first.stop();

  const second = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), sessionService: new SessionService(store), sessionId: "s1", workspace: "/repo" });
  await second.start();
  expect(second.state.workspace).toBe("/repo/wt");
  await second.stop();
});

test("reset：发 reset，收到时对话与计数已清；inbox 攒着的也清掉并补一条 queue_update", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]) });
  await agent.prompt("go");
  const events = collect(agent);
  startBackground(agent.background, { kind: "p", label: "build", run: async () => {} }); // 结束时往 inbox 投一条
  await settle();
  expect(ofType(events, "queue_update")).toMatchObject([{ queue: "inbox", size: 1 }]);
  const atReset: { messages: number; usage: number }[] = [];
  agent.subscribe((e) => {
    if (e.type === "reset") atReset.push({ messages: agent.state.messages.length, usage: agent.state.usage.outputTokens });
  });
  agent.reset();
  await settle();
  expect(atReset).toEqual([{ messages: 0, usage: 0 }]);
  expect(ofType(events, "queue_update")).toMatchObject([{ queue: "inbox", size: 1 }, { queue: "inbox", size: 0 }]);
});

test("启动恢复会话：session_restored 带回盘上的对话，收到时 state 已是恢复后的样子", async () => {
  const store = new InMemoryDir();
  const first = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]), sessionService: new SessionService(store), sessionId: "s1" });
  await first.start();
  await first.prompt("go");
  await first.stop();

  const second = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), sessionService: new SessionService(store), sessionId: "s1" });
  const seen: { event: number; state: number; sessionId: string | null }[] = [];
  second.subscribe((e) => {
    if (e.type === "session_restored") seen.push({ event: e.messages.length, state: second.state.messages.length, sessionId: second.state.sessionId });
  });
  await second.start();
  expect(seen).toEqual([{ event: 2, state: 2, sessionId: "s1" }]);
  await second.stop();
});

test("run 开合：status_changed 两条边——开门时 state 已是 generating 且 startedAt 对得上，收尾时已归 idle 且计数归零", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]) });
  const seen: string[] = [];
  agent.subscribe((e) => {
    if (e.type !== "status_changed") return;
    const s = agent.state;
    if (e.status === "generating") seen.push(`open:${s.status}:${s.startedAt === e.startedAt}`);
    else seen.push(`close:${s.status}:${s.startedAt}:${s.iteration}`);
  });
  await agent.prompt("go");
  expect(seen).toEqual(["open:generating:true", "close:idle:null:0"]);
});

test("接不接活：一个 run 前后各一条 availability_changed，最后一条与 acceptsWork 一致", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]) });
  const events = collect(agent);
  await agent.prompt("go");
  const avail = ofType(events, "availability_changed");
  expect(avail.map((e) => e.acceptsWork)).toEqual([false, true]);
  expect(avail[0]!.reason).toContain("正在处理上一个 prompt");
  expect(avail[1]!.reason).toBeNull();
  expect(agent.acceptsWork).toBe(true);
});

test("Inbox 那批等 ack 裁决的窗口：idle 已发但还不接活；裁决出来才发接活——最后一条事件就是它", async () => {
  const agent = new Agent({ model: FAKE_MODEL, autoConsumeInbox: true, streamFunction: scriptedStreamFn([textTurn("知道了")]) });
  const events = collect(agent);
  startBackground(agent.background, { kind: "p", label: "build", run: async () => {} });
  for (let i = 0; i < 50 && !(agent.acceptsWork && agent.status === "idle" && agent.messages.some((m) => m.role === "assistant")); i++) await settle();
  await settle();
  expect(agent.messages.some((m) => m.role === "assistant")).toBe(true); // 真跑了那一轮
  const idleAt = events.findIndex((e) => e.type === "status_changed" && e.status === "idle");
  const avail = ofType(events, "availability_changed");
  // 收尾那一拍（idle 之后）ticket 还在，理由是等 ack；清掉 ticket 那一拍发接活
  expect(avail.some((e) => e.seq > events[idleAt]!.seq && !e.acceptsWork && (e.reason ?? "").includes("ack"))).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "availability_changed", acceptsWork: true, reason: null });
});

test("stop()：不再接活发出来（订阅方不用去猜 Agent 还在不在）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const events = collect(agent);
  await agent.stop();
  await settle();
  const last = ofType(events, "availability_changed").at(-1);
  expect(last?.acceptsWork).toBe(false);
  expect(agent.acceptsWork).toBe(false);
});

test("宿主要回答 ask 却没人订阅 lifecycle 时不接活；订阅上的那一刻发接活", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    permission: { authorize: () => ({ kind: "allow" }), responder: "host", askTimeoutMs: null },
  });
  const events = collect(agent);
  agent.reset(); // 随便一个事件，让兜底核对一次，拿到「没订阅者」这个起点
  await settle();
  expect(agent.acceptsWork).toBe(false);
  agent.subscribeLifecycle(() => {});
  await settle();
  expect(ofType(events, "availability_changed").at(-1)).toMatchObject({ acceptsWork: true, reason: null });
});

test("现算的视图：工具池、收紧、已激活 skill、任务清单改了发 view_changed；同一拍的多次改动只发一条", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const events = collect(agent);

  registerTool(agent.tools, tool("a"));
  registerTool(agent.tools, tool("b"));
  registerTool(agent.tools, tool("c"));
  await settle();
  expect(ofType(events, "view_changed").map((e) => e.view)).toEqual(["tools"]); // 三次注册合成一条

  const release = restrictTools(agent.toolRestrictions, new Set(["a"]));
  await settle();
  expect(agent.state.tools.map((t) => t.name)).toEqual(["a"]);
  release();
  await settle();
  expect(ofType(events, "view_changed").map((e) => e.view)).toEqual(["tools", "tools", "tools"]);

  addSkills(agent.skills, [{ name: "s", description: "d", content: "c", files: [], requiredTools: [], modelInvocable: true, frontmatter: {} }]);
  activateSkill(agent.skills, agent.activeSkills, "s");
  await settle();
  createTasks(agent.tasks, [{ title: "t" }]);
  await settle();
  expect(ofType(events, "view_changed").map((e) => e.view).slice(3)).toEqual(["activeSkills", "tasks"]);
});

test("提问答上了：lifecycle 发 questionAnswered，与 question / questionCancelled 凑齐三拍", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "ask_user", { question: "A or B?", options: [{ label: "A" }, { label: "B" }] }), textTurn("done")]),
    questions: { responder: "host" },
  });
  await mountBuiltinTools(agent);
  const lifecycle: LifecycleEvent[] = [];
  agent.subscribeLifecycle((e) => {
    lifecycle.push(e);
    if (e.type === "question") void agent.answerQuestion({ questionId: e.questionId, selected: ["A"] });
  });
  await agent.prompt("go");
  const q = lifecycle.find((e) => e.type === "question");
  expect(lifecycle.filter((e) => e.type === "questionAnswered")).toEqual([
    { type: "questionAnswered", questionId: q?.type === "question" ? q.questionId : "?", toolCallId: "c1" },
  ]);
  expect(agent.pendingQuestions).toEqual([]);
});

test("兜底：判据的输入在没接核对的地方变了（扩展声明权限策略），下一个事件时补发 availability_changed", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const events = collect(agent);
  agent.thinkingLevel = "low"; // 起点：接活
  await settle();
  expect(ofType(events, "availability_changed").at(-1)?.acceptsWork).toBe(true);
  agent.policySlots.declare({ permission: { authorize: () => ({ kind: "allow" }), responder: "host", askTimeoutMs: null } });
  agent.thinkingLevel = "high"; // 任意一个事件
  await settle();
  const last = ofType(events, "availability_changed").at(-1);
  expect(last?.acceptsWork).toBe(false);
  expect(last?.reason).toContain("responder");
});

test("同步调用点发的事件，订阅方抛错：不成 unhandled rejection，记成诊断，状态照样生效", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => void unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
    const diagnostics: string[] = [];
    agent.subscribeLifecycle((e) => {
      if (e.type === "notification" && e.kind === "error") diagnostics.push(e.message);
    });
    agent.subscribe((e) => {
      if (e.type === "equipment_changed") throw new Error("订阅方炸了");
    });
    agent.thinkingLevel = "high";
    await settle();
    expect(agent.state.thinkingLevel).toBe("high");
    expect(unhandled).toEqual([]);
    expect(diagnostics.some((m) => m.includes("订阅方炸了"))).toBe(true);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
