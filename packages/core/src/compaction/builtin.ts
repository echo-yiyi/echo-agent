// `echo:compaction` 的缺省阶梯：四个阶段 + transcript_read + prompt 段。设计见 docs/design/compaction.md §5。
//
// 阶梯（按 order）：
//   10 tool-results  清旧的工具结果正文，零模型成本。只在触发时整批清，两次触发之间字节不动，不打 prompt 缓存。
//   20 collapse      auto 专用：从最旧的原文起，一段一段折成摘要（每段一次小调用），够了就停。渐进，不一次全丢。
//   30 summary       把尾巴之前的全部（已有的段摘要 + 剩余原文）折成一份结构化摘要。auto 在 collapse 不够时、manual 恒、overflow 恒。
//   40 snip          只在 overflow：summary 都失败了，把尾巴之前直接省略——总好过再撞一次窗。
//
// 三条底线（2026-11-03）：在飞那一批永远在尾巴里（`chooseTailStart`）；用户最新的请求不折不省（`foldRanges`）；
// 那一批自己就放不下时，清工具结果那一段把它清掉、模型按 id 读回，而不是整段省略。
//
// 阶段只产状态。校验吸附、投影、事件、落盘都在 core（`view.ts` / `pipeline.ts`）。
// 这一组与第三方扩展走**同一条** `AgentCompaction.stage()`，同一份所有权账本；`compaction.builtin = false` 就不装它。
//
// **算字节一律用 `input.estimate`**（已按 usage 校准），不直接调 `estimateTokens`——量纲要与 `budget` 一致。
//
// 提示词是**自己写的**（措辞、节名、框定），不抄任何专有产品的文案；结构上的「先草稿再正文」「按固定小节写」
// 是通用做法。摘要与折叠的调用从主对话分叉（同一份 system 与工具菜单、指令接在末尾），吃得到前缀缓存。全英文（2026-09-01 模型面全英文），但要求摘要**用用户主要使用的语言写**——用户说中文就得到中文摘要。

import { userMessage, type AgentMessage } from "../messages.ts";
import type { PromptSection } from "../prompt/types.ts";
import type { AgentTool } from "../tools/types.ts";
import { compactionSection, renderTranscriptMessage, transcriptReadTool } from "./tool.ts";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_SECTION_TOKENS,
  TOOL_RESULTS_STAGE,
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
 * 在飞的那一批从哪起：`n` 之前最后一个合法切点。transcript 以工具批收尾时是那条带 tool_use 的 assistant
 * （它与结果一起才是一批）；以用户输入或一条回答收尾时就是那一条。空 transcript 是 0。
 */
export function inflightStart(messages: readonly AgentMessage[]): number {
  for (let j = messages.length - 1; j > 0; j--) if (isLegalCut(messages, j)) return j;
  return 0;
}

/** 最新的用户请求：最后一条不是 harness 插话的 user 消息；没有返回 -1。折叠与省略都绕开它，原文留在视图里。 */
export function latestUserRequest(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && m.source !== "harness") return i;
  }
  return -1;
}

/**
 * 尾巴从哪条起：从末尾向前累加视图里的字节，找**最靠前**的轮起点 j（min ≤ j ≤ 在飞那一批的起点）使尾巴 ≤ keep；
 * 没有轮起点满足（在飞的一轮本身就超预算）→ 退到满足预算的最靠前合法切点；连那也没有 → 在飞那一批的起点。
 * **在飞那一批永远在尾巴里**：放不下时由清工具结果那一段把它缩小（overflow），不折进摘要、不省略。
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
  const cap = Math.max(min, inflightStart(messages));
  let acc = 0;
  let bestTurn = -1;
  let bestLegal = -1;
  for (let j = n; j >= min; j--) {
    if (j < n) acc += estimate(viewAt(messages, state, j));
    if (acc > keep) break;
    if (j > cap) continue;
    if (isTurnStart(messages, j)) bestTurn = j;
    else if (isLegalCut(messages, j)) bestLegal = j;
  }
  if (bestTurn >= 0) return bestTurn;
  if (bestLegal >= 0) return bestLegal;
  return cap;
}

/** 一段要折的 `[from, to)`。 */
export type FoldRange = readonly [from: number, to: number];

