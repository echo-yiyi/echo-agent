// `subagent`（2026-09-06 用户拍板）：模型菜单上的委派工具——子 agent 的 prompt / system / 工具集由模型在调用时决定；
// 机制是 Agent 从 Dream 抽出来的隔离子循环（`runSubagent`）。判据落在真循环上：父调工具、子在自己的 context 里
// 只带模型给的工具跑、最后一条回复回到父手里，父的 transcript 不掺子的。
// 2026-09-14 拍板加的三件：回执工具 `report`（不停循环、允许多次提交、四档 status）、fork 模式（继承父的
// system / 上下文 / 工具集）、并行扇出（`subagent` 声明 `concurrent`，`delegable: false` 的工具交不出去）。

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { listBackground } from "../src/background/harness.ts";
import { errorTurn, scriptedDialect, scriptedStreamFn, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { disableTools, restrictTools } from "../src/tools/harness.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import type { StreamFn } from "../src/provider/types.ts";

type Context = Parameters<StreamFn>[1];

const ping: ModelTool = {
  kind: "model",
  name: "ping",
  label: "ping",
  description: "Replies pong.",
  parameters: { type: "object", properties: {} },
  execute: async () => toolOk("pong"),
};

type Seen = { system: string | null; tools: string[]; body: string };

function seenOf(context: Context): Seen {
  return { system: context.systemPrompt, tools: context.tools.map((t) => t.name).sort(), body: JSON.stringify(context.messages) };
}

/** 按 system prompt 分流：父与子各有各的剧本；每次请求的 system / 工具菜单 / 消息正文都记下来。 */
function routed(parent: ScriptedTurn[], child: ScriptedTurn[], childSystem: string): { fn: StreamFn; parentSeen: Seen[]; childSeen: Seen[] } {
  const p = scriptedStreamFn(parent);
  const c = scriptedStreamFn(child);
  const parentSeen: Seen[] = [];
  const childSeen: Seen[] = [];
  const fn: StreamFn = (model, context, options) => {
    const seen = seenOf(context);
    if (context.systemPrompt === childSystem) {
      childSeen.push(seen);
      return c(model, context, options);
    }
    parentSeen.push(seen);
    return p(model, context, options);
  };
  return { fn, parentSeen, childSeen };
}

/**
 * fork 的子与父 system 一样，按正文分流：有一条带 `FORK-TASK` 的 **user** 消息 = 子的请求
 * （父的 transcript 里 FORK-TASK 只出现在 assistant 的 tool_use 输入里，不在 user 消息里）。
 */
function routedByTask(parent: ScriptedTurn[], child: ScriptedTurn[]): { fn: StreamFn; parentSeen: Seen[]; childSeen: Seen[] } {
  const p = scriptedStreamFn(parent);
  const c = scriptedStreamFn(child);
  const parentSeen: Seen[] = [];
  const childSeen: Seen[] = [];
  const fn: StreamFn = (model, context, options) => {
    const seen = seenOf(context);
    if (context.messages.some((m) => m.role === "user" && JSON.stringify(m).includes("FORK-TASK"))) {
      childSeen.push(seen);
      return c(model, context, options);
    }
    parentSeen.push(seen);
    return p(model, context, options);
  };
  return { fn, parentSeen, childSeen };
}

async function agentWith(fn: StreamFn, extra: { autoConsumeInbox?: boolean; tools?: ModelTool[] } = {}): Promise<Agent> {
  const agent = new Agent({ model: { provider: "t", id: "only", api: "scripted" }, streamFunction: fn, tools: extra.tools ?? [ping], ...(extra.autoConsumeInbox === undefined ? {} : { autoConsumeInbox: extra.autoConsumeInbox }) });
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

test("前台委派：子 agent 在自己的 context 里只带模型给的工具（加自己的 report）跑，system 是模型给的；没交回执就把最后一条回复给父；父 transcript 不掺子的", async () => {
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
  // 子：两次请求都只见 ping 与自己的 report；第一次的正文是模型给的任务，看不到父的对话
  expect(childSeen.map((s) => s.tools)).toEqual([
    ["ping", "report"],
    ["ping", "report"],
  ]);
  expect(childSeen[0]!.body).toContain("ping once and report");
  expect(childSeen[0]!.body).not.toContain("PARENT-ONLY-TOKEN");
  // 父的菜单上有 subagent，也有 ping（子集是从父池里点的）；report 只在子的菜单上
  expect(parentSeen[0]!.tools).toEqual(expect.arrayContaining(["subagent", "ping"]));
  expect(parentSeen[0]!.tools).not.toContain("report");
  expect(parentSeen.length).toBe(2);
});

test("回执（2026-09-14 拍板）：子多次 report 不停循环；父拿到的是全部回执按序，末条 status 是终态，子的收尾正文不掺进来", async () => {
  const { fn, childSeen } = routed(
    [toolTurn("c1", "subagent", { prompt: "do it", system: "You are thorough.", tools: [] }), textTurn("parent done")],
    [
      toolTurn("k1", "report", { status: "working", summary: "half way" }),
      toolTurn("k2", "report", { status: "done", summary: "all set", details: "touched a.ts\nand b.ts" }),
      textTurn("child epilogue"),
    ],
    "You are thorough.",
  );
  const agent = await agentWith(fn);
  await agent.prompt("go");
  const [r] = toolResults(agent);
  expect(r).toEqual({ name: "subagent", content: "#1 [working] half way\n#2 [done] all set\n   touched a.ts\n   and b.ts", isError: false });
  // 第一条回执之后子还在跑：第二、第三次请求都发出去了
  expect(childSeen.length).toBe(3);
  expect(childSeen[1]!.body).toContain("Recorded receipt #1 (working)");
});

test("回执：末条还是 working 的，父看到「没有终态回执」的标注并附上子的末条正文；status 不在四档里判红、不记", async () => {
  const { fn } = routed(
    [toolTurn("c1", "subagent", { prompt: "do it", system: "S", tools: [] }), textTurn("parent done")],
    [
      toolTurn("k0", "report", { status: "meh", summary: "x" }),
      toolTurn("k1", "report", { status: "working", summary: "still going" }),
      textTurn("conclusion only in text"),
    ],
    "S",
  );
  const agent = await agentWith(fn);
  await agent.prompt("go");
  const [r] = toolResults(agent);
  expect(r!.isError).toBe(false);
  expect(r!.content).toBe("#1 [working] still going\n(The subagent ended without a closing receipt; its last status is working.)\nIts last reply:\nconclusion only in text");
});

test("回执：子半路失败，已交的回执随失败结果一起回到父手里", async () => {
  const { fn } = routed(
    [toolTurn("c1", "subagent", { prompt: "do it", system: "S", tools: [] }), textTurn("parent done")],
    [toolTurn("k1", "report", { status: "working", summary: "got this far" }), errorTurn("provider_down", "boom", false)],
    "S",
  );
  const agent = await agentWith(fn);
  await agent.prompt("go");
  const [r] = toolResults(agent);
  expect(r!.isError).toBe(true);
  expect(r!.content).toContain("Subagent failed: boom");
  expect(r!.content).toContain("Receipts before it stopped:\n#1 [working] got this far");
});

test("验形：不认识的工具整组判红并列出可用的；子 agent 拿不到 subagent / report；空 prompt 判红；fork 不收 system / tools；fresh 缺 tools 判红；mode 乱写判红——都不起子循环", async () => {
  const { fn, childSeen } = routed(
    [
      toolTurn("c1", "subagent", { prompt: "x", tools: ["nope"] }),
      toolTurn("c2", "subagent", { prompt: "x", tools: ["subagent"] }),
      toolTurn("c3", "subagent", { prompt: "  ", tools: [] }),
      toolTurn("c4", "subagent", { prompt: "x", tools: ["report"] }),
      toolTurn("c5", "subagent", { prompt: "x", mode: "fork", tools: ["ping"] }),
      toolTurn("c6", "subagent", { prompt: "x" }),
      toolTurn("c7", "subagent", { prompt: "x", mode: "bogus", tools: [] }),
      textTurn("done"),
    ],
    [],
    "never",
  );
  const agent = await agentWith(fn);
  await agent.prompt("go");
  const rs = toolResults(agent);
  expect(rs.map((r) => r.isError)).toEqual([true, true, true, true, true, true, true]);
  expect(rs[0]!.content).toContain("Unknown tools: nope");
  expect(rs[0]!.content).toContain("ping"); // 列出可用的
  expect(rs[0]!.content).not.toContain("subagent,"); // 可用清单里没有 subagent 自己
  expect(rs[0]!.content).not.toMatch(/Available:.*\breport\b/); // report 是子循环自己造的，不在父池的可委派清单里
  expect(rs[1]!.content).toContain("cannot spawn subagents");
  expect(rs[2]!.content).toContain("prompt");
  expect(rs[3]!.content).toContain("its own 'report' tool");
  expect(rs[4]!.content).toContain("leave system and tools out");
  expect(rs[5]!.content).toContain("tools must be an array");
  expect(rs[6]!.content).toContain("mode must be 'fresh' or 'fork'");
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
      toolTurn("c0", "subagent", { prompt: "x", tools: ["tool_search"] }), // tool_search 本身也不能交出去：它替父取 schema
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
    ["subagent", true],
    ["tool_search", false],
    ["subagent", false],
  ]);
  expect(rs[0]!.content).toContain("Unknown tools: tool_search");
  expect(rs[1]!.content).toContain("Unknown tools: lazy");
  expect(rs[1]!.content).not.toMatch(/Available:.*\blazy\b/); // 还没取的 lazy 不在可委派清单里
  expect(rs[1]!.content).not.toMatch(/Available:.*tool_search/); // tool_search 也不在（review 2026-09-09：子调它会往父的 loadedTools 里写）
  expect(childSeen.map((s) => s.tools)).toEqual([["lazy", "report"]]);
  await agent.dispose();
});

