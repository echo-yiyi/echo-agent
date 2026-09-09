// 压缩流水线：在轮边界（或撞窗之后 / 用户要求时）按 order 跑注册进来的阶段，直到估算低于 goal。
// 设计见 docs/design/compaction.md §4。
//
// core 在这里拥有四件事：**触发判断、阶段的校验吸附、事件与 hook、状态落到 context**。
// 阶段（内建的、扩展的）只产 `CompactionState`。摘要要调模型，所以给阶段一个 `callModel`——
// 用本 run 冻结的 model 与 streamFn，一次、无工具、不进 transcript。
//
// **量纲**：触发以 provider usage 为准，阶段之间只能重新字符估——两者不是一个尺子（中文会话字符估低 2–4 倍）。
// 所以从 usage 算一个校准比（真 token / 字符估），之后所有字符估都乘它：流水线里的 `used`、给阶段的 `estimate`、
// 压完报出去的 `contextTokens`，全在 usage 的量纲上。校准比随本 run 最近一次 usage 走（`createCompactor`）。

import type { CompactionReason, CompactionBudget, CompactionModelCall, CompactionState } from "./types.ts";
import { COMPACTION_SLACK_RATIO, DEFAULT_RESERVE_TOKENS } from "./types.ts";
import { estimateText, estimateTokens, buildWorkingMessages, measureContext, normalizeCompaction, sameCompaction, type ContextAnchor } from "./view.ts";
import type { LoopDeps, TurnResult } from "../loop/types.ts";
import { clampDelay, sleep } from "../loop/backoff.ts";
import type { AgentMessage } from "../messages.ts";
import { agentError, errText } from "../errors.ts";

export type CompactionOutcome = {
  /** 有阶段改了状态。false = 跑了但没有一段有事可做（已发 compactionFailed）。 */
  readonly changed: boolean;
  readonly state: CompactionState;
  /** 真正改了状态的阶段名，按跑的顺序。 */
  readonly stages: readonly string[];
  /** 跑完之后的估算（usage 量纲）。 */
  readonly contextTokens: number;
};

/** 校准比的合理范围：超出多半是 usage 报错了（比如把缓存算了两遍），别让一个坏数把估算放大百倍。 */
const CALIBRATION_MIN = 0.2;
const CALIBRATION_MAX = 10;

/** 校准比夹到合理范围；非数 / 非正 → 1。Agent 记「上一次 usage 的校准比」时也用它。 */
export function clampCalibration(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 1;
  return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, x));
}

export function compactionBudget(input: {
  window: number | undefined;
  maxOutputTokens: number | undefined;
  reserveTokens: number | undefined;
  used: number;
  reason: CompactionReason;
}): CompactionBudget {
  const { window, used, reason } = input;
  if (window === undefined) {
    // 目录没标窗口：auto 无从判断（调用方不会走到这里）；overflow / manual 只能按「砍一半」给个方向
    return { window: null, used, target: used, goal: reason === "auto" ? used : Math.floor(used / 2) };
  }
  const reserve = input.reserveTokens ?? Math.max(input.maxOutputTokens ?? 0, DEFAULT_RESERVE_TOKENS);
  const target = Math.max(0, window - reserve);
  const goal = reason === "overflow" ? Math.floor(window / 2) : Math.max(0, target - Math.floor(window * COMPACTION_SLACK_RATIO));
  return { window, used, target, goal };
}

/**
 * 阶段用的模型调用（见 `CompactionModelCall` 的契约）。
 * 它不是 attempt，但重试与 loop 同一份 `retryPolicy`、同一个受 signal 管的退避（`loop/backoff.ts`）：
 * retryable 错误重试到 `maxAttempts`；只发 hook 侧的 modelCallFailed / retryScheduled，不发 loop 事件（它不在任何 turn 里）。
 */
