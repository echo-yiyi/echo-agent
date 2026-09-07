// turn 与 attempt——四层里靠里的两层（run ⊃ reply ⊃ turn ⊃ attempt，docs/design/run-loop-layers.md）。
//
//   turn    = reply 里的一次迭代：调一次模型、处理它落地的响应及其工具批。一个 turn **至多一条落地的** assistant 消息。
//   attempt = turn 里的一次模型请求：一次完整的上下文构建 + 一次 streamFn。**重试 = 同一 turn 的下一个 attempt**。
//
// 每层只管自己的开与关：turn 开一次（openTurn / turn_start）、关一次（closeTurn / turn_end），重试不重开；
// attempt 的 start / end 永远成对——contextBeforeBuild 说 block 也是一个 attempt_end{blocked}，不用异常出去；
// streamFn / 投影 / hook 违约抛了也是一个 attempt_end{failed}。配对由结构保证，不靠外层补。
//
// 一条贯穿全文件的规则:**每条进入 transcript 的消息都发一个 message_end 事件**
// （助手消息之前还有 start/update）——这样 Agent 侧只需要一条 append 路径，
// 「state = apply(state, event)」对每条消息都成立。
//
// 另一条:**本轮的工具与 hook 在开头定格**。模型看到的菜单、执行到的对象、
// 拦截它的 handler，整轮（每个 attempt）是同一份；中途的注册/卸载/替换全部归下一轮。

import { agentError, errText } from "../errors.ts";
import type { createCompactor } from "../compaction/pipeline.ts";
import type { HookWorkset } from "../hooks/runtime.ts";
import { deepFreezePlain, normalizeVerdict } from "../permission/ledger.ts";
import type { PermissionVerdict } from "../permission/types.ts";
import type { AgentMessage, ToolResultMessage, ToolUseBlock } from "../messages.ts";
import { toolResultMessage, toolUsesFromMessage } from "../messages.ts";
import { isModelVisible, toolSchemas, type AgentTool, type AgentToolResult, type McpTool, type ModelTool } from "../tools/types.ts";
import { buildWorkingMessages } from "../compaction/view.ts";
import { turnIdOf } from "./ids.ts";
import type { AgentLoopConfig, AttemptResult, Emit, LoopDeps, TurnCause, TurnResult } from "./types.ts";

type Compactor = ReturnType<typeof createCompactor>;

/** run 内三层共用的依赖：LoopDeps 之外多了 run 级的东西（由 runLoop 建一次）。`signal` 已与 deadline 合并。 */
export type RunDeps = LoopDeps & {
  /** 调用方的 signal（未与 deadline 合并）：reply 靠它区分「调用方取消」与「run 超时」。 */
  readonly callerSignal: AbortSignal;
  /** run 的 deadline signal；没配 timeoutMs 就没有。 */
  readonly deadline: AbortSignal | undefined;
  readonly startedAt: number;
  readonly compactor: Compactor;
};

/** 本轮工作集：开头冻一次，整轮只看它。 */
type TurnWorkset = {
  /** 摆给模型、也是唯一会被执行的工具对象。 */
  readonly tools: readonly AgentTool[];
  /** 本轮开始时池里的全部名字（含禁用的）——只用来决定「要不要去问原因」。 */
  readonly knownToolNames: ReadonlySet<string>;
  readonly hooks: HookWorkset;
};

