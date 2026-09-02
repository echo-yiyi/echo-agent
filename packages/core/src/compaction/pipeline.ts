// 压缩流水线：在轮边界（或撞窗之后 / 用户要求时）按 order 跑注册进来的阶段，直到估算低于 goal。
// 设计见 docs/design/compaction.md §4。
//
// core 在这里拥有四件事：**触发判断、阶段的校验吸附、事件与 hook、状态落到 context**。
// 阶段（内建的、扩展的）只产 `CompactionState`。摘要要调模型，所以给阶段一个 `callModel`——
// 用本 run 冻结的 model 与 streamFn，一次、无工具、不进 transcript。

import type { CompactionReason, CompactionBudget, CompactionModelCall, CompactionState } from "./types.ts";
import { COMPACTION_SLACK_RATIO, DEFAULT_RESERVE_TOKENS } from "./types.ts";
import { measureContext, normalizeCompaction, sameCompaction, type ContextAnchor } from "./view.ts";
import type { LoopDeps, TurnResult } from "../loop/types.ts";
import { errText } from "../errors.ts";

export type CompactionOutcome = {
  /** 有阶段改了状态。false = 跑了但没有一段有事可做（已发 compactionFailed）。 */
  readonly changed: boolean;
  readonly state: CompactionState;
  /** 真正改了状态的阶段名，按跑的顺序。 */
  readonly stages: readonly string[];
  /** 跑完之后的估算。 */
  readonly contextTokens: number;
};

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

/** 阶段用的模型调用（见 `CompactionModelCall` 的契约）。 */
export function modelCallFor(deps: LoopDeps): CompactionModelCall {
  const { config, streamFn } = deps;
  return async ({ systemPrompt, messages }, signal) => {
    const llm = await config.convertToLlm([...messages]);
    const apiKey = await config.getApiKey?.(config.model.provider);
    const stream = await streamFn(
      config.model,
      { systemPrompt, messages: llm, tools: [] },
      { signal, apiKey, thinkingLevel: "off", maxRetryDelayMs: config.maxRetryDelayMs },
    );
    for await (const _item of stream) {
      /* 只要定稿；流式增量不外发 */
    }
    const final = await stream.result();
    if (final.stopReason === "error") {
      const err = final.error;
      throw Object.assign(new Error(err?.message ?? "model call failed"), { code: err?.code ?? "internal" });
    }
    if (final.stopReason === "aborted") throw new Error("model call aborted");
    return final.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}

/**
 * 跑一次流水线。返回 `null` = 没触发（auto 未碰线 / 目录没标窗口 / 没有阶段 / preCompact 拦下），
 * 什么事件都没发；否则 compaction_start / compaction_end 成对，状态已写进 `deps.context.compaction`。
 */
export async function runCompaction(
  deps: LoopDeps,
  opts: { reason: CompactionReason; instructions?: string; anchor: ContextAnchor | null },
): Promise<CompactionOutcome | null> {
  const { context, config, emit, signal } = deps;
  const { reason } = opts;
  const stages = [...config.compaction.getStages()].sort((a, b) => a.order - b.order);
  const window = config.model.capabilities?.contextWindow;
  if (stages.length === 0) return null;
  if (reason === "auto" && window === undefined) return null;

  const measure = (state: CompactionState, anchor: ContextAnchor | null): number =>
    measureContext({ messages: context.messages, state, systemPrompt: context.systemPrompt, anchor });
  let used = measure(context.compaction, opts.anchor);
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
        { messages: context.messages, state, budget: { ...budget, used }, reason, ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}), callModel },
        signal,
      );
      if (next === null) continue;
      next = normalizeCompaction(context.messages, next);
    } catch (e) {
      await config.hooks.notify({ type: "compactionFailed", reason, stage: stage.name, message: errText(e) }, config.hookContext);
      continue;
    }
    if (sameCompaction(next, state)) continue;
    state = next;
    applied.push(stage.name);
    used = measure(state, null);
  }

  const changed = applied.length > 0;
  if (changed) context.compaction = state;
  else await config.hooks.notify({ type: "compactionFailed", reason, message: "no compaction stage changed the context" }, config.hookContext);
  await emit({ type: "compaction_end", reason, compaction: state, stages: applied, contextTokens: used });
  if (changed) await config.hooks.notify({ type: "postCompact", reason, compaction: state, stages: applied }, config.hookContext);
  return { changed, state, stages: applied, contextTokens: used };
}

/**
 * 一个 run 里的压缩簿记：provider 报的 usage 当基准、应急只准一次。
 * 循环在轮首调 `maybeCompact()`、轮末调 `noteTurn()`、撞窗时调 `recover()`。
 */
export function createCompactor(deps: LoopDeps): {
  maybeCompact(): Promise<void>;
  noteTurn(turn: TurnResult): void;
  recover(): Promise<boolean>;
} {
  let anchor: ContextAnchor | null = null;
  let recovered = false;
  return {
    async maybeCompact() {
      const r = await runCompaction(deps, { reason: "auto", anchor });
      if (r?.changed === true) anchor = null;
    },
    noteTurn(turn) {
      const usage = turn.message.usage;
      if (usage === null) return;
      // usage 量的是「那条 assistant 之前的视图 + 它自己的输出」；它之后入账的 toolResult 按字符估
      anchor = { index: deps.context.messages.length - turn.toolResults.length, tokens: usage.inputTokens + usage.outputTokens };
    },
    async recover() {
      if (recovered) return false;
      recovered = true;
      const r = await runCompaction(deps, { reason: "overflow", anchor });
      if (r?.changed === true) anchor = null;
      return r?.changed === true;
    },
  };
}
