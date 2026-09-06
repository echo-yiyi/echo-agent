// run 与 reply——四层里靠外的两层（run ⊃ reply ⊃ turn ⊃ attempt，docs/design/run-loop-layers.md）。
//
//   run   = 一次 admission 到 agent_end，可含多条 reply
//   reply = agent 对**一条输入**的完整回应：输入来自 prompt / followUp / stop hook 注入之一，或从 transcript 续跑；
//           steer 不开新 reply，它并入正在进行的这条
//
// 两个入口只差第一条 reply 的来源，循环体共用 runLoop——**它是纯方法**：吃快照 + 装备 + 通道，
// 吐事件，不认识 Agent 类、不认识磁盘。评测直接打这里：给假 streamFn、给固定 messages，
// 同样输入必然同样事件序列。
//
// 每层只管自己的开与关：正常路径按序关，emit / hook / intake 自身坏了也由本层补发自己的 *_end 再上抛
// ——配对由结构保证，不靠外层补。
//
// 预算两把：maxIterations 是每条 reply 的 turn 上限，maxReplies 是每个 run 的 reply 上限；timeoutMs 是可选的墙钟，不承担总闸。

import { agentError, errText } from "../errors.ts";
import type { AgentOutcome } from "../events.ts";
import { userMessage, type AgentMessage, type AssistantMessage } from "../messages.ts";
import { createCompactor } from "../compaction/pipeline.ts";
import { replyIdOf } from "./ids.ts";
import { runTurn, type RunDeps } from "./run-turn.ts";
import type { AgentContext, AgentLoopConfig, Emit, LoopDeps, LoopResult, ReplySource, TurnCause } from "./types.ts";
import type { StreamFn } from "../provider/types.ts";

/** stop hook 最多把 agent 拉回来几次（决策记录 docs/decisions/proposed/2026-09-01-stop-continuation-limit.md）。 */
const MAX_STOP_CONTINUATIONS = 3;

type ReplyInput = { source: ReplySource; input: readonly AgentMessage[] };

export async function runAgentLoop(
  newMessages: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: Emit,
  signal: AbortSignal,
  streamFn: StreamFn,
): Promise<LoopResult> {
  return runLoop({ context, config, emit, signal, streamFn }, { source: "prompt", input: newMessages });
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
  return runLoop({ context, config, emit, signal, streamFn }, { source: "resume", input: [] });
}

/* ─────────────── run ─────────────── */

