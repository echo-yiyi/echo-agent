import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type AgentTool, type ModelTool } from "../src/tools/types.ts";
import { registerTool, registerTools, enableTools, disableTools } from "../src/tools/harness.ts";
import { addSkills } from "../src/skill/harness.ts";
import type { ActiveSkillMap, SkillMap } from "../src/skill/harness.ts";
import type { Skill } from "../src/skill/types.ts";
import { HookRuntime, INTERCEPTABLE, isInterceptable, type HookContext } from "../src/hooks/runtime.ts";
import type { LifecycleEventType } from "../src/events.ts";
import type { AgentMessage } from "../src/messages.ts";

type ToolResultEntry = Extract<AgentMessage, { role: "toolResult" }>;

// 「先加固现有接缝」的六条反例（O1a）。每条都是**摘掉修复就会红**的判据，
// 不是「探到能力」——探到能力 ≠ 用了能力，本仓栽过。
//
//   1. 工具执行只认本轮对象快照——本轮中途注册的名字即使被模型点中也不执行
//   2. hook 也有本轮工作集——中途注册的下一轮才生效、中途卸掉的本轮仍跑完
//   3. `HookEffect[]` 已删（类型层：tsc 守）；`userPromptSubmit` 真的可拦截（patch / block）
//   4. `permissionRequest` 不再是可拦截点（授权只能来自 authorization stage）
//   5. 注册卸载器只认对象身份——名字被显式 replace 之后，旧卸载器不动新条目
//   6. `dispose()` 全尝试 + 聚合错误 + 幂等

/* ─────────────── fixtures ─────────────── */

function tool(name: string, execute: ModelTool["execute"]): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute };
}

/** 一条助手消息里点两个工具——`toolTurn` 只支持一个，这里直接给定稿。 */
function twoToolsTurn(a: [string, string], b: [string, string]): ScriptedTurn {
  return [
    { type: "start" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: a[0], name: a[1], input: {} },
          { type: "tool_use", id: b[0], name: b[1], input: {} },
        ],
        stopReason: "tool_use",
        usage: null,
      },
    },
  ];
}

function toolResults(messages: readonly AgentMessage[]): ToolResultEntry[] {
  return messages.filter((m): m is ToolResultEntry => m.role === "toolResult");
}

function lastUserText(messages: readonly AgentMessage[]): string | undefined {
  const user = [...messages].reverse().find((m) => m.role === "user");
  if (user === undefined || !("content" in user)) return undefined;
  const block = (user.content as { type: string; text?: string }[])[0];
  return block?.text;
}

function ctx(): HookContext {
  return { origin: "user", depth: 0, hookId: "" };
}

/* ─────────────── 1. 工具只认本轮快照 ─────────────── */

test("本轮中途注册的工具即使被同一条消息点中也不执行；下一轮才可用", async () => {
  const calls: string[] = [];
  let agent!: Agent;
  const late = tool("late", async () => {
    calls.push("late");
    return toolOk("late ran");
  });
  const registrar = tool("registrar", async () => {
    registerTool(agent.tools, late); // 执行期往池里塞一个新名字
    calls.push("registrar");
    return toolOk("registered");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([
      twoToolsTurn(["c1", "registrar"], ["c2", "late"]), // 第 1 轮：先注册，再点它
      toolTurn("c3", "late", {}), // 第 2 轮：现在它在快照里了
      textTurn("done"),
    ]),
    tools: [registrar],
  });

  const result = await agent.prompt("go");
  expect(result.outcome.kind).toBe("completed");
  // late 只跑了一次——第 2 轮那次。第 1 轮点它时池里已经有了，但**不在本轮快照里**。
  expect(calls).toEqual(["registrar", "late"]);
  const rs = toolResults(result.messages);
  expect(rs.map((r) => r.toolCallId)).toEqual(["c1", "c2", "c3"]);
  expect(rs[1]!.isError).toBe(true);
  expect(rs[1]!.content).toContain("Unknown tool 'late'"); // 实时池里有也不认：它是下一轮的
  expect(rs[2]!.isError).toBe(false);
  expect(rs[2]!.content).toBe("late ran");
});

