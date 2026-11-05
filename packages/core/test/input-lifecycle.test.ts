// 一条输入从收下到处理完的判据（2026-11-05，docs/decisions/implemented/2026-11-05-input-lifecycle.md）：
//   1. steer 是改方向：收下那一刻还没启动的工具不再启动、等授权的问撤掉，各记一条「没执行（superseded）」；
//   2. interrupt 只停当前这一步，abort 停整个任务（连这个 run 起的后台任务）；
//   3. 收下的输入都有身份（inputId），没进 transcript 的连正文交还（input_returned 在 intake.test.ts）。
// 观测上「输入 → 这一轮 → 这一轮的工具调用」接得上，端到端判据在 observability-decisions.test.ts。

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolError, toolOk, type ModelTool } from "../src/tools/types.ts";
import { killAllBackground, startBackground } from "../src/background/harness.ts";
import { RunIntakeGate } from "../src/loop/intake.ts";
import { NOT_EXECUTED } from "../src/loop/run-turn.ts";
import { userMessage, type AgentMessage, type ToolResultMessage } from "../src/messages.ts";
import type { AgentEvent } from "../src/events.ts";
import type { PermissionPolicy } from "../src/permission/types.ts";

/* ─────────────── fixtures ─────────────── */

function tool(name: string, execute: ModelTool["execute"]): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute };
}

/** 一条助手消息里依次点若干个工具（id 就用工具名）。都不声明 concurrent：一个一批，按序跑。 */
function toolsTurn(names: readonly string[]): ScriptedTurn {
  return [
    { type: "start" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: names.map((n) => ({ type: "tool_use" as const, id: n, name: n, input: {} })),
        stopReason: "tool_use",
        usage: null,
      },
    },
  ];
}

/** 等 signal 被 abort（已经 abort 就立即返回）。 */
function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((r) => {
    if (signal === undefined || signal.aborted) return r();
    signal.addEventListener("abort", () => r(), { once: true });
  });
}

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
  });
  return events;
}

function toolResults(messages: readonly AgentMessage[]): (ToolResultMessage & { at: number })[] {
  return messages.filter((m) => m.role === "toolResult") as (ToolResultMessage & { at: number })[];
}

function causes(events: readonly AgentEvent[]): string[] {
  return events.flatMap((e) => (e.type === "turn_start" ? [e.cause] : []));
}

function replySources(events: readonly AgentEvent[]): string[] {
  return events.flatMap((e) => (e.type === "reply_start" ? [e.source] : []));
}

/* ─────────────── 1. steer 是改方向 ─────────────── */

test("steer 收下的那一刻还没启动的调用不再启动、记「没执行（superseded）」；跑着的照常跑完；下一轮 cause=steer，从这句话接着", async () => {
  let agent!: Agent;
  const ran: string[] = [];
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn(["a", "b"]), textTurn("好，b 不做了")]),
    tools: [
      tool("a", async () => {
        ran.push("a");
        await agent.steer("别做 b");
        return toolOk("a done");
      }),
      tool("b", async () => {
        ran.push("b");
        return toolOk("b done");
      }),
    ],
  });
  const events = collect(agent);
  const r = await agent.prompt("go");

  expect(r.outcome.kind).toBe("completed");
  expect(ran).toEqual(["a"]); // a 已经在跑：跑完；b 还没启动：不再启动
  const results = toolResults(agent.messages);
  expect(results.map((m) => [m.toolCallId, m.isError, m.metadata])).toEqual([
    ["a", false, null],
    ["b", true, { notExecuted: "superseded" }],
  ]);
  expect(results[1]!.content).toBe(NOT_EXECUTED.superseded);
  // 插话排在这批结果之后、下一条助手消息之前；它引出的那一轮 cause 是 steer
  expect(agent.messages.map((m) => (m.role === "user" ? `user/${m.source}` : m.role))).toEqual([
    "user/human",
    "assistant",
    "toolResult",
    "toolResult",
    "user/steer",
    "assistant",
  ]);
  expect(causes(events)).toEqual(["input", "steer"]);
});

