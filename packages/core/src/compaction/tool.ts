// `transcript_read`：模型读原始对话的口子，以及 `echo:compaction` 的 prompt 段。设计见 docs/design/compaction.md §5。
//
// 压缩之后模型看到的是摘要、折叠说明、占位——它们说的是「有过什么」，不是原文。要精确细节
// （代码、报错、自己写过的东西）时，模型用这个工具按下标读 transcript，而不是凭记忆重构。
// 读的是**内存里的完整 transcript**（`Agent.messages`）：不走磁盘、不进 workspace jail，
// 没有文件工具的通用 agent 也能用；下标与压缩通知里的 `#12–#40` 同一套。

import type { AgentMessage } from "../messages.ts";
import { PROMPT_ORDER, type PromptSection } from "../prompt/types.ts";
import { toolError, toolOk, type ModelTool } from "../tools/types.ts";

/** 工具名。模型在压缩通知与 prompt 段里看到的就是这个名字。 */
export const TRANSCRIPT_READ_TOOL = "transcript_read";
/** 单条消息最多渲染多少字符；超了标注并提示分段读。 */
export const TRANSCRIPT_MESSAGE_CAP = 4_000;
/** 一次调用的输出上限。 */
export const TRANSCRIPT_OUTPUT_CAP = 24_000;
const DEFAULT_RANGE = 20;

/** `transcript_read` 的参数：`[from, to)` 下标范围（`to` 缺省 `from + 20`），`query` 只留含它的消息。 */
export type TranscriptReadParams = { from: number; to?: number; query?: string };

/** 一条消息渲染成一行（带 `#下标` 与角色）；assistant 的 tool_use / thinking 块也写出来，模型才能对上号。 */
export function renderTranscriptMessage(m: AgentMessage, index: number): string {
  const head = `#${index}`;
  switch (m.role) {
    case "user":
      return `${head} [user${m.source === "human" ? "" : `/${m.source}`}] ${textOf(m.content)}`;
    case "assistant": {
      const parts: string[] = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push(b.text);
        else if (b.type === "tool_use") parts.push(`<tool_use name="${b.name}" id="${b.id}">${JSON.stringify(b.input)}</tool_use>`);
        else if (b.type === "thinking") parts.push(`<thinking>${b.thinking}</thinking>`);
        else if (b.type === "image") parts.push("[image]");
      }
      return `${head} [assistant${m.stopReason === "error" ? " error" : ""}] ${parts.join("\n")}`;
    }
    case "toolResult":
      return `${head} [tool_result ${m.toolName}${m.isError ? " error" : ""} id="${m.toolCallId}"] ${m.content}`;
    case "environment":
      return `${head} [environment/${m.source}] ${textOf(m.content)}`;
    default:
      return `${head} [${String((m as { role: string }).role)}] ${JSON.stringify(m)}`;
  }
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : `[${b.type}]`)).join("\n");
}

function capLine(line: string, index: number): string {
  if (line.length <= TRANSCRIPT_MESSAGE_CAP) return line;
  return `${line.slice(0, TRANSCRIPT_MESSAGE_CAP)}\n…[message #${index} truncated at ${TRANSCRIPT_MESSAGE_CAP} characters]`;
}

/** 把 `[from, to)` 渲染成一段文本；`query` 只留含它的消息（大小写不敏感）。超出总上限就截断并告诉模型从哪续。 */
export function renderTranscript(messages: readonly AgentMessage[], params: TranscriptReadParams): string {
  const n = messages.length;
  const from = Math.max(0, params.from);
  const to = Math.min(n, params.to ?? from + DEFAULT_RANGE);
  if (from >= n) return `The transcript has ${n} messages (#0–#${Math.max(0, n - 1)}); from=${from} is past the end.`;
  const needle = params.query?.toLowerCase();
  const lines: string[] = [];
  let size = 0;
  let matched = 0;
  for (let i = from; i < to; i++) {
    const line = renderTranscriptMessage(messages[i]!, i);
    if (needle !== undefined && !line.toLowerCase().includes(needle)) continue;
    matched++;
    const capped = capLine(line, i);
    if (size + capped.length > TRANSCRIPT_OUTPUT_CAP && lines.length > 0) {
      lines.push(`…[output truncated at message #${i}; call again with from=${i} to continue]`);
      return lines.join("\n\n");
    }
    lines.push(capped);
    size += capped.length;
  }
  if (needle !== undefined && matched === 0) return `No message in #${from}–#${to - 1} contains "${params.query}".`;
  return lines.join("\n\n");
}

/**
 * `transcript_read` 工具。`source` 每次调用现读——它是 Agent 的 `messages`（活的 transcript），不是快照。
 * 在 Agent 构造期造，由 `echo:compaction` builtin 经 `AgentTools.register` 注册（造在这里，注册不在这里）。
 */
export function transcriptReadTool(source: () => readonly AgentMessage[]): ModelTool<TranscriptReadParams> {
  return {
    kind: "model",
    name: TRANSCRIPT_READ_TOOL,
    deferred: true, // 冷门：不上菜单，模型 tool_search 取过再用（2026-09-02，缺省那一批）
    label: "读原始对话",
    description:
      "Read the original messages of this conversation by index, including parts that context compaction has summarized, condensed, or cleared. " +
      "Compaction notices give the index range (for example #12–#40). Use from/to for a range (to is exclusive, default from+20), " +
      "or add query to keep only messages containing that text. Output is capped; narrow the range or the query to see more. " +
      "Use it when a task needs exact code, file contents, error text, or something you wrote earlier; do not reconstruct those from memory.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "integer", description: "First message index (0-based, inclusive)" },
        to: { type: "integer", description: "End index (exclusive). Default from+20" },
        query: { type: "string", description: "Optional: only messages whose text contains this (case-insensitive)" },
      },
      required: ["from"],
    },
    prepareArguments(raw: unknown): TranscriptReadParams {
      const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      const from = toInt(r.from);
      if (from === undefined || from < 0) throw new Error("from must be a non-negative integer");
      const to = r.to === undefined ? undefined : toInt(r.to);
      if (r.to !== undefined && (to === undefined || to <= from)) throw new Error("to must be an integer greater than from");
      const query = r.query === undefined ? undefined : String(r.query);
      const out: TranscriptReadParams = { from };
      if (to !== undefined) out.to = to;
      if (query !== undefined && query !== "") out.query = query;
      return out;
    },
    async execute(params) {
      try {
        return toolOk(renderTranscript(source(), params));
      } catch (e) {
        return toolError(`transcript_read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}

/** `echo:compaction` 的习惯段：谁拥有工具，谁告诉模型压缩之后怎么取回原文。 */
export function compactionSection(): PromptSection {
  return {
    name: "compaction",
    order: PROMPT_ORDER.tools + 50,
    render: () =>
      "## Compacted context\n" +
      "As this conversation grows, older parts get compacted: some are replaced by a summary, some stretches are condensed, " +
      "and old tool results are cleared. Each notice states the message range it covers, for example #12–#40. " +
      "A summary keeps decisions and state, not wording: when the task needs exact code, file contents, error output, or text you produced earlier, " +
      "call transcript_read with that range instead of reconstructing it. The task list is not affected by compaction; keep it current.",
  };
}
