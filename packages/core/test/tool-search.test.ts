// 渐进式披露（2026-09-02 用户拍板）：延迟工具**由配置给**（`AgentOptions.deferredTools`），不上模型菜单，
// 经 `tool_search` 取过 schema 才从下一轮起可调。判据落在**真装配 + 真循环**上：
// 模型直接点名要被准确拒绝、取过之后下一轮真能调——只测 harness 的过滤函数证明不了循环那半边。

import { expect, test } from "bun:test";
import { createEcho } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { resolveTool, visibleTools, type ToolMap } from "../src/tools/harness.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { Provider } from "../src/provider/types.ts";
import type { Echo } from "../src/create-echo.ts";

function scriptedProvider(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

const ping: ModelTool = {
  kind: "model",
  name: "ping",
  label: "ping",
  description: "Replies pong. Useful to check the tool loop.",
  parameters: { type: "object", properties: {} },
  execute: async () => toolOk("pong"),
};

async function echoWith(turns: ScriptedTurn[], deferredTools: readonly string[]): Promise<Echo> {
  const echo = await createEcho({
    provider: scriptedProvider(turns),
    store: new InMemoryDir(),
    lock: new InMemoryStateLock(),
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
    agent: { tools: [ping], deferredTools },
  });
  await echo.agent.start();
  return echo;
}

const toolResults = (echo: Echo): { name: string; content: string; isError: boolean }[] =>
  echo.agent.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => m as unknown as { toolName?: string; name?: string; content: string; isError: boolean })
    .map((m) => ({ name: m.toolName ?? m.name ?? "?", content: String(m.content), isError: m.isError }));

test("延迟工具不上菜单：直接点名 → 准确拒绝并指向 tool_search；取过 schema → 下一轮起真能调", async () => {
  const echo = await echoWith(
    [
      toolTurn("c1", "ping", {}), // 没取过就点：拒
      toolTurn("c2", "tool_search", { names: ["ping"] }), // 取 schema
      toolTurn("c3", "ping", {}), // 下一轮：通
      textTurn("done"),
    ],
    ["ping", "schedule_create"],
  );
  // 名单非空 → 装了 `echo:tool-search`，工具在池里（activeTools 仍列它：它是可用的，只是不在菜单上）
  expect(echo.extensions.map((e) => e.name)).toContain("echo:tool-search");
  expect(echo.agent.tools.has("tool_search")).toBe(true);
  expect(echo.agent.tools.has("ping")).toBe(true);

  await echo.agent.prompt("试试");
  const results = toolResults(echo);
  expect(results.map((r) => r.isError)).toEqual([true, false, false]);
  expect(results[0]!.content).toContain("Tool 'ping' is deferred: load it with tool_search first");
  expect(results[1]!.content).toContain("## ping"); // schema 回来了：名字、描述、参数
  expect(results[1]!.content).toContain("Replies pong");
  expect(results[1]!.content).toContain('"type":"object"');
  expect(results[2]!.content).toBe("pong"); // 取过之后，同一次 run 的下一轮就能调
  await echo.stop();
});

test("名单为空 = 全部常驻：不装 tool_search，菜单与从前一样", async () => {
  const echo = await echoWith([toolTurn("c1", "ping", {}), textTurn("done")], []);
  expect(echo.extensions.map((e) => e.name)).not.toContain("echo:tool-search");
  expect(echo.agent.tools.has("tool_search")).toBe(false);
  await echo.agent.prompt("试试");
  expect(toolResults(echo).map((r) => [r.isError, r.content])).toEqual([[false, "pong"]]);
  await echo.stop();
});

test("tool_search：description 每轮现算列出延迟层（取过的标 loaded）；不认识的名字 / 没命中都列出延迟层；query 按关键词命中", async () => {
  const echo = await echoWith(
    [
      toolTurn("c1", "tool_search", { names: ["nope"] }),
      toolTurn("c2", "tool_search", { query: "zzz-no-such" }),
      toolTurn("c3", "tool_search", { query: "PONG" }), // 大小写不敏感，匹配 description
      textTurn("done"),
    ],
    ["ping", "schedule_create"],
  );
  const search = echo.agent.tools.get("tool_search") as unknown as { description: string };
  expect(search.description).toContain("Deferred tools: ping, schedule_create.");

  await echo.agent.prompt("试试");
  const results = toolResults(echo);
  expect(results.map((r) => r.isError)).toEqual([true, true, false]);
  expect(results[0]!.content).toContain("Not deferred tools: nope");
  expect(results[0]!.content).toContain("Deferred tools: ping, schedule_create");
  expect(results[1]!.content).toContain("No deferred tool matches");
  expect(results[2]!.content).toContain("## ping");
  // 取过之后 description 跟着变：模型不会反复去取同一件
  expect(search.description).toContain("ping (loaded), schedule_create.");
  await echo.stop();
});

test("名单里的名字池里没有（那组能力没装 / MCP 断了）：如实说「not available」，不假装加载", async () => {
  const echo = await echoWith([toolTurn("c1", "tool_search", { names: ["ghost_tool"] }), textTurn("done")], ["ghost_tool", "ping"]);
  await echo.agent.prompt("试试");
  const [r] = toolResults(echo);
  expect([r!.isError, r!.content]).toEqual([false, expect.stringContaining("not available right now: ghost_tool")]);
  await echo.stop();
});

test("harness：visibleTools 按披露过滤，resolveTool 给 deferred 原因", () => {
  const tools: ToolMap = new Map([[ping.name, ping]]);
  const deferred = new Set(["ping"]);
  const loaded = new Set<string>();
  expect(visibleTools(tools, { deferred, loaded }).map((t) => t.name)).toEqual([]);
  expect(resolveTool(tools, "ping", { deferred, loaded })).toMatchObject({ ok: false, reason: "deferred" });
  loaded.add("ping");
  expect(visibleTools(tools, { deferred, loaded }).map((t) => t.name)).toEqual(["ping"]);
  expect(resolveTool(tools, "ping", { deferred, loaded })).toMatchObject({ ok: true });
  expect(visibleTools(tools).map((t) => t.name)).toEqual(["ping"]); // 不给披露 = 老行为
});