test("本轮开始时已禁用、中途又恢复的工具：本轮不执行但给准确原因，下一轮可用", async () => {
  const calls: string[] = [];
  let agent!: Agent;
  const flaky = tool("flaky", async () => {
    calls.push("flaky");
    return toolOk("flaky ran");
  });
  const enabler = tool("enabler", async () => {
    enableTools(agent.tools, ["flaky"]);
    return toolOk("enabled");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([
      twoToolsTurn(["c1", "enabler"], ["c2", "flaky"]),
      toolTurn("c3", "flaky", {}),
      textTurn("done"),
    ]),
    tools: [enabler, flaky],
  });
  disableTools(agent.tools, ["flaky"], "服务器已断开");

  const result = await agent.prompt("go");
  const rs = toolResults(result.messages);
  expect(rs[1]!.isError).toBe(true);
  // 不是「未知工具」（本轮开始时它是已知的），也不执行——原因来自实时池，对象不来自实时池
  expect(rs[1]!.content).toContain("unavailable when this turn started");
  expect(rs[2]!.content).toBe("flaky ran");
  expect(calls).toEqual(["flaky"]);
});

/* ─────────────── 2. hook 本轮工作集 ─────────────── */

test("hook：本轮中途注册的下一轮才生效，中途卸掉的本轮仍跑完", async () => {
  const hooks = new HookRuntime();
  const lateSeen: string[] = [];
  const earlySeen: string[] = [];
  let registered = false;
  const offEarly = hooks.on("postToolUse", (e) => {
    earlySeen.push(e.toolCallId);
  });
  hooks.on("preToolUse", (e) => {
    if (!registered) {
      registered = true;
      hooks.on("postToolUse", (p) => {
        lateSeen.push(p.toolCallId);
      });
    }
    if (e.toolCallId === "c1") offEarly(); // 第 1 轮中途卸掉 early
  });
  const t = tool("t", async () => toolOk("ok"));
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), toolTurn("c2", "t", {}), textTurn("done")]),
    tools: [t],
    hooks,
  });

  await agent.prompt("go");
  expect(lateSeen).toEqual(["c2"]); // 第 1 轮里注册的，第 1 轮的 postToolUse 看不到它
  expect(earlySeen).toEqual(["c1"]); // 第 1 轮里卸掉的，第 1 轮仍跑；第 2 轮没了
});

test("postToolUse 返回 block：结果按 reason 入账为 error、发 toolUseDenied、tool_execution_end 照发（review 2026-09-07，#3）", async () => {
  // 此前 decision / reason 在 run-turn 里被整个丢掉：工具结果照样入账送模，按 ABI 写 block 的 hook 一个字都不生效
  const hooks = new HookRuntime();
  const denied: string[] = [];
  hooks.on("postToolUse", (e) => (e.toolCallId === "c1" ? { decision: "block" as const, reason: "结果里有密钥" } : undefined));
  hooks.on("toolUseDenied", (e) => void denied.push(`${e.toolCallId}:${e.by}:${e.reason}`));
  const ends: string[] = [];
  const t = tool("t", async () => toolOk("sk-secret"));
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), toolTurn("c2", "t", {}), textTurn("done")]),
    tools: [t],
    hooks,
  });
  agent.subscribe((e) => {
    if (e.type === "tool_execution_end") ends.push(`${e.toolCallId}:${String(e.result.isError)}`);
  });
  const result = await agent.prompt("go");
  const rs = toolResults(result.messages);
  expect([rs[0]!.isError, rs[0]!.content]).toEqual([true, "结果里有密钥"]); // 模型看到的是 reason，不是密钥
  expect([rs[1]!.isError, rs[1]!.content]).toEqual([false, "sk-secret"]); // 没 block 的照常
  expect(denied).toEqual(["c1:hook:结果里有密钥"]);
  expect(ends).toEqual(["c1:true", "c2:false"]); // 工具已经跑过，start / end 仍配对
});

/* ─────────────── 3. userPromptSubmit 真的可拦截 ─────────────── */

test("userPromptSubmit：patch 改写正文进 transcript；block 拒掉这次 prompt、不起循环", async () => {
  const hooks = new HookRuntime();
  hooks.on("userPromptSubmit", (e) => (e.text === "原话" ? { patch: { text: "改过的话" } } : { decision: "block", reason: "不许" }));
  const events: string[] = [];
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok"), textTurn("ok2")]),
    hooks,
  });
  agent.subscribe((e) => {
    events.push(e.type);
  });

  const patched = await agent.prompt("原话");
  expect(patched.outcome.kind).toBe("completed");
  // `LoopResult.messages` 不含 prompt 本身（它在循环之前入账），改看 transcript
  expect(lastUserText(agent.state.messages)).toBe("改过的话");
  expect(events).toContain("agent_start");

  events.length = 0;
  const before = agent.state.messages.length;
  const blocked = await agent.prompt("别的话");
  expect(blocked.outcome.kind).toBe("aborted");
  expect((blocked.outcome as { reason?: string }).reason).toContain("userPromptSubmit（human）被 hook 拦下");
  expect(blocked.messages).toEqual([]);
  expect(agent.state.messages.length).toBe(before); // 没进 transcript
  expect(events).not.toContain("agent_start"); // 没起循环
});