test("steer 撤掉等授权的问：那个调用不跑、记「没执行（superseded）」，不留一个没人答的问", async () => {
  let agent!: Agent;
  const ran = { n: 0 };
  const ask: PermissionPolicy = { authorize: () => ({ kind: "ask", reason: "要人看一眼" }), askTimeoutMs: null, responder: "host" };
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "rm", {}), textTurn("好，不删了")]),
    tools: [tool("rm", async () => (ran.n++, toolOk("deleted")))],
    permission: ask,
  });
  agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") void agent.steer("算了，别删");
  });
  const r = await agent.prompt("删掉它");

  expect(r.outcome.kind).toBe("completed");
  expect(ran.n).toBe(0);
  expect(agent.pendingPermissions).toEqual([]);
  expect(toolResults(agent.messages).map((m) => [m.toolCallId, m.metadata])).toEqual([["c1", { notExecuted: "superseded" }]]);
});

/* ─────────────── 2. interrupt 只停这一步，abort 停整个任务 ─────────────── */

/** 在跑的那个工具：先做 `before`（插话 / 排队 / 中断），再等 signal 停下。 */
function slow(name: string, before: () => Promise<void> | void, ran: string[]): ModelTool {
  return tool(name, async (_p, ctx) => {
    ran.push(name);
    await before();
    await untilAborted(ctx.signal);
    return toolError(`${name} stopped`);
  });
}

test("interrupt（没有插话、没有排队）：在跑的工具收 signal 停下，没启动的记「没执行（interrupted）」，这条 reply 以 aborted{interrupted} 收，run 也是", async () => {
  let agent!: Agent;
  const ran: string[] = [];
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn(["s", "b"]), textTurn("不该到")]),
    tools: [slow("s", () => agent.interrupt(), ran), tool("b", async () => (ran.push("b"), toolOk("b")))],
  });
  const events = collect(agent);
  const r = await agent.prompt("go");

  expect(r.outcome).toEqual({ kind: "aborted", reason: "interrupted" });
  expect(ran).toEqual(["s"]);
  expect(toolResults(agent.messages).map((m) => [m.toolCallId, m.metadata])).toEqual([
    ["s", null],
    ["b", { notExecuted: "interrupted" }],
  ]);
  expect(causes(events)).toEqual(["input"]); // 没有下一轮
  const end = events.find((e) => e.type === "reply_end");
  expect(end?.type === "reply_end" && end.outcome).toEqual({ kind: "aborted", reason: "interrupted" });
});

test("interrupt 之后排队的 followUp 照常做：被中断的只是那一条 reply，run 以后面那条的结果收场", async () => {
  let agent!: Agent;
  const ran: string[] = [];
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "s", {}), textTurn("X 做完了")]),
    tools: [
      slow(
        "s",
        async () => {
          await agent.followUp("然后做 X");
          agent.interrupt("用户中断");
        },
        ran,
      ),
    ],
  });
  const events = collect(agent);
  const r = await agent.prompt("go");

  expect(r.outcome.kind).toBe("completed");
  expect(replySources(events)).toEqual(["prompt", "follow_up"]);
  const ends = events.flatMap((e) => (e.type === "reply_end" ? [e.outcome] : []));
  expect(ends).toEqual([{ kind: "aborted", reason: "用户中断" }, { kind: "completed" }]);
});

test("interrupt 时这一步里收下过插话：照插话接着跑（同一条 reply、下一轮 cause=steer），不收 reply", async () => {
  let agent!: Agent;
  const ran: string[] = [];
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "s", {}), textTurn("换了做法")]),
    tools: [
      slow(
        "s",
        async () => {
          await agent.steer("换个做法");
          agent.interrupt();
        },
        ran,
      ),
    ],
  });
  const events = collect(agent);
  const r = await agent.prompt("go");

  expect(r.outcome.kind).toBe("completed");
  expect(replySources(events)).toEqual(["prompt"]);
  expect(causes(events)).toEqual(["input", "steer"]);
});

test("没有 run 时 interrupt 什么都不做；下一个 run 不会一开始就被它中断", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("ok")]) });
  agent.interrupt();
  expect((await agent.prompt("go")).outcome.kind).toBe("completed");
});

