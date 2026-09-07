// `subagent`：模型菜单上的委派工具（2026-09-06 用户拍板）。**子 agent 长什么样由模型在调用时决定**——
// prompt、system、工具集都是参数，不是产品配置。机制在 Agent 的 `runSubagent`（原来内联在 Dream 里的那段隔离循环）：
// 同进程、独立 transcript、同一份模型绑定、随父收摊。前台 = 嵌在父 run 的这次工具执行里跑到完，最后一条回复就是
// 工具结果；后台 = 后台队列上 kind "subagent" 的任务（`BackgroundTask.kind` 早就预留了它），结束时回复投 inbox。
// 唯一硬规则：子 agent 拿不到 `subagent`（只扇一层，不会自己繁殖）。

import { toolError, toolOk, type ModelTool } from "../tools/types.ts";

export const SUBAGENT_NAME = "subagent";
/** 子 agent 的迭代上限封顶：模型可以少要，不能无限要。 */
const MAX_ITERATIONS_CAP = 500;

/** 模型在调用时决定的子 agent：任务、指令、工具名（父池里的名字）、预算。 */
export type SubagentSpec = Readonly<{
  prompt: string;
  systemPrompt: string | null;
  tools: readonly string[];
  maxIterations?: number;
}>;

/** 子 agent 跑完的结果：完成时带最后一条回复。 */
export type SubagentOutcome =
  | Readonly<{ kind: "completed"; text: string; assistantMessages: number }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "aborted" }>;

export type SubagentDeps = {
  /** 父池里能给子 agent 的工具名（不含 `subagent` 自己）。 */
  availableTools(): readonly string[];
  /** 前台：在父 run 里嵌套跑到完。`onProgress` 收子 agent 的文字增量（进 tool_execution_update）。 */
  runForeground(spec: SubagentSpec, ctx: { signal?: AbortSignal; onProgress?: (text: string) => void }): Promise<SubagentOutcome>;
  /** 后台：起一个 kind "subagent" 的后台任务，结束时回复投 inbox。没有后台队列就不给。 */
  runBackground?(spec: SubagentSpec, label: string): { ok: true; id: string } | { ok: false; message: string };
};

type Params = { prompt: string; system?: string; tools: string[]; max_iterations?: number; background?: boolean };

export function makeSubagentTool(deps: SubagentDeps): ModelTool<Params> {
  return {
    kind: "model",
    name: SUBAGENT_NAME,
    label: "派子 agent",
    description:
      "Delegate a self-contained task to a child agent. It runs with its own fresh context, only the tools you list, " +
      "and returns its final reply as this tool's result. You decide what it is: prompt is the task, system its " +
      "instructions, tools the names from your own tool list it may use (it cannot spawn subagents). It sees none of " +
      "this conversation, so put everything it needs in the prompt. Use it to keep exploration, long reads or noisy " +
      "work out of your context. background: true runs it in the background; its reply is delivered to you when it ends.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task, with all the context the child needs" },
        system: { type: "string", description: "The child's system prompt (its role and rules); omit for none" },
        tools: { type: "array", items: { type: "string" }, description: "Tool names from your own list the child may use; [] for none" },
        max_iterations: { type: "number", description: `Iteration budget for the child (default: yours, max ${MAX_ITERATIONS_CAP})` },
        background: { type: "boolean", description: "Run in the background and get the reply later (default false)" },
      },
      required: ["prompt", "tools"],
    },
    async execute({ prompt, system, tools, max_iterations, background }, ctx) {
      const task = typeof prompt === "string" ? prompt.trim() : "";
      if (task === "") return toolError("prompt must be a non-empty string");
      if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) return toolError("tools must be an array of tool names ([] for none)");
      if (tools.includes(SUBAGENT_NAME)) return toolError("a subagent cannot spawn subagents: leave 'subagent' out of tools");
      const available = deps.availableTools();
      const unknown = tools.filter((t) => !available.includes(t));
      if (unknown.length > 0) return toolError(`Unknown tools: ${unknown.join(", ")}. Available: ${available.join(", ")}`);
      if (system !== undefined && typeof system !== "string") return toolError("system must be a string");
      let maxIterations: number | undefined;
      if (max_iterations !== undefined) {
        if (!Number.isInteger(max_iterations) || max_iterations <= 0 || max_iterations > MAX_ITERATIONS_CAP) {
          return toolError(`max_iterations must be an integer between 1 and ${MAX_ITERATIONS_CAP}`);
        }
        maxIterations = max_iterations;
      }
      const spec: SubagentSpec = {
        prompt: task,
        systemPrompt: system === undefined || system.trim() === "" ? null : system,
        tools: [...new Set(tools)],
        ...(maxIterations === undefined ? {} : { maxIterations }),
      };
      if (background === true) {
        if (deps.runBackground === undefined) return toolError("This agent has no background queue; background: true is not supported");
        const r = deps.runBackground(spec, task.slice(0, 60));
        return r.ok
          ? toolOk(`Started subagent ${r.id} in the background; its reply will be delivered to you when it ends`, { taskId: r.id })
          : toolError(r.message);
      }
      const outcome = await deps.runForeground(spec, { ...(ctx.signal === undefined ? {} : { signal: ctx.signal }), ...(ctx.onUpdate === undefined ? {} : { onProgress: ctx.onUpdate.bind(ctx) }) });
      switch (outcome.kind) {
        case "completed":
          return toolOk(outcome.text === "" ? "(the subagent finished without a reply)" : outcome.text, { assistantMessages: outcome.assistantMessages });
        case "error":
          return toolError(`Subagent failed: ${outcome.message}`);
        case "aborted":
          return toolError("Subagent aborted before it finished");
      }
    },
  };
}