test("不可委派（2026-09-14 拍板）：标了 delegable: false 的工具 fresh 点名判红、清单里也没有；fork 整套继承时同样不带它", async () => {
  const pinned: ModelTool = { ...ping, name: "pinned", label: "pinned", delegable: false };
  const { fn, parentSeen, childSeen } = routedByTask(
    [toolTurn("c1", "subagent", { prompt: "x", tools: ["pinned"] }), toolTurn("c2", "subagent", { prompt: "FORK-TASK look around", mode: "fork" }), textTurn("done")],
    [textTurn("forked ok")],
  );
  const agent = await agentWith(fn, { tools: [ping, pinned] });
  await agent.prompt("go");
  const rs = toolResults(agent);
  expect(rs.map((r) => r.isError)).toEqual([true, false]);
  expect(rs[0]!.content).toContain("Unknown tools: pinned");
  expect(rs[0]!.content).not.toMatch(/Available:.*\bpinned\b/);
  expect(parentSeen[0]!.tools).toContain("pinned"); // 父自己照常有它
  expect(childSeen[0]!.tools).not.toContain("pinned");
  expect(childSeen[0]!.tools).toContain("ping");
});

test("fork（2026-09-14 拍板）：子继承父的 system、父的对话（截到派它的那条 assistant 之前）与父的可委派工具集；父只拿到子的回复", async () => {
  const { fn, parentSeen, childSeen } = routedByTask(
    [toolTurn("c1", "subagent", { prompt: "FORK-TASK check the tail", mode: "fork" }), textTurn("parent done")],
    [toolTurn("k1", "report", { status: "done", summary: "tail is fine" }), textTurn("forked reply")],
  );
  const agent = await agentWith(fn);
  await agent.prompt("PARENT-ONLY-TOKEN");
  expect(toolResults(agent)).toEqual([{ name: "subagent", content: "#1 [done] tail is fine", isError: false }]);
  expect(childSeen.length).toBe(2);
  const first = childSeen[0]!;
  // system 与父的一样（同一份装配），不是 null 也不是模型给的
  expect(first.system).toBe(parentSeen[0]!.system);
  // 看得到父的对话，看不到派它的那条 assistant（tool_use 还没结果，不给半截）
  expect(first.body).toContain("PARENT-ONLY-TOKEN");
  expect(first.body).not.toContain("tool_use");
  expect(first.body).toContain("FORK-TASK check the tail");
  // 工具集 = 父菜单上的，去掉 subagent / tool_search，加上 report
  const expected = [...parentSeen[0]!.tools.filter((n) => n !== "subagent" && n !== "tool_search"), "report"].sort();
  expect(first.tools).toEqual(expected);
  // 父的 transcript 一字不掺子的
  expect(agent.state.messages.filter((m) => m.role === "assistant").length).toBe(2);
});