export async function runTurn(deps: RunDeps, replyId: string, n: number, cause: TurnCause): Promise<TurnResult> {
  const { context, config, emit, signal } = deps;
  const turnId = turnIdOf(replyId, n);

  /* ⓪ 定格本轮工作集：hook 条目与工具对象在此刻冻结。
     **必须在 turn_start 事件之前**：AgentEvent listener 是被 await 的，订阅者收到 turn_start 就能注册/卸载
     Tool 或 Hook——先发事件再冻结，那些改动就混进了已经宣布开始的这一轮。 */
  const workset: TurnWorkset = {
    tools: config.getTools(),
    knownToolNames: new Set(config.knownToolNames()),
    hooks: config.hooks.snapshot(),
  };
  // turn 开门（RunIntakeGate）：同样在 turn_start 之前——订阅者收到 turn_start 就能 steer()
  config.intake?.openTurn(turnId);
  await emit({ type: "turn_start", turnId, replyId, cause });

  const toolResults: ToolResultMessage[] = [];
  let ended = false;
  try {
    /* ① attempt 循环：落地或放弃。一个 turn 最多 maxAttempts 个 attempt，不分原因 */
    const { maxAttempts } = config.retryPolicy;
    let attempt = 0;
    let result: AttemptResult;
    for (;;) {
      // 取消路径：backoff 被 signal 提前结束（或开圈前就已中止）→ 不再发起 attempt，turn 以 aborted 收场
      if (signal.aborted) {
        result = { kind: "aborted" };
        break;
      }
      attempt += 1;
      result = await runAttempt(deps, turnId, attempt, workset);
      if (result.kind !== "failed") break;
      const err = result.error;
      await workset.hooks.notify({ type: "modelCallFailed", error: err, attempt }, config.hookContext);
      if (attempt >= maxAttempts) break;
      // 撞窗（provider 说上下文超了）：**应急压缩一次**再来一个 attempt。压不动 / 第二次撞 → 按失败收场。
      // 它不是重试（上下文变了），所以不发 retry_scheduled——压缩事件已说明原因
      if (err.code === "context_overflow") {
        if (await deps.compactor.recover()) continue;
        break;
      }
      if (!err.retryable) break;
      const next = attempt + 1;
      const delayMs = clampDelay(config.retryPolicy.backoffMs(attempt), config.maxRetryDelayMs);
      await emit({ type: "retry_scheduled", turnId, attempt: next, maxAttempts, delayMs, cause: err.code });
      await workset.hooks.notify({ type: "retryScheduled", attempt: next, maxAttempts, delayMs, cause: err.code }, config.hookContext);
      await sleep(delayMs, signal);
    }

    /* ② 工具批：只在落地后 */
    if (result.kind === "landed") {
      for (const use of toolUsesFromMessage(result.message)) {
        const msg = await runOneTool(use, deps, turnId, n, workset);
        context.messages.push(msg);
        await emit({ type: "message_end", message: msg });
        toolResults.push(msg as ToolResultMessage);
        if (signal.aborted) break; // 批中断：已跑完的保留，剩下的不跑
      }
    }

    /* ③ 关 turn：gate 的 turn 边界与事件的 turn 边界重合。交出的 steer 由 reply 决定吸收 */
    const steers = (await config.intake?.closeTurn()) ?? [];
    ended = true;
    await emit({ type: "turn_end", turnId, result, toolResults });
    return { turnId, result, toolResults, steers };
  } catch (e) {
    // emit / hook / intake 自身坏了：turn 仍由本层关——turn_end 不靠外层补。gate 里的 turn 不在这关，
    // 留给 run 关门（closeRun）连同它 accepted 的 steer 一起报出
    if (!ended) {
      ended = true;
      await emit({ type: "turn_end", turnId, result: { kind: "failed", error: agentError("internal", "internal", errText(e), false) }, toolResults });
    }
    throw e;
  }
}

/* ─────────────────── attempt ─────────────────── */

/** 一个 attempt 内 assistant 消息事件的进度：抛出时据此补齐 message_start / message_end，保成对。 */
type MessageProgress = { opened: boolean; ended: boolean };

