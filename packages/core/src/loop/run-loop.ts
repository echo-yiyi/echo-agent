// 外层与内层。设计见 docs/design/AGENT-CORE.md §3。
//
//   内层 = agent **还在工作**：它自己要工具、输出被截断、或有人插话
//   外层 = agent **已经停下，但被交了新的活**：followUp，或 stop 被拦
//
// 两个入口只差准备工作，循环体共用 runLoop——**它是纯方法**：吃快照 + 装备 + 通道，
// 吐事件，不认识 Agent 类、不认识磁盘。评测直接打这里：给假 streamFn、给固定 messages，
// 同样输入必然同样事件序列。

import { agentError, type AgentError } from "../errors.ts";
import type { AgentOutcome } from "../events.ts";
import { userMessage, type AgentMessage } from "../messages.ts";
import { ContextBuildBlocked, runTurn } from "./run-turn.ts";
import type { AgentContext, AgentLoopConfig, Emit, LoopDeps, LoopResult, TurnResult } from "./types.ts";
import type { StreamFn } from "../provider/types.ts";

const MAX_STOP_CONTINUATIONS = 3;

export async function runAgentLoop(
  newMessages: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: Emit,
  signal: AbortSignal,
  streamFn: StreamFn,
): Promise<LoopResult> {
  for (const m of newMessages) {
    context.messages.push(m);
    await emit({ type: "message_end", message: m });
  }
  return runLoop({ context, config, emit, signal, streamFn });
}

