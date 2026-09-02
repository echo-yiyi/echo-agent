// 内层一轮：一次助手响应 + 它的工具执行。设计见 docs/design/AGENT-CORE.md §3.4；接缝加固见 §14.7.5。
//
// runTurn 只负责跑完这一轮——**没有任何提前 return 的分支**，所有出圈判断集中在 runLoop。
//
// 一条贯穿全文件的规则:**每条进入 transcript 的消息都发一个 message_end 事件**
// （助手消息之前还有 start/update）——这样 Agent 侧只需要一条 append 路径，
// 「state = apply(state, event)」对每条消息都成立。
//
// 另一条（§14.7.5 第 1、2 条）:**本轮的工具与 hook 在开头定格**。模型看到的菜单、执行到的对象、
// 拦截它的 handler，整轮是同一份；中途的注册/卸载/替换全部归下一轮。

import { agentError, errText } from "../errors.ts";
import type { HookWorkset } from "../hooks/runtime.ts";
import { deepFreezePlain, normalizeVerdict } from "../permission/ledger.ts";
import type { PermissionVerdict } from "../permission/types.ts";
import type { AgentMessage, AssistantMessage, ToolResultMessage, ToolSchema, ToolUseBlock } from "../messages.ts";
import { toolResultMessage, toolUsesFromMessage } from "../messages.ts";
import { isModelTool, isModelVisible, toolSchemas, type AgentTool, type AgentToolResult, type McpTool, type ModelTool } from "../tools/types.ts";
import { buildWorkingMessages } from "../compaction/view.ts";
import type { AgentLoopConfig, Emit, LoopDeps, TurnResult } from "./types.ts";

/** 本轮工作集：开头冻一次，整轮只看它。 */
type TurnWorkset = {
  /** 摆给模型、也是唯一会被执行的工具对象。 */
  readonly tools: readonly AgentTool[];
  /** 本轮开始时池里的全部名字（含禁用的）——只用来决定「要不要去问原因」。 */
  readonly knownToolNames: ReadonlySet<string>;
  readonly hooks: HookWorkset;
};

/**
 * `contextBeforeBuild` 返回 block：**不调模型**。这是本文件唯一的提前出口——block 的含义是「这一轮不该发生」，
 * 没有 assistant 消息可以挂 TurnResult，所以用异常出去，由 runLoop 折成 `aborted` outcome（reason 透传）。
 * 不合成假的 assistant 消息进 transcript：什么都没说过，账本里就不该有一条。
 */
export class ContextBuildBlocked extends Error {
  constructor(readonly reason: string | undefined) {
    super(`contextBeforeBuild blocked the turn${reason !== undefined ? `: ${reason}` : ""}`);
    this.name = "ContextBuildBlocked";
  }
}

