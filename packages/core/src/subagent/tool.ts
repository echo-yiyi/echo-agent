// `subagent`：模型菜单上的委派工具（2026-09-06 用户拍板）。**子 agent 长什么样由模型在调用时决定**——
// 不是产品配置、也不是盘上的角色文件（角色是 session 的事）。机制在 Agent 的 `runSubagent`（原来内联在 Dream 里的那段
// 隔离循环）：同进程、独立 transcript、同一份模型绑定、随父收摊。
//
// 两种模式（2026-09-14 用户拍板）：
//   · fresh —— 空白上下文，prompt / system / 工具集全由模型给；子看不到这场对话。
//   · fork  —— 继承父此刻的 system、working context（压缩后的视图，截到父最后一条 assistant 之前）与可委派的工具集，
//              任务追加成一条 user 消息。「顺着现在这摊去干个支线」不必把背景重写进 prompt。
// 前台 = 嵌在父 run 的这次工具执行里跑到完；后台 = 后台队列上 kind "subagent" 的任务，回执与收尾都投 inbox。
//
// 回执（2026-09-14 用户拍板）：子循环的菜单上多一件 `report`，父没有它。**不停循环、允许多次提交**——每条回执带四档封闭
// status，最后一条的 status 就是这次委派的终态；没交过回执才退回「末条正文」并标 `reported: false`。
// 唯一硬规则：子 agent 拿不到 `subagent`（只扇一层，不会自己繁殖）。

import { toolError, toolOk, type ModelTool } from "../tools/types.ts";

export const SUBAGENT_NAME = "subagent";
/** 子循环菜单上的回执工具。按 run 造一件（`makeReceiptBook`），父的菜单上没有它。 */
export const REPORT_NAME = "report";
/** 子 agent 的迭代上限封顶：模型可以少要，不能无限要。 */
const MAX_ITERATIONS_CAP = 500;

/** 回执的四档 status（封闭，2026-09-14 拍板）：working = 中间成果、还在做；其余三档是终态。 */
export type ReceiptStatus = "working" | "done" | "blocked" | "failed";
export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ["working", "done", "blocked", "failed"];

/** 子 agent 交给父的一条回执。`seq` 从 1 起、按提交顺序。 */
export type Receipt = Readonly<{ seq: number; status: ReceiptStatus; summary: string; details?: string }>;

/** 模型在调用时决定的子 agent。fresh 自带 system 与工具名（父池里的名字）；fork 全继承，只给任务。 */
export type SubagentSpec =
  | Readonly<{ mode: "fresh"; prompt: string; systemPrompt: string | null; tools: readonly string[]; maxIterations?: number }>
  | Readonly<{ mode: "fork"; prompt: string; maxIterations?: number }>;

/** 子 agent 跑完的结果。三种结局都带回执：子交过的东西不因为它后来失败或被中断而丢。 */
export type SubagentOutcome =
  | Readonly<{ kind: "completed"; text: string; assistantMessages: number; receipts: readonly Receipt[] }>
  | Readonly<{ kind: "error"; message: string; receipts: readonly Receipt[] }>
  | Readonly<{ kind: "aborted"; receipts: readonly Receipt[] }>;

export type SubagentDeps = {
  /** 父池里能给子 agent 的工具名（不含 `subagent` 自己、`tool_search`、标了 `delegable: false` 的）。 */
  availableTools(): readonly string[];
  /** 前台：在父 run 的这次工具调用（`toolCallId`）里嵌套跑到完。`onProgress` 收子 agent 的文字增量与回执（进 tool_execution_update）。 */
  runForeground(spec: SubagentSpec, ctx: { toolCallId: string; signal?: AbortSignal; onProgress?: (text: string) => void }): Promise<SubagentOutcome>;
  /** 后台：起一个 kind "subagent" 的后台任务，每条回执与收尾都投 inbox。`toolCallId` 是派出它的那次工具调用。没有后台队列就不给。 */
  runBackground?(spec: SubagentSpec, label: string, toolCallId: string): { ok: true; id: string } | { ok: false; message: string };
};

type Params = { prompt: string; mode?: string; system?: string; tools?: string[]; max_iterations?: number; background?: boolean };

/** 父在工具结果的 metadata 里拿到的回执账：交没交、终态是哪档、全部回执。 */
export type SubagentReportMeta = { reported: boolean; finalStatus: ReceiptStatus | null; receipts: readonly Receipt[]; assistantMessages?: number };