export async function runLoop(deps: LoopDeps, first: ReplyInput): Promise<LoopResult> {
  const { context, config, emit, signal } = deps;
  const before = context.messages.length;

  // **run deadline 是一个 signal，不只是轮首的一次比较。** 轮首那道闸管不到正在 turn 里等的东西——
  // 等人授权的 ask、卡住的 authorizer——`timeoutMs:10` 配上不超时的 ask，run 会永远回不到轮首（实测）。
  // 所以把 deadline 做成 AbortSignal，与调用方的 signal 合并后交给每一轮：轮内一切等待都受同一个 signal 控制。
  const deadline = config.timeoutMs !== undefined ? new AbortController() : undefined;
  const deadlineTimer =
    deadline !== undefined ? setTimeout(() => deadline.abort(new Error(`run 超时 ${config.timeoutMs}ms`)), config.timeoutMs) : undefined;
  const merged = deadline !== undefined ? AbortSignal.any([signal, deadline.signal]) : signal;
  const runDeps: RunDeps = {
    ...deps,
    signal: merged,
    callerSignal: signal,
    deadline: deadline?.signal,
    startedAt: Date.now(),
    // 压缩簿记（`compaction/pipeline.ts`）：轮首按阈值压、轮末记 provider 的 usage 当基准、撞窗后应急一次
    compactor: createCompactor({ ...deps, signal: merged }),
  };

  let outcome: AgentOutcome = { kind: "completed" };
  // loop 已 drain 出来、却没吸收进 transcript 的消息：随关门显式报出，不静默
  const leftovers = { steers: [] as AgentMessage[], followUps: [] as AgentMessage[] };
  let failure: { error: unknown } | null = null;
  try {
    await emit({ type: "agent_start" });

    let replies = 0;
    let stopContinuations = 0;
    let next: ReplyInput | null = first;
    while (next !== null) {
      replies += 1;
      const reply = await runReply(runDeps, replyIdOf(config.runId, replies), next.source, next.input);
      leftovers.steers.push(...reply.unconsumedSteers);
      next = null;
      if (reply.outcome.kind !== "completed") {
        outcome = reply.outcome;
        break;
      }
      /* 调用方要求体面收手 → 直接关门，不 drain、不问 stop hook（turn 里 accepted 的 steer 由关门时报出） */
      if (reply.stopped) break;

      if (replies < config.maxReplies) {
        /* 还有下一件事？ */
        const followUps = (await config.intake?.drainFollowUps()) ?? [];
        if (followUps.length > 0) {
          next = { source: "follow_up", input: followUps };
          continue;
        }
        /* 真要停了——最后问一次 stop 拦截点（排在队列之后：队列里是真实待办，它是策略兜底） */
        const verdict = await config.hooks.intercept({ type: "stop", iteration: reply.turns, finalText: reply.finalText }, config.hookContext);
        if (verdict.decision === "block" && stopContinuations < MAX_STOP_CONTINUATIONS) {
          stopContinuations += 1;
          next = { source: "stop_hook", input: [userMessage(verdict.reason ?? "The task is not finished yet. Continue.", "harness")] };
          continue;
        }
      }

      /* 关 run intake（RunIntakeGate）。「队列空」与「关门」是同一原子步——stop hook 等待期间
         到达并 accepted 的 followUp 不能凭空消失：关不上就说明有货。 */
      const late = (await config.intake?.tryCloseRun()) ?? null;
      if (late === null) break;
      if (replies < config.maxReplies) {
        next = { source: "follow_up", input: late };
        continue;
      }
      // 达 reply 上限且仍有待办：不再开 reply，待办显式报出，run 以 error 收场（与 max_iterations 同一态度）
      leftovers.followUps.push(...late);
      outcome = { kind: "error", error: agentError("internal", "max_replies", `reply 上限 ${config.maxReplies}`, false) };
      break;
    }
  } catch (e) {
    // 循环违约或 bug（attempt 内的抛出已被 runAttempt 折成 failed，这里剩下的是 emit / hook / intake 自身坏了）：
    // 仍然封口——关门三件事在 finally 里走完再上抛，Agent 据 agent_end 已发不再合成第二个
    failure = { error: e };
    outcome = { kind: "error", error: agentError("internal", "internal", errText(e), false) };
  } finally {
    // 关门三件事，**任何路径都走**：上一版只有 break outer 走得到，runTurn 抛出时 deadline timer 撑着 event loop
    // 到 timeoutMs 才退（实测）；closeRun 必须在 agent_end 之前——agent_end 的订阅者再 followUp() 得到的是
    // rejected，不是「accepted 随后被丢掉」的假 accepted
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    config.intake?.closeRun(leftovers);
    await emit({ type: "agent_end", outcome });
  }
  if (failure !== null) throw failure.error;
  return { outcome, messages: context.messages.slice(before) };
}

/* ─────────────── reply ─────────────── */

type ReplyEnd = {
  outcome: AgentOutcome;
  /** 最后一条落地消息；一条都没落地时 null。 */
  final: AssistantMessage | null;
  finalText: string;
  turns: number;
  /** `shouldStopAfterTurn` 叫停：run 直接关门，不 drain 也不问 stop hook。 */
  stopped: boolean;
  /** turn 交出但没吸收的 steer。 */
  unconsumedSteers: AgentMessage[];
};

