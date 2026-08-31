// 消息的形状校验。**内部共用件**：Session 恢复、Inbox 接受与 legacy migration 用的是同一份判据——
// 两份各写各的必然漂移，而「盘上的坏档」要在读进来那一刻就判红，不能等到下游拿着半截消息炸。
//
// **不进公共面**：`messages.ts` 被 `engine.ts` 整个 re-export，放那儿等于凭空长两个公开符号；
// 公共面只许因真实的跨包需要而增长（docs/ISSUES.md OSS-2）。包内两处 import 这个文件即可。

import type { AgentMessage } from "./messages.ts";

/**
 * `ContentBlock` 的**闭合**验形。此前只看 `block.type` 是不是字符串，于是
 * `{ type: "text" }`（缺 text）、缺字段的 image / tool_use、以及**完全不认识的 type**
 * 都能恢复成功，错误一路推迟到投影或 provider 那一层才炸。
 *
 * 这三种是 `messages.ts` 里闭合的联合（`tool_result` 不在其中——它在 v2 是一等消息角色），
 * 所以这里可以、也应该验到底。
 */
export function assertContentBlock(block: unknown, where: string): void {
  const b = block as Record<string, unknown> | null | undefined;
  if (b === null || b === undefined || typeof b !== "object") throw new Error(`${where} 里有块不是对象`);
  switch (b["type"]) {
    case "text":
      if (typeof b["text"] !== "string") throw new Error(`${where} 的 text 块缺 text`);
      return;
    case "thinking":
      // `thinking` 必填字符串；`signature` 是 provider 不透明回放数据，可省但给了必须是字符串；
      // `redacted` 同理。**闭合验形**：多一个字段就说明上游改了协议而这里没跟上。
      if (typeof (block as { thinking?: unknown }).thinking !== "string") {
        throw new Error(`${where}：thinking 块缺 thinking 字段（或不是字符串）`);
      }
      for (const [key, kind] of [
        ["signature", "string"],
        ["redacted", "boolean"],
      ] as const) {
        const value = (block as Record<string, unknown>)[key];
        if (value !== undefined && typeof value !== kind) throw new Error(`${where}：thinking 块的 ${key} 必须是 ${kind}`);
      }
      // `origin` 给了就必须**三件齐全**：判「同源」少一件就判不成，半份来源比没有更危险
      //（会让跨源的不透明数据被当成同源放行）。
      {
        const origin = (block as Record<string, unknown>)["origin"];
        if (origin !== undefined) {
          if (typeof origin !== "object" || origin === null) throw new Error(`${where}：thinking 块的 origin 必须是对象`);
          for (const key of ["provider", "api", "model"] as const) {
            if (typeof (origin as Record<string, unknown>)[key] !== "string") {
              throw new Error(`${where}：thinking 块的 origin.${key} 必须是字符串（三件缺一，同源判据就不成立）`);
            }
          }
        }
      }
      return;
    case "image":
      if (typeof b["mimeType"] !== "string" || typeof b["data"] !== "string") {
        throw new Error(`${where} 的 image 块缺 mimeType / data`);
      }
      return;
    case "tool_use":
      if (typeof b["id"] !== "string" || typeof b["name"] !== "string") {
        throw new Error(`${where} 的 tool_use 块缺 id / name`);
      }
      // input 是 unknown，但**字段必须在**——缺了下游拿到 undefined 当参数
      if (!("input" in b)) throw new Error(`${where} 的 tool_use 块缺 input`);
      return;
    default:
      throw new Error(`${where} 里有块的 type 不认识：${String(b["type"])}`);
  }
}

/**
 * 逐 role 验 `AgentMessage`。**只验 role 在不在是不够的**：实测过
 * `{ kind:"message", message:{ role:"user" } }` 会被收下并恢复进 `messages`，
 * 缺 `content`/`source`/`at` 也照过——直到投影或送进 provider 才炸，
 * 而那时已经离「盘上有坏档」很远了，人只能看到一个莫名其妙的下游错误。
 *
 * 四个内建 role 闭合验；**自定义 role 只验信封**（`CustomAgentMessages` 是开放扩展位，
 * core 不认识上层的字段形状，验多了等于把扩展位关掉）。
 */
export function assertMessageShape(message: unknown, where: string): void {
  const m = message as Record<string, unknown> | null | undefined;
  if (m === null || m === undefined || typeof m !== "object") {
    throw new Error(`${where} 是 message 但 message 不是对象`);
  }
  if (typeof m["role"] !== "string") throw new Error(`${where} 是 message 但缺 message.role`);
  // 信封：`at` 一切变体生效（messages.ts 的 AgentMessage 定义）
  if (typeof m["at"] !== "number") throw new Error(`${where} 的 message 缺信封字段 at`);

  const blocks = (label: string): void => {
    const c = m["content"];
    if (!Array.isArray(c)) throw new Error(`${where} 的 ${label} 消息缺 content 数组`);
    for (const b of c) assertContentBlock(b, `${where} 的 ${label} 消息`);
  };

  switch (m["role"]) {
    case "user":
      if (m["source"] !== "human" && m["source"] !== "steer" && m["source"] !== "harness") {
        throw new Error(`${where} 的 user 消息 source 不合法：${String(m["source"])}`);
      }
      blocks("user");
      return;
    case "assistant": {
      blocks("assistant");
      const stop = m["stopReason"];
      const ok =
        stop === "end_turn" || stop === "tool_use" || stop === "max_tokens" || stop === "aborted" || stop === "error";
      if (!ok) throw new Error(`${where} 的 assistant 消息 stopReason 不合法：${String(stop)}`);
      // usage 是「null = provider 没报」的诚实位，**缺字段与 null 不是一回事**
      if (!("usage" in m)) throw new Error(`${where} 的 assistant 消息缺 usage（没报要写成 null）`);
      const usage = m["usage"] as Record<string, unknown> | null;
      if (usage !== null) {
        if (typeof usage?.["inputTokens"] !== "number" || typeof usage?.["outputTokens"] !== "number") {
          throw new Error(`${where} 的 assistant 消息 usage 形状不对`);
        }
      }
      return;
    }
    case "toolResult":
      if (typeof m["toolCallId"] !== "string" || typeof m["toolName"] !== "string") {
        throw new Error(`${where} 的 toolResult 消息缺 toolCallId / toolName`);
      }
      if (typeof m["content"] !== "string") throw new Error(`${where} 的 toolResult 消息 content 必须是字符串`);
      if (typeof m["isError"] !== "boolean") throw new Error(`${where} 的 toolResult 消息缺 isError`);
      // metadata 只观测、永不进模型，但它是必填位（null 表示没有）
      if (!("metadata" in m)) throw new Error(`${where} 的 toolResult 消息缺 metadata（没有要写成 null）`);
      return;
    case "environment":
      if (typeof m["source"] !== "string") throw new Error(`${where} 的 environment 消息缺 source`);
      blocks("environment");
      return;
    default:
      // 自定义 role：扩展位，只验到信封为止。
      return;
  }
}
