// AgentEvent → 观测事实的**固定 descriptor**（§15.3.5 / §15.9 Agent/Turn、Model、Tool、Context 四行）。
//
// 只做投影，不改事实：`CoreAgentEvent` 每种 type 一条固定 name/kind；非 core 的 `CustomAgentEvents`
// 只能成为 `agent.custom_event` generic record（OR2）——原 type 进 `attributes.customEventType`，
// metadata 档 body 恒 `{}`（payload 没有可信的字段级 sensitivity schema，按整体敏感处理，§15.11）。
//
// run 边界（run.accepted / started / closed）**不在这里**：它们只有 admission / executor / finalizer 一个
// emission owner（§15.3.5）；tap 只提供 turn / message / tool / status 这些 finalizer 形成终态所需的事实。
//
// 纯 Web-standard（不碰 `node:`）。

import type { AgentEvent, AgentOutcome } from "../events.ts";
import type { AgentMessage, ContentBlock } from "../messages.ts";
import type { CapabilityFactDescriptor, ObservationFactProjection } from "./fact-sink.ts";
import { ObservationEncodingError, encodeCanonical, projectionEncodingLimits } from "./normalize.ts";
import type { ObservationCapturePolicy } from "./types.ts";
import { OBSERVATION_SYNC_LIMITS } from "./types.ts";

export const AGENT_EVENT_INSTRUMENTATION = { name: "echo.agent-event", version: "1" } as const;

/** 固定 span 名（§15.3.2 / §15.9）。 */
export const SPAN_TURN_EXECUTE = "turn.execute";
export const SPAN_MODEL_GENERATE = "model.generate";
export const SPAN_TOOL_EXECUTE = "tool.execute";
export const SPAN_CONTEXT_COMPACT = "context.compact";
export const EVENT_AGENT_CUSTOM = "agent.custom_event";

type Attrs = Record<string, string | number | boolean>;

/**
 * 单次投影愿意走过的 ContentBlock 上限。
 *
 * 起因（2026-08-27 review 实测）：`message_end` 在进 `encodeCanonical()` **之前**就把整条 content
 * 遍历、拼接、物化了一遍——metadata 档也照跑 `textOf()` 与 `toolUsesOf()`，后者建完整数组只为取
 * `.length`；content 档还把这两件事各做第二遍。50 万个普通 tool_use block 额外分配约 35 MB，
 * 最后只产出一个几百字节的 metadata body。**这是当前 Provider 数据路径上就会发生的事**，
 * 不属于 §15.16 OP2 那类未来敌意 Proxy 风险，不能挂在那条待拍板下面拖。
 *
 * 所以 projector 自己也进同步预算：**一次扫描**同时算 metadata 计数与 content 正文，
 * 扫描条数有上限，计数不建中间数组，正文不做无界拼接；被截断一律显式标出来
 * （`contentTruncated` + `contentBlocksScanned` / `textTruncated`），不假装聚合是全量的。
 */
const MAX_CONTENT_BLOCK_SCAN = 1_024;

/**
 * content 档拼出的正文上限，单位是**canonical 字节**，且是从**整条 fact 的预算**里扣出来的。
 *
 * 起因（2026-08-27 review P2 实测）：上一版把它定成 64 KiB **code unit**，而整条投影的预算是
 * 64 KiB − 8 KiB envelope reserve，Runtime envelope 自己还有开销——50,000 chars accepted、60,000 dropped、
 * **70,000 被 projector 截断后照样 dropped**。也就是说 `textTruncated:true` 的记录必然过不了后续编码，
 * 那个标记只在 `projectAgentEvent()` 的单测里成立，穿过 Sequencer 就是假的。
 *
 * 保留额留给 body 其余字段（stopReason / 计数 / usage / model）与 fact 框架（name / scope / attributes）。
 * **仍不是整条 body 的保证**：content 档的 `toolUseBlocks[].input` 大小不可预估，它超预算时整条照样被拒——
 * 那条走 O3a 的 attachment/blob（`docs/ISSUES.md` E 类已登记）。这里保证的是**正文本身不再是超预算的原因**。
 */