test("patch 正文不打乱多模态块顺序：新文本落在原文本块的位置，图片原位；纯图片消息文本插最前", async () => {
  const hooks = new HookRuntime();
  hooks.on("userPromptSubmit", () => ({ patch: { text: "改" } }));
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok"), textTurn("ok2")]),
    hooks,
  });
  const img = (data: string) => ({ type: "image" as const, mimeType: "image/png", data });

  await agent.prompt({ role: "user", source: "human", content: [img("1"), { type: "text", text: "原" }, img("2")], at: 1 });
  const first = agent.state.messages.filter((m) => m.role === "user")[0] as { content: { type: string; text?: string; data?: string }[] };
  expect(first.content.map((b) => b.type)).toEqual(["image", "text", "image"]);
  expect(first.content[1]!.text).toBe("改");
  expect([first.content[0]!.data, first.content[2]!.data]).toEqual(["1", "2"]);

  await agent.prompt({ role: "user", source: "human", content: [img("only")], at: 2 });
  const second = agent.state.messages.filter((m) => m.role === "user")[1] as { content: { type: string; text?: string }[] };
  expect(second.content.map((b) => b.type)).toEqual(["text", "image"]);
  expect(second.content[0]!.text).toBe("改");
});

test("steering 也过 userPromptSubmit：source 标 steer，patch 进 transcript、block 不进并记诊断", async () => {
  const hooks = new HookRuntime();
  const seenSources: string[] = [];
  const diagnostics: string[] = [];
  hooks.on("userPromptSubmit", (e) => {
    seenSources.push(e.source);
    if (e.source !== "steer") return undefined;
    if (e.text === "插话") return { patch: { text: "插话（改）" } };
    return { decision: "block", reason: "不许插" };
  });
  hooks.on("notification", (e) => {
    if (e.kind === "error") diagnostics.push(e.message);
  });
  let agent!: Agent;
  const t = tool("t", async () => {
    agent.steer("插话");
    agent.steer("另一句");
    return toolOk("ok");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [t],
    hooks,
  });

  await agent.prompt("开始");
  expect(seenSources).toEqual(["human", "steer", "steer"]);
  const users = agent.state.messages.filter((m) => m.role === "user");
  const texts = users.map((m) => (m as { content: { text?: string }[] }).content[0]!.text);
  expect(texts).toEqual(["开始", "插话（改）"]); // patch 后的进了；被 block 的没进
  expect((users[1] as { source: string }).source).toBe("steer");
  expect(diagnostics.some((d) => d.includes("[user_prompt_blocked]") && d.includes("steer") && d.includes("不许插"))).toBe(true);
});

test("followUp 也过 userPromptSubmit：source 标 followUp，patch 进 transcript、block 不进", async () => {
  const hooks = new HookRuntime();
  const seenSources: string[] = [];
  hooks.on("userPromptSubmit", (e) => {
    seenSources.push(e.source);
    if (e.source !== "followUp") return undefined;
    if (e.text === "跟进") return { patch: { text: "跟进（改）" } };
    return { decision: "block", reason: "不许跟" };
  });
  let agent!: Agent;
  const t = tool("t", async () => {
    agent.followUp("跟进");
    agent.followUp("再跟");
    return toolOk("ok");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    // 第 1 轮点工具；第 2 轮收尾；followUp 让 run 继续 → 第 3 轮收尾
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok"), textTurn("ok2")]),
    tools: [t],
    hooks,
  });

  const result = await agent.prompt("开始");
  expect(result.outcome.kind).toBe("completed");
  expect(seenSources).toEqual(["human", "followUp", "followUp"]);
  const texts = agent.state.messages.filter((m) => m.role === "user").map((m) => (m as { content: { text?: string }[] }).content[0]!.text);
  expect(texts).toEqual(["开始", "跟进（改）"]);
});

test("run 里 steer / followUp 进 transcript 时 source 也如实标（steer 轮末、followUp 收尾后）", async () => {
  const hooks = new HookRuntime();
  const seenSources: string[] = [];
  hooks.on("userPromptSubmit", (e) => {
    seenSources.push(e.source);
    return undefined;
  });
  let agent!: Agent;
  const t = tool("t", async () => {
    await agent.steer("插话");
    await agent.followUp("跟进");
    return toolOk("ok");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("b"), textTurn("c")]),
    tools: [t],
    hooks,
  });
  await agent.prompt("开始");
  expect(seenSources).toEqual(["human", "steer", "followUp"]);
});