test("abort 停整个任务：这个 run 起的后台任务一起停；run 外起的不动。interrupt 不动后台任务", async () => {
  let agent!: Agent;
  const mine: { abort?: ReturnType<typeof startBackground>; interrupt?: ReturnType<typeof startBackground> } = {};
  const spawn = (key: "abort" | "interrupt"): ModelTool =>
    tool(`spawn_${key}`, async () => {
      mine[key] = startBackground(agent.background, { kind: "process", label: key, run: (ctx) => untilAborted(ctx.signal) });
      if (key === "abort") agent.abort("停");
      else agent.interrupt();
      return toolOk("spawned");
    });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "spawn_interrupt", {}), toolTurn("c2", "spawn_abort", {})]),
    tools: [spawn("abort"), spawn("interrupt")],
  });
  const outside = startBackground(agent.background, { kind: "process", label: "outside", run: (ctx) => untilAborted(ctx.signal) });
  try {
    expect((await agent.prompt("一")).outcome).toEqual({ kind: "aborted", reason: "interrupted" });
    expect((await agent.prompt("二")).outcome).toEqual({ kind: "aborted", reason: "停" });
    if (!outside.ok || mine.abort?.ok !== true || mine.interrupt?.ok !== true) throw new Error("后台任务没起来");
    await mine.abort.task.settled;
    expect(mine.abort.task.runId).not.toBeNull();
    expect(mine.abort.task.status).toBe("killed");
    expect(mine.interrupt.task.status).toBe("running"); // 中断只停那一步，后台任务本来就比 run 活得久
    expect(outside.task.runId).toBeNull();
    expect(outside.task.status).toBe("running");
  } finally {
    await killAllBackground(agent.background.tasks, { graceMs: 100 });
  }
});

/* ─────────────── 3. 输入的身份 ─────────────── */

test("prompt / steer / followUp 收下的那一刻发 inputId，随消息入账；harness 插的话没有", async () => {
  let agent!: Agent;
  const ids: { steer?: string; followUp?: string } = {};
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("好"), textTurn("跟进完了")]),
    tools: [
      tool("t", async () => {
        const s = await agent.steer("补一句");
        const f = await agent.followUp("再做一件");
        if (s.kind === "accepted") ids.steer = s.inputId;
        if (f.kind === "accepted") ids.followUp = f.inputId;
        return toolOk("ok");
      }),
    ],
  });
  await agent.prompt("go");
  const users = agent.messages.filter((m) => m.role === "user") as (AgentMessage & { inputId?: string; source: string })[];
  expect(users.map((m) => m.source)).toEqual(["human", "steer", "human"]);
  expect(users.every((m) => typeof m.inputId === "string" && m.inputId.startsWith("in-"))).toBe(true);
  expect(new Set(users.map((m) => m.inputId)).size).toBe(3);
  expect(users[1]!.inputId).toBe(ids.steer);
  expect(users[2]!.inputId).toBe(ids.followUp);
  // 不出门：送模投影里没有它
  expect(JSON.stringify(await agent.convertToLlm([...agent.messages]))).not.toContain("inputId");
});

/* ─────────────── gate 的两个信号 ─────────────── */

test("RunIntakeGate：中断落在两步之间也不丢（下一步一开始就是 aborted），取走即清；不带进下一个 run。steer 收下即 abort 本 turn 的 steered", () => {
  const g = new RunIntakeGate("i");
  expect(g.interrupt("x")).toBe(false); // 没有 run
  g.openRun("r1");
  expect(g.beginStep().aborted).toBe(false);
  expect(g.interrupt("x")).toBe(true);
  expect(g.beginStep().aborted).toBe(true); // 两步之间到的：下一步一开始就停
  expect(g.takeInterrupt()).toBe("x");
  expect(g.takeInterrupt()).toBeNull();
  expect(g.beginStep().aborted).toBe(false);

  g.openTurn("t1");
  const steered = g.steered!;
  expect(steered.aborted).toBe(false);
  expect(g.steer(userMessage("改方向", "steer")).kind).toBe("accepted");
  expect(steered.aborted).toBe(true);
  g.closeTurn();
  expect(g.steered).toBeUndefined();

  g.interrupt("y");
  g.closeRun();
  g.openRun("r2");
  expect(g.beginStep().aborted).toBe(false);
  expect(g.takeInterrupt()).toBeNull();
});