async function runReply(deps: RunDeps, replyId: string, source: ReplySource, input: readonly AgentMessage[]): Promise<ReplyEnd> {
  const { context, config, emit, callerSignal, deadline, compactor } = deps;
  await emit({ type: "reply_start", replyId, source });

  let n = 0;
  let final: AssistantMessage | null = null;
  let outcome: AgentOutcome = { kind: "completed" };
  let stopped = false;
  const unconsumedSteers: AgentMessage[] = [];
  let cause: TurnCause = "input";
  let ended = false;
  try {
    // 输入消息的 message_end 紧挨在它引发的 turn_start 之前（中间只可能有轮首压缩的 compaction_*）
    await absorb(context, input, emit);

    for (;;) {
      /* 硬闸：三条都在轮首集中判 */
      if (callerSignal.aborted) {
        outcome = { kind: "aborted" };
        break;
      }
      if (fired(deadline)) {
        outcome = await timedOut(deps);
        break;
      }
      if (n >= config.maxIterations) {
        outcome = { kind: "error", error: agentError("internal", "max_iterations", `迭代上限 ${config.maxIterations}`, false) };
        break;
      }

      /* 压缩在轮边界上做，不把一轮劈成两半 */
      await compactor.maybeCompact();

      n += 1;
      const turn = await runTurn(deps, replyId, n, cause);
      compactor.noteTurn(turn);

      // deadline 在轮内到了：轮内的等待已被它中止，这里按超时封口（不是「aborted」——调用方没有取消）
      if (fired(deadline) && !callerSignal.aborted) {
        unconsumedSteers.push(...turn.steers);
        outcome = await timedOut(deps);
        break;
      }
      if (turn.result.kind !== "landed") {
        unconsumedSteers.push(...turn.steers);
        outcome =
          turn.result.kind === "failed"
            ? { kind: "error", error: turn.result.error }
            : turn.result.kind === "blocked"
              ? // hook 在送模前说「别发」：不是用户取消、不是错误，是明确的 aborted（reason 透传给 agent_end 的读者）
                { kind: "aborted", reason: turn.result.reason ?? "contextBeforeBuild blocked the turn" }
              : { kind: "aborted" };
        break;
      }
      final = turn.result.message;

      /* ① 模型还要工具 / ①b 输出被截断（截断不是失败，让模型接着写）→ 继续。
         本 turn 交出的 steer 一并并入——「跑的中途插话 → 下一圈开头」 */
      const stop = final.stopReason;
      if (stop === "tool_use" || stop === "max_tokens") {
        await absorb(context, turn.steers, emit);
        cause = stop;
        continue;
      }

      /* ② 调用方要求体面收手 → 不吸收 steer（关门时报出） */
      if ((await config.shouldStopAfterTurn?.({ iteration: n, message: final })) === true) {
        unconsumedSteers.push(...turn.steers);
        stopped = true;
        break;
      }

      /* ③ 轮末换装：下一轮的 model / thinking / systemPrompt */
      const update = await config.prepareNextTurn?.({ iteration: n, message: final, messages: context.messages });
      if (update !== undefined) {
        if (update.model !== undefined) config.model = update.model;
        if (update.thinkingLevel !== undefined) config.thinkingLevel = update.thinkingLevel;
        if (update.systemPrompt !== undefined) context.systemPrompt = update.systemPrompt;
      }

      /* ④ 有人插话 → 并入，继续干 */
      if (turn.steers.length > 0) {
        await absorb(context, turn.steers, emit);
        cause = "steer";
        continue;
      }

      break; // settle：这件事干完了
    }

    ended = true;
    await emit({ type: "reply_end", replyId, outcome, final, turns: n });
    return { outcome, final, finalText: final === null ? "" : textOf(final), turns: n, stopped, unconsumedSteers };
  } catch (e) {
    // emit / hook / intake 自身坏了：reply 仍由本层关，再上抛（run 的 finally 接着关门）
    if (!ended) {
      ended = true;
      await emit({ type: "reply_end", replyId, outcome: { kind: "error", error: agentError("internal", "internal", errText(e), false) }, final, turns: n });
    }
    throw e;
  }
}

/** `signal.aborted` 是会变的 getter；经函数读，避免 TS 在一次 `=== true` 判断后把它收窄成 false。 */
function fired(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

async function timedOut(deps: RunDeps): Promise<AgentOutcome> {
  const { config } = deps;
  const elapsedMs = Date.now() - deps.startedAt;
  await config.hooks.notify({ type: "agentTimeout", elapsedMs, timeoutMs: config.timeoutMs as number }, config.hookContext);
  return { kind: "error", error: agentError("internal", "timeout", `超时 ${elapsedMs}ms`, false) };
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

function textOf(m: AssistantMessage): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