/**
 * 要折的 `[from, to)` 绕开最新的用户请求：它落在里面就拆成前后两段，原文留在两段之间——
 * 尾巴从它的轮中途切起时（在飞的一轮比尾巴预算还大），模型照样看得到用户要它干什么。
 */
export function foldRanges(messages: readonly AgentMessage[], from: number, to: number): FoldRange[] {
  const u = latestUserRequest(messages);
  if (u < from || u >= to) return to > from ? [[from, to]] : [];
  const out: FoldRange[] = [];
  if (u > from) out.push([from, u]);
  if (to > u + 1) out.push([u + 1, to]);
  return out;
}

/** 状态里的段是不是正好覆盖这几段（不看正文）。 */
function coversExactly(state: CompactionState, ranges: readonly FoldRange[]): boolean {
  return state.spans.length === ranges.length && ranges.every(([from, to], i) => state.spans[i]!.from === from && state.spans[i]!.to === to);
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

/**
 * summary 指令的开头一段：叫停手上的活、定角色（写给「要接着干活的那个 agent」，只保真、不发挥）。
 * 摘要调用从主对话分叉（同一份 system、同一份工具菜单，见 `CompactionModelCall`），指令是接在末尾的一条 harness 消息，
 * 所以角色说在这里、不在 system 里。脚本化模型的测试也靠它认出一次模型调用是 summary 阶段发的。
 */
export const SUMMARY_PROMPT_OPENING =
  "Pause the task above: this conversation no longer fits the context window, and you are now writing its compaction summary, not continuing the work.";

/**
 * summary 阶段末尾那条 harness 指令：先 `<scratchpad>` 草稿再 `<summary>` 正文（九个小节）；manual 的附加要求接在它后面。
 * 节序：接着干活最离不开的（目标、没做完的、正在做的、下一步）在前，细节在后——输出越写越长，越往后越可能被压缩掉注意力。
 */
export const SUMMARY_INSTRUCTION =
  `${SUMMARY_PROMPT_OPENING} ` +
  "The summary takes the place of the original messages, and the same agent will carry on from it. " +
  "Preserve what the work depends on: the user's words, decisions, identifiers, paths, commands, numbers, and error output, quoted exactly. " +
  "Do not add opinions, advice, or anything the conversation does not contain. Reply with text only; do not call any tools.\n\n" +
  "Write the compaction summary for the conversation above.\n\n" +
  "Draft first inside <scratchpad></scratchpad>: walk through the conversation in order and note, for each stretch, " +
  "what the user asked for, what happened, which files and tools were involved, and what was learned or decided. The scratchpad is discarded.\n\n" +
  "Then write the summary inside <summary></summary>, in the language the user has mostly been writing in, with these headings in this order:\n" +
  "1. Goal: what the user wants, in full.\n" +
  "2. Open work: requested but not finished.\n" +
  "3. In progress: precisely what was happening at the moment of compaction, with file names and snippets.\n" +
  "4. Resume with: the very next action, only if the latest user request calls for it; quote that request.\n" +
  "5. Ground rules: constraints, conventions, and technical context the work must respect.\n" +
  "6. Failures and fixes: every error that came up, how it was resolved, and any correction the user gave.\n" +
  "7. Findings: what was established, what was ruled out, what is still being investigated.\n" +
  "8. Touched files: files read or changed, why, and the snippets that matter, quoted exactly.\n" +
  "9. The user's messages: every message from the user, quoted exactly and in order (tool output excluded). " +
  "For a very long one (a pasted log, file, or document), quote only its first and last few lines and mark the gap as " +
  "[… cut; the full message can be read back with transcript_read].\n\n" +
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

/** collapse 指令的开头一段：只折一段，其余对话还在，所以只留后续会依赖的东西。与 summary 同理放在指令里、不在 system 里。 */
export const COLLAPSE_PROMPT_OPENING =
  "Pause the task: you are now condensing the stretch of conversation above so that the agent keeps working with less context, not continuing the work.";

/** collapse 阶段末尾那条 harness 指令。 */
export const COLLAPSE_INSTRUCTION =
  `${COLLAPSE_PROMPT_OPENING} ` +
  "Only this stretch is replaced; everything after it stays. Keep what later work may need, quoted exactly: " +
  "the user's words, decisions, paths, identifiers, commands, results, error output. No opinions, no advice. Reply with text only; do not call any tools.\n\n" +
  "Condense the stretch above. Use <scratchpad></scratchpad> first if it helps; it is discarded. " +
  "Then write inside <summary></summary>, in the language the user has mostly been writing in, a tight account in order: " +
  "what was asked, what was done and with which files or tools, what came out of it, what was decided. " +
  "Quote the user's messages exactly; for a very long one, quote only its first and last few lines and mark the gap as " +
  "[… cut; the full message can be read back with transcript_read]. Drop dead ends unless they rule something out.";

/**
 * 摘要调用的回复 → 正文：剥掉 `<scratchpad>`，取 `<summary>` 里面的；两种标签都没有就整段。
 * `<summary>` 打开了没闭合、或草稿没闭合又没有正文 = 输出被截断，返回 ""（阶段据此判失败），不拿半截当摘要。
 */
export function extractSummary(text: string): string {
  const withoutScratch = text.replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "");
  const m = /<summary>([\s\S]*?)<\/summary>/i.exec(withoutScratch);
  if (m !== null) return m[1]!.trim();
  if (/<summary>|<scratchpad>/i.test(withoutScratch)) return "";
  return withoutScratch.trim();
}

