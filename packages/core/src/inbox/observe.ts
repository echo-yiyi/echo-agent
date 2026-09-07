// Inbox 的领域观测（Inbox 行）：唯一 emission point 在 store.ts——
//   · accepted：一条投递进了账本。via 说是本进程 `deliver` 投的，还是别的进程写进目录、`refresh` 轮询发现的
//     （跨 session 发来的就是后者）；deduplicated = 撞上 dedupeKey，指向已有那条；
//   · rejected：账本没收（形状不对 / 空 key / 落盘失败 / 已封）；
//   · restored：重启从盘上恢复的 pending 那批；
//   · consumed：一批被 reserve 并交给某条 run——**发在那条 run 里**（consumeInbox 的 executor 进 loop 之前），
//     所以 run 的时间线能回答「这次是谁的哪几条消息触发的」；
//   · acked：run 之后整批 ack 落盘；released：整批放回（run 被拒 / enqueue 抛 / ack 未提交）；
//   · sealed：账本进了无法裁决的状态，之后 intake 一律 fail-loud。
// 除 consumed 外都发生在 run 之外：没有 runId 就是 runtime activity，离线经 `reader.recentActivity()` 取。
// 发送方那一侧不另发事实：跨 session 发消息是 `session_send` 工具调用，tool.execute 已经记了它。

import type { AgentMessage } from "../messages.ts";
import type { CapabilityFactDescriptor, ObservationFactProjection } from "../observability/fact-sink.ts";
import { sha256Hex } from "../observability/hash.ts";
import type { ObservationCapturePolicy } from "../observability/types.ts";

export type InboxFactKind = "accepted" | "rejected" | "restored" | "consumed" | "acked" | "released" | "sealed";

/** 一条 inbox record 的可观测摘要：id 与来源是结构信息（metadata 档也带），正文只在 content 档。 */
export type InboxRecordBrief = Readonly<{
  /** rejected 没有 id（账本没收就没发号）。 */
  recordId?: string;
  role: AgentMessage["role"];
  /** environment 消息的 source：`session` = 别的会话发来的；schedule / 后台任务等由投递方定。 */
  source?: string;
  /** environment 消息的 ref：会话间消息是 `<发送方 session id>:<发送方消息 id>`。 */
  ref?: string;
  text?: string;
  textTruncated?: boolean;
}>;

export type InboxFact = Readonly<{
  kind: InboxFactKind;
  /** accepted / rejected 是这一条；restored / consumed / acked / released 是这一批。 */
  records: readonly InboxRecordBrief[];
  deduplicated?: boolean;
  via?: "deliver" | "refresh";
  /** rejected：invalid-request | store-error；released：run-rejected | enqueue-failed | ack-pre-commit。 */
  reason?: string;
  errorDigest?: string;
  reservationId?: string;
  /** consumed / acked / released：消费这批的 run。 */
  runId?: string;
  /** sealed 的理由 / rejected 的错误原文：content 直出，metadata 只留 digest。 */
  message?: string;
  occurredAt: number;
}>;

export const INBOX_INSTRUMENTATION = { name: "echo.inbox", version: "1" } as const;

/** 每条正文摘要的上限：一批几十条长消息不能把整条 fact 顶过 64 KiB 变 gap。 */
const TEXT_LIMIT = 4_000;

/** 从 record 的消息取摘要。正文总是取（store 不知道采集档），descriptor 投影时按档去留。 */
export function inboxRecordBrief(message: AgentMessage, recordId?: string): InboxRecordBrief {
  const m = message as AgentMessage & { source?: string; ref?: string; content?: unknown };
  const brief: { -readonly [K in keyof InboxRecordBrief]: InboxRecordBrief[K] } = { role: message.role };
  if (recordId !== undefined) brief.recordId = recordId;
  if (typeof m.source === "string") brief.source = m.source;
  if (typeof m.ref === "string") brief.ref = m.ref;
  const text = textOf(m.content);
  if (text !== undefined) {
    if (text.length > TEXT_LIMIT) {
      brief.text = text.slice(0, TEXT_LIMIT);
      brief.textTruncated = true;
    } else {
      brief.text = text;
    }
  }
  return brief;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function withoutText(r: InboxRecordBrief): InboxRecordBrief {
  const { text: _text, textTruncated: _truncated, ...rest } = r;
  return rest;
}

export const inboxFactDescriptor: CapabilityFactDescriptor<InboxFact> = {
  instrumentation: INBOX_INSTRUMENTATION,
  project(fact: InboxFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
    if (policy === "off") return null;
    const content = policy === "content";
    const attributes: Record<string, string | number | boolean> = { count: fact.records.length };
    const first = fact.records[0];
    if (fact.records.length === 1 && first !== undefined) {
      if (first.recordId !== undefined) attributes.recordId = first.recordId;
      if (first.source !== undefined) attributes.source = first.source;
      if (first.ref !== undefined) attributes.ref = first.ref;
    }
    if (fact.deduplicated !== undefined) attributes.deduplicated = fact.deduplicated;
    if (fact.via !== undefined) attributes.via = fact.via;
    if (fact.reason !== undefined) attributes.reason = fact.reason;
    if (fact.runId !== undefined) attributes.runId = fact.runId;
    const activityId = fact.reservationId !== undefined ? `inbox:${fact.reservationId}` : first?.recordId !== undefined ? `inbox:${first.recordId}` : "inbox";
    return {
      occurredAt: fact.occurredAt,
      kind: "event",
      name: `inbox.${fact.kind}`,
      scope: { activityId },
      attributes,
      body: {
        records: fact.records.map((r) => (content ? r : withoutText(r))),
        ...(fact.deduplicated === undefined ? {} : { deduplicated: fact.deduplicated }),
        ...(fact.via === undefined ? {} : { via: fact.via }),
        ...(fact.reason === undefined ? {} : { reason: fact.reason }),
        ...(fact.errorDigest === undefined ? {} : { errorDigest: fact.errorDigest }),
        ...(fact.reservationId === undefined ? {} : { reservationId: fact.reservationId }),
        ...(fact.runId === undefined ? {} : { runId: fact.runId }),
        ...(fact.message === undefined ? {} : content ? { message: fact.message } : { messageDigest: sha256Hex(fact.message) }),
      },
    };
  },
};