const PROJECTED_BODY_RESERVE = 8 * 1024;
export const MAX_PROJECTED_TEXT_BYTES = projectionEncodingLimits().maxBytes - PROJECTED_BODY_RESERVE;

/** 非代理区 code unit 在 canonical JSON 里的字节数**上界**（宁可高估，绝不低估——低估就等于又放行一条编不出来的记录）。 */
function jsonByteCost(c: number): number {
  if (c === 0x22 || c === 0x5c) return 2; // " 与 \ 转义成两字节
  if (c < 0x20) return 6; // 控制字符最坏 \uXXXX
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  return 3; // BMP 非代理字符，UTF-8 三字节
}

const HI_MIN = 0xd800;
const HI_MAX = 0xdbff;
const LO_MIN = 0xdc00;
const LO_MAX = 0xdfff;

/**
 * 取 `s` 中 canonical 字节数不超过 `room` 的最长前缀。
 *
 * **代理区必须成对看**（2026-08-27 review P1 实测）：把所有 surrogate code unit 一律算 3 字节时，
 * 合法代理对（2 单位 6 ≥ 实际 4）没问题，但**孤立 surrogate** 会被 `JSON.stringify` 转义成 `\ud800`
 * ——实打实 6 字节，3 就是低估，`textTruncated:true` 的记录又编不出来了（复现：projectedTextLength=16384、
 * textTruncated=true、accepted=0）。所以合法对按 4 记并整体推进 2 个单位（也避免把对切成孤立 surrogate），
 * 孤立的高/低代理一律按 6 记。
 *
 * 扫描长度按 `room` 封顶——每个 code unit 至少 1 字节，扫过 `room` 个必然已经停了；
 * 否则一条 5 MB 的 text block 会让「按预算截断」自己变成 O(输入) 的无界工作。
 */
function takePrefix(s: string, room: number): Readonly<{ text: string; used: number; truncated: boolean }> {
  const cap = s.length < room ? s.length : room;
  let cost = 0;
  let i = 0;
  while (i < cap) {
    const c = s.charCodeAt(i);
    let width = 1;
    let unit: number;
    if (c >= HI_MIN && c <= HI_MAX && i + 1 < s.length && s.charCodeAt(i + 1) >= LO_MIN && s.charCodeAt(i + 1) <= LO_MAX) {
      width = 2;
      unit = 4; // 合法代理对：UTF-8 四字节
    } else if (c >= HI_MIN && c <= LO_MAX) {
      unit = 6; // 孤立高/低代理：`\udXXX`
    } else {
      unit = jsonByteCost(c);
    }
    if (cost + unit > room) break;
    cost += unit;
    i += width;
  }
  return i < s.length ? { text: s.slice(0, i), used: cost, truncated: true } : { text: s, used: cost, truncated: false };
}

type ContentSummary = {
  /** 已扫描块内的 text 字符数；`blocksTruncated` 为 true 时不是全量。 */
  textChars: number;
  /** 已扫描块内的 tool_use 条数；同上。 */
  toolUses: number;
  scanned: number;
  blocksTruncated: boolean;
  text: string;
  textTruncated: boolean;
  toolUseBlocks: { id: string; name: string; input: unknown }[];
};

function emptySummary(): ContentSummary {
  return { textChars: 0, toolUses: 0, scanned: 0, blocksTruncated: false, text: "", textTruncated: false, toolUseBlocks: [] };
}

function summarizeString(text: string, collect: boolean): ContentSummary {
  const out = emptySummary();
  out.textChars = text.length;
  if (collect) {
    const r = takePrefix(text, MAX_PROJECTED_TEXT_BYTES);
    out.text = r.text;
    out.textTruncated = r.truncated;
  }
  return out;
}