export function makeSubagentTool(deps: SubagentDeps): ModelTool<Params, SubagentReportMeta> {
  return {
    kind: "model",
    name: SUBAGENT_NAME,
    label: "派子 agent",
    // 子之间没有共享的可变状态（各自独立 context），并行的只是执行；共享的工具实例由 `delegable` 把关
    concurrent: true,
    description:
      "Delegate a self-contained task to a child agent and get its receipts back as this tool's result. " +
      "mode 'fresh' (default): the child starts with an empty context; you give prompt (the task), system (its role and rules) " +
      "and tools (names from your own tool list it may use; [] for none). It sees none of this conversation, so put everything " +
      "it needs in the prompt. mode 'fork': the child inherits your system prompt, this conversation so far and your tools; " +
      "give only the prompt (leave system and tools out). Either way the child cannot spawn subagents, and it has a 'report' tool " +
      "to hand you receipts as it goes (status working / done / blocked / failed); the last receipt's status is its final state. " +
      "Use it to keep exploration, long reads or noisy work out of your context. background: true runs it in the background; " +
      "each receipt and the final notice are delivered to you as they happen.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task, with all the context the child needs (fresh) or the side task to pursue (fork)" },
        mode: { type: "string", enum: ["fresh", "fork"], description: "fresh: empty context, you supply system and tools (default). fork: inherits your system, conversation and tools" },
        system: { type: "string", description: "fresh only: the child's system prompt (its role and rules); omit for none" },
        tools: { type: "array", items: { type: "string" }, description: "fresh only: tool names from your own list the child may use; [] for none" },
        max_iterations: { type: "number", description: `Iteration budget for the child (default: yours, max ${MAX_ITERATIONS_CAP})` },
        background: { type: "boolean", description: "Run in the background; receipts and the final notice reach you as they happen (default false)" },
      },
      required: ["prompt"],
    },
    async execute({ prompt, mode, system, tools, max_iterations, background }, ctx) {
      const task = typeof prompt === "string" ? prompt.trim() : "";
      if (task === "") return toolError("prompt must be a non-empty string");
      if (mode !== undefined && mode !== "fresh" && mode !== "fork") return toolError("mode must be 'fresh' or 'fork'");
      let maxIterations: number | undefined;
      if (max_iterations !== undefined) {
        if (!Number.isInteger(max_iterations) || max_iterations <= 0 || max_iterations > MAX_ITERATIONS_CAP) {
          return toolError(`max_iterations must be an integer between 1 and ${MAX_ITERATIONS_CAP}`);
        }
        maxIterations = max_iterations;
      }
      const budget = maxIterations === undefined ? {} : { maxIterations };
      let spec: SubagentSpec;
      if (mode === "fork") {
        // fork 全继承：模型给了 system / tools 说明它把两种模式混了——判红，不静默忽略
        if (system !== undefined || tools !== undefined) return toolError("mode 'fork' inherits your system and tools: leave system and tools out");
        spec = { mode: "fork", prompt: task, ...budget };
      } else {
        if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) return toolError("tools must be an array of tool names ([] for none) in mode 'fresh'");
        if (tools.includes(SUBAGENT_NAME)) return toolError("a subagent cannot spawn subagents: leave 'subagent' out of tools");
        if (tools.includes(REPORT_NAME)) return toolError(`the child gets its own '${REPORT_NAME}' tool: leave it out of tools`);
        const available = deps.availableTools();
        const unknown = tools.filter((t) => !available.includes(t));
        if (unknown.length > 0) return toolError(`Unknown tools: ${unknown.join(", ")}. Available: ${available.join(", ")}`);
        if (system !== undefined && typeof system !== "string") return toolError("system must be a string");
        spec = {
          mode: "fresh",
          prompt: task,
          systemPrompt: system === undefined || system.trim() === "" ? null : system,
          tools: [...new Set(tools)],
          ...budget,
        };
      }
      if (background === true) {
        if (deps.runBackground === undefined) return toolError("This agent has no background queue; background: true is not supported");
        const r = deps.runBackground(spec, task.slice(0, 60), ctx.toolCallId);
        return r.ok
          ? toolOk(`Started subagent ${r.id} in the background; its receipts and final notice will be delivered to you as they happen`, {
              reported: false,
              finalStatus: null,
              receipts: [],
            })
          : toolError(r.message);
      }
      const outcome = await deps.runForeground(spec, { toolCallId: ctx.toolCallId, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }), ...(ctx.onUpdate === undefined ? {} : { onProgress: ctx.onUpdate.bind(ctx) }) });
      return renderOutcome(outcome);
    },
  };
}