/** 从现有 transcript 续跑：末条必须是 user 或 toolResult（assistant 之后无从续起）。 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: Emit,
  signal: AbortSignal,
  streamFn: StreamFn,
): Promise<LoopResult> {
  const last = context.messages[context.messages.length - 1];
  if (last === undefined) throw new Error("没有可续跑的消息");
  if (last.role === "assistant") throw new Error("末条是 assistant，无从续跑（请先 prompt 或入队消息）");
  return runLoop({ context, config, emit, signal, streamFn });
}

export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const { context, config, emit, signal } = deps;
  const startedAt = Date.now();
  const before = context.messages.length;

  // **run deadline 是一个 signal，不只是轮首的一次比较。** 轮首那道闸管不到正在 runTurn 里等的东西——
  // 等人授权的 ask、卡住的 authorizer——`timeoutMs:10` 配上不超时的 ask，run 会永远回不到轮首（实测）。
  // 所以把 deadline 做成 AbortSignal，与调用方的 signal 合并后交给每一轮：轮内一切等待都受同一个 signal 控制。
  const deadline = config.timeoutMs !== undefined ? new AbortController() : undefined;
  const deadlineTimer =
    deadline !== undefined ? setTimeout(() => deadline.abort(new Error(`run 超时 ${config.timeoutMs}ms`)), config.timeoutMs) : undefined;
  const turnDeps: LoopDeps = deadline !== undefined ? { ...deps, signal: AbortSignal.any([signal, deadline.signal]) } : deps;

  await emit({ type: "agent_start" });

  let iteration = 0;
  let retryCount = 0;
  let stopContinuations = 0;
  let outcome: AgentOutcome = { kind: "completed" };

  outer: while (true) {
    inner: while (true) {
      /* 硬闸：三条都在轮首集中判 */
      if (signal.aborted) {
        outcome = { kind: "aborted" };
        break outer;
      }
      if (iteration >= config.maxIterations) {
        outcome = { kind: "error", error: agentError("internal", "max_iterations", `迭代上限 ${config.maxIterations}`, false) };
        break outer;
      }
      if (config.timeoutMs !== undefined && Date.now() - startedAt >= config.timeoutMs) {
        const elapsedMs = Date.now() - startedAt;
        await config.hooks.notify({ type: "agentTimeout", elapsedMs, timeoutMs: config.timeoutMs }, config.hookContext);
        outcome = { kind: "error", error: agentError("internal", "timeout", `超时 ${elapsedMs}ms`, false) };
        break outer;
      }

      /* 压缩在轮边界上做，不把一轮劈成两半 */
      await maybeCompact(deps);

      iteration += 1;
      let turn: TurnResult;
      try {
        turn = await runTurn(turnDeps, iteration);
      } catch (e) {
        if (!(e instanceof ContextBuildBlocked)) throw e;
        // hook 在送模前说「别发」：不是用户取消、不是错误，是明确的 aborted（reason 透传给 agent_end 的读者）
        outcome = { kind: "aborted", reason: e.reason ?? "contextBeforeBuild blocked the turn" };
        break outer;
      }
      // deadline 在轮内到了：轮内的等待已被它中止，这里按超时封口（不是「aborted」——调用方没有取消）
      if (deadline?.signal.aborted === true && !signal.aborted) {
        const elapsedMs = Date.now() - startedAt;
        await config.hooks.notify({ type: "agentTimeout", elapsedMs, timeoutMs: config.timeoutMs as number }, config.hookContext);
        outcome = { kind: "error", error: agentError("internal", "timeout", `超时 ${elapsedMs}ms`, false) };
        break outer;
      }

      /* 失败：可重试且额度未尽 → **重跑本轮**（消耗 retryCount，不消耗 iteration） */
      if (turn.stopReason === "error") {
        const err = turn.message.error ?? agentError("provider", "internal", "未标注的失败", false);
        if (err.retryable && retryCount < config.retryPolicy.maxAttempts) {
          retryCount += 1;
          const delayMs = config.retryPolicy.backoffMs(retryCount);
          await emit({
            type: "retry_scheduled",
            attempt: retryCount,
            maxAttempts: config.retryPolicy.maxAttempts,
            delayMs,
            cause: err.code,
          });
          await sleep(delayMs);
          iteration -= 1;
          continue inner;
        }
        outcome = { kind: "error", error: err };
        break outer;
      }
      if (turn.stopReason === "aborted") {
        outcome = { kind: "aborted" };
        break outer;
      }
      retryCount = 0; // 成功一轮即清零

      const decision = await decideAfterTurn(turn, context, config, iteration, emit);
      if (decision.action === "continue") continue inner;
      if (decision.action === "stop") break outer;
      break inner; // settle：这件事干完了
    }

    /* 外层：还有下一件事？ */
    const followUps = (await config.intake?.drainFollowUps()) ?? [];
    if (followUps.length > 0) {
      await absorb(context, followUps, emit);
      continue outer;
    }

    /* 真要停了——最后问一次 stop 拦截点（排在队列之后：队列里是真实待办，它是策略兜底） */
    const finalText = lastText(context);
    const verdict = await config.hooks.intercept({ type: "stop", iteration, finalText }, config.hookContext);
    if (verdict.decision === "block" && stopContinuations < MAX_STOP_CONTINUATIONS) {
      stopContinuations += 1;
      const injected = userMessage(verdict.reason ?? "The task is not finished yet. Continue.", "harness");
      context.messages.push(injected);
      await emit({ type: "message_end", message: injected });
      continue outer; // 注入即「又给了一件事」，回内层
    }

    /* 真要停了：关 run intake（§14 RunIntakeGate）。「队列空」与「关门」是同一原子步——stop hook 等待期间
       到达并 accepted 的 followUp 不能凭空消失：关不上就说明有货，消费掉再回内层。 */
    const late = (await config.intake?.tryCloseRun()) ?? null;
    if (late !== null) {
      await absorb(context, late, emit);
      continue outer;
    }
    break outer;
  }

  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  // run 关门（§14 RunIntakeGate）**必须在 agent_end 之前**：abort / error / 超时 / 轮数用尽 / shouldStopAfterTurn
  // 各条 break outer 都经这里。上一版关门在 runWithLifecycle 的 finally——agent_end 的订阅者 followUp() 拿到
  // accepted、随后被 [queue_dropped] 丢掉，等于对一个已结束的 run 返回假 accepted（实测）。正常收尾时门已在
  // tryCloseRun 关上，这里 no-op。
  config.intake?.closeRun();
  await emit({ type: "agent_end", outcome });
  return { outcome, messages: context.messages.slice(before) };
}

/* ─────────────── 轮末决策：四步收进一个方法 ─────────────── */

