// `ask_user`（2026-09-05 用户拍板）：模型菜单上的提问工具，与权限询问**平行**的另一条通道——
// 权限是壳子拦工具调用的工程机制，提问是模型主动调的工具。判据落在真循环上：模型调了工具、
// 宿主经 lifecycle 收到 `question`、`answerQuestion()` 回去、工具把选择回给模型、同一轮接着跑。

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { agentRuntimeOf, mountBuiltinTools } from "../src/extension/builtin.ts";
import { scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { makeAskUserTool } from "../src/question/tool.ts";
import type { LifecycleEvent } from "../src/events.ts";
import type { QuestionPolicy } from "../src/question/types.ts";

const ASK = toolTurn("c1", "ask_user", { question: "Use A or B?", options: [{ label: "A" }, { label: "B", description: "the safe one" }] });

async function agentWith(questions?: QuestionPolicy, turns = [ASK, textTurn("done")]): Promise<Agent> {
  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn(turns),
    ...(questions === undefined ? {} : { questions }),
  });
  await mountBuiltinTools(agent); // 低层 Agent 工具面为空：内建那张表要自己 mount（与 createEcho 同一条路）
  return agent;
}

function toolResult(agent: Agent): { content: string; isError: boolean } {
  const m = agent.state.messages.find((x) => x.role === "toolResult");
  if (m === undefined || m.role !== "toolResult") throw new Error("no tool result in the transcript");
  return { content: m.content, isError: m.isError };
}

test("缺省没人答（responder none）：ask_user 当场回「没人能答」，不等人、不发 question 事件；模型接着跑", async () => {
  const agent = await agentWith();
  const events: LifecycleEvent["type"][] = [];
  agent.subscribeLifecycle((e) => {
    events.push(e.type);
  });
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  expect(toolResult(agent)).toEqual({ isError: true, content: expect.stringContaining("Nobody can answer") });
  expect(events).not.toContain("question");
  expect(agent.pendingQuestions).toEqual([]);
});

test("有人答（host + 订阅者）：发 question 事件、pendingQuestions 有它；宿主 answerQuestion 后工具把选择回给模型；重答与乱答都有说法", async () => {
  const agent = await agentWith({ responder: "host" });
  let seen: Extract<LifecycleEvent, { type: "question" }> | null = null;
  agent.subscribeLifecycle((e) => {
    if (e.type !== "question") return;
    seen = e;
    expect(agent.pendingQuestions.map((q) => q.questionId)).toEqual([e.questionId]);
    void agent.answerQuestion({ questionId: e.questionId, selected: ["B"], text: "" });
  });
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  const q = seen as Extract<LifecycleEvent, { type: "question" }> | null;
  if (q === null) throw new Error("question event never came");
  expect([q.toolCallId, q.question, q.multiSelect]).toEqual(["c1", "Use A or B?", false]);
  expect(q.options).toEqual([{ label: "A" }, { label: "B", description: "the safe one" }]);
  expect(toolResult(agent)).toEqual({ isError: false, content: "User chose: B" });
  expect(agent.pendingQuestions).toEqual([]);
  // 再答一次 = 已封口；不认识的 id = stale
  expect(await agent.answerQuestion({ questionId: q.questionId, selected: ["A"] })).toEqual({ kind: "closed", questionId: q.questionId, reason: "answered" });
  expect(await agent.answerQuestion({ questionId: "nope", selected: ["A"] })).toEqual({ kind: "stale", questionId: "nope", reason: "unknown" });
});

test("自由文本回答：选项与文字都回给模型", async () => {
  const agent = await agentWith({ responder: "host" });
  agent.subscribeLifecycle((e) => {
    if (e.type === "question") void agent.answerQuestion({ questionId: e.questionId, selected: [], text: "neither, use C" });
  });
  await agent.prompt("go");
  expect(toolResult(agent)).toEqual({ isError: false, content: "User said: neither, use C" });
});

test("声明了 host 但没人订阅 lifecycle：与权限那边同一口径，当场回没人能答", async () => {
  const agent = await agentWith({ responder: "host" });
  await agent.prompt("go");
  expect(toolResult(agent).content).toContain("Nobody can answer");
});

test("等人时 run 被中止：工具回 aborted、发 questionCancelled(run-aborted)；超时同理（timed-out）", async () => {
  const aborted = await agentWith({ responder: "host" });
  const cancelled: string[] = [];
  aborted.subscribeLifecycle((e) => {
    if (e.type === "question") aborted.abort("test");
    if (e.type === "questionCancelled") cancelled.push(e.reason);
  });
  await aborted.prompt("go");
  expect(cancelled).toEqual(["run-aborted"]);
  expect(toolResult(aborted)).toEqual({ isError: true, content: expect.stringContaining("aborted") });
  expect(aborted.pendingQuestions).toEqual([]);

  const slow = await agentWith({ responder: "host", askTimeoutMs: 20 });
  const reasons: string[] = [];
  slow.subscribeLifecycle((e) => {
    if (e.type === "questionCancelled") reasons.push(e.reason);
  });
  await slow.prompt("go");
  expect(reasons).toEqual(["timed-out"]);
  expect(toolResult(slow)).toEqual({ isError: true, content: expect.stringContaining("did not answer in time") });
});

test("answerQuestion 验形：空回答 / 坏 shape 抛 TypeError；工具验选项：超过 8 个、重名、空 label、空问题都是 error", async () => {
  const agent = await agentWith({ responder: "host" }, [textTurn("x")]);
  await expect(agent.answerQuestion({ questionId: "q", selected: [] })).rejects.toThrow(TypeError);
  await expect(agent.answerQuestion({ questionId: "q", selected: [], text: "  " })).rejects.toThrow(TypeError);
  await expect(agent.answerQuestion({ questionId: "", selected: ["a"] })).rejects.toThrow(TypeError);

  const tool = makeAskUserTool({ ask: async () => ({ kind: "answered", selected: ["x"], text: "and why" }) });
  const ctx = { toolCallId: "t", workspace: "/", sessionId: null, iteration: 0 };
  expect((await tool.execute({ question: "q", options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) }, ctx)).content).toContain("at most 8");
  expect((await tool.execute({ question: "q", options: [{ label: "a" }, { label: "a" }] }, ctx)).content).toContain("duplicate");
  expect((await tool.execute({ question: "q", options: [{ label: " " }] }, ctx)).isError).toBe(true);
  expect((await tool.execute({ question: " " }, ctx)).isError).toBe(true);
  const ok = await tool.execute({ question: "q" }, ctx);
  expect([ok.isError, ok.content]).toEqual([false, "User chose: x\nUser said: and why"]);
});

test("runtime 协议：answerQuestion / pendingQuestions 经 agentRuntimeOf 转发", async () => {
  const agent = await agentWith({ responder: "host" }, [textTurn("x")]);
  const rt = agentRuntimeOf(agent);
  expect(rt.pendingQuestions).toEqual([]);
  expect(await rt.answerQuestion({ questionId: "nope", selected: ["a"] })).toEqual({ kind: "stale", questionId: "nope", reason: "unknown" });
});