/** `collect=false`（metadata 档）时只累加计数：零字符串拼接、零数组分配。 */
function summarizeContent(blocks: readonly ContentBlock[] | undefined, collect: boolean): ContentSummary {
  const out = emptySummary();
  if (blocks === undefined) return out;
  const total = blocks.length;
  const scan = total > MAX_CONTENT_BLOCK_SCAN ? MAX_CONTENT_BLOCK_SCAN : total;
  out.scanned = scan;
  out.blocksTruncated = scan < total;
  const parts: string[] = [];
  let taken = 0;
  for (let i = 0; i < scan; i++) {
    const b = blocks[i]!;
    if (b.type === "text") {
      out.textChars += b.text.length;
      if (!collect) continue;
      const room = MAX_PROJECTED_TEXT_BYTES - taken; // taken 记的是 canonical 字节，不是 code unit
      if (room <= 0) {
        out.textTruncated = true;
        continue;
      }
      const r = takePrefix(b.text, room);
      if (r.text.length > 0) parts.push(r.text);
      taken += r.used;
      if (r.truncated) out.textTruncated = true;
    } else if (b.type === "tool_use") {
      out.toolUses += 1;
      if (collect) out.toolUseBlocks.push({ id: b.id, name: b.name, input: b.input });
    }
  }
  if (collect) out.text = parts.join("");
  return out;
}

/** 被截断时把「聚合只覆盖前 N 条」写进 body：省略了什么必须看得见，不能让读者以为是全量。 */
function noteTruncation(body: Record<string, unknown>, s: ContentSummary): void {
  if (s.blocksTruncated) {
    body.contentTruncated = true;
    body.contentBlocksScanned = s.scanned;
  }
}

/**
 * metadata 档的尺寸估算：走同一套 canonical 编码但只取字节数；达到同步上限即停、标 truncated——
 * 坏 shape / getter 抛错也只标 truncated，绝不让 Agent outcome 失败（§15.11）。
 * `payloadTruncated:false` 时 payloadBytes 是精确 canonical UTF-8 长度；true 时是已检查上限（lower bound）。
 */
export function estimatePayloadBytes(value: unknown): Readonly<{ payloadBytes: number; payloadTruncated: boolean }> {
  try {
    const enc = encodeCanonical(value, {
      maxBytes: OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes,
      maxValueDepth: OBSERVATION_SYNC_LIMITS.maxValueDepth,
      maxValueNodes: OBSERVATION_SYNC_LIMITS.maxValueNodes,
      maxBlobChunkBytes: 0,
    });
    return { payloadBytes: enc.bytes.byteLength, payloadTruncated: false };
  } catch (e) {
    const bound = e instanceof ObservationEncodingError && e.code === "bytes_exceeded" ? OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes : 0;
    return { payloadBytes: bound, payloadTruncated: true };
  }
}

function outcomeAttrs(outcome: AgentOutcome): Attrs {
  return outcome.kind === "error" ? { status: "error", errorCode: outcome.error.code, errorSource: outcome.error.source } : { status: outcome.kind };
}

function messageBody(message: AgentMessage, policy: ObservationCapturePolicy): Record<string, unknown> {
  const m = message as AgentMessage & { content?: unknown; toolName?: string; isError?: boolean; source?: string };
  const collect = policy === "content";
  const s =
    typeof m.content === "string"
      ? summarizeString(m.content, collect)
      : summarizeContent(Array.isArray(m.content) ? (m.content as ContentBlock[]) : undefined, collect);
  const body: Record<string, unknown> = { role: m.role, chars: s.textChars };
  noteTruncation(body, s);
  if (typeof m.source === "string") body.source = m.source;
  if (typeof m.toolName === "string") body.toolName = m.toolName;
  if (typeof m.isError === "boolean") body.isError = m.isError;
  if (collect) {
    body.text = s.text;
    if (s.textTruncated) body.textTruncated = true;
  }
  return body;
}

