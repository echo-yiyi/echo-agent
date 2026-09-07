// 事件层。
//
// **事件是变化本身，不只是记录**：`state = apply(state, event)` 是状态更新的唯一路径，
// 所以对外广播与状态更新同源，不可能漂移（不存在「状态变了但外面没看见」）。
// 事件**不落盘**——事件驱动是进程内结构，持久化是 session 的事。
//
// 三套事件，各管一段：
//   ProviderEvent   适配器的输出契约（模型方言 → 归一化词汇）
//   AgentEvent      对外订阅流（UI/产品层/评测看的那条）
//   LifecycleEvent  hook 的挂点词汇表（可拦截 / 仅通知）

import type { AgentError } from "./errors.ts";
import type { QuestionOption } from "./question/types.ts";
import type { AgentMessage, AssistantMessage, ToolResultMessage, Usage } from "./messages.ts";
import type { AgentToolResult } from "./tools/types.ts";
import type { CompactionReason, CompactionState } from "./compaction/types.ts";
import type { AttemptResult, ReplySource, TurnCause } from "./loop/types.ts";

/* ══════════════════ 1. ProviderEvent ══════════════════ */

/**
 * 适配器的输出契约。四条不变量：
 *  ① **终结事件恰好一个**（done | error 互斥）——调用方永远等得到一个结局。
 *  ② 块严格串行：同一时刻至多一个块打开，end 必配 start（所以 delta 不需要索引字段）。
 *  ③ **最低实现门槛 = 只发 done（或 error）**：无流式后端（CLI）无痛接入。
 *  ④ 增量观测、定稿权威：重放/丢包以 done 为准；usage 只在 done.message 上，不单发。
 */
export type ProviderEvent =
  | { type: "start" }
  | { type: "text_start" }
  | { type: "text_delta"; text: string }
  | { type: "text_end" }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; text: string }
  /**
   * `signature`：**provider 不透明的回放数据**，方言在收尾时给。
   * OpenAI 兼容侧记的是这段思考来自哪个字段（`reasoning_content` / `reasoning` / `reasoning_text`），
   * 下一轮请求要原样写回同一个字段——不带它，preserved thinking 的多轮 tool loop 在服务端不闭合。
   */
  | { type: "thinking_end"; signature?: string; redacted?: boolean }
  | { type: "toolcall_start"; toolCallId: string; name: string }
  | { type: "toolcall_delta"; argsText: string }
  | { type: "toolcall_end" }
  /* 在途异象，不终结生成（重试不在流里：一次 stream = 一次请求，重试是 loop 的下一个 attempt） */
  | { type: "warning"; code: string; message: string }
  /* 终结二选一 */
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: AgentError };

/** 流里真正流动的条目：每个事件都背着「此刻的完整 partial」，消费方不必自己攒增量。 */
export type StreamItem = ProviderEvent & { readonly partial: AssistantMessage };

/** 资源面变了（工具注册/卸载、skill 装入/激活、MCP 连上/断开）。 */
export type ResourceChange = {
  readonly kind: string; // "tool" | "skill" | "mcp" | 自定义
  readonly action: "added" | "removed" | "activated" | "deactivated";
  readonly name: string;
  readonly source: string;
};

/* ══════════════════ 2. AgentEvent ══════════════════ */

export type AgentOutcome =
  | { kind: "completed" }
  | { kind: "aborted"; reason?: string }
  /** 含义是「**真的没救了**」——该重的循环已经重过（重试在 core 里）。 */
  | { kind: "error"; error: AgentError };