export function modelCallFor(deps: LoopDeps): CompactionModelCall {
  const { config, streamFn } = deps;
  return async ({ systemPrompt, messages }, signal) => {
    const llm = await config.convertToLlm([...messages]);
    const { maxAttempts } = config.retryPolicy;
    for (let attempt = 1; ; attempt++) {
      const apiKey = await config.getApiKey?.(config.model.provider);
      const stream = await streamFn(
        config.model,
        { systemPrompt, messages: llm, tools: [] },
        { signal, apiKey, thinkingLevel: "off" },
      );
      for await (const _item of stream) {
        /* 只要定稿；流式增量不外发 */
      }
      const final = await stream.result();
      if (final.stopReason === "aborted") throw new Error("model call aborted");
      if (final.stopReason !== "error") {
        return final.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
      }
      const err = final.error ?? agentError("provider", "internal", "未标注的失败", false);
      await config.hooks.notify({ type: "modelCallFailed", error: err, attempt }, config.hookContext);
      if (!err.retryable || attempt >= maxAttempts || signal.aborted) {
        throw Object.assign(new Error(err.message), { code: err.code });
      }
      const delayMs = clampDelay(config.retryPolicy.backoffMs(attempt), config.maxRetryDelayMs);
      await config.hooks.notify({ type: "retryScheduled", attempt: attempt + 1, maxAttempts, delayMs, cause: err.code }, config.hookContext);
      await sleep(delayMs, signal);
      if (signal.aborted) throw new Error("model call aborted");
    }
  };
}

/**
 * 跑一次流水线。返回 `null` = 没触发（auto 未碰线 / 目录没标窗口 / 没有阶段 / preCompact 拦下），
 * 什么事件都没发；否则 compaction_start / compaction_end 成对，状态已写进 `deps.context.compaction`。
 *
 * `anchor` 是本 run 最近一次 usage；`calibration` 是从更早的 usage 算出的校准比（没有就 1）。
 * 有 anchor 时以它为准并据它重算校准比；没有（run 刚开始、刚压过、上一轮报错没 usage）就用传进来的校准比乘字符估。
 */
export async function runCompaction(
  deps: LoopDeps,
  opts: { reason: CompactionReason; instructions?: string; anchor: ContextAnchor | null; calibration?: number },
): Promise<CompactionOutcome | null> {
  const { context, config, emit, signal } = deps;
  const { reason } = opts;
  const stages = [...config.compaction.getStages()].sort((a, b) => a.order - b.order);
  const window = config.model.capabilities?.contextWindow;
  if (stages.length === 0) return null;
  if (reason === "auto" && window === undefined) return null;

  /** 纯字符估（system + 视图），未校准。 */
  const raw = (state: CompactionState): number =>
    measureContext({ messages: context.messages, state, systemPrompt: context.systemPrompt, anchor: null });
  let calibration = clampCalibration(opts.calibration ?? 1);
  let used: number;
  if (opts.anchor !== null) {
    used = measureContext({ messages: context.messages, state: context.compaction, systemPrompt: context.systemPrompt, anchor: opts.anchor, calibration });
    const r = raw(context.compaction);
    if (r > 0) calibration = clampCalibration(used / r);
  } else {
    used = Math.ceil(raw(context.compaction) * calibration);
  }
  const estimate = (messages: readonly AgentMessage[]): number => Math.ceil(estimateTokens(messages) * calibration);
  const budget = compactionBudget({
    window,
    maxOutputTokens: config.model.capabilities?.maxOutputTokens,
    reserveTokens: config.compaction.reserveTokens,
    used,
    reason,
  });
  if (reason === "auto" && used < budget.target) return null;

  const pre = await config.hooks.intercept({ type: "preCompact", reason }, config.hookContext);
  if (pre.decision === "block") return null;

  await emit({ type: "compaction_start", reason });
  const callModel = modelCallFor(deps);
  let state = context.compaction;
  const applied: string[] = [];
  for (const stage of stages) {
    if (signal.aborted) break;
    if (reason === "auto" && used <= budget.goal) break;
    let next: CompactionState | null;
    try {
      next = await stage.run(
        {
          messages: context.messages,
          state,
          budget: { ...budget, used },
          reason,
          ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
          callModel,
          estimate,
        },
        signal,
      );
      if (next === null) continue;
      next = normalizeCompaction(context.messages, next);
    } catch (e) {
      await config.hooks.notify({ type: "compactionFailed", reason, stage: stage.name, message: errText(e) }, config.hookContext);
      // 官方产品里 compactionFailed 没人收（TUI 的 default 分支丢掉、观测层不记），压缩失败等于不可见——
      // 再发一条通用错误通知，壳与 serve 端都认它（review 2026-09-07）
      await config.hooks.notify({ type: "notification", kind: "error", message: `[compaction_stage_failed] ${stage.name}: ${errText(e)}` }, config.hookContext);
      continue;
    }
    if (sameCompaction(next, state)) continue;
    state = next;
    applied.push(stage.name);
    // 同一把尺子：字符估乘校准比，与触发时的 usage 同量纲
    used = Math.ceil(raw(state) * calibration);
  }

  const changed = applied.length > 0;
  if (changed) context.compaction = state;
  else {
    await config.hooks.notify({ type: "compactionFailed", reason, message: "no compaction stage changed the context" }, config.hookContext);
    await config.hooks.notify({ type: "notification", kind: "error", message: "[compaction_stage_failed] no compaction stage changed the context" }, config.hookContext);
  }
  await emit({ type: "compaction_end", reason, compaction: state, stages: applied, contextTokens: used });
  if (changed) await config.hooks.notify({ type: "postCompact", reason, compaction: state, stages: applied }, config.hookContext);
  return { changed, state, stages: applied, contextTokens: used };
}