test("并行扇出（2026-09-14 拍板）：同一条 assistant 消息里的两个 subagent 调用同批同跑——第二个子的请求在第一个子结束之前就发出", async () => {
  const twoCalls: ScriptedTurn = [
    { type: "start" },
    { type: "toolcall_start", toolCallId: "a", name: "subagent" },
    { type: "toolcall_delta", argsText: JSON.stringify({ prompt: "left", system: "A", tools: [] }) },
    { type: "toolcall_end" },
    { type: "toolcall_start", toolCallId: "b", name: "subagent" },
    { type: "toolcall_delta", argsText: JSON.stringify({ prompt: "right", system: "B", tools: [] }) },
    { type: "toolcall_end" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "subagent", input: { prompt: "left", system: "A", tools: [] } },
          { type: "tool_use", id: "b", name: "subagent", input: { prompt: "right", system: "B", tools: [] } },
        ],
        stopReason: "tool_use",
        usage: null,
      },
    },
  ];
  const parent = scriptedStreamFn([twoCalls, textTurn("both back")]);
  let started = 0;
  // 子的方言先等「两个都起来了」再吐剧本。串行的话第一个子永远等不到第二个：这里的超时就是「并行没生效」的红
  const gated = (turns: ScriptedTurn[]): StreamFn => {
    const base = scriptedDialect(turns);
    const streams = createProviderStreams({
      api: base.api,
      async *request(model, context, options) {
        started++;
        await until(() => started >= 2, "两个子 agent 同时在跑", 2000);
        yield* base.request(model, context, options);
      },
    });
    return (model, context, options) => streams.stream(model, context, options);
  };
  const a = gated([textTurn("A done")]);
  const b = gated([textTurn("B done")]);
  const fn: StreamFn = (model, context, options) => {
    if (context.systemPrompt === "A") return a(model, context, options);
    if (context.systemPrompt === "B") return b(model, context, options);
    return parent(model, context, options);
  };
  const agent = await agentWith(fn);
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  expect(toolResults(agent)).toEqual([
    { name: "subagent", content: "A done", isError: false },
    { name: "subagent", content: "B done", isError: false },
  ]);
});

