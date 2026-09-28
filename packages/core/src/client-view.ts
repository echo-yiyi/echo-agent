// 给远端客户端的投影（2026-09-20，下游产品「一一」要把状态推到手机端）。
//
// **为什么不是协议成员**：这里一行状态都不碰，纯函数就够；`AgentRuntime` 是封闭协议，
// 加一支所有壳与测试替身都要跟上（`extension/runtime.ts` 文件头）。宿主自己决定什么时候取、
// 经什么传输送出去——传输、重连、归并都不是 core 的事。
//
// 洗掉三类东西：
//   · **进不了 JSON 的**——`tools` 是带 `execute` 的对象、`pendingToolCalls` 是 `Set`；
//   · **provider 的回放数据**——`ThinkingBlock.signature` / `origin`：下一轮请求要原样带回，
//     对客户端一个字节的意义都没有，却是最容易随手 `JSON.stringify` 送出去的东西；
//   · **流里那份 runtime 附加物**——`message_update.delta` 上挂着的 `partial`（见 `events.ts#StreamItem`）。
//
// 保留 `redacted`：那是「这段思考被安全过滤器抹掉了」这个**事实**，界面要照实说。
//
// 衔接（快照 + 后续订阅）：`state.lastSeq` 是水位——状态已经吸收到第几号事件。同一拍里
// 先取快照再订阅，`seq > lastSeq` 的才送给客户端，之前的已经在快照里了。断线就重取快照，
// core 不留事件日志、不补播（2026-09-20 一一的 MVP 明确不要求）。
//
// ```ts
// const snap = clientSnapshot(runtime);
// runtime.subscribe((e) => { if (e.seq > snap.state.lastSeq) send(clientEvent(e)); });
// ```
//
// **权限与提问走的是另一条流**（`LifecycleEvent`，没有 seq）：快照里的 `pendingPermissions` /
// `pendingQuestions` 是权威，lifecycle 事件只当提示——可能收到一条已经在列表里的提问，按 id 覆盖，
// 别按到达顺序追加。

import type { AgentState } from "./agent.ts";
import type { CoreAgentEvent, AgentEvent, ProviderEvent } from "./events.ts";
import type { AgentMessage, AssistantMessage, ContentBlock } from "./messages.ts";
import type { AgentRuntime } from "./extension/runtime.ts";
import type { PermissionAsk } from "./permission/types.ts";
import type { QuestionAsk } from "./question/types.ts";
import type { AgentTool } from "./tools/types.ts";

/** 工具的可显示面：池里那些对象带着 `execute`，JSON 化之后只剩名字，不如直说给了什么。 */
export type ClientTool = Readonly<{
  name: string;
  kind: AgentTool["kind"];
  /** 人读名，恒有（`ToolBase.label`）。 */
  label: string;
  /** 模型读的正文。`kind: "internal"` 的工具没有这一项——它不进模型菜单。 */
  description?: string;
  /** 非空 = 这件工具当前不可用（来源断了），值是原因。 */
  disabled?: string;
}>;

/** `AgentState` 的可外发形态：换掉进不了 JSON 的三项，其余字段与 `AgentState` 逐一对应（含水位 `lastSeq`）。 */
export type ClientState = Readonly<
  Omit<AgentState, "tools" | "pendingToolCalls" | "messages" | "streamingMessage"> & {
    tools: readonly ClientTool[];
    pendingToolCalls: readonly string[];
    messages: readonly AgentMessage[];
    streamingMessage?: AgentMessage;
  }
>;

/**
 * 一次快照：客户端接上来时要先看到的全部。`state.lastSeq` 是它与后续订阅的接缝。
 * `pendingPermissions` / `pendingQuestions` 放在这里，是因为它们不在 `AgentState` 上、
 * 而且走的是没有 seq 的 lifecycle 流——快照里这两份是权威。
 */
export type ClientSnapshot = Readonly<{
  state: ClientState;
  /** 与 `AgentRuntime.acceptsWork` 同一份判据；翻转时有 `availability_changed` 事件。 */
  acceptsWork: boolean;
  pendingPermissions: readonly PermissionAsk[];
  pendingQuestions: readonly QuestionAsk[];
}>;

/** 与 `AgentEvent` 同形，只是洗过。`seq` / `at` 原样带着——`seq` 就是衔接用的那个号。 */
export type ClientEvent = AgentEvent;

/** 快照：`state` 与订阅的衔接点在 `state.lastSeq`。**同一拍里取完就订阅**，中间别 await。 */
export function clientSnapshot(runtime: AgentRuntime): ClientSnapshot {
  return {
    state: clientState(runtime.state),
    acceptsWork: runtime.acceptsWork,
    pendingPermissions: runtime.pendingPermissions,
    pendingQuestions: runtime.pendingQuestions,
  };
}

