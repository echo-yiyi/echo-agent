// 压缩流水线：在轮边界（或撞窗之后 / 用户要求时）按 order 跑注册进来的阶段，直到估算低于 goal。
// 设计见 docs/design/compaction.md §4。
//
// core 在这里拥有四件事：**触发判断、阶段的校验吸附、事件与 hook、状态落到 context**。
// 阶段（内建的、扩展的）只产 `CompactionState`。摘要要调模型，所以给阶段一个 `callModel`——
// 用本 run 冻结的 model 与 streamFn，一次、无工具、不进 transcript。
//
// **量纲**：触发以 provider usage 为准，阶段之间只能重新字符估——两者不是一个尺子（中文会话字符估低 2–4 倍）。
// 所以从 usage 算一个校准比（真 token / 字符估），之后 system 与消息的字符估都乘它：流水线里的 `used`、给阶段的 `estimate`、
// 压完报出去的 `contextTokens`，全在 usage 的量纲上。校准比随本 run 最近一次 usage 走（`createCompactor`）。
// **固定开销单独算**（`fixedOverhead`）：usage 里还有工具 schema 与每轮注入，字符估里没有它们——不扣掉的话，
// 会话早期工具定义占了大头，校准比被抬到 3–4，之后每个大工具结果都乘它，真实占用约 1/3 窗口就触发压缩。

import type { CompactionReason, CompactionBudget, CompactionModelCall, CompactionState } from "./types.ts";
import {
  COMPACTION_GOAL_MAX_TOKENS,
  COMPACTION_SLACK_RATIO,
  DEFAULT_IDLE_CLEAR_MIN_TOKENS,
  DEFAULT_IDLE_CLEAR_MS,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_RESERVE_TOKENS,
  TOOL_RESULTS_STAGE,
} from "./types.ts";
import { probeCompaction } from "./observe.ts";
import { estimateText, estimateTokens, buildWorkingMessages, measureContext, normalizeCompaction, sameCompaction, type ContextAnchor } from "./view.ts";
import type { LoopDeps, TurnResult } from "../loop/types.ts";
import { clampDelay, sleep } from "../loop/backoff.ts";
import type { AgentMessage } from "../messages.ts";
import { agentError, errText } from "../errors.ts";
import { toolSchemas, type AgentTool } from "../tools/types.ts";

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

/**
 * 每次请求都带、却不在 system 与消息字符估里的固定开销：本轮菜单的工具 schema 与每轮注入。
 * 按字符估、**不乘校准比**——schema 是 JSON（ASCII 为主），chars/4 本来就准；乘上中文会话的校准比反而放大。
 */
export function fixedOverhead(tools: readonly AgentTool[], injections: readonly AgentMessage[]): number {
  return estimateText(JSON.stringify(toolSchemas(tools))) + estimateTokens(injections);
}

/** provider 报的真值 → 校准比：先扣掉固定开销，剩下的才是 system + 消息的真值，再与它们的字符估相比。 */
export function calibrationFrom(tokens: number, contentEstimate: number, overhead: number): number {
  return contentEstimate > 0 ? clampCalibration((tokens - overhead) / contentEstimate) : 1;
}

/** 此刻循环的固定开销：`getTools()` 是本轮菜单，每轮注入按它门控现算。 */
async function overheadNow(deps: LoopDeps): Promise<number> {
  const tools = deps.config.getTools();
  const injections = (await deps.config.getTurnInjections?.(new Set(tools.map((t) => t.name)))) ?? [];
  return fixedOverhead(tools, injections);
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
  const goal =
    reason === "overflow" ? Math.floor(window / 2) : Math.min(COMPACTION_GOAL_MAX_TOKENS, Math.max(0, target - Math.floor(window * COMPACTION_SLACK_RATIO)));
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
      // 撞上输出上限 = 正文是半截：当这一阶段失败（阶梯往下走 / 走应急），不拿截断的摘要顶替原文。不重试——同样的输入多半同样长
      if (final.stopReason === "max_tokens") throw Object.assign(new Error("model call hit its output limit; the reply is incomplete"), { code: "max_tokens" });
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
  /** `turnId`：撞窗应急时所在的 turn（轮首的自动压缩与手动压缩不在 turn 里，不给）。只用于观测记录的身份。 */
  opts: { reason: CompactionReason; instructions?: string; anchor: ContextAnchor | null; calibration?: number; turnId?: string },
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
  // 工具 schema 与每轮注入：usage 里有、字符估里没有，单独加，不乘校准比
  const overhead = await overheadNow(deps);
  let calibration = clampCalibration(opts.calibration ?? 1);
  let used: number;
  if (opts.anchor !== null) {
    used = measureContext({ messages: context.messages, state: context.compaction, systemPrompt: context.systemPrompt, anchor: opts.anchor, calibration });
    const r = raw(context.compaction);
    if (r > 0) calibration = calibrationFrom(used, r, overhead);
  } else {
    used = Math.ceil(raw(context.compaction) * calibration) + overhead;
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

  // 子循环的压缩不经 hooks（`LoopCompactionConfig.notifyHooks`）：不问、不报
  const viaHooks = config.compaction.notifyHooks !== false;
  const notify = async (event: Parameters<typeof config.hooks.notify>[0]): Promise<void> => {
    if (viaHooks) await config.hooks.notify(event, config.hookContext);
  };
  if (viaHooks) {
    const pre = await config.hooks.intercept({ type: "preCompact", reason }, config.hookContext);
    if (pre.decision === "block") return null;
  }

  const observe = deps.observe?.compaction;
  const where = { runId: config.runId, ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}) };
  probeCompaction(observe, where, { kind: "compaction_started", reason });
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
      probeCompaction(observe, where, { kind: "compaction_failed", reason, stage: stage.name, message: errText(e) });
      await notify({ type: "compactionFailed", reason, stage: stage.name, message: errText(e) });
      // compactionFailed 在官方产品里没人收（TUI 不显示、观测层不记）：再发一条壳与 serve 端都认的通用错误通知
      await notify({ type: "notification", kind: "error", message: `[compaction_stage_failed] ${stage.name}: ${errText(e)}` });
      continue;
    }
    if (sameCompaction(next, state)) continue;
    state = next;
    applied.push(stage.name);
    // 同一把尺子：字符估乘校准比、加固定开销，与触发时的 usage 同量纲
    used = Math.ceil(raw(state) * calibration) + overhead;
  }

  const changed = applied.length > 0;
  if (changed) context.compaction = state;
  else {
    probeCompaction(observe, where, { kind: "compaction_failed", reason, message: "no compaction stage changed the context" });
    await notify({ type: "compactionFailed", reason, message: "no compaction stage changed the context" });
    await notify({ type: "notification", kind: "error", message: "[compaction_stage_failed] no compaction stage changed the context" });
  }
  probeCompaction(observe, where, { kind: "compaction_ended", reason, compaction: state, stages: applied, contextTokens: used });
  await emit({ type: "compaction_end", reason, compaction: state, stages: applied, contextTokens: used });
  if (changed) await notify({ type: "postCompact", reason, compaction: state, stages: applied });
  return { changed, state, stages: applied, contextTokens: used };
}