export type CoreAgentEvent =
  /* 四层（docs/design/run-loop-layers.md）：run ⊃ reply ⊃ turn ⊃ attempt，start / end 严格嵌套、每层至少一对。
     turn 事件不带 iteration——turnId（`${replyId}#${n}`）的 n 就是它（`loop/ids.ts`）。 */
  | { type: "agent_start" }
  | { type: "agent_end"; outcome: AgentOutcome }
  | { type: "reply_start"; replyId: string; source: ReplySource }
  | { type: "reply_end"; replyId: string; outcome: AgentOutcome; final: AssistantMessage | null; turns: number }
  | { type: "turn_start"; turnId: string; replyId: string; cause: TurnCause }
  | { type: "turn_end"; turnId: string; result: AttemptResult; toolResults: ToolResultMessage[] }
  | { type: "attempt_start"; turnId: string; attempt: number }
  | { type: "attempt_end"; turnId: string; attempt: number; result: AttemptResult }
  /* 消息（由 StreamFn 消费协议产出，见 loop/run-turn.ts） */
  | { type: "message_start"; role: "assistant" }
  | { type: "message_update"; delta: ProviderEvent; message: AssistantMessage }
  | { type: "message_end"; message: AgentMessage }
  /* 工具（tool_execution_* = 我们在跑工具；toolcall_* = 模型在打字参数，两回事） */
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; params: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partial: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult }
  /* 压缩（`compaction/pipeline.ts`）：start / end 成对；end 带跑完的状态、真正改了状态的阶段名（空 = 没压动）与估算 */
  | { type: "compaction_start"; reason: CompactionReason }
  | { type: "compaction_end"; reason: CompactionReason; compaction: CompactionState; stages: readonly string[]; contextTokens: number }
  /* 重试与账。retry_scheduled 只出现在同一 turn 的 attempt_end{failed} 之后，attempt 是即将开始的那个；
     退避被 abort / deadline 打断时其后是 turn_end{aborted}，那个 attempt 不会开始 */
  | { type: "retry_scheduled"; turnId: string; attempt: number; maxAttempts: number; delayMs: number; cause: string }
  | { type: "usage"; usage: Usage }
  /**
   * 资源面变了（工具注册/卸载、skill 装入/激活）。
   * **它是观察事件,不是状态写路径**——池的权威在 harness，`state` 里那份是读取时算出来的视图
   * （与 `isStreaming` 同款）。发它是因为订阅事件流的 UI 需要知道「skill 激活了」，
   * 而不是因为有人要靠它改状态。
   */
  | { type: "resource_changed"; kind: string; action: "added" | "removed" | "activated" | "deactivated"; name: string; source: string }
  /* 队列 */
  | { type: "queue_update"; queue: "steering" | "followUp" | "inbox"; size: number };

/** 上层 agent 的领域事件走这里（评测打分、飞轮进展…），内核零改动。 */
export interface CustomAgentEvents {}

/** 信封：seq 单调递增（「有序」的实体，乱序可排回），at 供人读。 */
export type AgentEvent = { readonly seq: number; readonly at: number } & (
  | CoreAgentEvent
  | CustomAgentEvents[keyof CustomAgentEvents]
);

/** 未盖信封的事件——emit 时由 Agent 盖 seq/at。 */
export type AgentEventInput = CoreAgentEvent | CustomAgentEvents[keyof CustomAgentEvents];

export type AgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/**
 * golden 判据面：**时序性观测事件排除在外**。
 * message_update / tool_execution_update 什么时候来、来几条取决于网络与调度——
 * 把它们放进确定性判据面，回归必然 flaky。
 */
export const NON_DETERMINISTIC_EVENTS: ReadonlySet<string> = new Set([
  "message_update",
  "tool_execution_update",
]);

/* ══════════════════ 3. LifecycleEvent ══════════════════ */

/**
 * hook 的挂点词汇表。两条完备性原则：
 *   **成对**（有 pre 有 post、有 request 有 granted/denied）
 *   **可失败的环节各配一拍失败事件**（带 cause 分类）
 * 载荷原则：带足那个时刻的全部现场。
 */
