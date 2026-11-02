// 大工具结果的外存（2026-11-02 用户拍板，照 Claude Code 的做法）。
//
// 工具结果超过内联上限，就在**入账那一刻**把全文存进会话目录，transcript 里只记一段说明加头尾预览；
// 模型要看剩下的，用 `tool_output_read` 按 id 分页读或按关键词查。决策见
// `docs/decisions/implemented/2026-11-02-large-tool-results-and-images.md`。
//
// 为什么在入账时截、不在送模时截：transcript 记的就是模型看到的那份；会话文件、记忆提取、观测
// 都不再背着几 MB；预览一次定格，之后每轮请求的前缀不变，缓存不断。工具执行完的那一刻、hook 与
// `tool_execution_end` 事件拿到的仍是全文——外存只改「记进对话的是什么」。
//
// 本模块只有纯逻辑与工具定义；写盘经注入的 `save` 端口（循环不碰盘），读盘经注入的 `read`。

import { errText } from "../errors.ts";
import type { AgentMessage } from "../messages.ts";
import { toolError, toolOk, type AgentToolResult, type ModelTool } from "./types.ts";

/**
 * 估算超过这么多 token 就外存。英文约 3 万字符——与 Claude Code 的内联上限（约 30,000 字符）同一个量级；
 * 按 token 估而不按字符数，中文同样大小的输出（一字约一 token）不会多吃几倍上下文。
 */
export const TOOL_OUTPUT_INLINE_TOKENS = 7_500;
/** 预览留开头多少字符。 */
export const TOOL_OUTPUT_PREVIEW_HEAD = 2_000;
/** 预览留结尾多少字符：构建日志、测试输出的报错多半在末尾。 */
export const TOOL_OUTPUT_PREVIEW_TAIL = 1_000;
/** 存下来的全文最多这么多字符，再多截断（与 Claude Code 的 64 MiB 同一个量级）。 */
export const TOOL_OUTPUT_MAX_STORED = 64 * 1024 * 1024;

/** 外存文件在会话目录下的子目录名。 */
export const TOOL_OUTPUTS_DIR = "tool-outputs";

/** 取回工具的名字。外存说明里点名它。 */
export const TOOL_OUTPUT_READ = "tool_output_read";
/** 一次分页缺省读多少字符、最多读多少字符。 */
export const TOOL_OUTPUT_READ_DEFAULT_LIMIT = 10_000;
export const TOOL_OUTPUT_READ_MAX_LIMIT = 40_000;
/** 按关键词查时最多给几行、每行最多多少字符。 */
export const TOOL_OUTPUT_QUERY_MAX_LINES = 200;
const QUERY_LINE_CAP = 500;

/** 中日韩文字（不靠空格分词、一字约一 token）。 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** 粗估 token：中日韩文字一字一个，其余四个字符一个。 */
export function estimateOutputTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) if (isCjk(text.charCodeAt(i))) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * 超不超上限。两头先判，免得几 MB 的输出逐字数：全按一字一 token 也不超 → 不超；
 * 全按四字一 token 也超 → 超。只有中间那段才数。
 */
export function exceedsInline(text: string, limit: number): boolean {
  if (!Number.isFinite(limit)) return false;
  if (text.length <= limit) return false;
  if (Math.ceil(text.length / 4) > limit) return true;
  return estimateOutputTokens(text) > limit;
}

/** 外存文件名：工具调用 id 里文件名不认的字符换成 `_`。 */
export function toolOutputFile(id: string): string {
  return `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`;
}

/** 切片时不把一对 surrogate 切开（否则预览里出现半个字符）。 */
function head(text: string, n: number): string {
  let end = Math.min(n, text.length);
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}
function tail(text: string, n: number): string {
  let start = Math.max(0, text.length - n);
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start++;
  return text.slice(start);
}
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * 超上限就外存：全文经 `save` 落盘，返回的结果里 `content` 换成说明加头尾预览，其余字段原样。
 * 不超就原样返回。`save` 抛错（盘满、丢锁）不让这一轮崩：说明里讲清全文没存下来，只剩预览。
 * `readBack: false` = 读回工具不在本轮菜单上：照样外存（上下文照样受保护），但说明里不点读回工具的名。
 */