/**
 * 整段折叠（summary 阶段）送模时的框定：来历、范围、怎么取回原文、正文。`ranges` 是 `foldRanges()` 的产物：
 * 两段时中间夹着的那条是用户最新的请求，原文紧跟在这条摘要之后，第二段只留一句指回这里的说明（`frameCovered`）。
 */
export function frameFull(ranges: readonly FoldRange[], body: string): string {
  const span = ([from, to]: FoldRange): string => `#${from}–#${to - 1}`;
  const scope =
    ranges.length === 2
      ? `Messages ${span(ranges[0]!)} and ${span(ranges[1]!)} are replaced by the compaction summary below. ` +
        `The user's latest request, message #${ranges[0]![1]}, follows this summary verbatim; everything after the note for ${span(ranges[1]!)} is the unchanged recent conversation.\n`
      : `Messages ${ranges.map(span).join(", ")} are replaced by the compaction summary below; everything after this message is the unchanged recent conversation.\n`;
  return (
    "Earlier parts of this conversation were compacted to fit the context window. " +
    scope +
    "A summary keeps decisions and state, not exact text. For verbatim code, file contents, error output, or anything you wrote earlier, " +
    "call transcript_read with the index range instead of reconstructing it.\n\n" +
    `<summary>\n${body}\n</summary>`
  );
}

/** 用户最新请求之后、尾巴之前那一段的说明：内容在请求之前那条摘要里。 */
export function frameCovered(from: number, to: number): string {
  return `[Messages #${from}–#${to - 1}, the work on the request above, are covered by the compaction summary before it. Exact text: transcript_read from=${from} to=${to}.]`;
}

/** summary 阶段的产物：第一段放摘要正文，第二段（有的话）放指回它的说明。 */
function summarySpans(ranges: readonly FoldRange[], body: string): CompactionSpan[] {
  return ranges.map(([from, to], i) => ({ from, to, summary: i === 0 ? frameFull(ranges, body) : frameCovered(from, to) }));
}

/** 一段折叠（collapse 阶段）的框定。 */
export function frameSection(from: number, to: number, body: string): string {
  return `[Condensed: messages #${from}–#${to - 1}. Exact text: transcript_read from=${from} to=${to}.]\n<summary>\n${body}\n</summary>`;
}

/* ───────────────────────── 阶段 ───────────────────────── */

/**
 * order 10：清最近 `keepBatches` 批工具调用之前的所有工具结果正文（overflow 时只留 1 批；那一批的结果合计
 * 超过 `OVERFLOW_KEEP_TOKENS` 时连它也清）。零模型成本。
 */
