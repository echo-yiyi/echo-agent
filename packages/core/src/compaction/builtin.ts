// `echo:compaction` 的缺省阶梯：四个阶段 + transcript_read + prompt 段。设计见 docs/design/compaction.md §5。
//
// 阶梯（按 order）：
//   10 tool-results  清旧的工具结果正文，零模型成本。只在触发时整批清，两次触发之间字节不动，不打 prompt 缓存。
//   20 collapse      auto 专用：从最旧的原文起，一段一段折成摘要（每段一次小调用），够了就停。渐进，不一次全丢。
//   30 summary       把尾巴之前的全部（已有的段摘要 + 剩余原文）折成一份结构化摘要。auto 在 collapse 不够时、manual 恒、overflow 恒。
//   40 snip          只在 overflow：summary 都失败了，把尾巴之前直接省略——总好过再撞一次窗。
//
// 阶段只产状态。校验吸附、投影、事件、落盘都在 core（`view.ts` / `pipeline.ts`）。
// 这一组与第三方扩展走**同一条** `AgentCompaction.stage()`，同一份所有权账本；`compaction.builtin = false` 就不装它。
//
// **算字节一律用 `input.estimate`**（已按 usage 校准），不直接调 `estimateTokens`——量纲要与 `budget` 一致。
//
// 提示词是**自己写的**（措辞、节名、框定），不抄任何专有产品的文案；结构上的「先草稿再正文」「按固定小节写」
// 是通用做法。全英文（2026-09-01 模型面全英文），但要求摘要**用用户主要使用的语言写**——用户说中文就得到中文摘要。

import { userMessage, type AgentMessage } from "../messages.ts";
import type { PromptSection } from "../prompt/types.ts";
import type { AgentTool } from "../tools/types.ts";
import { compactionSection, renderTranscriptMessage, transcriptReadTool } from "./tool.ts";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_SECTION_TOKENS,
  type CompactionInput,
  type CompactionOptions,
  type CompactionSpan,
  type CompactionStage,
  type CompactionState,
} from "./types.ts";
import { estimateTokens, isLegalCut, isTurnStart, projectRange, viewAt } from "./view.ts";

/** 应急时尾巴只留这么多（再吸到轮边界）：撞窗了，先活下来。 */
export const OVERFLOW_KEEP_TOKENS = 2_000;
/** collapse 一次触发最多折几段——每段一次模型调用，给成本一个上界。 */
export const COLLAPSE_MAX_SECTIONS = 8;

/* ───────────────────────── 切尾巴 ───────────────────────── */

/**
 * 尾巴从哪条起：从末尾向前累加视图里的字节，找**最靠前**的轮起点 j（j ≥ min）使尾巴 ≤ keep；
 * 没有轮起点满足（在飞的一轮本身就超预算）→ 退到满足预算的最靠前合法切点；连那也没有 → n（不留尾）。
 * `estimate` 给校准过的估算器（阶段传 `input.estimate`）；缺省裸字符估只供测试与离线计算。
 */
export function chooseTailStart(
  messages: readonly AgentMessage[],
  state: CompactionState,
  keep: number,
  min: number,
  estimate: (messages: readonly AgentMessage[]) => number = estimateTokens,
): number {
  const n = messages.length;
  let acc = 0;
  let bestTurn = -1;
  let bestLegal = -1;
  for (let j = n; j >= min; j--) {
    if (j < n) acc += estimate(viewAt(messages, state, j));
    if (acc > keep) break;
    if (isTurnStart(messages, j)) bestTurn = j;
    else if (isLegalCut(messages, j)) bestLegal = j;
  }
  if (bestTurn >= 0) return bestTurn;
  if (bestLegal >= 0) return bestLegal;
  return n;
}

/** (min, i] 里最靠后的轮起点；没有返回 -1。 */
function turnStartBack(messages: readonly AgentMessage[], i: number, min: number): number {
  for (let j = Math.min(i, messages.length - 1); j > min; j--) if (isTurnStart(messages, j)) return j;
  return -1;
}

/** [i, max) 里最靠前的轮起点；没有返回 max。 */
function turnStartForward(messages: readonly AgentMessage[], i: number, max: number): number {
  for (let j = Math.max(0, i); j < max; j++) if (isTurnStart(messages, j)) return j;
  return max;
}

function lastSpanEnd(state: CompactionState): number {
  return state.spans.length > 0 ? state.spans[state.spans.length - 1]!.to : 0;
}