/** `CoreAgentEvent` 逐 type 的固定投影；`policy:"off"` 下一律不生成。 */
export function projectAgentEvent(event: AgentEvent, policy: ObservationCapturePolicy): ObservationFactProjection | null {
  if (policy === "off") return null;
  const base = { occurredAt: event.at, sourceSeq: event.seq } as const;
  const content = policy === "content";
  switch (event.type) {
    case "agent_start":
      return { ...base, kind: "event", name: "agent.loop.started", scope: {}, attributes: {}, body: {} };
    case "agent_end": {
      const attrs = outcomeAttrs(event.outcome);
      const body: Record<string, unknown> = { ...attrs };
      if (event.outcome.kind === "aborted" && event.outcome.reason !== undefined) body.reason = event.outcome.reason;
      if (event.outcome.kind === "error") {
        body.retryable = event.outcome.error.retryable;
        if (content) body.errorMessage = event.outcome.error.message;
      }
      return { ...base, kind: "event", name: "agent.loop.ended", scope: {}, attributes: attrs, body };
    }
    case "turn_start":
      return {
        ...base,
        kind: "span_start",
        name: SPAN_TURN_EXECUTE,
        scope: { turnId: `t${event.iteration}` },
        attributes: { iteration: event.iteration },
        body: { iteration: event.iteration },
      };
    case "turn_end": {
      const body: Record<string, unknown> = {
        iteration: event.iteration,
        stopReason: event.message.stopReason,
        toolResultCount: event.toolResults.length,
        contentBlocks: event.message.content.length,
        usage: event.message.usage,
      };
      if (event.message.error !== undefined) body.errorCode = event.message.error.code;
      return {
        ...base,
        kind: "span_end",
        name: SPAN_TURN_EXECUTE,
        scope: { turnId: `t${event.iteration}` },
        attributes: { iteration: event.iteration, stopReason: event.message.stopReason, toolResultCount: event.toolResults.length },
        body,
      };
    }
    case "message_start":
      return { ...base, kind: "span_start", name: SPAN_MODEL_GENERATE, scope: {}, attributes: { role: event.role }, body: {} };
    case "message_update": {
      if (!content) return null; // metadata：token 级 delta 只做 span 聚合，不逐条成记录（§15.7 / §15.11）
      const d = event.delta as { type: string; text?: string; argsText?: string };
      const body: Record<string, unknown> = { deltaType: d.type };
      if (typeof d.text === "string") body.text = d.text;
      if (typeof d.argsText === "string") body.argsText = d.argsText;
      return { ...base, kind: "event", name: "model.generate.delta", scope: {}, attributes: { deltaType: d.type }, body };
    }
    case "message_end": {
      const m = event.message;
      if (m.role === "assistant") {
        // metadata 与 content 共用**同一次**有界扫描：原来 metadata 也全量拼串 + 建数组，
        // content 还会把这两件事各做第二遍（review P1 实测 50 万 block 多分配约 35 MB）。
        const s = summarizeContent(m.content, content);
        const body: Record<string, unknown> = {
          stopReason: m.stopReason,
          contentBlocks: m.content.length,
          textChars: s.textChars,
          toolUses: s.toolUses,
          usage: m.usage,
        };
        noteTruncation(body, s);
        if (m.model !== undefined) body.model = { provider: m.model.provider, id: m.model.id };
        if (m.error !== undefined) body.errorCode = m.error.code;
        if (content) {
          body.text = s.text;
          if (s.textTruncated) body.textTruncated = true;
          body.toolUseBlocks = s.toolUseBlocks;
          if (m.error !== undefined) body.errorMessage = m.error.message;
        }
        return {
          ...base,
          kind: "span_end",
          name: SPAN_MODEL_GENERATE,
          scope: {},
          attributes: { role: "assistant", stopReason: m.stopReason, hasError: m.error !== undefined },
          body,
        };
      }
      return { ...base, kind: "event", name: "agent.message.appended", scope: {}, attributes: { role: m.role }, body: messageBody(m, policy) };
    }
    case "tool_execution_start": {
      const est = estimatePayloadBytes(event.params);
      const body: Record<string, unknown> = { toolName: event.toolName, argsBytes: est.payloadBytes, argsTruncated: est.payloadTruncated };
      if (content) body.params = event.params;
      return {
        ...base,
        kind: "span_start",
        name: SPAN_TOOL_EXECUTE,
        scope: { toolCallId: event.toolCallId },
        attributes: { toolName: event.toolName, toolCallId: event.toolCallId },
        body,
      };
    }
    case "tool_execution_update":
      if (!content) return null;
      return {
        ...base,
        kind: "event",
        name: "tool.execute.progress",
        scope: { toolCallId: event.toolCallId },
        attributes: { toolCallId: event.toolCallId },
        body: { partial: event.partial },
      };
    case "tool_execution_end": {
      const r = event.result;
      const body: Record<string, unknown> = {
        toolName: event.toolName,
        isError: r.isError,
        resultChars: r.content.length,
        images: r.images?.length ?? 0,
        hasMetadata: r.metadata !== null,
      };
      if (content) {
        body.content = r.content;
        body.metadata = r.metadata;
      }
      return {
        ...base,
        kind: "span_end",
        name: SPAN_TOOL_EXECUTE,
        scope: { toolCallId: event.toolCallId },
        attributes: { toolName: event.toolName, toolCallId: event.toolCallId, isError: r.isError },
        body,
      };
    }
    case "compaction_start":
      return { ...base, kind: "span_start", name: SPAN_CONTEXT_COMPACT, scope: {}, attributes: { reason: event.reason }, body: { reason: event.reason } };
    case "compaction_end": {
      const body: Record<string, unknown> = { summaryChars: event.summary.length, coveredUpTo: event.coveredUpTo };
      if (content) body.summary = event.summary;
      return { ...base, kind: "span_end", name: SPAN_CONTEXT_COMPACT, scope: {}, attributes: {}, body };
    }
    case "retry_scheduled":
      return {
        ...base,
        kind: "event",
        name: "model.retry.scheduled",
        scope: {},
        attributes: { attempt: event.attempt, maxAttempts: event.maxAttempts, cause: event.cause },
        body: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, cause: event.cause },
      };
    case "usage":
      return { ...base, kind: "event", name: "model.usage", scope: {}, attributes: {}, body: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens } };
    case "resource_changed":
      return {
        ...base,
        kind: "event",
        name: "agent.resource.changed",
        scope: {},
        attributes: { kind: event.kind, action: event.action, source: event.source },
        body: { kind: event.kind, action: event.action, name: event.name, source: event.source },
      };
    case "queue_update":
      return { ...base, kind: "event", name: "agent.queue.updated", scope: {}, attributes: { queue: event.queue }, body: { queue: event.queue, size: event.size } };
    default:
      return projectCustomEvent(event as AgentEvent & { type: string }, policy, base);
  }
}

/** OR2：非 core type 只能成为固定 generic record；provider 指定不了 name/kind/lane/scope/owner。 */
function projectCustomEvent(event: AgentEvent & { type: string }, policy: ObservationCapturePolicy, base: { occurredAt: number; sourceSeq: number }): ObservationFactProjection {
  const { type, seq: _seq, at: _at, ...rest } = event as AgentEvent & { type: string } & Record<string, unknown>;
  const est = estimatePayloadBytes(rest);
  const attributes: Attrs = { customEventType: type, payloadBytes: est.payloadBytes, payloadTruncated: est.payloadTruncated };
  return {
    ...base,
    kind: "event",
    name: EVENT_AGENT_CUSTOM,
    scope: {},
    attributes,
    // metadata 档：body 恒 {}；只有 content 才把其余字段交出去 normalize / redact
    body: policy === "content" ? rest : {},
  };
}

export const agentEventDescriptor: CapabilityFactDescriptor<AgentEvent> = {
  instrumentation: AGENT_EVENT_INSTRUMENTATION,
  project: projectAgentEvent,
};