export type LifecycleEvent =
  /* 会话与命令 */
  /** `messageCount`：续了多少条进上下文（新建为 0）。壳据此把「恢复」说出来，无声恢复是禁止的。 */
  | { type: "sessionStart"; sessionId: string | null; resumed: boolean; messageCount: number }
  | { type: "sessionEnd"; sessionId: string | null; reason: "closed" | "process_exit" }
  | { type: "userPromptSubmit"; text: string; source: "human" | "steer" | "followUp" }
  | { type: "abortRequested"; reason?: string }
  /* 任务级 */
  | { type: "agentTimeout"; elapsedMs: number; timeoutMs: number }
  | { type: "equipmentChanged"; field: "tools" | "model" | "timeoutMs"; source: string }
  /* 模型调用 */
  | { type: "modelCallFailed"; error: AgentError; attempt: number }
  | { type: "retryScheduled"; attempt: number; maxAttempts: number; delayMs: number; cause: string }
  | { type: "toolCallDropped"; reason: "malformed" | "truncated" }
  /* 工具 */
  | { type: "preToolUse"; toolCallId: string; toolName: string; params: Record<string, unknown> }
  | {
      type: "postToolUse";
      toolCallId: string;
      toolName: string;
      params: Record<string, unknown>;
      result: AgentToolResult;
    }
  | { type: "toolUseDenied"; toolCallId: string; toolName: string; by: "hook" | "policy" | "permission"; reason: string }
  | {
      type: "toolUseFailed";
      toolCallId: string;
      toolName: string;
      cause: "not_found" | "bad_params" | "crashed" | "timeout" | "aborted";
      message: string;
    }
  /* 收尾与上下文 */
  | { type: "stop"; iteration: number; finalText: string }
  | { type: "contextBeforeBuild"; messages: AgentMessage[] }
  | { type: "preCompact"; reason: CompactionReason }
  | { type: "postCompact"; reason: CompactionReason; compaction: CompactionState; stages: readonly string[] }
  /** 某个阶段抛错（带 `stage`），或整条流水线跑完没有一段改了状态（不带）。 */
  | { type: "compactionFailed"; reason: CompactionReason; stage?: string; message: string }
  /* 权限（固定 stage）：只有真正进入 ask 才有 permissionId；policy 直接 allow/deny 没有 ask、也就没有 ID。
     这四种全部 notify-only——hook 只能观察，回答只能来自可信宿主的 answerPermission()。 */
  | {
      type: "permissionRequest";
      permissionId: string;
      runId: string;
      turnId: string;
      toolCallId: string;
      toolName: string;
      /** transform hooks 完成、重新校验并冻结后的**最终参数**——与 Tool execute() 收到的是同一份对象。 */
      params: unknown;
      reason: string;
    }
  | { type: "permissionGranted"; toolCallId: string; decidedBy: "policy" }
  | { type: "permissionGranted"; permissionId: string; toolCallId: string; decidedBy: "human" }
  | { type: "permissionDenied"; toolCallId: string; toolName: string; reason: string; decidedBy: "policy" }
  | {
      type: "permissionDenied";
      permissionId: string;
      toolCallId: string;
      toolName: string;
      reason: string;
      decidedBy: "human" | "timeout";
    }
  | { type: "permissionCancelled"; permissionId: string; toolCallId: string; reason: "run-aborted" | "runtime-disposed" }
  /* 提问（`ask_user`，2026-09-05）：与权限询问平行的另一条通道——那是壳子拦工具的工程机制，这是模型主动调的工具。
     同样 notify-only：回答只能来自可信宿主的 answerQuestion()。没等到答案（超时 / 中止 / 收摊）发 cancelled，壳子据此撤掉问题。 */
  | {
      type: "question";
      questionId: string;
      toolCallId: string;
      question: string;
      options: readonly QuestionOption[];
      multiSelect: boolean;
    }
  | { type: "questionCancelled"; questionId: string; toolCallId: string; reason: "timed-out" | "run-aborted" | "runtime-disposed" }
  /* 通知 */
  | { type: "notification"; kind: "waiting_permission"; permissionId: string; message: string }
  | { type: "notification"; kind: "idle" | "task_done" | "error"; message: string };

export type LifecycleEventType = LifecycleEvent["type"];
export type LifecycleEventOf<E extends LifecycleEventType> = Extract<LifecycleEvent, { type: E }>;