function inSpan(state: CompactionState, i: number): boolean {
  return state.spans.some((s) => s.from <= i && i < s.to);
}

/* ───────────────────────── prompt ───────────────────────── */

/** summary 阶段的 system prompt：写给「要接着干活的那个 agent」，只保真、不发挥。 */
export const SUMMARY_SYSTEM =
  "You are writing a compaction summary for an agent whose conversation no longer fits its context window. " +
  "The summary takes the place of the original messages, and the same agent will carry on from it. " +
  "Preserve what the work depends on: the user's words, decisions, identifiers, paths, commands, numbers, and error output, quoted exactly. " +
  "Do not add opinions, advice, or anything the conversation does not contain.";

/** summary 阶段末尾那条 harness 指令：先 `<scratchpad>` 草稿再 `<summary>` 正文（九个小节）；manual 的附加要求接在它后面。 */
export const SUMMARY_INSTRUCTION =
  "Write the compaction summary for the conversation above.\n\n" +
  "Draft first inside <scratchpad></scratchpad>: walk through the conversation in order and note, for each stretch, " +
  "what the user asked for, what happened, which files and tools were involved, and what was learned or decided. The scratchpad is discarded.\n\n" +
  "Then write the summary inside <summary></summary>, in the language the user has mostly been writing in, with these headings in this order:\n" +
  "1. Goal: what the user wants, in full.\n" +
  "2. Ground rules: constraints, conventions, and technical context the work must respect.\n" +
  "3. Touched files: files read or changed, why, and the snippets that matter, quoted exactly.\n" +
  "4. Failures and fixes: every error that came up, how it was resolved, and any correction the user gave.\n" +
  "5. Findings: what was established, what was ruled out, what is still being investigated.\n" +
  "6. The user's messages: every message from the user, quoted exactly and in order (tool output excluded).\n" +
  "7. Open work: requested but not finished.\n" +
  "8. In progress: precisely what was happening at the moment of compaction, with file names and snippets.\n" +
  "9. Resume with: the very next action, only if the latest user request calls for it; quote that request.\n\n" +
  "If the conversation already contains a compaction summary or condensed stretches, fold them in: keep what still holds, " +
  "drop what has been superseded, and never paste them back verbatim.";

/** 尾巴给摘要器看的上限：单条 1 500 字符、总共 10 000 字符——它只是让「现在在干什么」写对，不是要总结的对象。 */
export const RECENT_MESSAGE_CAP = 1_500;
export const RECENT_TOTAL_CAP = 10_000;

const RECENT_PREAMBLE =
  "The conversation continues after the summarized range with the messages below. They stay in the context verbatim and come right after your summary, " +
  "so do not summarize them; use them only so that \"Open work\", \"In progress\", and \"Resume with\" describe the state as it is now.";

/**
 * 尾巴在视图里的样子，渲染成带下标的文本（去掉 thinking）。摘要器不看它就会把「当前状态」写成尾巴之前那一刻的：
 * 用户答完一轮再 `/compact`，摘要会说「尚未回答」，而答案就在后面（2026-09-02 真机记录）。
 */
export function renderRecent(messages: readonly AgentMessage[], state: CompactionState, from: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = from; i < messages.length; i++) {
    const [m] = viewAt(messages, state, i);
    if (m === undefined) continue;
    let line = renderTranscriptMessage(m, i).replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "");
    if (line.length > RECENT_MESSAGE_CAP) line = `${line.slice(0, RECENT_MESSAGE_CAP)}…`;
    if (size + line.length > RECENT_TOTAL_CAP) {
      lines.push("…");
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return lines.join("\n");
}

/** collapse 阶段的 system prompt：只折一段，其余对话还在，所以只留后续会依赖的东西。 */
export const COLLAPSE_SYSTEM =
  "You are condensing one stretch of an agent's conversation so the agent keeps working with less context. " +
  "Only this stretch is replaced; everything after it stays. Keep what later work may need, quoted exactly: " +
  "the user's words, decisions, paths, identifiers, commands, results, error output. No opinions, no advice.";

/** collapse 阶段末尾那条 harness 指令。 */
export const COLLAPSE_INSTRUCTION =
  "Condense the stretch above. Use <scratchpad></scratchpad> first if it helps; it is discarded. " +
  "Then write inside <summary></summary>, in the language the user has mostly been writing in, a tight account in order: " +
  "what was asked, what was done and with which files or tools, what came out of it, what was decided. " +
  "Quote the user's messages exactly. Drop dead ends unless they rule something out.";

