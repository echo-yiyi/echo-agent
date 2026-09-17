// 等在自己的 inbox 上（2026-09-16）。实现在 `Agent.watchInbox`，经 `AgentInbox` 开给 extension；
// `session_send` 的 `wait` 是它的第一个用户。决策见 docs/decisions/implemented/2026-09-03-sessions-are-peers.md。

import type { AgentMessage } from "../messages.ts";

/** 等多久、谁能叫停。 */
export type InboxWatchOptions = Readonly<{
  /** 最多等多少毫秒。到点什么都不消费，之后到的照普通路径投递。 */
  timeoutMs: number;
  /** 叫停（工具调用被中止、run 被打断）。叫停同样什么都不消费。 */
  signal?: AbortSignal;
}>;

/**
 * 等的结局。**只有 `matched` 消费了东西**，其余三种 inbox 原样。
 *
 * - `matched`：那一条已从待投递里摘走，随本轮 run 收尾一起 ack（transcript 落定之后）；
 *   收尾之前进程崩了，它还在盘上，重启后照普通消息投一次——at-least-once。
 * - `timeout` / `aborted`：没等到 / 被叫停。
 * - `rejected`：根本等不了（不在 run 里、参数不对、账本已封），`reason` 说清为什么。
 */
export type InboxWatchResult =
  | Readonly<{ kind: "matched"; message: AgentMessage }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ kind: "rejected"; reason: string }>;

/** extension 面拿到的那一份（`AgentInbox`）。 */
export interface AgentInboxPort {
  /**
   * 等到 inbox 里出现第一条 `match` 为真的消息，**命中即消费**：它作为结果交给你，不会再以 environment
   * 消息进来一次。只能在 run 里调——命中之后的 ack 跟这一轮 run 的收尾绑在一起。
   */
  watch(match: (message: AgentMessage) => boolean, opts: InboxWatchOptions): Promise<InboxWatchResult>;
}
