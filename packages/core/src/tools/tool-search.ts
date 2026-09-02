// `tool_search`：渐进式披露的唯一入口（2026-09-02 用户拍板，形状照 Claude Code 的 ToolSearch）。
//
// 延迟工具（`AgentOptions.deferredTools`，**配置给的名单**，所有工具一视同仁）注册在池里但不上菜单；
// 模型要用，先在这里按名或按关键词取 schema——取过的进 `loaded`，下一轮起上菜单。
// 延迟层的**名字**跟着本工具的 description 走（每轮现算）：工具不进 system，名字也不进。
//
// 为什么「下一轮起」而不是当轮：循环的工作集是轮首冻结的（`AgentLoopConfig.getTools()` 的契约，
// 实时池不能成为第二条解析路）。模型拿到 schema 之后本来也要再发一轮才会调它，没有损失。

import type { ToolMap } from "./harness.ts";
import { isModelVisible, toolError, toolOk, toolSchemas, type ModelTool } from "./types.ts";

export type ToolSearchDeps = {
  readonly tools: ToolMap;
  readonly deferred: ReadonlySet<string>;
  /** 可变：本工具唯一会写的状态。 */
  readonly loaded: Set<string>;
};

type Params = { names?: string[]; query?: string };

export function makeToolSearchTool(deps: ToolSearchDeps): ModelTool<Params> {
  const catalog = (): string => {
    const names = [...deps.deferred].sort();
    return names.map((n) => (deps.loaded.has(n) ? `${n} (loaded)` : n)).join(", ");
  };
  return {
    kind: "model",
    name: "tool_search",
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
      const wanted = new Set<string>();
      const unknown: string[] = [];
      for (const n of names ?? []) {
        if (deps.deferred.has(n)) wanted.add(n);
        else unknown.push(n);
      }
      if (query !== undefined && query.trim() !== "") {
        const q = query.trim().toLowerCase();
        for (const n of deps.deferred) {
          const t = deps.tools.get(n);
          const text = `${n} ${t !== undefined && isModelVisible(t) ? (t.description ?? "") : ""}`.toLowerCase();
          if (text.includes(q)) wanted.add(n);
        }
      }
      if (unknown.length > 0) {
        return toolError(`Not deferred tools: ${unknown.join(", ")}. Deferred tools: ${catalog()}`);
      }
      if (wanted.size === 0) {
        return toolError(`No deferred tool matches. Deferred tools: ${catalog()}`);
      }
      // 名字在配置里、池里却没有（那组能力没装、或 MCP 断了）：如实说，不假装加载了
      const present = [...wanted].filter((n) => deps.tools.has(n)).sort();
      const missing = [...wanted].filter((n) => !deps.tools.has(n)).sort();
      for (const n of present) deps.loaded.add(n);
      const schemas = toolSchemas(present.map((n) => deps.tools.get(n)!));
      const lines = schemas.map((s) => `## ${s.name}\n${s.description}\nparameters: ${JSON.stringify(s.input_schema)}`);
      const tail = missing.length > 0 ? `\n\n(not available right now: ${missing.join(", ")})` : "";
      return toolOk(
        `Loaded ${present.length} tool(s); call them from your next turn.\n\n${lines.join("\n\n")}${tail}`,
        { loaded: present, missing },
      );
    },
  };
}