/** 摘要调用的回复 → 正文：剥掉 `<scratchpad>`，取 `<summary>` 里面的；都没有就整段。 */
export function extractSummary(text: string): string {
  const withoutScratch = text.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "");
  const m = /<summary>([\s\S]*?)<\/summary>/i.exec(withoutScratch);
  return (m !== null ? m[1]! : withoutScratch).trim();
}

/** 整段折叠（summary 阶段）送模时的框定：来历、范围、怎么取回原文、正文。 */
export function frameFull(from: number, to: number, body: string): string {
  return (
    "Earlier parts of this conversation were compacted to fit the context window. " +
    `Messages #${from}–#${to - 1} are replaced by the compaction summary below; everything after this message is the unchanged recent conversation.\n` +
    "A summary keeps decisions and state, not exact text. For verbatim code, file contents, error output, or anything you wrote earlier, " +
    "call transcript_read with the index range instead of reconstructing it.\n\n" +
    `<summary>\n${body}\n</summary>`
  );
}

/** 一段折叠（collapse 阶段）的框定。 */
export function frameSection(from: number, to: number, body: string): string {
  return `[Condensed: messages #${from}–#${to - 1}. Exact text: transcript_read from=${from} to=${to}.]\n<summary>\n${body}\n</summary>`;
}

/* ───────────────────────── 阶段 ───────────────────────── */

/** order 10：清最近 `keepBatches` 批工具调用之前的所有工具结果正文（overflow 时只留 1 批）。零模型成本。 */
export function toolResultsStage(keepBatches: number = DEFAULT_KEEP_RECENT_TOOL_RESULTS): CompactionStage {
  return {
    name: "tool-results",
    order: 10,
    run(input: CompactionInput): CompactionState | null {
      const { messages, state } = input;
      const keep = input.reason === "overflow" ? 1 : Math.max(1, keepBatches);
      // 从末尾数第 keep 批工具调用（带 tool_use 的 assistant）：它之前的结果都可以清
      let seen = 0;
      let cut = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "assistant" && m.content.some((b) => b.type === "tool_use")) {
          seen += 1;
          if (seen === keep) {
            cut = i;
            break;
          }
        }
      }
      if (cut <= state.clearedBefore) return null;
      let any = false;
      for (let i = state.clearedBefore; i < cut; i++) {
        if (messages[i]!.role === "toolResult" && !inSpan(state, i)) {
          any = true;
          break;
        }
      }
      if (!any) return null;
      return { spans: state.spans, clearedBefore: cut };
    },
  };
}

/** order 20，只服务 auto：从最旧原文起每 `sectionTokens` 一段、在轮起点收口，折成段摘要；`used ≤ goal` 就停，一次最多 8 段。 */
export function collapseStage(opts: { sectionTokens?: number; keepRecentTokens?: number } = {}): CompactionStage {
  const sectionTokens = opts.sectionTokens ?? DEFAULT_SECTION_TOKENS;
  const keepRecent = opts.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  return {
    name: "collapse",
    order: 20,
    async run(input, signal) {
      // 渐进折叠只服务 auto：应急要一步到位（一次大调用而不是十几次小的），manual 由 summary 整段重做
      if (input.reason !== "auto") return null;
      const { messages, state, budget, estimate } = input;
      const tailStart = chooseTailStart(messages, state, keepRecent, lastSpanEnd(state), estimate);
      const spans: CompactionSpan[] = [...state.spans];
      let start = lastSpanEnd(state);
      let used = budget.used;
      let sections = 0;
      while (used > budget.goal && sections < COLLAPSE_MAX_SECTIONS && start < tailStart) {
        if (signal.aborted) break;
        // 段尾：从 start 累到 sectionTokens
        let end = start;
        let acc = 0;
        while (end < tailStart && acc < sectionTokens) {
          acc += estimate(viewAt(messages, state, end));
          end += 1;
        }
        // 段只在轮起点上收口：先往回找 (start, end] 里最近的轮起点；一整段都在一轮里就往后到下一个轮起点
        // （一轮比 sectionTokens 还大就整轮一段）；再没有就到尾巴起点
        let cut = end >= tailStart ? tailStart : turnStartBack(messages, end, start);
        if (cut < 0) cut = turnStartForward(messages, end, tailStart);
        if (cut <= start) break;
        const section = projectRange(messages, state, start, cut);
        const text = await input.callModel({ systemPrompt: COLLAPSE_SYSTEM, messages: [...section, userMessage(COLLAPSE_INSTRUCTION, "harness")] }, signal);
        const body = extractSummary(text);
        if (body === "") throw new Error(`collapse: model returned no summary for #${start}–#${cut - 1}`);
        const summary = frameSection(start, cut, body);
        spans.push({ from: start, to: cut, summary });
        used -= estimate(section) - estimate([userMessage(summary, "harness")]);
        start = cut;
        sections += 1;
      }
      if (sections === 0) return null;
      return { spans, clearedBefore: state.clearedBefore };
    },
  };
}