async function runAttempt(deps: RunDeps, turnId: string, attempt: number, workset: TurnWorkset): Promise<AttemptResult> {
  const { context, emit } = deps;
  await emit({ type: "attempt_start", turnId, attempt });
  const progress: MessageProgress = { opened: false, ended: false };
  let ended = false;
  try {
    let result: AttemptResult;
    try {
      result = await callModel(deps, workset, progress);
    } catch (e) {
      // streamFn / 投影 / hook 违约抛出：仍是一次失败的 attempt——不让异常击穿 turn，配对由结构保证。
      // 与 dialect 的「stream 不许 throw」同一态度：throw 只留给 bug，bug 也要有形状。
      const error = agentError("internal", "internal", errText(e), false);
      if (!progress.ended) {
        if (!progress.opened) await emit({ type: "message_start", role: "assistant" });
        const failure: AgentMessage = { role: "assistant", content: [], stopReason: "error", usage: null, error, at: Date.now() };
        context.messages.push(failure);
        await emit({ type: "message_end", message: failure });
      }
      result = { kind: "failed", error };
    }
    ended = true;
    await emit({ type: "attempt_end", turnId, attempt, result });
    return result;
  } catch (e) {
    // 连补失败消息的 emit 都坏了：attempt 仍由本层关，再上抛
    if (!ended) {
      ended = true;
      await emit({ type: "attempt_end", turnId, attempt, result: { kind: "failed", error: agentError("internal", "internal", errText(e), false) } });
    }
    throw e;
  }
}

async function callModel(deps: RunDeps, workset: TurnWorkset, progress: MessageProgress): Promise<AttemptResult> {
  const { context, config, emit, signal, streamFn } = deps;
  const { tools, hooks } = workset;

  /* ① AgentMessage 层变换。先按压缩状态投影 transcript（段 → 摘要、旧工具结果 → 占位；transcript 本身不动），
     再拼每轮注入（激活 skill 正文，末尾、不进 transcript），
     再过 transformContext 与 contextBeforeBuild——上层能看到注入后的全貌，有最终话语权。
     注入的**工具门控读本轮冻结的工具集**（与模型菜单同一份快照）：turn_start 里才注册的工具，
     菜单里没有，注入也不许提——否则末尾一段清单要模型用一个它这轮点不到的工具。 */
  const visibleTools: ReadonlySet<string> = new Set(tools.map((t) => t.name));
  const injections = (await config.getTurnInjections?.(visibleTools)) ?? [];
  let working: AgentMessage[] = buildWorkingMessages(context.messages, context.compaction);
  if (injections.length > 0) working.push(...injections);
  if (config.transformContext !== undefined) {
    working = await config.transformContext(working, signal);
  }
  if (hooks.has("contextBeforeBuild")) {
    const r = await hooks.intercept({ type: "contextBeforeBuild", messages: working }, config.hookContext);
    // block = 这个 attempt 不发：没有 assistant 消息可挂，什么都没说过账本里就不该有一条
    if (r.decision === "block") return { kind: "blocked", ...(r.reason !== undefined ? { reason: r.reason } : {}) };
    working = r.event.messages;
  }

  /* ② 投影：AgentMessage → 线上形状（唯一一道翻译） */
  const llmMessages = await config.convertToLlm(working);

  /* ③ 每次重解析 key（短命 token 会在长工具阶段中途过期） */
  const apiKey = await config.getApiKey?.(config.model.provider);

  /* ④ 调模型 + 消费协议（占槽逐字） */
  const stream = await streamFn(
    config.model,
    { systemPrompt: context.systemPrompt, messages: llmMessages, tools: toolSchemas(tools) },
    { signal, apiKey, thinkingLevel: config.thinkingLevel },
  );

  for await (const item of stream) {
    if (item.type === "start") {
      progress.opened = true;
      await emit({ type: "message_start", role: "assistant" });
      continue;
    }
    await emit({ type: "message_update", delta: item, message: item.partial });
  }

  // **入账取权威定稿，不是槽里自己攒的 partial**——拿槽当定稿会被重放/丢包污染。
  const final = await stream.result();
  // 退化路径：违约或无流式后端没发过 start，补一个，保「每个定稿消息必有成对 start/end」。
  if (!progress.opened) {
    progress.opened = true;
    await emit({ type: "message_start", role: "assistant" });
  }

  const finalMsg = { ...final, at: Date.now() };
  context.messages.push(finalMsg);
  progress.ended = true;
  await emit({ type: "message_end", message: finalMsg });
  if (final.usage !== null) await emit({ type: "usage", usage: final.usage });

  if (final.stopReason === "error") return { kind: "failed", error: final.error ?? agentError("provider", "internal", "未标注的失败", false) };
  if (final.stopReason === "aborted") return { kind: "aborted" };
  return { kind: "landed", message: finalMsg };
}

