// 渐进式披露（2026-09-02 用户拍板）：延迟是**工具自己的标记**（`ToolBase.deferred`，与 `disabled` 同款），
// 标了的不上模型菜单，经 `tool_search` 取过 schema 才从下一轮起可调。判据落在**真装配 + 真循环**上：
// 模型直接点名要被准确拒绝、取过之后下一轮真能调——只测 harness 的过滤函数证明不了循环那半边。

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOf, createEcho } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { resolveTool, visibleTools, type ToolMap } from "../src/tools/harness.ts";
import { makeToolSearchTool } from "../src/tools/tool-search.ts";
import { toolOk, type AgentTool, type ModelTool } from "../src/tools/types.ts";
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
/** 同一件工具，标成延迟——改的只是定义上的一个字段，这就是「配置」 */
const lazyPing: ModelTool = { ...ping, deferred: true };

async function echoWith(turns: ScriptedTurn[], tools: AgentTool[]): Promise<Echo> {
  const echo = await createEcho({
    provider: scriptedProvider(turns),
    store: new InMemoryDir(),
    lock: new InMemoryStateLock(),
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
    agent: { tools },
  });
  await echo.start();
  return echo;
}

const toolResults = (echo: Echo): { content: string; isError: boolean }[] =>
  agentOf(echo).messages
    .filter((m) => m.role === "toolResult")
    .map((m) => m as unknown as { content: string; isError: boolean })
    .map((m) => ({ content: String(m.content), isError: m.isError }));

test("标了 deferred 的工具不上菜单：直接点名 → 准确拒绝并指向 tool_search；取过 schema → 下一轮起真能调", async () => {
  const echo = await echoWith(
    [
      toolTurn("c1", "ping", {}), // 没取过就点：拒
      toolTurn("c2", "tool_search", { names: ["ping"] }), // 取 schema
      toolTurn("c3", "ping", {}), // 下一轮：通
      textTurn("done"),
    ],
    [lazyPing],
  );
  // `echo:tool-search` 恒装；工具在池里（activeTools 仍列它：它是可用的，只是不在菜单上）
  expect(echo.extensions.map((e) => e.name)).toContain("echo:tool-search");
  expect(agentOf(echo).tools.has("tool_search")).toBe(true);
  expect(agentOf(echo).tools.has("ping")).toBe(true);

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

test("没有延迟工具时 tool_search 自己也不上菜单：常驻工具照旧直接可调", async () => {
  const echo = await echoWith([toolTurn("c1", "ping", {}), textTurn("done")], [ping]);
  await echo.agent.prompt("试试");
  expect(toolResults(echo).map((r) => [r.isError, r.content])).toEqual([[false, "pong"]]);
  await echo.stop();
});

test("tool_search：description 每轮现算列出延迟层（取过的标 loaded）；不认识的名字 / 没命中都列出延迟层；query 按关键词命中", async () => {
  const lazyOther: ModelTool = { ...ping, name: "other", description: "Something else entirely.", deferred: true };
  const echo = await echoWith(
    [
      toolTurn("c1", "tool_search", { names: ["nope"] }),
      toolTurn("c2", "tool_search", { query: "zzz-no-such" }),
      toolTurn("c3", "tool_search", { query: "PONG" }), // 大小写不敏感，匹配 description
      textTurn("done"),
    ],
    [lazyPing, lazyOther],
  );
  const search = agentOf(echo).tools.get("tool_search") as unknown as { description: string };
  // core 自己那几件缺省延迟的（schedule_* / skill_create / TaskGet / transcript_read）也在名单里
  expect(search.description).toContain("other, ping, schedule_cancel, schedule_create, schedule_list, skill_create");

  await echo.agent.prompt("试试");
  const results = toolResults(echo);
  expect(results.map((r) => r.isError)).toEqual([true, true, false]);
  expect(results[0]!.content).toContain("Not deferred tools: nope");
  expect(results[0]!.content).toContain("Deferred tools: ");
  expect(results[1]!.content).toContain("No deferred tool matches");
  expect(results[2]!.content).toContain("## ping");
  expect(results[2]!.content).not.toContain("## other"); // 关键词只命中 ping
  // 取过之后 description 跟着变：模型不会反复去取同一件
  expect(search.description).toContain("ping (loaded)");
  expect(search.description).toContain("other,"); // 没取的不标
  await echo.stop();
});

test("harness：visibleTools 按标记 + 已加载过滤，tool_search 只在还有待取的延迟工具时上菜单；resolveTool 给 deferred 原因", () => {
  const loaded = new Set<string>();
  const tools: ToolMap = new Map<string, AgentTool>([[lazyPing.name, lazyPing]]);
  tools.set("tool_search", makeToolSearchTool({ tools, loaded }));

  // 没取过：ping 不在菜单，tool_search 在（有东西可取）
  expect(visibleTools(tools, loaded).map((t) => t.name)).toEqual(["tool_search"]);
  expect(resolveTool(tools, "ping", loaded)).toMatchObject({ ok: false, reason: "deferred" });
  // 取过：ping 上菜单，tool_search 下菜单（没剩什么可取）
  loaded.add("ping");
  expect(visibleTools(tools, loaded).map((t) => t.name)).toEqual(["ping"]);
  expect(resolveTool(tools, "ping", loaded)).toMatchObject({ ok: true });
  // 不给 loaded = 老行为：不过滤（低层调用方自己不做披露）
  expect(visibleTools(tools).map((t) => t.name).sort()).toEqual(["ping", "tool_search"]);
});

/* ───────────── 已加载的延迟工具跟着会话走（2026-11-03） ───────────── */

// 此前「取过 schema」只记在进程内存里：续会话后菜单缩回去，模型再 tool_search 一次，菜单又变——
// 每变一次，菜单之后的整段历史都失去 provider 缓存。已加载的名字本来就随 tool_search 结果的 metadata 落了盘，
// 续会话时从 transcript 里收回来即可，不另存状态。

/** 记下每次请求的菜单（工具名，按序）。 */
function recordingProvider(turns: ScriptedTurn[], menus: string[][]): Provider {
  const inner = scriptedDialect(turns);
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams({
      api: inner.api,
      request(model, context, options) {
        menus.push(context.tools.map((t) => t.name));
        return inner.request(model, context, options);
      },
    }),
  });
}