export type AfterTurnDecision =
  | { action: "continue" } // 继续内层
  | { action: "settle" } // 出内层，去外层问 followUp
  | { action: "stop" }; // 两层都出

export async function decideAfterTurn(
  turn: TurnResult,
  context: AgentContext,
  config: AgentLoopConfig,
  iteration: number,
  emit: Emit,
): Promise<AfterTurnDecision> {
  /* ① 模型还要工具 → 继续干。本 turn accepted 的 steer 在关 turn 时一并并入——「跑的中途插话 → 下一圈开头」，
     accepted 的 steer 必须在它所属的 turn 关门前消费（§14 RunIntakeGate），不攒到某个收尾的轮才捞 */
  if (turn.stopReason === "tool_use") {
    await absorb(context, (await config.intake?.closeTurn()) ?? [], emit);
    return { action: "continue" };
  }

  /* ①b 输出被截断 → **可续跑**：截断不是失败，让模型接着写（受同一个 iteration 闸约束） */
  if (turn.stopReason === "max_tokens") {
    await absorb(context, (await config.intake?.closeTurn()) ?? [], emit);
    return { action: "continue" };
  }

  /* ② 调用方要求体面收手 → 两层都出，且不捞任何队列（turn 里 accepted 的 steer 由 run 关门时显式报出） */
  if ((await config.shouldStopAfterTurn?.({ iteration, message: turn.message })) === true) {
    return { action: "stop" };
  }

  /* ③ 轮末换装：下一轮的 model / thinking / systemPrompt */
  const update = await config.prepareNextTurn?.({ iteration, message: turn.message, messages: context.messages });
  if (update !== undefined) {
    if (update.model !== undefined) config.model = update.model;
    if (update.thinkingLevel !== undefined) config.thinkingLevel = update.thinkingLevel;
    if (update.systemPrompt !== undefined) context.systemPrompt = update.systemPrompt;
  }

  /* ④ 关 turn：有人插话 → 并入，继续干。 */
  const steering = (await config.intake?.closeTurn()) ?? [];
  if (steering.length > 0) {
    await absorb(context, steering, emit);
    return { action: "continue" };
  }

  return { action: "settle" };
}

/**
 * 队列消息并入 context。**每条进入 transcript 的消息都要发 message_end**——否则循环的 context 与
 * Agent 的 messages 就分叉了（实测踩到过：插话真的并入了循环，却没进 transcript）。
 */
async function absorb(context: AgentContext, messages: readonly AgentMessage[], emit: Emit): Promise<void> {
  for (const m of messages) {
    context.messages.push(m);
    await emit({ type: "message_end", message: m });
  }
}

/* ─────────────── 压缩：轮边界上的一次模型调用 ─────────────── */

async function maybeCompact(deps: LoopDeps): Promise<void> {
  const { context, config, emit, signal } = deps;
  const summarize = config.compaction.summarize;
  if (summarize === undefined) return;

  const budget = config.compaction.budget ?? config.model.capabilities?.contextWindow;
  if (budget === undefined) return;
  if (estimateTokens(context.messages) <= budget) return;

  const pre = await config.hooks.intercept({ type: "preCompact", reason: "auto" }, config.hookContext);
  if (pre.decision === "block") return;

  await emit({ type: "compaction_start", reason: "auto" });
  try {
    const summary = await summarize(context.messages, signal);
    const coveredUpTo = String(context.messages.length);
    await emit({ type: "compaction_end", summary, coveredUpTo });
    await config.hooks.notify({ type: "postCompact", summary, coveredUpTo }, config.hookContext);
  } catch (e) {
    // 压缩失败不该杀掉整个任务：如实告警，让这一轮照常发出去（超预算由模型端报错兜底）。
    await config.hooks.notify(
      { type: "compactionFailed", message: e instanceof Error ? e.message : String(e) },
      config.hookContext,
    );
  }
}

/** 粗估：4 字符 ≈ 1 token（CJK 更密，这里保守）。真实预算由 provider 的 usage 校准，见待办。 */
export function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if ("content" in m) chars += JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

function lastText(context: AgentContext): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m !== undefined && m.role === "assistant") {
      return m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
    }
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type { AgentError };