export function toolResultsStage(keepBatches: number = DEFAULT_KEEP_RECENT_TOOL_RESULTS): CompactionStage {
  return {
    name: TOOL_RESULTS_STAGE,
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
      // 应急时那一批自己就放不下（结果合计超过应急尾巴）：连它也清掉，模型按占位里的 id 分段读回——
      // 尾巴不再拿在飞那一批去撞窗，也不会因此把用户的请求折掉
      if (input.reason === "overflow" && cut >= 0) {
        let batch = 0;
        for (let i = cut + 1; i < messages.length; i++) if (messages[i]!.role === "toolResult" && !inSpan(state, i)) batch += input.estimate(viewAt(messages, state, i));
        if (batch > OVERFLOW_KEEP_TOKENS) cut = messages.length;
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
      const request = latestUserRequest(messages);
      const spans: CompactionSpan[] = [...state.spans];
      let start = lastSpanEnd(state);
      let used = budget.used;
      let sections = 0;
      while (used > budget.goal && sections < COLLAPSE_MAX_SECTIONS && start < tailStart) {
        if (signal.aborted) break;
        // 用户最新的请求不折：段在它前面收口，下一段从它后面起
        if (start === request) {
          start += 1;
          continue;
        }
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
        if (start < request && cut > request) cut = request;
        if (cut <= start) break;
        const section = projectRange(messages, state, start, cut);
        // 从主对话分叉（不给 systemPrompt）：同一份 system 与工具菜单，从最旧那段折起时前缀与上一次请求逐字相同
        const text = await input.callModel({ messages: [...section, userMessage(COLLAPSE_INSTRUCTION, "harness")] }, signal);
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
      // 空闲清理只清工具结果：摘要要调模型，不是「趁缓存凉了顺手清一下」该做的事
      if (reason === "idle") return null;
      const keep = reason === "overflow" ? Math.min(keepRecent, OVERFLOW_KEEP_TOKENS) : keepRecent;
      const tailStart = chooseTailStart(messages, state, keep, lastSpanEnd(state), estimate);
      const ranges = foldRanges(messages, 0, tailStart);
      if (ranges.length === 0) return null;
      // 已经是同样几段覆盖到同一个尾巴：auto / overflow 无事可做；manual 只在带了新指令时重做
      if (coversExactly(state, ranges) && (reason !== "manual" || input.instructions === undefined)) return null;
      const prefix = projectRange(messages, state, 0, tailStart);
      const recent = renderRecent(messages, state, tailStart);
      const ask =
        SUMMARY_INSTRUCTION +
        (recent !== "" ? `\n\n${RECENT_PREAMBLE}\n<recent>\n${recent}\n</recent>` : "") +
        (input.instructions !== undefined ? `\n\nThe user also asks, for this summary:\n${input.instructions}` : "");
      // 从主对话分叉（不给 systemPrompt）：同一份 system 与工具菜单，前缀（视图从头到尾巴之前）与上一次请求逐字相同
      const text = await input.callModel({ messages: [...prefix, userMessage(ask, "harness")] }, signal);
      const body = extractSummary(text);
      if (body === "") throw new Error("summary: model returned no summary");
      return { spans: summarySpans(ranges, body), clearedBefore: state.clearedBefore };
    },
  };
}

/** order 40，只在 overflow：summary 都失败时把尾巴之前直接省略（`summary: null`）；用户最新的请求照样绕开。 */
export function snipStage(): CompactionStage {
  return {
    name: "snip",
    order: 40,
    run(input): CompactionState | null {
      if (input.reason !== "overflow") return null;
      const { messages, state, estimate } = input;
      const tailStart = chooseTailStart(messages, state, OVERFLOW_KEEP_TOKENS, lastSpanEnd(state), estimate);
      const ranges = foldRanges(messages, 0, tailStart);
      if (ranges.length === 0 || coversExactly(state, ranges)) return null;
      return { spans: ranges.map(([from, to]) => ({ from, to, summary: null })), clearedBefore: state.clearedBefore };
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