export async function spillToolResult(
  result: AgentToolResult,
  id: string,
  limit: number,
  save: (file: string, text: string) => Promise<void>,
  opts: { readBack: boolean } = { readBack: true },
): Promise<AgentToolResult> {
  const text = result.content;
  if (!exceedsInline(text, limit)) return result;
  const stored = text.length > TOOL_OUTPUT_MAX_STORED ? head(text, TOOL_OUTPUT_MAX_STORED) : text;
  let failure: string | null = null;
  try {
    await save(toolOutputFile(id), stored);
  } catch (e) {
    failure = errText(e);
  }
  const first = head(text, TOOL_OUTPUT_PREVIEW_HEAD);
  const last = tail(text, TOOL_OUTPUT_PREVIEW_TAIL);
  const omitted = text.length - first.length - last.length;
  const size = `${fmt(text.length)} characters (~${fmt(estimateOutputTokens(stored))} tokens)`;
  const where =
    failure !== null
      ? `The full output could not be saved (${failure}), so only this preview is available.`
      : !opts.readBack
        ? `The full output was saved as tool output "${id}", but it cannot be read from this session, so only this preview is available.`
        : `Full output saved as tool output "${id}"; read the rest with ${TOOL_OUTPUT_READ} (offset/limit to page, query to search).` +
          (stored.length < text.length ? ` Only the first ${fmt(stored.length)} characters were saved.` : "");
  const notice = `[Output too large: ${size}. ${where} Showing the first ${fmt(first.length)} and last ${fmt(last.length)} characters.]`;
  return { ...result, content: `${notice}\n${first}\n…[${fmt(omitted)} characters omitted]…\n${last}` };
}

/* ───────────────────────── 取回工具 ───────────────────────── */

export type ToolOutputReadParams = { id: string; offset?: number; limit?: number; query?: string };

/**
 * `tool_output_read`：按工具调用 id 读回一条工具结果的全文。先找外存文件；找不到再去 transcript 里
 * 按 id 找那条工具结果的原文——被压缩清掉正文的旧结果也从这里取回（transcript 原文从不改写）。
 *
 * 它自己的输出由 `limit` 封顶，所以声明 `maxInlineTokens: Infinity`：不然会把自己的输出再外存一遍。
 */
export function makeToolOutputReadTool(deps: {
  read(file: string): Promise<string | null>;
  transcript(): readonly AgentMessage[];
}): ModelTool<ToolOutputReadParams> {
  return {
    kind: "model",
    name: TOOL_OUTPUT_READ,
    label: "读工具输出",
    concurrent: true,
    maxInlineTokens: Infinity,
    description:
      "Read the full text of an earlier tool result by its tool call id: one that was too large to show in full, or one whose content was cleared from the context. " +
      "Page with offset/limit (characters), or pass query to get only the matching lines.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The tool call id named in the notice" },
        offset: { type: "integer", description: "First character to return (0-based), default 0" },
        limit: { type: "integer", description: `Characters to return, default ${TOOL_OUTPUT_READ_DEFAULT_LIMIT}, at most ${TOOL_OUTPUT_READ_MAX_LIMIT}` },
        query: { type: "string", description: "Return only lines containing this text (case-insensitive), with line numbers" },
      },
      required: ["id"],
    },
    async execute({ id, offset, limit, query }) {
      const text = (await deps.read(toolOutputFile(id))) ?? fromTranscript(deps.transcript(), id);
      if (text === null) return toolError(`No tool output with id '${id}'`);
      if (query !== undefined && query !== "") return toolOk(searchLines(text, query), { id, chars: text.length });
      const from = Math.max(0, Math.floor(offset ?? 0));
      const take = Math.min(TOOL_OUTPUT_READ_MAX_LIMIT, Math.max(1, Math.floor(limit ?? TOOL_OUTPUT_READ_DEFAULT_LIMIT)));
      if (from >= text.length) return toolOk(`[offset ${fmt(from)} is past the end: the output has ${fmt(text.length)} characters]`, { id, chars: text.length });
      const chunk = text.slice(from, from + take);
      const to = from + chunk.length;
      const more = to < text.length ? `; continue with offset=${to}` : "; this is the end";
      return toolOk(`[characters ${fmt(from)}–${fmt(to)} of ${fmt(text.length)}${more}]\n${chunk}`, { id, chars: text.length });
    },
  };
}

function fromTranscript(messages: readonly AgentMessage[], id: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "toolResult" && m.toolCallId === id) return m.content;
  }
  return null;
}

function searchLines(text: string, query: string): string {
  const needle = query.toLowerCase();
  const lines = text.split("\n");
  const hits: string[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.toLowerCase().includes(needle)) continue;
    total++;
    if (hits.length < TOOL_OUTPUT_QUERY_MAX_LINES) {
      const line = lines[i]!;
      hits.push(`${i + 1}: ${line.length > QUERY_LINE_CAP ? `${line.slice(0, QUERY_LINE_CAP)}…` : line}`);
    }
  }
  if (total === 0) return `[no line contains "${query}" (${fmt(lines.length)} lines searched)]`;
  const cap = total > hits.length ? `; showing the first ${hits.length}, narrow the query for the rest` : "";
  return `[${fmt(total)} matching line${total === 1 ? "" : "s"} of ${fmt(lines.length)}${cap}]\n${hits.join("\n")}`;
}