/** 子循环的回执账：回执数组 + 往里写的那件工具。每次子循环一份。 */
export type ReceiptBook = { readonly receipts: Receipt[]; readonly tool: ModelTool<{ status: string; summary: string; details?: string }> };

/**
 * 造这次子循环的 `report` 工具。**不停循环**：工具结果只回一句「记下了」，子接着做、自己 end_turn 才停。
 * `onReceipt` 每条回执都调（前台推进度、后台投 inbox）。
 */
export function makeReceiptBook(onReceipt?: (r: Receipt) => void): ReceiptBook {
  const receipts: Receipt[] = [];
  const tool: ReceiptBook["tool"] = {
    kind: "model",
    name: REPORT_NAME,
    label: "回执",
    description:
      "Hand a receipt to the agent that delegated this task. Call it as you go, once per deliverable: status 'working' for an " +
      "intermediate result while you continue, 'done' when the task is complete, 'blocked' when you need a decision from the " +
      "parent (say what you need), 'failed' when it cannot be done. The parent sees every receipt in order and treats your last " +
      "one's status as your final state, so end with done / blocked / failed. Calling it does not stop you; end your turn when finished.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...RECEIPT_STATUSES], description: "working | done | blocked | failed" },
        summary: { type: "string", description: "The conclusion, for the parent" },
        details: { type: "string", description: "Evidence, files touched, what you are blocked on; omit if none" },
      },
      required: ["status", "summary"],
    },
    async execute({ status, summary, details }) {
      if (!(RECEIPT_STATUSES as readonly string[]).includes(status)) return toolError(`status must be one of ${RECEIPT_STATUSES.join(", ")}`);
      const text = typeof summary === "string" ? summary.trim() : "";
      if (text === "") return toolError("summary must be a non-empty string");
      if (details !== undefined && typeof details !== "string") return toolError("details must be a string");
      const receipt: Receipt = {
        seq: receipts.length + 1,
        status: status as ReceiptStatus,
        summary: text,
        ...(details === undefined || details.trim() === "" ? {} : { details: details.trim() }),
      };
      receipts.push(receipt);
      onReceipt?.(receipt);
      return toolOk(`Recorded receipt #${receipt.seq} (${receipt.status}). Keep going, or end your turn when you are finished.`);
    },
  };
  return { receipts, tool };
}

/** 一条回执的一行：进度与 inbox 通知共用这一份措辞。 */
export function renderReceiptLine(r: Receipt): string {
  return `#${r.seq} [${r.status}] ${r.summary}${r.details === undefined ? "" : `\n${indent(r.details)}`}`;
}

export function renderReceipts(receipts: readonly Receipt[]): string {
  return receipts.map(renderReceiptLine).join("\n");
}

/** 终态 = 最后一条回执的 status；没交过就是 null。 */
export function finalStatusOf(receipts: readonly Receipt[]): ReceiptStatus | null {
  const last = receipts[receipts.length - 1];
  return last === undefined ? null : last.status;
}

/**
 * 子循环的结果 → 父看到的工具结果。回执优先：交过就按回执给；末条还是 working 的，把子的末条正文一并附上
 * （它可能把结论写在正文里、忘了交终态回执）；一条没交才退回末条正文并标 `reported: false`。
 * 失败 / 中断也把已交的回执带回去：子做到一半的东西不因结局而丢。
 */
function renderOutcome(outcome: SubagentOutcome) {
  const receipts = outcome.receipts;
  const finalStatus = finalStatusOf(receipts);
  const meta: SubagentReportMeta = { reported: receipts.length > 0, finalStatus, receipts };
  const before = receipts.length === 0 ? "" : `\nReceipts before it stopped:\n${renderReceipts(receipts)}`;
  switch (outcome.kind) {
    case "completed": {
      const withCount = { ...meta, assistantMessages: outcome.assistantMessages };
      if (receipts.length === 0) return toolOk(outcome.text === "" ? "(the subagent finished without a reply or a receipt)" : outcome.text, withCount);
      let content = renderReceipts(receipts);
      if (finalStatus === "working") {
        content += "\n(The subagent ended without a closing receipt; its last status is working.)";
        if (outcome.text !== "") content += `\nIts last reply:\n${outcome.text}`;
      }
      return toolOk(content, withCount);
    }
    case "error":
      return toolError(`Subagent failed: ${outcome.message}${before}`, meta);
    case "aborted":
      return toolError(`Subagent aborted before it finished${before}`, meta);
  }
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `   ${l}`)
    .join("\n");
}