test("turn_start 的订阅者在事件里注册的工具：本轮不生效，下一轮才生效", async () => {
  const calls: string[] = [];
  let agent!: Agent;
  const late = tool("late", async () => {
    calls.push("late");
    return toolOk("late ran");
  });
  let registered = false;
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "late", {}), toolTurn("c2", "late", {}), textTurn("done")]),
  });
  agent.subscribe((e) => {
    if (e.type === "turn_start" && !registered) {
      registered = true;
      registerTool(agent.tools, late); // listener 是被 await 的：这一步发生在 turn_start 事件里
    }
  });

  const result = await agent.prompt("go");
  const rs = toolResults(result.messages);
  expect(rs[0]!.isError).toBe(true);
  expect(rs[0]!.content).toContain("Unknown tool 'late'"); // 工作集在 turn_start 之前就冻了
  expect(rs[1]!.content).toBe("late ran");
  expect(calls).toEqual(["late"]);
});

/* ─────────────── 4. permissionRequest 不可拦截 ─────────────── */

test("类型门：notify-only 事件的 handler 不能返回 HookResult（tsc 守）", () => {
  const h = new HookRuntime();
  // @ts-expect-error permissionRequest 是 notify-only：返回 block 不通过 tsc
  h.on("permissionRequest", () => ({ decision: "block" }));
  // @ts-expect-error notify-only 也不能 patch
  h.on("permissionGranted", () => ({ patch: { params: {} } }));
  h.on("permissionRequest", () => {}); // 什么都不返回可以
  h.on("permissionRequest", async () => {}); // Promise<void> 可以
  h.on("preToolUse", () => ({ decision: "block" })); // 可拦截点照旧
  // 宽化成 LifecycleEventType 的变量：两组 overload 都不匹配，必须先显式收窄——否则单泛型分布后又放行了
  const widened = "permissionRequest" as LifecycleEventType;
  // @ts-expect-error 宽联合不能直接注册（不论返回什么）
  h.on(widened, () => ({ decision: "block" }));
  expect(h.has("permissionRequest")).toBe(true);
});

test("permissionRequest 不在可拦截集：hook 对它只能观察，不能 block/patch", () => {
  expect(isInterceptable("permissionRequest")).toBe(false);
  expect(INTERCEPTABLE).not.toContain("permissionRequest");
  // 其余可拦截点原样
  expect(isInterceptable("preToolUse")).toBe(true);
  expect(isInterceptable("userPromptSubmit")).toBe(true);
});

/* ─────────────── 5. 卸载器只认对象身份 ─────────────── */

test("registerTool 的卸载器：名字被显式 replace 成另一个对象后，旧卸载器不动它", () => {
  const map = new Map<string, AgentTool>();
  const a1 = tool("a", async () => toolOk("1"));
  const a2 = tool("a", async () => toolOk("2"));
  const off1 = registerTool(map, a1);
  registerTool(map, a2, { replace: true });
  expect(off1()).toBe(false);
  expect(map.get("a")).toBe(a2); // 没被误删
  const off2 = registerTool(map, a1, { replace: true });
  expect(off2()).toBe(true);
  expect(map.has("a")).toBe(false);
});

test("registerTools 的卸载器逐条认身份，只报真卸掉的名字", () => {
  const map = new Map<string, AgentTool>();
  const x = tool("x", async () => toolOk(""));
  const y = tool("y", async () => toolOk(""));
  const off = registerTools(map, [x, y]);
  const y2 = tool("y", async () => toolOk("y2"));
  registerTool(map, y2, { replace: true });
  expect(off()).toEqual(["x"]);
  expect(map.has("x")).toBe(false);
  expect(map.get("y")).toBe(y2); // y 是别人的了，旧卸载器没碰它
});

test("addSkills 的卸载器认对象身份，并顺手撤下激活", () => {
  const skills: SkillMap = new Map();
  const active: ActiveSkillMap = new Map();
  const s1 = { name: "s", description: "d", content: "c", requiredTools: [] } as unknown as Skill;
  const s2 = { name: "s", description: "d2", content: "c", requiredTools: [] } as unknown as Skill;
  const off1 = addSkills(skills, [s1], { active });
  active.set("s", { name: "s", activatedAt: 1 });
  addSkills(skills, [s2], { replace: true, active });
  expect(off1()).toEqual([]); // s 已经是 s2 的了
  expect(skills.get("s")).toBe(s2);
  expect(active.has("s")).toBe(true);
  const off2 = addSkills(skills, [s1], { replace: true, active });
  expect(off2()).toEqual(["s"]);
  expect(active.has("s")).toBe(false);
});