/** order 30：尾巴之前的全部（已有段摘要 + 剩余原文）折成一份九节摘要；模型失败就抛（流水线记诊断），不产空摘要。 */
export function summaryStage(opts: { keepRecentTokens?: number } = {}): CompactionStage {
  const keepRecent = opts.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  return {
    name: "summary",
    order: 30,
    async run(input, signal) {
      const { messages, state, reason, estimate } = input;
      const keep = reason === "overflow" ? Math.min(keepRecent, OVERFLOW_KEEP_TOKENS) : keepRecent;
      const tailStart = chooseTailStart(messages, state, keep, lastSpanEnd(state), estimate);
      if (tailStart <= 0) return null;
      const already = state.spans.length === 1 && state.spans[0]!.from === 0 && state.spans[0]!.to === tailStart;
      // 已经是一整段覆盖到同一个尾巴：auto / overflow 无事可做；manual 只在带了新指令时重做
      if (already && (reason !== "manual" || input.instructions === undefined)) return null;
      const prefix = projectRange(messages, state, 0, tailStart);
      const recent = renderRecent(messages, state, tailStart);
      const ask =
        SUMMARY_INSTRUCTION +
        (recent !== "" ? `\n\n${RECENT_PREAMBLE}\n<recent>\n${recent}\n</recent>` : "") +
        (input.instructions !== undefined ? `\n\nThe user also asks, for this summary:\n${input.instructions}` : "");
      const text = await input.callModel({ systemPrompt: SUMMARY_SYSTEM, messages: [...prefix, userMessage(ask, "harness")] }, signal);
      const body = extractSummary(text);
      if (body === "") throw new Error("summary: model returned no summary");
      return { spans: [{ from: 0, to: tailStart, summary: frameFull(0, tailStart, body) }], clearedBefore: state.clearedBefore };
    },
  };
}

/** order 40，只在 overflow：summary 都失败时把尾巴之前直接省略（`summary: null`）。 */
export function snipStage(): CompactionStage {
  return {
    name: "snip",
    order: 40,
    run(input): CompactionState | null {
      if (input.reason !== "overflow") return null;
      const { messages, state, estimate } = input;
      const tailStart = chooseTailStart(messages, state, OVERFLOW_KEEP_TOKENS, lastSpanEnd(state), estimate);
      if (tailStart <= 0) return null;
      const already = state.spans.length === 1 && state.spans[0]!.from === 0 && state.spans[0]!.to === tailStart;
      if (already) return null;
      return { spans: [{ from: 0, to: tailStart, summary: null }], clearedBefore: state.clearedBefore };
    },
  };
}

/** 缺省阶梯的四个阶段（tool-results → collapse → summary → snip），参数来自 `CompactionOptions`。 */
export function defaultCompactionStages(opts: CompactionOptions = {}): CompactionStage[] {
  return [
    toolResultsStage(opts.keepRecentToolResults),
    collapseStage({ ...(opts.sectionTokens !== undefined ? { sectionTokens: opts.sectionTokens } : {}), ...(opts.keepRecentTokens !== undefined ? { keepRecentTokens: opts.keepRecentTokens } : {}) }),
    summaryStage(opts.keepRecentTokens !== undefined ? { keepRecentTokens: opts.keepRecentTokens } : {}),
    snipStage(),
  ];
}

/** `echo:compaction` 那一组的 config 形状：与 `defineToolPack` 的同款，多一个 `stages`。 */
export type CompactionPackConfig = {
  readonly tools: readonly AgentTool[];
  readonly sections: readonly PromptSection[];
  readonly stages: readonly CompactionStage[];
};

/** Agent 构造期造这一组；由 `echo:compaction` builtin 注册。`source` 是活的 transcript。 */
export function defaultCompactionPack(opts: CompactionOptions, source: () => readonly AgentMessage[]): CompactionPackConfig {
  return {
    tools: [transcriptReadTool(source)],
    sections: [compactionSection()],
    stages: defaultCompactionStages(opts),
  };
}
