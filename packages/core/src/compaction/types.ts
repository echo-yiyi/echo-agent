// 压缩（context compaction）的数据形状。设计见 docs/design/compaction.md。
//
// 一句话：**transcript 永远全量原文，压缩只是一个作用在它上面的视图状态**，送模时才物化。
// 所有压缩策略（内建的、扩展的）写的都是同一个 `CompactionState`；core 负责校验它、
// 把它投影成送模消息、落盘、恢复。策略只产状态，不碰消息数组、不发事件、不写盘。

import type { AgentMessage } from "../messages.ts";

/** 一段被折叠的原文：`[from, to)` 是 transcript 下标（半开）。`summary === null` = 只省略、不摘要。 */
export type CompactionSpan = {
  readonly from: number;
  readonly to: number;
  readonly summary: string | null;
};

/**
 * 压缩状态。运行时（`AgentState.compaction` / `AgentContext.compaction`）与盘上（session 的
 * compaction entry）**同一个形状、同一套下标**——恢复不需要换算。
 *
 *   · `spans`：按 `from` 升序、互不重叠；每个边界都在**合法切点**上（见 `view.ts` 的 `isLegalCut`）；
 *   · `clearedBefore`：下标 < 它、且不在任何 span 内的 `toolResult`，投影时正文换成占位——
 *     消息本身保留、`toolCallId` 不动，所以 tool_use ↔ tool_result 配对永远不破。
 */
export type CompactionState = {
  readonly spans: readonly CompactionSpan[];
  readonly clearedBefore: number;
};

/** 没压过：没有段、没清过任何工具结果。运行时与 session 的缺省值。 */
export const EMPTY_COMPACTION: CompactionState = Object.freeze({ spans: Object.freeze([]) as readonly CompactionSpan[], clearedBefore: 0 });

/** 状态是否等于「没压过」。 */
export function isEmptyCompaction(s: CompactionState): boolean {
  return s.spans.length === 0 && s.clearedBefore === 0;
}

/** 为什么压：轮边界超阈值 / provider 报 context_overflow 之后的应急 / 用户 `/compact`。 */
export type CompactionReason = "auto" | "overflow" | "manual";

/**
 * 本次压缩的预算，全是 token 估算值（provider usage 为基准、尾巴按字符估）。
 *   · `window`：模型窗口；目录没标时为 null（auto 在未知窗口下不触发，overflow / manual 仍能跑）；
 *   · `used`：阶段跑之前的估算；
 *   · `target`：触发线 = window − reserve；
 *   · `goal`：这次要压到哪——auto / manual 是 target 再减一截（免得下一轮又触发），overflow 是半窗。
 */
export type CompactionBudget = {
  readonly window: number | null;
  readonly used: number;
  readonly target: number;
  readonly goal: number;
};

/**
 * 阶段能用的模型调用：**一次、无工具、不进 transcript、不发 message_\* 事件**，
 * 用本 run 冻结的 model 与 streamFn。失败以 rejection 返回（带 provider 的 AgentError code），阶段自己决定兜底。
 */
export type CompactionModelCall = (
  input: { systemPrompt: string | null; messages: readonly AgentMessage[] },
  signal: AbortSignal,
) => Promise<string>;

/** 阶段看到的全部现场。**只读**：`messages` 是 transcript 快照，改它不会有任何效果，也不该改。 */
export type CompactionInput = {
  readonly messages: readonly AgentMessage[];
  readonly state: CompactionState;
  readonly budget: CompactionBudget;
  readonly reason: CompactionReason;
  /** `/compact <指令>` 带的附加要求；只有 manual 会有。 */
  readonly instructions?: string;
  readonly callModel: CompactionModelCall;
  /**
   * **阶段算字节一律用它**，别直接调 `estimateTokens()`：它已按本 run 的 provider usage 校准过
   * （真 token / 字符估），与 `budget.used` / `budget.goal` 同一个量纲。裸字符估对中文低 2–4 倍。
   */
  readonly estimate: (messages: readonly AgentMessage[]) => number;
};

/**
 * 一个压缩阶段（策略的最小单元）。经 `AgentCompaction` registry 注册；流水线按 `order` 升序跑，
 * 每跑完一段重估 `used`，够了就停。返回 `null` = 本阶段无事可做；返回新状态 = core 校验吸附后采用。
 * 抛错 = 记 `compactionFailed` 诊断、跳到下一段——阶段是增强面，坏一段不许击穿整个 run。
 */
export type CompactionStage = {
  readonly name: string;
  /** 越小越先跑。内建：tool-results 10 · collapse 20 · summary 30 · snip 40。 */
  readonly order: number;
  run(input: CompactionInput, signal: AbortSignal): Promise<CompactionState | null> | CompactionState | null;
};

/**
 * `AgentOptions.compaction`：core 触发面的两个数 + 内建阶段的参数 + 要不要内建那组。
 * 内建阶段的参数只有在 `builtin !== false` 时才有意义；产品自己的阶段走自己的配置。
 */
export type CompactionOptions = {
  /** 给输出与安全边际留的 token；估算 ≥ contextWindow − reserveTokens 就触发。缺省 max(maxOutputTokens, 16 000)。 */
  reserveTokens?: number;
  /** 内建 collapse / summary 阶段：尾部保留多少 token 的原文（再吸到轮边界）。缺省 8 000。 */
  keepRecentTokens?: number;
  /** 内建 collapse 阶段：一段折叠多少 token。缺省 32 000。 */
  sectionTokens?: number;
  /** 内建 tool-results 阶段：最近几批工具调用的结果不清。缺省 3。 */
  keepRecentToolResults?: number;
  /**
   * `false` = 不造 `echo:compaction` 那组（阶段 / transcript_read / prompt 段）。流水线与 registry 仍在，
   * 等别的 extension 注册阶段——这是「换一套策略」的入口。缺省 true。
   */
  builtin?: boolean;
};

/** `reserveTokens` 的缺省下限：目录没标 `maxOutputTokens`、或标得比这小，就按它留。 */
export const DEFAULT_RESERVE_TOKENS = 16_000;
/** `keepRecentTokens` 的缺省：摘要 / 折叠之后尾部保留多少原文。 */
export const DEFAULT_KEEP_RECENT_TOKENS = 8_000;
/** `sectionTokens` 的缺省：collapse 一段折多少。 */
export const DEFAULT_SECTION_TOKENS = 32_000;
/** `keepRecentToolResults` 的缺省：最近几批工具调用的结果不清。 */
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 3;
/** auto / manual 压到 target 之下再留这么一截（占窗口比例），免得下一轮又碰线。 */
export const COMPACTION_SLACK_RATIO = 0.1;