export async function runTurn(deps: LoopDeps, iteration: number): Promise<TurnResult> {
  const { context, config, emit, signal, streamFn } = deps;

  /* ⓪ 定格本轮工作集（§14.7.5 第 1、2 条）：hook 条目与工具对象在此刻冻结。
     **必须在 turn_start 事件之前**：AgentEvent listener 是被 await 的，订阅者收到 turn_start 就能注册/卸载
     Tool 或 Hook——先发事件再冻结，那些改动就混进了已经宣布开始的这一轮。 */
  const workset: TurnWorkset = {
    tools: config.getTools(),
    knownToolNames: new Set(config.knownToolNames()),
    hooks: config.hooks.snapshot(),
  };
  const { tools, hooks } = workset;
  // turn 开门（§14 RunIntakeGate）：同样在 turn_start 之前——订阅者收到 turn_start 就能 steer()
  config.intake?.openTurn(`${config.runId}#${iteration}`);
  await emit({ type: "turn_start", iteration });

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
    // block = 这轮不发（2026-09-01 前这里只取 patch 后的 messages、无视 decision——hook 说别调模型，模型照调）
    if (r.decision === "block") throw new ContextBuildBlocked(r.reason);
    working = r.event.messages;
  }

  /* ② 投影：AgentMessage → 线上形状（唯一一道翻译） */
  const llmMessages = await config.convertToLlm(working);

  /* ③ 每轮重解析 key（短命 token 会在长工具阶段中途过期） */
  const apiKey = await config.getApiKey?.(config.model.provider);

  /* ④ 调模型 + 消费协议（占槽逐字，见 §8.4） */
  const stream = await streamFn(
    config.model,
    { systemPrompt: context.systemPrompt, messages: llmMessages, tools: toolSchemas(tools) },
    {
      signal,
      apiKey,
      thinkingLevel: config.thinkingLevel,
      maxRetryDelayMs: config.maxRetryDelayMs,
    },
  );

  let opened = false;
  for await (const item of stream) {
    if (item.type === "start") {
      opened = true;
      await emit({ type: "message_start", role: "assistant" });
      continue;
    }
    if (item.type === "retry") {
      await emit({
        type: "retry_scheduled",
        attempt: item.attempt,
        maxAttempts: item.maxAttempts,
        delayMs: item.delayMs,
        cause: item.code,
      });
      continue;
    }
    await emit({ type: "message_update", delta: item, message: item.partial });
  }

  // **入账取权威定稿，不是槽里自己攒的 partial**——拿槽当定稿会被重放/丢包污染。
  const final = await stream.result();
  // 退化路径：违约或无流式后端没发过 start，补一个，保「每个定稿消息必有成对 start/end」。
  if (!opened) await emit({ type: "message_start", role: "assistant" });

  const finalMsg = withAt(final);
  context.messages.push(finalMsg);
  await emit({ type: "message_end", message: finalMsg });
  if (final.usage !== null) await emit({ type: "usage", usage: final.usage });

  /* ⑤⑥ 工具批 */
  const toolUses = toolUsesFromMessage(finalMsg);
  const toolResults: ToolResultMessage[] = [];
  if (toolUses.length > 0) {
    for (const use of toolUses) {
      const msg = await runOneTool(use, deps, iteration, workset);
      context.messages.push(msg);
      await emit({ type: "message_end", message: msg });
      toolResults.push(msg as ToolResultMessage);
      if (signal.aborted) break; // 批中断：已跑完的保留，剩下的不跑
    }
  }

  await emit({ type: "turn_end", iteration, message: final, toolResults });
  return { message: final, toolResults, stopReason: final.stopReason };
}

/* ─────────────────── 单次工具调用 ─────────────────── */

async function runOneTool(
  use: ToolUseBlock,
  deps: LoopDeps,
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

  /* authorization（§14.10.3 固定 stage）：参数已冻结，从这里起不可再改；authorization 只能决定。
     ask 里的 params、宿主看到的 params、execute 收到的 params 是**同一份**冻结对象。
     authInput 自身也冻：policy 若 `input.params = 另一份`，在 ESM 严格模式下当场抛 → 下面按 fail-closed 拒。 */
  const authInput = Object.freeze({
    runId: config.runId,
    turnId: `${config.runId}#${iteration}`,
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
 * 本轮快照里没有这个名字时，给模型一个准确原因（§14.7.5 第 1 条）：
 *   - 本轮开始时池里就没有 → 「未知工具」。**即使此刻池里已经有了也一样**——
 *     它是本轮开始后才注册的，归下一轮；实时池不能成为第二条解析路。
 *   - 本轮开始时已知 → 去问实时池要原因：禁用（带来源给的话）/ 已卸载 /
 *     本轮开始时被禁用、中途又恢复了（下一轮起可用）。**只取原因，不取对象。**
 */
function explainMissingTool(config: AgentLoopConfig, known: ReadonlySet<string>, name: string): string {
  if (!known.has(name)) return `Unknown tool '${name}'`;
  const r = config.resolveTool(name);
  if (!r.ok) return r.reason === "disabled" ? r.message : `Tool '${name}' has been unloaded`;
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

export function withAt(m: AssistantMessage, at: number = Date.now()): AgentMessage {
  return { ...m, at };
}

export { agentError, toolSchemas };
export type { Emit };