/* ─────────────────── 单次工具调用 ─────────────────── */

async function runOneTool(
  use: ToolUseBlock,
  deps: RunDeps,
  turnId: string,
  iteration: number,
  workset: TurnWorkset,
): Promise<AgentMessage> {
  const { config, emit, signal } = deps;
  const { tools, hooks } = workset;
  // **只在本轮快照里找**。找不到的名字只拿一个准确原因回给模型，绝不从实时池里捞对象来执行。
  const tool = tools.find((t) => t.name === use.name);
  if (tool === undefined) {
    const reason = explainMissingTool(config, workset.knownToolNames, use.name);
    await notify(hooks, config, { type: "toolUseFailed", toolCallId: use.id, toolName: use.name, cause: "not_found", message: reason });
    return toolResultMessage(use.id, use.name, reason, true);
  }
  if (!isModelVisible(tool)) {
    // 存在但不是模型可调的（InternalTool 不上模型菜单，模型不该点它的名）
    const reason = `Tool '${use.name}' is not available to the model`;
    await notify(hooks, config, { type: "toolUseFailed", toolCallId: use.id, toolName: use.name, cause: "not_found", message: reason });
    return toolResultMessage(use.id, use.name, reason, true);
  }

  /* 修参归一，随即冻结：交给 hook 的是**不可原地修改的快照**。
     - hook 想改参数只能返回 patch（新对象）；原地改会在严格模式下抛，preToolUse 是 fail-closed 档 → 拦下；
     - 因此不需要「无条件二次 prepare」来防原地改写——prepareArguments 的契约是 raw → TParams，不承诺幂等，
       第二次喂它自己的输出会把合法 normalizer 打坏（实测）。只有 hook 返回了新对象才对那份重跑一次；
     - 冻不住的（class 实例 / Map / Set / Date / 函数 / TypedArray）直接拒——不能原样放行。 */
  let params: Record<string, unknown>;
  try {
    params = deepFreezePlain(prepare(tool, use.input));
  } catch (e) {
    const message = `Invalid arguments: ${errText(e)}`;
    await notify(hooks, config, { type: "toolUseFailed", toolCallId: use.id, toolName: use.name, cause: "bad_params", message });
    return toolResultMessage(use.id, use.name, message, true);
  }

  /* preToolUse 拦截：block 短路；patch（返回了新对象）后**必须重跑修参**（否则等于绕过校验） */
  const pre = await hooks.intercept(
    { type: "preToolUse", toolCallId: use.id, toolName: use.name, params },
    config.hookContext,
  );
  if (pre.decision === "block") {
    const reason = pre.reason ?? "Blocked by a hook";
    await notify(hooks, config, { type: "toolUseDenied", toolCallId: use.id, toolName: use.name, by: "hook", reason });
    return toolResultMessage(use.id, use.name, reason, true);
  }
  if (pre.event.params !== params) {
    try {
      params = deepFreezePlain(prepare(tool, pre.event.params));
    } catch (e) {
      const message = `Arguments rewritten by a hook are invalid: ${errText(e)}`;
      await notify(hooks, config, { type: "toolUseFailed", toolCallId: use.id, toolName: use.name, cause: "bad_params", message });
      return toolResultMessage(use.id, use.name, message, true);
    }
  }

  /* authorization（固定 stage）：参数已冻结，从这里起不可再改；authorization 只能决定。
     ask 里的 params、宿主看到的 params、execute 收到的 params 是**同一份**冻结对象。
     authInput 自身也冻：policy 若 `input.params = 另一份`，在 ESM 严格模式下当场抛 → 下面按 fail-closed 拒。
     turnId 是 loop 产的那一个（`ids.ts`），permission 与观测引用同一份。 */
  const authInput = Object.freeze({
    runId: config.runId,
    turnId,
    toolCallId: use.id,
    toolName: use.name,
    params,
  });
  let verdict: PermissionVerdict;
  try {
    // authorizer 也受 run signal 管：永不 resolve 的 authorize() 不能拖住 abort/超时（实测）
    const raw = await raceAbort(Promise.resolve(config.permission.authorize(authInput)), signal);
    if (raw.kind === "aborted") {
      const message = "The run was aborted while waiting for authorization";
      await notify(hooks, config, { type: "toolUseFailed", toolCallId: use.id, toolName: use.name, cause: "aborted", message });
      return toolResultMessage(use.id, use.name, message, true);
    }
    // 循环不信任任何 PermissionStage 实现：这里再验一次形（Agent 的 stage 也验，两道都是 fail-closed）
    verdict = normalizeVerdict(raw.value);
  } catch (e) {
    verdict = { kind: "deny", reason: `authorization threw (denied, fail-closed): ${errText(e)}` }; // 抛错 = 拒，不放行
  }
  if (verdict.kind === "ask") {
    // 只有真正进入 ask 才有 permissionId：先登记 ledger，再恰好发一次带同一 ID 的 permissionRequest
    const handle = config.permission.ask({ ...authInput, reason: verdict.reason }, signal);
    await notify(hooks, config, { type: "permissionRequest", permissionId: handle.permissionId, ...authInput, reason: verdict.reason });
    await notify(hooks, config, {
      type: "notification",
      kind: "waiting_permission",
      permissionId: handle.permissionId,
      message: `等待授权：${use.name}（${verdict.reason}）`,
    });
    const settled = await handle.settled;
    if (settled.kind === "cancelled") {
      await notify(hooks, config, { type: "permissionCancelled", permissionId: handle.permissionId, toolCallId: use.id, reason: settled.reason });
      const message = `Aborted while waiting for approval (${settled.reason})`;
      await notify(hooks, config, { type: "toolUseFailed", toolCallId: use.id, toolName: use.name, cause: "aborted", message });
      return toolResultMessage(use.id, use.name, message, true);
    }
    if (settled.kind === "deny") {
      await notify(hooks, config, {
        type: "permissionDenied",
        permissionId: handle.permissionId,
        toolCallId: use.id,
        toolName: use.name,
        reason: settled.reason,
        decidedBy: settled.decidedBy,
      });
      await notify(hooks, config, { type: "toolUseDenied", toolCallId: use.id, toolName: use.name, by: "permission", reason: settled.reason });
      return toolResultMessage(use.id, use.name, settled.reason, true);
    }
    await notify(hooks, config, { type: "permissionGranted", permissionId: handle.permissionId, toolCallId: use.id, decidedBy: "human" });
  } else if (verdict.kind === "deny") {
    await notify(hooks, config, { type: "permissionDenied", toolCallId: use.id, toolName: use.name, reason: verdict.reason, decidedBy: "policy" });
    await notify(hooks, config, { type: "toolUseDenied", toolCallId: use.id, toolName: use.name, by: "permission", reason: verdict.reason });
    return toolResultMessage(use.id, use.name, verdict.reason, true);
  } else {
    await notify(hooks, config, { type: "permissionGranted", toolCallId: use.id, decidedBy: "policy" });
  }

  await emit({ type: "tool_execution_start", toolCallId: use.id, toolName: use.name, params });

  /* 执行。铁律说 execute 绝不 reject，但工具由调用方提供——仍兜一层，违约不该击穿这一轮 */
  let result: AgentToolResult;
  try {
    result = await tool.execute(params, {
      toolCallId: use.id,
      workspace: config.workspace,
      sessionId: config.sessionId ?? null,
      iteration,
      signal,
      onUpdate: (partial) => {
        void emit({ type: "tool_execution_update", toolCallId: use.id, partial });
      },
    });
  } catch (e) {
    const message = `Tool '${use.name}' threw: ${errText(e)}`;
    await notify(hooks, config, { type: "toolUseFailed", toolCallId: use.id, toolName: use.name, cause: "crashed", message });
    await emit({
      type: "tool_execution_end",
      toolCallId: use.id,
      toolName: use.name,
      result: { content: message, isError: true, metadata: null },
    });
    return toolResultMessage(use.id, use.name, message, true);
  }

  /* postToolUse 拦截：可改写结果 */
  const post = await hooks.intercept(
    { type: "postToolUse", toolCallId: use.id, toolName: use.name, params, result },
    config.hookContext,
  );
  const finalResult = post.event.result;

  await emit({ type: "tool_execution_end", toolCallId: use.id, toolName: use.name, result: finalResult });
  return toolResultMessage(
    use.id,
    use.name,
    finalResult.content,
    finalResult.isError,
    finalResult.metadata as Record<string, unknown> | null,
    finalResult.images,
  );
}

