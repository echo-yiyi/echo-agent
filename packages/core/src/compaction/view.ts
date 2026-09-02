// 压缩视图：状态 × transcript → 送模消息。纯函数，不碰事件、不碰盘。设计见 docs/design/compaction.md §3。
//
// 三件事都在这一个文件里，因为它们共用同一条切点规则：
//   · 估算（`estimateTokens` / `measureContext`）
//   · 切点合法性与吸附（`isLegalCut` / `snapBack` / `normalizeCompaction` / `assertCompactionFits`）
//   · 投影（`projectRange` / `buildWorkingMessages`）
//
// **配对保证只在这里**：切点永远不落在 tool_use 与它的 toolResult 之间；清理只换 `content` 不删消息。
// 策略（阶段）产出的状态无论多离谱，经 `normalizeCompaction` 之后送模的消息都不会撕裂配对。

import { userMessage, type AgentMessage, type ToolResultMessage } from "../messages.ts";
import type { CompactionSpan, CompactionState } from "./types.ts";

/* ───────────────────────── 估算 ───────────────────────── */

/** 粗估：4 字符 ≈ 1 token（CJK 更密，这里偏低）。只用于尾巴与无 usage 的兜底；有 provider usage 时以它为基准。 */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if ("content" in m) chars += JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

/** 一段文本的粗估（同 `estimateTokens` 的 4 字符 ≈ 1 token）；system prompt 与摘要正文用它。 */
export function estimateText(text: string | null | undefined): number {
  return text === null || text === undefined ? 0 : Math.ceil(text.length / 4);
}

/** provider 报过的账：`index` 之前的视图折算成 `tokens`（含那条 assistant 自己的输出）。之后的按字符估。 */
export type ContextAnchor = { readonly index: number; readonly tokens: number };

/**
 * 当前送模上下文的估算。有基准（本 run 最近一次 usage）就用基准 + 基准之后新入账消息的字符估；
 * 没有（run 刚开始、或刚压缩过）就按 system + 整个视图的字符估。
 */
export function measureContext(input: {
  readonly messages: readonly AgentMessage[];
  readonly state: CompactionState;
  readonly systemPrompt: string | null;
  readonly anchor: ContextAnchor | null;
}): number {
  const { messages, state, systemPrompt, anchor } = input;
  if (anchor !== null && anchor.index <= messages.length) {
    return anchor.tokens + estimateTokens(messages.slice(anchor.index));
  }
  return estimateText(systemPrompt) + estimateTokens(buildWorkingMessages(messages, state));
}

/* ───────────────────────── 切点 ───────────────────────── */

/**
 * `i` 能不能当切点（`[.., i)` 与 `[i, ..)` 分开）。**唯一的禁区**：`messages[i]` 是 toolResult——
 * 切在那里会把它和前面那条带 tool_use 的 assistant 分到两边。0 与 n 恒合法。
 */
export function isLegalCut(messages: readonly AgentMessage[], i: number): boolean {
  if (i <= 0 || i >= messages.length) return true;
  return messages[i]!.role !== "toolResult";
}

/** 一轮的开头：人 / harness / 环境说话的那条。摘要与折叠优先切在这里，留下的尾巴才是完整的轮。 */
export function isTurnStart(messages: readonly AgentMessage[], i: number): boolean {
  if (i < 0 || i >= messages.length) return false;
  const role = messages[i]!.role;
  return role === "user" || role === "environment";
}

/**
 * 从 `i` 向前找切点，结果落在 `[min, i]`：`prefer === "turn"` 先找轮起点，找不到再找合法切点；
 * 都没有返回 `min`（调用方保证 `min` 自身是合法的：0、n 或上一段的末尾）。
 */
export function snapBack(messages: readonly AgentMessage[], i: number, min: number, prefer: "turn" | "legal"): number {
  const hi = Math.min(i, messages.length);
  if (prefer === "turn") {
    for (let j = hi; j > min; j--) if (isTurnStart(messages, j)) return j;
  }
  for (let j = hi; j > min; j--) if (isLegalCut(messages, j)) return j;
  return min;
}