test("后台委派：kind subagent 的后台任务；每条回执当场投 inbox、结束再投收尾（终态与条数），父空闲时逐批看到", async () => {
  const { fn, parentSeen } = routed(
    [
      toolTurn("c1", "subagent", { prompt: "think in the background", system: "You are quiet.", tools: [], background: true }),
      textTurn("parent done"),
      textTurn("ack1"), // inbox 那几轮：回执与收尾攒成几批不定，给足剧本
      textTurn("ack2"),
      textTurn("ack3"),
    ],
    [toolTurn("k1", "report", { status: "working", summary: "step one" }), toolTurn("k2", "report", { status: "done", summary: "finished: 42" }), textTurn("bg epilogue")],
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
  expect(task.buffer.tail(1000)).toContain("[report #1 [working] step one]");
  // 收尾那条到了父眼前之后，两条回执也都到过（各是一条环境消息，ref 带 seq 所以不被去重）
  await until(() => parentSeen.some((s) => s.body.includes("finished: 2 receipt(s), final status done")), "收尾那一轮");
  const all = parentSeen.map((s) => s.body).join("\n");
  expect(all).toContain(`Subagent ${task.id} (think in the background) receipt #1 [working] step one`);
  expect(all).toContain(`receipt #2 [done] finished: 42`);
  expect(all).not.toContain("bg epilogue"); // 交过回执：收尾不带末条正文
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
