// `subagent`（2026-09-06 用户拍板）：模型菜单上的委派工具——子 agent 的 prompt / system / 工具集由模型在调用时决定；
// 机制是 Agent 从 Dream 抽出来的隔离子循环（`runSubagent`）。判据落在真循环上：父调工具、子在自己的 context 里
// 只带模型给的工具跑、最后一条回复回到父手里，父的 transcript 不掺子的。

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { listBackground } from "../src/background/harness.ts";
import { scriptedStreamFn, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { disableTools, restrictTools } from "../src/tools/harness.ts";
import type { StreamFn } from "../src/provider/types.ts";

const ping: ModelTool = {
  kind: "model",
  name: "ping",
  label: "ping",
  description: "Replies pong.",
  parameters: { type: "object", properties: {} },
  execute: async () => toolOk("pong"),
};

type Seen = { system: string | null; tools: string[]; body: string };

/** 按 system prompt 分流：父与子各有各的剧本；每次请求的 system / 工具菜单 / 消息正文都记下来。 */
function routed(parent: ScriptedTurn[], child: ScriptedTurn[], childSystem: string): { fn: StreamFn; parentSeen: Seen[]; childSeen: Seen[] } {
  const p = scriptedStreamFn(parent);
  const c = scriptedStreamFn(child);
  const parentSeen: Seen[] = [];
  const childSeen: Seen[] = [];
  const fn: StreamFn = (model, context, options) => {
    const seen: Seen = { system: context.systemPrompt, tools: context.tools.map((t) => t.name).sort(), body: JSON.stringify(context.messages) };
    if (context.systemPrompt === childSystem) {
      childSeen.push(seen);
      return c(model, context, options);
    }
    parentSeen.push(seen);
    return p(model, context, options);
  };
  return { fn, parentSeen, childSeen };
}

async function agentWith(fn: StreamFn, extra: { autoConsumeInbox?: boolean } = {}): Promise<Agent> {
  const agent = new Agent({ model: { provider: "t", id: "only", api: "scripted" }, streamFunction: fn, tools: [ping], ...extra });
  await mountBuiltinTools(agent); // 低层 Agent 工具面为空：内建那张表要自己 mount（与 createEcho 同一条路）
  await agent.start();
  return agent;
}

function toolResults(agent: Agent): { name: string; content: string; isError: boolean }[] {
  return agent.state.messages.flatMap((m) => (m.role === "toolResult" ? [{ name: m.toolName, content: m.content, isError: m.isError }] : []));
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("前台委派：子 agent 在自己的 context 里只带模型给的工具跑，system 是模型给的；最后一条回复回到父手里；父 transcript 不掺子的", async () => {
  const { fn, parentSeen, childSeen } = routed(
    [toolTurn("c1", "subagent", { prompt: "ping once and report", system: "You are a counter.", tools: ["ping"] }), textTurn("parent done")],
    [toolTurn("k1", "ping", {}), textTurn("child: one pong")],
    "You are a counter.",
  );
  const agent = await agentWith(fn);
  const r = await agent.prompt("PARENT-ONLY-TOKEN");
  expect(r.outcome.kind).toBe("completed");
  // 父只看到 subagent 一件工具的结果：子调的 ping 及其结果不进父 transcript
  expect(toolResults(agent)).toEqual([{ name: "subagent", content: "child: one pong", isError: false }]);
  // 子：两次请求都只见 ping；第一次的正文是模型给的任务，看不到父的对话
  expect(childSeen.map((s) => s.tools)).toEqual([["ping"], ["ping"]]);
  expect(childSeen[0]!.body).toContain("ping once and report");
  expect(childSeen[0]!.body).not.toContain("PARENT-ONLY-TOKEN");
  // 父的菜单上有 subagent，也有 ping（子集是从父池里点的）
  expect(parentSeen[0]!.tools).toEqual(expect.arrayContaining(["subagent", "ping"]));
  expect(parentSeen.length).toBe(2);
});

test("验形：不认识的工具整组判红并列出可用的；子 agent 拿不到 subagent；空 prompt 判红——都不起子循环", async () => {
  const { fn, childSeen } = routed(
    [
      toolTurn("c1", "subagent", { prompt: "x", tools: ["nope"] }),
      toolTurn("c2", "subagent", { prompt: "x", tools: ["subagent"] }),
      toolTurn("c3", "subagent", { prompt: "  ", tools: [] }),
      textTurn("done"),
    ],
    [],
    "never",
  );
  const agent = await agentWith(fn);
  await agent.prompt("go");
  const rs = toolResults(agent);
  expect(rs.map((r) => r.isError)).toEqual([true, true, true]);
  expect(rs[0]!.content).toContain("Unknown tools: nope");
  expect(rs[0]!.content).toContain("ping"); // 列出可用的
  expect(rs[0]!.content).not.toContain("subagent,"); // 可用清单里没有 subagent 自己
  expect(rs[1]!.content).toContain("cannot spawn subagents");
  expect(rs[2]!.content).toContain("prompt");
  expect(childSeen).toEqual([]);
});

test("委派不绕过工具面：被禁用的、被角色收紧挡在外面的工具，子 agent 一样拿不到（review 2026-09-07）", async () => {
  const dead: ModelTool = { ...ping, name: "dead", label: "dead" };
  const other: ModelTool = { ...ping, name: "other", label: "other" };
  const { fn, childSeen } = routed(
    [toolTurn("c1", "subagent", { prompt: "x", tools: ["dead"] }), toolTurn("c2", "subagent", { prompt: "x", tools: ["other"] }), textTurn("done")],
    [],
    "never",
  );
  const agent = new Agent({ model: { provider: "t", id: "only", api: "scripted" }, streamFunction: fn, tools: [ping, dead, other] });
  await mountBuiltinTools(agent);
  await agent.start();
  disableTools(agent.tools, ["dead"], "MCP server 's' disconnected");
  restrictTools(agent.toolRestrictions, new Set(["ping", "dead", "subagent"])); // other 被角色收紧挡在工作集外
  await agent.prompt("go");
  const rs = toolResults(agent);
  expect(rs.map((r) => r.isError)).toEqual([true, true]);
  expect(rs[0]!.content).toContain("dead"); // 禁用的：不在可委派清单里
  expect(rs[1]!.content).toContain("Unknown tools: other"); // 收紧掉的：对这一段来说就是不存在
  expect(childSeen).toEqual([]); // 两次都没起子循环
  await agent.dispose();
});

test("委派也不绕过渐进披露：父没 tool_search 过的延迟工具不在可委派清单里；取过 schema 之后才能给子 agent（2026-09-09 拍板）", async () => {
  const lazy: ModelTool = { ...ping, name: "lazy", label: "lazy", deferred: true };
  const { fn, childSeen } = routed(
    [
      toolTurn("c1", "subagent", { prompt: "x", tools: ["lazy"] }), // 没取过：拒，清单里也没有它
      toolTurn("c2", "tool_search", { names: ["lazy"] }), // 父自己取 schema
      toolTurn("c3", "subagent", { prompt: "use lazy", system: "You are lazy.", tools: ["lazy"] }), // 取过：能委派
      textTurn("done"),
    ],
    [textTurn("child ok")],
    "You are lazy.",
  );
  const agent = new Agent({ model: { provider: "t", id: "only", api: "scripted" }, streamFunction: fn, tools: [ping, lazy] });
  await mountBuiltinTools(agent);
  await agent.start();
  await agent.prompt("go");
  const rs = toolResults(agent);
  expect(rs.map((r) => [r.name, r.isError])).toEqual([
    ["subagent", true],
    ["tool_search", false],
    ["subagent", false],
  ]);
  expect(rs[0]!.content).toContain("Unknown tools: lazy");
  expect(rs[0]!.content).toContain("tool_search"); // 清单上有取 schema 的入口，没有还没取的 lazy
  expect(rs[0]!.content).not.toMatch(/Available:.*\blazy\b/);
  expect(childSeen.map((s) => s.tools)).toEqual([["lazy"]]);
  await agent.dispose();
});

test("后台委派：kind subagent 的后台任务，子的文字进缓冲；结束时回复投 inbox，父下一轮就看到", async () => {
  const { fn, parentSeen } = routed(
    [
      toolTurn("c1", "subagent", { prompt: "think in the background", system: "You are quiet.", tools: [], background: true }),
      textTurn("parent done"),
      textTurn("ack"), // inbox 那一轮
    ],
    [textTurn("bg reply: 42")],
    "You are quiet.",
  );
  const agent = await agentWith(fn, { autoConsumeInbox: true });
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  expect(toolResults(agent)[0]).toEqual({ name: "subagent", content: expect.stringContaining("Started subagent bg-"), isError: false });

  const task = listBackground(agent.background.tasks)[0]!;
  expect(task.kind).toBe("subagent");
  await task.settled;
  expect(task.status).toBe("completed");
  expect(task.buffer.tail(1000)).toContain("bg reply: 42");
  // 结束投 inbox → 空闲时自动消费成一轮：父的第三次请求里带着那条 environment 消息
  await until(() => parentSeen.length >= 3, "inbox 那一轮");
  expect(parentSeen[2]!.body).toContain("bg reply: 42");
});

test("父 run 之外派不了：前台与后台都如实拒绝", async () => {
  const agent = await agentWith(routed([textTurn("x")], [], "never").fn);
  const tool = agent.tools.get("subagent")!;
  const ctx = { toolCallId: "t", workspace: "/", sessionId: null, iteration: 0 };
  const fg = await tool.execute({ prompt: "x", tools: [] }, ctx);
  expect([fg.isError, fg.content]).toEqual([true, expect.stringContaining("inside a run")]);
  const bg = await tool.execute({ prompt: "x", tools: [], background: true }, ctx);
  expect([bg.isError, bg.content]).toEqual([true, expect.stringContaining("inside a run")]);
});