/** 从 `i` 向后找合法切点，结果落在 `[i, max]`；没有就返回 `max`。 */
export function snapForward(messages: readonly AgentMessage[], i: number, max: number): number {
  const hi = Math.min(max, messages.length);
  for (let j = Math.max(0, i); j < hi; j++) if (isLegalCut(messages, j)) return j;
  return hi;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

/**
 * 阶段产出的状态 → 可用的状态：越界截断、空段丢弃、按 from 排序、边界吸到合法切点。
 * **重叠是阶段的 bug，抛**（流水线把它记成该阶段的失败，跳过）；其余都能修，修了就用。
 */
export function normalizeCompaction(messages: readonly AgentMessage[], state: CompactionState): CompactionState {
  const n = messages.length;
  const clearedBefore = clamp(state.clearedBefore, 0, n);
  const spans = state.spans
    .map((s) => ({ from: clamp(s.from, 0, n), to: clamp(s.to, 0, n), summary: s.summary }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  const out: CompactionSpan[] = [];
  for (const s of spans) {
    const prevEnd = out.length > 0 ? out[out.length - 1]!.to : 0;
    if (s.from < prevEnd) throw new Error(`compaction spans overlap: [${s.from}, ${s.to}) starts before ${prevEnd}`);
    const from = isLegalCut(messages, s.from) ? s.from : snapBack(messages, s.from, prevEnd, "legal");
    const to = isLegalCut(messages, s.to) ? s.to : snapBack(messages, s.to, from, "legal");
    if (to <= from) continue;
    out.push({ from, to, summary: s.summary });
  }
  return { spans: out, clearedBefore };
}

/**
 * 恢复期的**严格**验形：盘上的状态必须原样成立（下标在界内、不重叠、切点合法）。
 * 不吸附、不修——transcript 只增不改，写下去时合法的状态永远合法；不合法就是坏档，判红。
 */
export function assertCompactionFits(messages: readonly AgentMessage[], state: CompactionState, where = "compaction"): void {
  const n = messages.length;
  if (!Number.isInteger(state.clearedBefore) || state.clearedBefore < 0 || state.clearedBefore > n) {
    throw new Error(`${where}: clearedBefore ${String(state.clearedBefore)} 越界（transcript 共 ${n} 条）`);
  }
  let prevEnd = 0;
  for (const s of state.spans) {
    if (!Number.isInteger(s.from) || !Number.isInteger(s.to) || s.from < 0 || s.to > n || s.to <= s.from) {
      throw new Error(`${where}: span [${String(s.from)}, ${String(s.to)}) 不合法（transcript 共 ${n} 条）`);
    }
    if (s.from < prevEnd) throw new Error(`${where}: span [${s.from}, ${s.to}) 与前一段重叠`);
    if (!isLegalCut(messages, s.from) || !isLegalCut(messages, s.to)) {
      throw new Error(`${where}: span [${s.from}, ${s.to}) 的边界切在 tool_use 与 tool_result 之间`);
    }
    if (s.summary !== null && typeof s.summary !== "string") throw new Error(`${where}: span 的 summary 必须是字符串或 null`);
    prevEnd = s.to;
  }
}

/** 两个状态逐字段相等（段的 from / to / summary 与 clearedBefore）。流水线用它判「这一段有没有真的改了什么」。 */
export function sameCompaction(a: CompactionState, b: CompactionState): boolean {
  if (a.clearedBefore !== b.clearedBefore || a.spans.length !== b.spans.length) return false;
  for (let i = 0; i < a.spans.length; i++) {
    const x = a.spans[i]!;
    const y = b.spans[i]!;
    if (x.from !== y.from || x.to !== y.to || x.summary !== y.summary) return false;
  }
  return true;
}

/* ───────────────────────── 投影 ───────────────────────── */

/** `summary === null` 的段在送模时长这样。core 的固定文案不提任何工具——怎么取回原文由拥有工具的 extension 出段说明。 */
export function omissionNotice(from: number, to: number): string {
  return `[Messages #${from}–#${to - 1} were omitted to save context.]`;
}

/** 被清掉的工具结果在送模时的占位正文：说明省了多少字符、是第几条，同样不提任何工具。 */
export function clearedNotice(index: number, chars: number): string {
  return `[Tool result cleared to save context: ${chars} characters omitted (message #${index}).]`;
}

function spanMessage(span: CompactionSpan, messages: readonly AgentMessage[]): AgentMessage {
  const at = messages[span.from]?.at ?? 0;
  return userMessage(span.summary ?? omissionNotice(span.from, span.to), "harness", undefined, at);
}

function clearedCopy(m: ToolResultMessage & { readonly at: number }, index: number): AgentMessage {
  // 新对象：transcript 里那条一个字都不动（所有权边界）；images 一并去掉——清的就是体积
  const { images: _images, ...rest } = m;
  return { ...rest, content: clearedNotice(index, m.content.length) };
}

/**
 * transcript 的 `[from, to)` 在 `state` 下长什么样。段 → 一条 user/harness 消息（摘要或省略说明）；
 * 被清的 toolResult → 占位副本；其余原样（同一个对象，不复制）。
 */
export function projectRange(messages: readonly AgentMessage[], state: CompactionState, from: number, to: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  const spans = state.spans;
  let si = 0;
  let i = Math.max(0, from);
  const end = Math.min(to, messages.length);
  while (i < end) {
    while (si < spans.length && spans[si]!.to <= i) si++;
    const span = spans[si];
    if (span !== undefined && span.from <= i) {
      out.push(spanMessage(span, messages));
      i = span.to;
      continue;
    }
    const m = messages[i]!;
    if (m.role === "toolResult" && i < state.clearedBefore) out.push(clearedCopy(m, i));
    else out.push(m);
    i++;
  }
  return out;
}

/** 单条在视图里的样子（估算用）。 */
export function viewAt(messages: readonly AgentMessage[], state: CompactionState, i: number): AgentMessage[] {
  return projectRange(messages, state, i, i + 1);
}

/** 送模前的工作副本起点：整个 transcript 经压缩状态投影。之后再拼每轮注入、过 transform 与 hook。 */
export function buildWorkingMessages(messages: readonly AgentMessage[], state: CompactionState): AgentMessage[] {
  return projectRange(messages, state, 0, messages.length);
}