/**
 * 一个 run 里的压缩簿记：provider 报的 usage 当基准并算校准比、应急只准一次。
 * 循环在轮首调 `maybeCompact()`、轮末调 `noteTurn()`、撞窗时调 `recover()`。
 */
export function createCompactor(deps: LoopDeps): {
  maybeCompact(): Promise<void>;
  noteTurn(turn: TurnResult): void;
  recover(): Promise<boolean>;
} {
  let anchor: ContextAnchor | null = null;
  // 起点用 Agent 记住的上一次校准比：新 run 的首轮还没有 usage，裸字符估对中文会低估
  let calibration = clampCalibration(deps.config.compaction.calibration ?? 1);
  let recovered = false;
  return {
    async maybeCompact() {
      const r = await runCompaction(deps, { reason: "auto", anchor, calibration });
      if (r?.changed === true) anchor = null;
    },
    noteTurn(turn) {
      // 只有落地的 turn 有可信的 usage；失败 / block / abort 的没有基准可记
      if (turn.result.kind !== "landed") return;
      const usage = turn.result.message.usage;
      if (usage === null) return;
      // usage 量的是「那条 assistant 之前的视图 + 它自己的输出」；它之后入账的 toolResult 按字符估
      const index = deps.context.messages.length - turn.toolResults.length;
      const tokens = usage.inputTokens + usage.outputTokens;
      anchor = { index, tokens };
      // 校准比：同一份视图（system + 到那条 assistant 为止的投影）的字符估，与 provider 说的真值之比。
      // 记住它——压缩之后 anchor 作废、上一轮报错没 usage 时，字符估还能按本会话的语言密度换算。
      const raw = estimateText(deps.context.systemPrompt) + estimateTokens(buildWorkingMessages(deps.context.messages.slice(0, index), deps.context.compaction));
      if (raw > 0) calibration = clampCalibration(tokens / raw);
    },
    async recover() {
      if (recovered) return false;
      recovered = true;
      const r = await runCompaction(deps, { reason: "overflow", anchor, calibration });
      if (r?.changed === true) anchor = null;
      return r?.changed === true;
    },
  };
}
