// 收紧工作集（2026-09-07，角色定义）：`AgentTools.restrict(names)` 把这一段 session 的工具集
// 收成池的子集。**只能少不能多**，池一个字不动。
//
// 判据分两层：harness 的求交本身，以及**接线**——菜单、状态快照、执行时解析三个读点是不是同一个
// 口径。只测 harness 证明不了「菜单上没有但点得动」这类漏接线，而那正是收紧唯一会真出错的地方。

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { ExtensionHost } from "../src/extension/host.ts";
import { agentRegistries, AgentTools } from "../src/extension/registries.ts";
import { defineExtension } from "../src/extension/abi.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { activeTools, effectiveRestriction, registerTool, resolveTool, restrictTools, visibleTools, type ToolMap, type ToolRestrictions } from "../src/tools/harness.ts";
import { toolOk, type AgentTool, type ModelTool } from "../src/tools/types.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn } from "../src/testing.ts";

function tool(name: string): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => toolOk("ok") };
}

function poolOf(...names: string[]): ToolMap {
  const map: ToolMap = new Map();
  for (const n of names) void registerTool(map, tool(n) as AgentTool);
  return map;
}

/* ─────────────── ① 求交本身 ─────────────── */

test("一条都没有 = 不收紧（undefined,不是空集——空集会把工作集清成零件）", () => {
  const list: ToolRestrictions = [];
  expect(effectiveRestriction(list)).toBeUndefined();
  expect(activeTools(poolOf("a", "b"), effectiveRestriction(list)).map((t) => t.name).sort()).toEqual(["a", "b"]);
});

test("多条并存 = 交集,叠加只会更小;disposer 只摘自己那一条", () => {
  const list: ToolRestrictions = [];
  const off1 = restrictTools(list, new Set(["a", "b", "c"]));
  const off2 = restrictTools(list, new Set(["b", "c", "d"]));
  expect([...effectiveRestriction(list)!].sort()).toEqual(["b", "c"]);
  off2();
  expect([...effectiveRestriction(list)!].sort()).toEqual(["a", "b", "c"]); // 只摘掉第二条
  off1();
  expect(effectiveRestriction(list)).toBeUndefined();
});

test("收紧是**池 ∩ names**:names 里有池外的名字不会把它变出来", () => {
  const pool = poolOf("a", "b");
  const only = new Set(["a", "ghost"]);
  expect(activeTools(pool, only).map((t) => t.name)).toEqual(["a"]);
});

test("三个读点同一个口径:菜单、快照、执行时解析都认这一份", () => {
  const pool = poolOf("a", "b");
  const only = new Set(["a"]);
  expect(activeTools(pool, only).map((t) => t.name)).toEqual(["a"]);
  expect(visibleTools(pool, undefined, only).map((t) => t.name)).toEqual(["a"]);
  expect(resolveTool(pool, "a", undefined, only).ok).toBe(true);
  // 被挡住的:对这一段来说**就是不存在**——它从没上过菜单,点它只可能是幻觉
  expect(resolveTool(pool, "b", undefined, only)).toEqual({ ok: false, reason: "not_found" });
});

/* ─────────────── ② 接线（真 Agent + 真 mount） ─────────────── */

function hostFor(agent: Agent): ExtensionHost {
  return new ExtensionHost({
    services: agentRegistries({ tools: agent.tools, toolRestrictions: agent.toolRestrictions, hooks: agent.hooks }),
  });
}

const RESTRICTOR = defineExtension<{ names: string[] }>({
  name: "t:role",
  hostAbiVersion: 1,
  reload: "agent",
  inject: { tools: { service: AgentTools, required: true } },
  config: (raw) => raw as { names: string[] },
  apply(ctx, config) {
    const reg = ctx.get(AgentTools);
    void ctx.effect({ boundary: "agent", start: () => ({ value: "restrict", dispose: reg.restrict(new Set(config.names)) }) });
  },
});

test("mount 之后状态快照只剩子集;unmount 复原——池自始至终没动过", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("好")]) });
  void registerTool(agent.tools, tool("read_file") as AgentTool);
  void registerTool(agent.tools, tool("write_file") as AgentTool);
  const host = hostFor(agent);

  await host.mount("g1", [{ entryId: "t:role", definition: RESTRICTOR as never, config: { names: ["read_file"] } }]);
  expect(agent.state.tools.map((t) => t.name)).toEqual(["read_file"]);
  expect(agent.tools.size).toBe(2); // **池不动**:收紧的是露出什么,不是装了什么

  await host.unmount("g1");
  expect(agent.state.tools.map((t) => t.name).sort()).toEqual(["read_file", "write_file"]);
});

test("收紧**之后**注册的工具也露不出来——求交在查询时做,不是一次性打标记", async () => {
  // 这条是 `disabled` 那条路走不通的原因:标记打在对象上,后来的工具没被打上,
  // 于是角色一边限着、池里一边冒出没限住的工具。
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("好")]) });
  void registerTool(agent.tools, tool("read_file") as AgentTool);
  const host = hostFor(agent);
  await host.mount("g1", [{ entryId: "t:role", definition: RESTRICTOR as never, config: { names: ["read_file"] } }]);

  void registerTool(agent.tools, tool("shell") as AgentTool); // 别的 extension 后到
  expect(agent.state.tools.map((t) => t.name)).toEqual(["read_file"]);
  expect(agent.tools.has("shell")).toBe(true); // 池里在,只是这一段看不见
});

test("没接工作集表的 Host:restrict() 抛——装上了不生效比装不上更坏", () => {
  const services = agentRegistries({ tools: new Map(), hooks: new HookRuntime() });
  const reg = services.find(([k]) => k === AgentTools)![1] as { restrict: (n: ReadonlySet<string>) => () => void };
  expect(() => reg.restrict(new Set(["a"]))).toThrow(/没接工作集收紧表/);
});
