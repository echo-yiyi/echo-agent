// `tool_search`：渐进式披露的唯一入口（2026-09-02 用户拍板，形状照 Claude Code 的 ToolSearch）。
//
// 延迟工具是**工具自己的标记**（`ToolBase.deferred`，与 `disabled` 同一条规矩：状态住在工具身上，
// 改缺省 = 改工具的定义），注册在池里但不上菜单；模型要用，先在这里按名或按关键词取 schema——
// 取过的进 `loaded`，下一轮起上菜单。延迟层的**名字**跟着本工具的 description 走（每轮现算）：
// 工具不进 system，名字也不进。
//
// 为什么「下一轮起」而不是当轮：循环的工作集是轮首冻结的（`AgentLoopConfig.getTools()` 的契约，
// 实时池不能成为第二条解析路）。模型拿到 schema 之后本来也要再发一轮才会调它，没有损失。

import type { ToolMap } from "./harness.ts";
import { isModelVisible, toolError, toolOk, toolSchemas, type AgentTool, type ModelTool } from "./types.ts";

export const TOOL_SEARCH_NAME = "tool_search";

export type ToolSearchDeps = {
  readonly tools: ToolMap;
  /** 可变：本工具唯一会写的状态。按 agent 进程记，不持久化、`reset()` 也不清。 */
  readonly loaded: Set<string>;
};

/** 池里当前标着 `deferred` 的工具（按名排）。每次现算：extension / MCP 后注册的也算数。 */
export function deferredTools(tools: ToolMap): readonly AgentTool[] {
  return [...tools.values()].filter((t) => t.deferred === true).sort((a, b) => a.name.localeCompare(b.name));
}

type Params = { names?: string[]; query?: string };

export function makeToolSearchTool(deps: ToolSearchDeps): ModelTool<Params> {
  const catalog = (): string =>
    deferredTools(deps.tools)
      .map((t) => (deps.loaded.has(t.name) ? `${t.name} (loaded)` : t.name))
      .join(", ");
  return {
    kind: "model",
    name: TOOL_SEARCH_NAME,
    label: "取工具",
    // **getter**：延迟层的名字每轮现算——加载过的标出来，模型不会反复去取同一件
    get description(): string {
      return (
        "Load the schemas of deferred tools so you can call them from the next turn on. " +
        "Pass names for exact tools, or query to match names and descriptions. " +
        `Deferred tools: ${catalog()}.`
      );
    },
    parameters: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, description: "Exact tool names to load" },
        query: { type: "string", description: "Keyword matched against deferred tools' names and descriptions (case-insensitive)" },
      },
    },
    async execute({ names, query }) {
      const deferred = deferredTools(deps.tools);
      const byName = new Map(deferred.map((t) => [t.name, t] as const));
      const wanted = new Set<string>();
      const unknown: string[] = [];
      for (const n of names ?? []) {
        if (byName.has(n)) wanted.add(n);
        else unknown.push(n);
      }
      if (query !== undefined && query.trim() !== "") {
        const q = query.trim().toLowerCase();
        for (const t of deferred) {
          const text = `${t.name} ${isModelVisible(t) ? (t.description ?? "") : ""}`.toLowerCase();
          if (text.includes(q)) wanted.add(t.name);
        }
      }
      if (unknown.length > 0) {
        return toolError(`Not deferred tools: ${unknown.join(", ")}. Deferred tools: ${catalog()}`);
      }
      if (wanted.size === 0) {
        return toolError(`No deferred tool matches. Deferred tools: ${catalog()}`);
      }
      const present = [...wanted].sort();
      for (const n of present) deps.loaded.add(n);
      const schemas = toolSchemas(present.map((n) => byName.get(n)!));
      const lines = schemas.map((s) => `## ${s.name}\n${s.description}\nparameters: ${JSON.stringify(s.input_schema)}`);
      return toolOk(`Loaded ${present.length} tool(s); call them from your next turn.\n\n${lines.join("\n\n")}`, { loaded: present });
    },
  };
}
