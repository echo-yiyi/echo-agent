// 从进程外往一段会话的 inbox 投递（2026-11-16，docs/decisions/implemented/2026-11-16-session-ingress.md）。
//
// 场景：agent 常驻在一个容器里（`--serve` 或产品自己的壳），同一个容器里的别的进程（运维后台、脚本、cron）要它做事。
// 协议与进程内的投递口是同一份（`DurableIngressPort`，`inbox/ingress.ts`）：`accepted` = 那条 record 已经落盘；
// 同一个 `dedupeKey` 还有没处理完的，返回原来那条的 `recordId` 与 `deduplicated: true`。
//
// 做法与 `session_send` 一样：往那段会话的 `inbox/` 写一个文件（`inbox/foreign.ts`），活着的 agent 每秒扫一次盘
// 就收进去、空下来就跑；没在跑的，下次起来时收。**不起进程、不叫醒**——core 不起进程（sessions.md 的 Non-Goals）。
//
// 投进去的消息算谁说的，由 `message` 决定：`userMessage(text)` 是用户的话（当指令执行，安全分类器也认它是用户要的）；
// `environmentMessage(text, source)` 是环境消息（材料，不当指令）。能写这个会话目录的就能投——边界是容器与沙箱，
// 不是这个函数（决策记录 2026-11-15-security-hardening）。

import { resolveSessionsRoot, resolveStateDir } from "../create-agent.ts";
import type { DurableDeliveryResult, DurableIngressPort } from "../inbox/ingress.ts";
import { pendingRecordWithKey, writeInboxRecord } from "../inbox/foreign.ts";
import { canonicalizeMessage, createRecordIdSource } from "../inbox/records.ts";
import type { AgentMessage } from "../messages.ts";
import { FileDir } from "../storage/file-dir.ts";
import { readSessionInfo } from "./service.ts";

/** `openSessionIngress()` 的参数。 */
export type SessionIngressOptions = Readonly<{
  /** 全部会话目录的上一层。缺省 `resolveSessionsRoot()`（`$ECHO_HOME/sessions`，再退到 `~/.echo/sessions`）。 */
  sessionsRoot?: string;
  /** 投给哪一段。 */
  sessionId: string;
}>;

/**
 * 打开一段会话的投递口，给**进程外**的调用方用（同一台机器、能读写那段会话的目录）。
 *
 * 打开时核对那段会话存在且没关，不满足就抛（地址写错是调用方的错，不是一次投递的失败）。
 * 之后每次 `deliverDurable()` 不抛，结果走 `DurableDeliveryResult`：
 *   · `accepted`：record 已落盘；`deduplicated: true` = 同一个 `dedupeKey` 还有一条没处理完，这次没写新的；
 *   · `rejected{invalid-request}`：`dedupeKey` 为空或 `message` 形状不对；
 *   · `rejected{runtime-disposed}`：打开之后那段会话被关了或被删了；
 *   · `rejected{store-error}`：盘写不进去。
 * 投进去的那条什么时候处理：会话活着就在它空下来时（扫盘每秒一次），没活着就在它下次起来时。
 */
export async function openSessionIngress(opts: SessionIngressOptions): Promise<DurableIngressPort> {
  const sessionsRoot = opts.sessionsRoot ?? resolveSessionsRoot();
  const sessionId = opts.sessionId;
  const store = new FileDir(resolveStateDir({ sessionsRoot, sessionId })); // 顺带验 sessionId 是安全的路径段
  const root = new FileDir(sessionsRoot);
  const info = await readSessionInfo(root, sessionId);
  if (info === null) throw new Error(`没有会话 ${sessionId}（${sessionsRoot} 下找不到它）`);
  if (info.status !== "active") throw new Error(`会话 ${sessionId} 已经关了`);
  // 这个投递口的发号器：同一个口子连着投的几条，收方按投的顺序处理
  const newRecordId = createRecordIdSource();

  return {
    async deliverDurable(request): Promise<DurableDeliveryResult> {
      const dedupeKey = request?.dedupeKey;
      if (typeof dedupeKey !== "string" || dedupeKey === "") return { kind: "rejected", reason: "invalid-request", errorDigest: "empty-dedupe-key" };
      let message: AgentMessage;
      try {
        message = canonicalizeMessage(request?.message, "deliverDurable 的 message");
      } catch {
        return { kind: "rejected", reason: "invalid-request", errorDigest: "message-shape" };
      }
      try {
        const now = await readSessionInfo(root, sessionId);
        if (now === null || now.status !== "active") return { kind: "rejected", reason: "runtime-disposed", errorDigest: now === null ? "session-missing" : "session-closed" };
        const existing = await pendingRecordWithKey(store, dedupeKey);
        if (existing !== null) return { kind: "accepted", recordId: existing, dedupeKey, deduplicated: true };
        const recordId = await writeInboxRecord(store, newRecordId, message, dedupeKey);
        return { kind: "accepted", recordId, dedupeKey, deduplicated: false };
      } catch {
        // 原文不进 errorDigest（公共协议字段，不放本地路径这类东西），只给一个固定的码
        return { kind: "rejected", reason: "store-error", errorDigest: "write-failed" };
      }
    },
  };
}
