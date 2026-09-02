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

import { userMessage, type AgentMessage } from "../messages.ts";
import type { PromptSection } from "../prompt/types.ts";
import type { AgentTool } from "../tools/types.ts";
import { compactionSection, transcriptReadTool } from "./tool.ts";
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
import { estimateText, estimateTokens, isLegalCut, isTurnStart, projectRange, viewAt } from "./view.ts";

/** 应急时尾巴只留这么多（再吸到轮边界）：撞窗了，先活下来。 */
export const OVERFLOW_KEEP_TOKENS = 2_000;
/** collapse 一次触发最多折几段——每段一次模型调用，给成本一个上界。 */
export const COLLAPSE_MAX_SECTIONS = 8;

/* ───────────────────────── 切尾巴 ───────────────────────── */

/**
 * 尾巴从哪条起：从末尾向前累加视图里的字节，找**最靠前**的轮起点 j（j ≥ min）使尾巴 ≤ keep；
 * 没有轮起点满足（在飞的一轮本身就超预算）→ 退到满足预算的最靠前合法切点；连那也没有 → n（不留尾）。
 */
export function chooseTailStart(messages: readonly AgentMessage[], state: CompactionState, keep: number, min: number): number {
  const n = messages.length;
  let acc = 0;
  let bestTurn = -1;
  let bestLegal = -1;
  for (let j = n; j >= min; j--) {
    if (j < n) acc += estimateTokens(viewAt(messages, state, j));
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

/** summary 阶段的 system prompt：写给「要接着干活的那个 agent」，精确、不评价、不发明。 */
export const SUMMARY_SYSTEM =
  "You are compacting the working context of an AI agent that is in the middle of a session. Your output replaces the original messages in the agent's context, " +
  "so it must let the same agent continue the work without re-reading them. Write for that agent. Be precise: keep file paths, identifiers, commands, numbers, " +
  "and error text verbatim. Do not invent, evaluate, or advise beyond what the conversation contains.";

/** summary 阶段末尾那条 harness 指令：先 `<analysis>` 草稿再 `<summary>` 九节正文；manual 的附加要求接在它后面。 */
export const SUMMARY_INSTRUCTION =
  "Summarize the conversation above so far.\n\n" +
  "First, inside <analysis></analysis>, work through the conversation chronologically and note for each part what the user asked, what was done, " +
  "which files and tools were involved, and what was found or decided. This block is a scratchpad and will be discarded.\n\n" +
  "Then, inside <summary></summary>, write the summary with exactly these sections:\n" +
  "1. Primary request and intent: what the user is trying to get done, in detail.\n" +
  "2. Key technical concepts: technologies, frameworks, conventions, and constraints that matter for the work.\n" +
  "3. Files and code: files that were read or changed and why; include the important snippets verbatim.\n" +
  "4. Errors and fixes: every error hit and how it was resolved, including feedback from the user.\n" +
  "5. Problem solving: what was solved and how; ongoing troubleshooting.\n" +
  "6. All user messages: every message the user sent (not tool results), verbatim, in order.\n" +
  "7. Pending tasks: work the user asked for that is not done yet.\n" +
  "8. Current work: precisely what was being done right before this summary, with file names and snippets.\n" +
  "9. Next step: the immediate next action, only if it follows directly from the user's most recent request; quote the request it comes from.\n\n" +
  "If an earlier summary or condensed section appears in the conversation, integrate it: keep what is still true, drop what has been superseded, " +
  "and do not repeat it verbatim.";

/** collapse 阶段的 system prompt：只折一段，其余对话还在，所以只留后续会依赖的东西。 */
export const COLLAPSE_SYSTEM =
  "You are condensing one section of an AI agent's session so the agent can keep working with less context. The section's summary replaces those messages; " +
  "the rest of the conversation stays as it is. Keep exactly what later work may depend on: user requests verbatim, decisions, file paths, identifiers, " +
  "commands, results, and error text. Do not add advice or evaluation.";

/** collapse 阶段末尾那条 harness 指令。 */
export const COLLAPSE_INSTRUCTION =
  "Condense the section above. You may use <analysis></analysis> first as a scratchpad; it will be discarded. " +
  "Then, inside <summary></summary>, write a dense chronological account: what the user asked, what was done and with which files or tools, " +
  "what was found, and what was decided. Keep user messages verbatim. Leave out reasoning that led nowhere unless it rules something out.";

/** 摘要调用的回复 → 正文：剥掉 <analysis>，取 <summary> 里面的；都没有就整段。 */
export function stripAnalysis(text: string): string {
  const withoutAnalysis = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "");
  const m = /<summary>([\s\S]*?)<\/summary>/i.exec(withoutAnalysis);
  return (m !== null ? m[1]! : withoutAnalysis).trim();
}

/** 整段折叠（summary 阶段）送模时的框定：来历、范围、怎么取回原文、正文。 */
export function frameFull(from: number, to: number, body: string): string {
  return (
    "This session is being continued from an earlier conversation that ran out of context. " +
    `Messages #${from}–#${to - 1} are summarized below; the messages after this one are the original recent conversation.\n` +
    "If you need specific details from before compaction (exact code, file contents, error messages, or content you generated), " +
    "call transcript_read with a message index range instead of guessing.\n\n" +
    `<summary>\n${body}\n</summary>`
  );
}

/** 一段折叠（collapse 阶段）的框定。 */
export function frameSection(from: number, to: number, body: string): string {
  return `[Messages #${from}–#${to - 1} were condensed to save context. For exact details call transcript_read with from=${from}, to=${to}.]\n<summary>\n${body}\n</summary>`;
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
      const { messages, state, budget } = input;
      const tailStart = chooseTailStart(messages, state, keepRecent, lastSpanEnd(state));
      const spans: CompactionSpan[] = [...state.spans];
      let start = lastSpanEnd(state);
      let used = budget.used;
      let sections = 0;
      while (used > budget.goal && sections < COLLAPSE_MAX_SECTIONS && start < tailStart) {
        if (signal.aborted) break;
        // 段尾：从 start 累到 sectionTokens，再吸到轮起点；一整段里没有轮起点就向后到下一个合法切点
        let end = start;
        let acc = 0;
        while (end < tailStart && acc < sectionTokens) {
          acc += estimateTokens(viewAt(messages, state, end));
          end += 1;
        }
        // 段只在轮起点上收口：先往回找 (start, end] 里最近的轮起点；一整段都在一轮里就往后到下一个轮起点
        // （一轮比 sectionTokens 还大就整轮一段）；再没有就到尾巴起点
        let cut = end >= tailStart ? tailStart : turnStartBack(messages, end, start);
        if (cut < 0) cut = turnStartForward(messages, end, tailStart);
        if (cut <= start) break;
        const section = projectRange(messages, state, start, cut);
        const text = await input.callModel({ systemPrompt: COLLAPSE_SYSTEM, messages: [...section, userMessage(COLLAPSE_INSTRUCTION, "harness")] }, signal);
        const body = stripAnalysis(text);
        if (body === "") throw new Error(`collapse: model returned no summary for #${start}–#${cut - 1}`);
        const summary = frameSection(start, cut, body);
        spans.push({ from: start, to: cut, summary });
        used -= estimateTokens(section) - estimateText(summary);
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
      const { messages, state, reason } = input;
      const keep = reason === "overflow" ? Math.min(keepRecent, OVERFLOW_KEEP_TOKENS) : keepRecent;
      const tailStart = chooseTailStart(messages, state, keep, lastSpanEnd(state));
      if (tailStart <= 0) return null;
      const already = state.spans.length === 1 && state.spans[0]!.from === 0 && state.spans[0]!.to === tailStart;
      // 已经是一整段覆盖到同一个尾巴：auto / overflow 无事可做；manual 只在带了新指令时重做
      if (already && (reason !== "manual" || input.instructions === undefined)) return null;
      const prefix = projectRange(messages, state, 0, tailStart);
      const ask =
        SUMMARY_INSTRUCTION +
        (input.instructions !== undefined ? `\n\nAdditional instructions from the user for this summary:\n${input.instructions}` : "");
      const text = await input.callModel({ systemPrompt: SUMMARY_SYSTEM, messages: [...prefix, userMessage(ask, "harness")] }, signal);
      const body = stripAnalysis(text);
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
      const { messages, state } = input;
      const tailStart = chooseTailStart(messages, state, OVERFLOW_KEEP_TOKENS, lastSpanEnd(state));
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