/** 只投影状态那一份（宿主已经自己拿着 `state` 时用；要连 pending 一起拿就用 `clientSnapshot`）。 */
export function clientState(state: Readonly<AgentState>): ClientState {
  const { tools, pendingToolCalls, messages, streamingMessage, ...rest } = state;
  return {
    ...rest,
    tools: tools.map(clientTool),
    pendingToolCalls: [...pendingToolCalls],
    messages: messages.map(cleanMessage),
    ...(streamingMessage === undefined ? {} : { streamingMessage: cleanMessage(streamingMessage) }),
  };
}

/**
 * 事件：只有带消息的那几支要洗，其余原样。
 *
 * `CARRIES_MESSAGES` 是一张按事件名穷举的表——**加一支新事件变体，这张表就编译不过**，
 * 逼着作者回答「它带不带消息」。上层 agent 自己的事件（`CustomAgentEvents`）不在表里，原样放行。
 */
export function clientEvent(event: ClientEvent): ClientEvent {
  switch (event.type) {
    case "message_update":
      return { ...event, delta: cleanDelta(event.delta), message: cleanContent(event.message) };
    case "message_end":
      return { ...event, message: cleanMessage(event.message) };
    case "reply_end":
      return { ...event, final: event.final === null ? null : cleanContent(event.final) };
    case "turn_end":
      return { ...event, result: cleanAttempt(event.result), toolResults: [...event.toolResults] };
    case "attempt_end":
      return { ...event, result: cleanAttempt(event.result) };
    case "session_restored":
      return { ...event, messages: event.messages.map(cleanMessage) };
    default:
      return event;
  }
}

/** 穷举表：值 = 这支事件带不带消息（带的必须在 `clientEvent` 里洗）。 */
const CARRIES_MESSAGES: Record<CoreAgentEvent["type"], boolean> = {
  agent_start: false,
  agent_end: false,
  reply_start: false,
  reply_end: true,
  turn_start: false,
  turn_end: true,
  attempt_start: false,
  attempt_end: true,
  message_start: false,
  message_update: true,
  message_end: true,
  tool_execution_start: false,
  tool_execution_update: false,
  tool_execution_end: false,
  compaction_start: false,
  compaction_end: false,
  retry_scheduled: false,
  usage: false,
  resource_changed: false,
  queue_update: false,
  equipment_changed: false,
  workspace_changed: false,
  reset: false,
  session_restored: true,
  status_changed: false,
  availability_changed: false,
  view_changed: false,
};

/** `clientEvent` 洗到的那几支，必须与表对得上——判据用它，不靠人读两遍。 */
export const MESSAGE_CARRYING_EVENTS: readonly string[] = Object.entries(CARRIES_MESSAGES)
  .filter(([, carries]) => carries)
  .map(([type]) => type);

function clientTool(tool: AgentTool): ClientTool {
  return {
    name: tool.name,
    kind: tool.kind,
    label: tool.label,
    ...(tool.kind === "internal" ? {} : { description: tool.description }),
    ...(tool.disabled === undefined ? {} : { disabled: tool.disabled }),
  };
}

function cleanMessage<T extends AgentMessage>(message: T): T {
  // toolResult / environment 的 `content` 是字符串，没有块可洗；按 role 判，不按有没有 content 猜
  if (message.role === "assistant" || message.role === "user") return cleanContent(message) as T;
  return message;
}

/**
 * 泛型保住信封（`at`）与各变体自己的字段：只换 `content` 那一项。
 * 展开一个泛型对象 TS 推不回 `T`（只多不少也不认），在这里收口一次，调用点保持精确类型。
 */
function cleanContent<T extends { content: readonly ContentBlock[] }>(message: T): T {
  return { ...message, content: message.content.map(cleanBlock) } as T;
}

function cleanBlock(block: ContentBlock): ContentBlock {
  if (block.type !== "thinking") return block;
  const { signature, origin, ...rest } = block; // 回放数据：客户端用不上，也不该拿到
  void signature;
  void origin;
  return rest;
}

function cleanDelta(delta: ProviderEvent): ProviderEvent {
  // 流里跑的是 `StreamItem`（`ProviderEvent` + 此刻的 `partial`）：`partial` 是 runtime 附加物，不出门
  const { partial, ...rest } = delta as ProviderEvent & { partial?: AssistantMessage };
  void partial;
  if (rest.type === "thinking_end") {
    const { signature, ...tail } = rest;
    void signature;
    return tail;
  }
  if (rest.type === "done") return { ...rest, message: cleanContent(rest.message) };
  return rest;
}

function cleanAttempt(result: Extract<CoreAgentEvent, { type: "attempt_end" }>["result"]): Extract<CoreAgentEvent, { type: "attempt_end" }>["result"] {
  return result.kind === "landed" ? { ...result, message: cleanContent(result.message) } : result;
}