/**
 * 空闲清理该不该做（2026-11-02，照 Claude Code 的空闲清理）。两道门都过才做：
 *   · **空闲**：最后一条助手回复到 `now` 超过 `DEFAULT_IDLE_CLEAR_MS`——provider 缓存多半已过期，改写前缀不多付钱；
 *   · **够量**：最近 `DEFAULT_KEEP_RECENT_TOOL_RESULTS` 批之前、还没清的旧工具结果，估计（乘校准比）至少 `DEFAULT_IDLE_CLEAR_MIN_TOKENS`。
 * 缓存热的时候不清：清掉一条旧结果，它之后的整段历史就要按未命中重付一次，往往比省下的多。
 */
export function idleClearDue(messages: readonly AgentMessage[], state: CompactionState, now: number, calibration = 1): boolean {
  let lastAssistantAt: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistantAt = messages[i]!.at;
      break;
    }
  }
  if (lastAssistantAt === null || now - lastAssistantAt < DEFAULT_IDLE_CLEAR_MS) return false;
  // 与清工具结果阶段同一个切点：从末尾数第 K 批带 tool_use 的 assistant，它之前的结果可清
  let seen = 0;
  let cut = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.content.some((b) => b.type === "tool_use") && ++seen === DEFAULT_KEEP_RECENT_TOOL_RESULTS) {
      cut = i;
      break;
    }
  }
  if (cut <= state.clearedBefore) return false;
  let tokens = 0;
  for (let i = state.clearedBefore; i < cut; i++) {
    const m = messages[i]!;
    if (m.role === "toolResult" && !state.spans.some((s) => s.from <= i && i < s.to)) tokens += estimateTokens([m]);
  }
  return Math.ceil(tokens * calibration) >= DEFAULT_IDLE_CLEAR_MIN_TOKENS;
}

/**
 * 一个 run 里的压缩簿记：provider 报的 usage 当基准并算校准比、应急只准一次。
 * 循环在轮首调 `maybeCompact()`、轮末调 `noteTurn()`、撞窗时调 `recover()`。
 */
export function createCompactor(deps: LoopDeps): {
  maybeCompact(): Promise<void>;
  noteTurn(turn: TurnResult): void;
  /** 撞窗应急：`turnId` 是撞窗的那个 turn。 */
  recover(turnId: string): Promise<boolean>;
} {
  let anchor: ContextAnchor | null = null;
  // 起点用 Agent 记住的上一次校准比：新 run 的首轮还没有 usage，裸字符估对中文会低估
  let calibration = clampCalibration(deps.config.compaction.calibration ?? 1);
  // 本轮的固定开销（轮首量一次，菜单本轮冻结）：轮末算校准比时从 usage 里扣掉
  let overhead = 0;
  let recovered = false;
  return {
    async maybeCompact() {
      overhead = await overheadNow(deps);
      const r = await runCompaction(deps, { reason: "auto", anchor, calibration });
      if (r !== null) {
        if (r.changed) anchor = null;
        return;
      }
      // 没碰窗口线：再看空闲清理该不该做（2026-11-02，照 Claude Code）。只在清旧工具结果的阶段注册着时才看
      if (!deps.config.compaction.getStages().some((s) => s.name === TOOL_RESULTS_STAGE)) return;
      const now = deps.config.compaction.now?.() ?? Date.now();
      if (!idleClearDue(deps.context.messages, deps.context.compaction, now, calibration)) return;
      const idle = await runCompaction(deps, { reason: "idle", anchor, calibration });
      if (idle?.changed === true) anchor = null;
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
      // 校准比：provider 说的真值扣掉固定开销，与同一份视图（system + 到那条 assistant 为止的投影）的字符估之比。
      // 记住它——压缩之后 anchor 作废、上一轮报错没 usage 时，字符估还能按本会话的语言密度换算。
      const raw = estimateText(deps.context.systemPrompt) + estimateTokens(buildWorkingMessages(deps.context.messages.slice(0, index), deps.context.compaction));
      if (raw > 0) calibration = calibrationFrom(tokens, raw, overhead);
    },
    async recover(turnId) {
      if (recovered) return false;
      recovered = true;
      const r = await runCompaction(deps, { reason: "overflow", anchor, calibration, turnId });
      if (r?.changed === true) anchor = null;
      return r?.changed === true;
    },
  };
}