test("续会话：上个进程取过 schema 的延迟工具，新进程第一次请求的菜单里照样有，不用再 tool_search", async () => {
  const root = mkdtempSync(join(tmpdir(), "echo-loaded-"));
  const base = { allowNetwork: false, withoutMemory: true, extensionDirs: [], sessionsRoot: root, agent: { tools: [lazyPing] } };
  const before: string[][] = [];
  const first = await createEcho({
    ...base,
    provider: recordingProvider([toolTurn("s1", "tool_search", { names: ["ping"] }), toolTurn("p1", "ping", {}), textTurn("ok")], before),
  });
  await first.start();
  await first.agent.prompt("load ping and call it");
  const id = first.agent.state.sessionId!;
  await first.stop();
  expect(before[before.length - 1]).toContain("ping"); // 前提：上个进程最后一次请求的菜单里有它

  const after: string[][] = [];
  const second = await createEcho({ ...base, sessionId: id, provider: recordingProvider([textTurn("still here")], after) });
  await second.start();
  await second.agent.prompt("again");
  await second.stop();
  expect(after[0]).toEqual(before[before.length - 1]); // 菜单逐项相同：前缀不变，缓存不断
});

test("reset 清空对话：已加载的延迟工具一起清掉，菜单回到只有常驻的那一份", async () => {
  const menus: string[][] = [];
  const echo = await createEcho({
    provider: recordingProvider([toolTurn("s1", "tool_search", { names: ["ping"] }), textTurn("loaded"), textTurn("fresh")], menus),
    store: new InMemoryDir(),
    lock: new InMemoryStateLock(),
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
    agent: { tools: [lazyPing] },
  });
  await echo.start();
  await echo.agent.prompt("load ping");
  expect(menus[menus.length - 1]).toContain("ping");
  await echo.agent.reset();
  await echo.agent.prompt("start over");
  expect(menus[menus.length - 1]).not.toContain("ping");
  expect(menus[menus.length - 1]).toContain("tool_search"); // 还有没取的延迟工具，入口回到菜单上
  await echo.stop();
});