test("卸载器只认注册那一刻的快照：注册后清空/改动调用方的数组与 config，仍能完整卸载", () => {
  // tools：注册后清空原数组
  const map = new Map<string, AgentTool>();
  const list = [tool("a", async () => toolOk("")), tool("b", async () => toolOk(""))];
  const offTools = registerTools(map, list);
  list.length = 0;
  expect(offTools().slice().sort()).toEqual(["a", "b"]);
  expect([...map.keys()]).toEqual([]);

  // skills：注册后清空原数组、换掉 opts 对象里的 active
  const skills: SkillMap = new Map();
  const active: ActiveSkillMap = new Map();
  const s = { name: "s", description: "d", content: "c", requiredTools: [] } as unknown as Skill;
  const skillList = [s];
  const opts = { active };
  const offSkills = addSkills(skills, skillList, opts);
  active.set("s", { name: "s", activatedAt: 1 });
  skillList.length = 0;
  (opts as { active?: ActiveSkillMap }).active = undefined;
  expect(offSkills()).toEqual(["s"]);
  expect(skills.size).toBe(0);
  expect(active.has("s")).toBe(false); // 用的是注册时快照下来的 active

  // script hook：注册后改 config.event / args
  const hooks = new HookRuntime({ externalRunner: async () => undefined });
  const config = { event: "stop" as const, command: "x", args: ["1"] };
  const offScript = hooks.addScript(config);
  (config as { event: string }).event = "preCompact";
  config.args.push("2");
  expect(hooks.has("stop")).toBe(true);
  offScript();
  expect(hooks.has("stop")).toBe(false); // 改了 config.event 也照样从 stop 队列里卸掉
});

test("hook 卸载器认条目身份：同 id 后来者不受旧卸载器影响", async () => {
  const hooks = new HookRuntime();
  const ran: string[] = [];
  const off1 = hooks.on("stop", () => void ran.push("h1"), { id: "same" });
  hooks.on("stop", () => void ran.push("h2"), { id: "same" });
  off1();
  await hooks.intercept({ type: "stop", iteration: 1, finalText: "" }, ctx());
  expect(ran).toEqual(["h2"]); // 按 id 删会把 h2 误删掉（旧实现）
});

/* ─────────────── 6. dispose 全尝试 + 聚合 + 幂等 ─────────────── */

test("dispose：一个 disposer 抛错不跳过其余；错误聚合抛出；第二次调用不重跑", async () => {
  const log: string[] = [];
  const good = (name: string) => ({
    dispose: async () => {
      log.push(name);
    },
  });
  const bad = (name: string) => ({
    dispose: async () => {
      log.push(name);
      throw new Error(`${name} 坏了`);
    },
  });
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok")]),
    disposables: [bad("d1"), good("d2"), bad("d3")],
    finalDisposables: [bad("f1"), good("f2")],
  });

  let error: unknown;
  try {
    await agent.dispose();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AggregateError);
  const agg = error as AggregateError;
  expect(agg.errors.map((e) => (e as Error).message).sort()).toEqual(["d1 坏了", "d3 坏了", "f1 坏了"]);
  expect(agg.message).toContain("3 处失败");
  // 全都试到了：坏的没挡住好的，②里的和③里的都是
  expect(log.sort()).toEqual(["d1", "d2", "d3", "f1", "f2"]);

  // 幂等：再来一次不重跑（log 不变），拿到同一个结果
  let again: unknown;
  try {
    await agent.dispose();
  } catch (e) {
    again = e;
  }
  expect(again).toBe(error);
  expect(log.length).toBe(5);
});

test("dispose：某个 disposer 同步 throw（返回 Promise 之前就抛）也挡不住其余清理与资产归零", async () => {
  const log: string[] = [];
  const syncBad = {
    dispose: (() => {
      log.push("sync");
      throw new Error("同步坏了");
    }) as unknown as () => Promise<void>,
  };
  const good = (name: string) => ({
    dispose: async () => {
      log.push(name);
    },
  });
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok")]),
    tools: [tool("t", async () => toolOk(""))],
    disposables: [syncBad, good("d2")],
    finalDisposables: [good("f1")],
  });
  expect(agent.tools.has("t")).toBe(true); // 池里除它还有恒装的 task 工具，所以不数 size

  let error: unknown;
  try {
    await agent.dispose();
  } catch (e) {
    error = e;
  }
  expect((error as Error).message).toBe("同步坏了");
  expect(log.sort()).toEqual(["d2", "f1", "sync"]); // 后面的 disposer 与 ③ 段都跑到了
  expect(agent.tools.size).toBe(0); // 资产归零也发生了
});