/**
 * 本轮快照里没有这个名字时，给模型一个准确原因：
 *   - 本轮开始时池里就没有 → 「未知工具」。**即使此刻池里已经有了也一样**——
 *     它是本轮开始后才注册的，归下一轮；实时池不能成为第二条解析路。
 *   - 本轮开始时已知 → 去问实时池要原因：禁用（带来源给的话）/ 已卸载 /
 *     本轮开始时被禁用、中途又恢复了（下一轮起可用）。**只取原因，不取对象。**
 */
function explainMissingTool(config: AgentLoopConfig, known: ReadonlySet<string>, name: string): string {
  if (!known.has(name)) return `Unknown tool '${name}'`;
  const r = config.resolveTool(name);
  // 禁用 / 延迟未加载都带着来源给的话；只有真从池里没了才说「已卸载」
  if (!r.ok) return r.reason === "not_found" ? `Tool '${name}' has been unloaded` : r.message;
  return `Tool '${name}' was unavailable when this turn started; it is available from the next turn`;
}

/**
 * 与 signal 赛跑：signal 先到就不再等 promise。**promise 之后的 rejection 也必须有人接**——
 * 上一版在 rejection 分支里 `resolve(Promise.reject(e))`，signal 先赢之后外层已经完成，新造的
 * rejected promise 无人接管，变成 unhandled rejection（实测）。这里始终用 `.then(_, reject)` 消费：
 * 晚到的 rejection 调 `reject(e)` 是 no-op，但已被 handler 接走。
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<{ kind: "value"; value: T } | { kind: "aborted" }> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve({ kind: "aborted" });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ kind: "value", value });
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e); // 先赢的是 abort 时这是 no-op，但 rejection 已被消费
      },
    );
  });
}

function prepare(tool: ModelTool | McpTool, raw: unknown): Record<string, unknown> {
  // McpTool 没有 prepareArguments（参数 schema 是服务器给的，模型按它产出）→ 走形状垫片
  if (tool.kind === "model" && tool.prepareArguments !== undefined) {
    return tool.prepareArguments(raw) as Record<string, unknown>;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Expected an object argument, got ${Array.isArray(raw) ? "an array" : typeof raw}`);
  }
  return raw as Record<string, unknown>;
}

async function notify(
  hooks: HookWorkset,
  config: AgentLoopConfig,
  event: Parameters<HookWorkset["notify"]>[0],
): Promise<void> {
  await hooks.notify(event, config.hookContext);
}

function clampDelay(ms: number, cap?: number): number {
  return cap === undefined ? ms : Math.min(ms, cap);
}

/**
 * 可中止的退避：signal 一到就提前 resolve（不 reject——由循环顶部的判断收场），timer 同时清掉。
 * 裸 `setTimeout` 会把 abort / deadline 拖到整段 backoff 走完（缺省最长 30s），还撑着 event loop。
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export { agentError, toolSchemas };
export type { Emit };
