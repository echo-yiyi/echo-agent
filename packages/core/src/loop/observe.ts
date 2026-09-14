// 循环的观测探针：四层（run ⊃ reply ⊃ turn ⊃ attempt）、模型生成、工具执行，各在**执行节点**上记一条事实。
//
// **观测是插桩，不是事件协议**（docs/design/observability.md）。`AgentEvent` 是给壳实时展示的功能契约，形状由
// 前端要什么决定；这里的事实由事后复盘与评估要什么决定。所以循环在每个节点**与 emit 并列**调一次探针，两条输出
// 互不依赖：观测不订阅、不转发 AgentEvent，AgentEvent 为前端改形状也不改变观测记下什么。
//
// 探针放在 emit **之前**：它同步、永不抛，emit 自己坏了，「到过这个节点」也已经记下；各层的 `ended` 标记照样
// 挡住 catch 分支里的重复关层。循环是纯方法（评测直接打它），探针可选——不给照跑。
//
// run 边界（run.accepted / started / closed）不在这里，它们只有 admission / executor / finalizer 一个 emission owner。
// 压缩的事实在 `compaction/observe.ts`，Agent 自身的（队列、资源）在 `agent-observe.ts`。
//
// 纯 Web-standard（不碰 `node:`）。

import type { AgentOutcome, ProviderEvent } from "../events.ts";
import type { AgentMessage, ContentBlock, Usage } from "../messages.ts";
import type { AgentToolResult } from "../tools/types.ts";
import type { CapabilityFactDescriptor, CapabilityFactSink, ObservationFactProjection } from "../observability/fact-sink.ts";
import { MAX_PROJECTED_TEXT_BYTES, estimatePayloadBytes, takePrefix } from "../observability/projection.ts";
import type { ObservationCapturePolicy } from "../observability/types.ts";
import { turnNumberOf } from "./ids.ts";
import type { AttemptResult, ReplySource, TurnCause } from "./types.ts";

export const LOOP_INSTRUMENTATION = { name: "echo.loop", version: "1" } as const;

/** 固定 span 名。四层里 run 由 admission 发边界，其余三层各是一对 span；模型生成与工具执行各一对。 */
export const SPAN_REPLY_EXECUTE = "reply.execute";
export const SPAN_ATTEMPT_EXECUTE = "attempt.execute";
export const SPAN_TURN_EXECUTE = "turn.execute";
export const SPAN_MODEL_GENERATE = "model.generate";
export const SPAN_TOOL_EXECUTE = "tool.execute";

/**
 * 循环在节点上交给探针的事实。**归观测所有**：它长什么样由复盘与评估要什么决定，与 `AgentEvent` 各自演化。
 * 用到的 `AgentMessage` / `AttemptResult` / `ProviderEvent` 是循环本来就吃进吐出的领域数据，不是前端协议。
 */
export type LoopFactBody =
  | { kind: "loop_started" }
  | { kind: "loop_ended"; outcome: AgentOutcome }
  | { kind: "reply_started"; replyId: string; source: ReplySource }
  | { kind: "reply_ended"; replyId: string; outcome: AgentOutcome; hasFinal: boolean; turns: number }
  | { kind: "turn_started"; turnId: string; replyId: string; cause: TurnCause }
  | { kind: "turn_ended"; turnId: string; result: AttemptResult; toolResultCount: number }
  | { kind: "attempt_started"; turnId: string; attempt: number }
  | { kind: "attempt_ended"; turnId: string; attempt: number; result: AttemptResult }
  | { kind: "retry_scheduled"; turnId: string; attempt: number; maxAttempts: number; delayMs: number; cause: string }
  | { kind: "generation_started" }
  | { kind: "generation_delta"; delta: ProviderEvent }
  /** 一条消息入账：assistant 的定稿收 `model.generate` span；输入 / 工具结果是 `agent.message.appended`。 */
  | { kind: "message_committed"; message: AgentMessage }
  | { kind: "usage"; usage: Usage }
  | { kind: "tool_started"; toolCallId: string; toolName: string; params: unknown }
  | { kind: "tool_progress"; toolCallId: string; partial: unknown }
  | { kind: "tool_ended"; toolCallId: string; toolName: string; result: AgentToolResult };

/** 带发生时刻的事实。时刻由 `probe()` 在节点上补，调用处不必各写一遍。 */
export type LoopFact = LoopFactBody & Readonly<{ at: number }>;

/** 循环拿到的探针。 */
export type LoopProbe = CapabilityFactSink<LoopFact>;

/** 节点上调它：补发生时刻，交给探针。探针自身同步、永不抛（`fact-sink.ts`），没给就什么都不做。 */
export function probe(sink: LoopProbe | undefined, fact: LoopFactBody): void {
  sink?.offer({ ...fact, at: Date.now() } as LoopFact);
}

type Attrs = Record<string, string | number | boolean>;

/**
 * 单次投影愿意走过的 ContentBlock 上限。
 *
 * 起因（2026-08-27 review 实测）：`message_end` 在进 `encodeCanonical()` **之前**就把整条 content
 * 遍历、拼接、物化了一遍——metadata 档也照跑 `textOf()` 与 `toolUsesOf()`，后者建完整数组只为取
 * `.length`；content 档还把这两件事各做第二遍。50 万个普通 tool_use block 额外分配约 35 MB，
 * 最后只产出一个几百字节的 metadata body。**这是当前 Provider 数据路径上就会发生的事**，
 * 不属于「未来敌意 Proxy」那类风险，不能挂在那条待拍板下面拖。
 *
 * 所以 projector 自己也进同步预算：**一次扫描**同时算 metadata 计数与 content 正文，
 * 扫描条数有上限，计数不建中间数组，正文不做无界拼接；被截断一律显式标出来
 * （`contentTruncated` + `contentBlocksScanned` / `textTruncated`），不假装聚合是全量的。
 */
const MAX_CONTENT_BLOCK_SCAN = 1_024;

/**
 * 正文预算里划给**思考**的那一份。**是划分，不是再加一份。**
 *
 * 为什么不另开一份等量预算：上面那份是从整条 fact 的 64 KiB 里扣出来的，body 有机会翻倍就会
 * 回到 `MAX_PROJECTED_TEXT_BYTES` 注释里记的那个坑——整条记录穿不过 Sequencer 被丢掉，
 * 于是**一个事实都不剩**。为省一半正文而丢掉全部事实，方向反了。
 *
 * 怎么分：**思考封顶在这一份，回答拿池子里剩下的**，两边合计不超总预算。thinking 块在消息里
 * 排在回答前面，封顶就是为了不让一段长思考把回答挤成空串；反过来没有思考的消息，回答仍拿整份
 * ——不为不存在的块预留额度。这样只需**一遍扫描**，不必先数一遍有没有思考（那会让下标读翻倍，
 * 踩到「content 档只扫一遍」那道既有的门）。
 *
 * 代价说清楚：一条既有长思考又有长回答的消息，两边都会被截，各自带 `thinkingTruncated` /
 * `textTruncated`。content 档下完整正文本来就逐条记在 `model.generate.delta` 里，
 * 这里是摘要不是唯一副本；metadata 档没有 delta，但那一档本来就只记计数。
 */
export const MAX_PROJECTED_THINKING_BYTES = Math.floor(MAX_PROJECTED_TEXT_BYTES / 2);

type ContentSummary = {
  /** 已扫描块内的 text 字符数；`blocksTruncated` 为 true 时不是全量。 */
  textChars: number;
  /** 已扫描块内的 tool_use 条数；同上。 */
  toolUses: number;
  /** 已扫描块内的 thinking 条数；同上。 */
  thinkingBlocks: number;
  /** 已扫描块内的思考字符数。被抹掉的块贡献 0——它本来就没有正文。 */
  thinkingChars: number;
  /** 其中被安全过滤器抹掉的块数。它没有正文却仍要原样回传，只看 `thinkingChars` 看不出它存在过。 */
  thinkingRedacted: number;
  scanned: number;
  blocksTruncated: boolean;
  text: string;
  textTruncated: boolean;
  thinking: string;
  thinkingTruncated: boolean;
  toolUseBlocks: { id: string; name: string; input: unknown }[];
};

function emptySummary(): ContentSummary {
  return {
    textChars: 0,
    toolUses: 0,
    thinkingBlocks: 0,
    thinkingChars: 0,
    thinkingRedacted: 0,
    scanned: 0,
    blocksTruncated: false,
    text: "",
    textTruncated: false,
    thinking: "",
    thinkingTruncated: false,
    toolUseBlocks: [],
  };
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
  const thinkingParts: string[] = [];
  let taken = 0;
  let thinkingTaken = 0;
  for (let i = 0; i < scan; i++) {
    const b = blocks[i]!;
    if (b.type === "text") {
      out.textChars += b.text.length;
      if (!collect) continue;
      const room = MAX_PROJECTED_TEXT_BYTES - taken - thinkingTaken; // taken 记的是 canonical 字节，不是 code unit
      if (room <= 0) {
        out.textTruncated = true;
        continue;
      }
      const r = takePrefix(b.text, room);
      if (r.text.length > 0) parts.push(r.text);
      taken += r.used;
      if (r.truncated) out.textTruncated = true;
    } else if (b.type === "thinking") {
      // **计数无条件记，两档都记。** metadata 档没有 delta 记录，这条摘要是「模型这一轮想过、
      // 想了多少、其中几块被抹」的唯一痕迹；上一版连扫描都没进，于是 contentBlocks 算着它、
      // 别的字段一个都不提它——读者看不出少了什么，也看不出少的是思考。
      out.thinkingBlocks += 1;
      if (b.redacted === true) out.thinkingRedacted += 1;
      out.thinkingChars += b.thinking.length;
      if (!collect) continue;
      // 两个上限取小的：① 思考自己封顶在半份——它排在回答前面，不封顶就把回答挤成空串；
      // ② 池子里真正剩下的——两边合起来不许超总预算，否则整条记录穿不过 Sequencer，一个事实都不剩。
      const cap = MAX_PROJECTED_THINKING_BYTES - thinkingTaken;
      const left = MAX_PROJECTED_TEXT_BYTES - taken - thinkingTaken;
      const room = cap < left ? cap : left;
      if (room <= 0) {
        out.thinkingTruncated = true;
        continue;
      }
      const r = takePrefix(b.thinking, room);
      if (r.text.length > 0) thinkingParts.push(r.text);
      thinkingTaken += r.used;
      if (r.truncated) out.thinkingTruncated = true;
    } else if (b.type === "tool_use") {
      out.toolUses += 1;
      if (collect) out.toolUseBlocks.push({ id: b.id, name: b.name, input: b.input });
    }
  }
  if (collect) {
    out.text = parts.join("");
    out.thinking = thinkingParts.join("");
  }
  return out;
}

/** 被截断时把「聚合只覆盖前 N 条」写进 body：省略了什么必须看得见，不能让读者以为是全量。 */
function noteTruncation(body: Record<string, unknown>, s: ContentSummary): void {
  if (s.blocksTruncated) {
    body.contentTruncated = true;
    body.contentBlocksScanned = s.scanned;
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
  // 这里的消息可能是 user / toolResult，思考只在 assistant 上出现——有才写，别给没有思考的角色
  // 挂三个恒零字段。`message_end` 那头不一样：那是 assistant 生成的摘要，「想没想」是一等问题。
  if (s.thinkingBlocks > 0) {
    body.thinkingBlocks = s.thinkingBlocks;
    body.thinkingChars = s.thinkingChars;
    if (s.thinkingRedacted > 0) body.thinkingRedacted = s.thinkingRedacted;
  }
  if (typeof m.source === "string") body.source = m.source;
  if (typeof m.toolName === "string") body.toolName = m.toolName;
  if (typeof m.isError === "boolean") body.isError = m.isError;
  if (collect) {
    body.text = s.text;
    if (s.textTruncated) body.textTruncated = true;
    if (s.thinking.length > 0) body.thinking = s.thinking;
    if (s.thinkingTruncated) body.thinkingTruncated = true;
  }
  return body;
}

/** `LoopFact` 逐 kind 的固定投影；`policy:"off"` 下一律不生成。 */
export function projectLoopFact(fact: LoopFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
  if (policy === "off") return null;
  const base = { occurredAt: fact.at } as const;
  const content = policy === "content";
  switch (fact.kind) {
    case "loop_started":
      return { ...base, kind: "event", name: "agent.loop.started", scope: {}, attributes: {}, body: {} };
    case "loop_ended": {
      const attrs = outcomeAttrs(fact.outcome);
      const body: Record<string, unknown> = { ...attrs };
      if (fact.outcome.kind === "aborted" && fact.outcome.reason !== undefined) body.reason = fact.outcome.reason;
      if (fact.outcome.kind === "error") {
        body.retryable = fact.outcome.error.retryable;
        if (content) body.errorMessage = fact.outcome.error.message;
      }
      return { ...base, kind: "event", name: "agent.loop.ended", scope: {}, attributes: attrs, body };
    }
    // reply：对一条输入的完整回应。replyId 由 loop 产（`${runId}/${k}`）；scope 没有 replyId 这一维，进 attributes
    case "reply_started":
      return { ...base, kind: "span_start", name: SPAN_REPLY_EXECUTE, scope: {}, attributes: { replyId: fact.replyId, source: fact.source }, body: { replyId: fact.replyId, source: fact.source } };
    case "reply_ended": {
      const attrs: Attrs = { replyId: fact.replyId, ...outcomeAttrs(fact.outcome), turns: fact.turns };
      const body: Record<string, unknown> = { ...attrs, hasFinal: fact.hasFinal };
      if (fact.outcome.kind === "error" && content) body.errorMessage = fact.outcome.error.message;
      return { ...base, kind: "span_end", name: SPAN_REPLY_EXECUTE, scope: {}, attributes: attrs, body };
    }
    // attempt：turn 里的一次模型请求。重试 = 同一 turn 的下一个 attempt，靠 `(turnId, attempt)` 配对
    case "attempt_started":
      return { ...base, kind: "span_start", name: SPAN_ATTEMPT_EXECUTE, scope: { turnId: fact.turnId }, attributes: { turnId: fact.turnId, attempt: fact.attempt }, body: { attempt: fact.attempt } };
    case "attempt_ended": {
      const attrs: Attrs = { turnId: fact.turnId, attempt: fact.attempt, result: fact.result.kind };
      const body: Record<string, unknown> = { attempt: fact.attempt, result: fact.result.kind };
      if (fact.result.kind === "failed") {
        body.errorCode = fact.result.error.code;
        attrs.errorCode = fact.result.error.code;
        attrs.retryable = fact.result.error.retryable;
        if (content) body.errorMessage = fact.result.error.message;
      }
      return { ...base, kind: "span_end", name: SPAN_ATTEMPT_EXECUTE, scope: { turnId: fact.turnId }, attributes: attrs, body };
    }
    // turn span 的 scope.turnId 就是 loop 产的 turnId（与 Agent 的观测 scope 供给、permission 引用的同一份）；
    // iteration 从它的 n 取（`loop/ids.ts`），不另外算
    case "turn_started": {
      const iteration = turnNumberOf(fact.turnId);
      return {
        ...base,
        kind: "span_start",
        name: SPAN_TURN_EXECUTE,
        scope: { turnId: fact.turnId },
        attributes: { iteration, replyId: fact.replyId, cause: fact.cause },
        body: { iteration, replyId: fact.replyId, cause: fact.cause },
      };
    }
    case "turn_ended": {
      const iteration = turnNumberOf(fact.turnId);
      const landed = fact.result.kind === "landed" ? fact.result.message : null;
      const stopReason = landed === null ? fact.result.kind : landed.stopReason;
      const body: Record<string, unknown> = {
        iteration,
        result: fact.result.kind,
        stopReason,
        toolResultCount: fact.toolResultCount,
        contentBlocks: landed === null ? 0 : landed.content.length,
        usage: landed === null ? null : landed.usage,
      };
      if (fact.result.kind === "failed") body.errorCode = fact.result.error.code;
      return {
        ...base,
        kind: "span_end",
        name: SPAN_TURN_EXECUTE,
        scope: { turnId: fact.turnId },
        attributes: { iteration, result: fact.result.kind, stopReason, toolResultCount: fact.toolResultCount },
        body,
      };
    }
    case "retry_scheduled":
      return {
        ...base,
        kind: "event",
        name: "model.retry.scheduled",
        scope: {},
        attributes: { attempt: fact.attempt, maxAttempts: fact.maxAttempts, cause: fact.cause },
        body: { attempt: fact.attempt, maxAttempts: fact.maxAttempts, delayMs: fact.delayMs, cause: fact.cause },
      };
    case "generation_started":
      return { ...base, kind: "span_start", name: SPAN_MODEL_GENERATE, scope: {}, attributes: { role: "assistant" }, body: {} };
    case "generation_delta": {
      if (!content) return null; // metadata：token 级 delta 只做 span 聚合，不逐条成记录
      const d = fact.delta as { type: string; text?: string; argsText?: string; signature?: string; redacted?: boolean };
      const body: Record<string, unknown> = { deltaType: d.type };
      if (typeof d.text === "string") body.text = d.text;
      if (typeof d.argsText === "string") body.argsText = d.argsText;
      // `thinking_end` 带的两个回放判据：signature 是「这段思考来自哪个字段」
      // （`reasoning_content` / `reasoning` / `reasoning_text`），redacted 是「正文被抹了但仍要原样回传」。
      if (typeof d.signature === "string") body.signature = d.signature;
      if (d.redacted === true) body.redacted = true;
      return { ...base, kind: "event", name: "model.generate.delta", scope: {}, attributes: { deltaType: d.type }, body };
    }
    case "message_committed": {
      const m = fact.message;
      if (m.role === "assistant") {
        // metadata 与 content 共用**同一次**有界扫描：计数与正文一遍算完
        const s = summarizeContent(m.content, content);
        const body: Record<string, unknown> = {
          stopReason: m.stopReason,
          contentBlocks: m.content.length,
          textChars: s.textChars,
          // 与 textChars / toolUses 同一性质的事实，恒写：读者要能从一条记录里回答
          // 「这一轮模型想了没有、想了多少」，而不是从 contentBlocks 减出来猜。
          thinkingBlocks: s.thinkingBlocks,
          thinkingChars: s.thinkingChars,
          toolUses: s.toolUses,
          usage: m.usage,
        };
        if (s.thinkingRedacted > 0) body.thinkingRedacted = s.thinkingRedacted;
        noteTruncation(body, s);
        if (m.model !== undefined) body.model = { provider: m.model.provider, id: m.model.id };
        if (m.error !== undefined) body.errorCode = m.error.code;
        if (content) {
          body.text = s.text;
          if (s.textTruncated) body.textTruncated = true;
          if (s.thinking.length > 0) body.thinking = s.thinking;
          if (s.thinkingTruncated) body.thinkingTruncated = true;
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
    case "usage":
      return { ...base, kind: "event", name: "model.usage", scope: {}, attributes: {}, body: { inputTokens: fact.usage.inputTokens, outputTokens: fact.usage.outputTokens } };
    case "tool_started": {
      const est = estimatePayloadBytes(fact.params);
      const body: Record<string, unknown> = { toolName: fact.toolName, argsBytes: est.payloadBytes, argsTruncated: est.payloadTruncated };
      if (content) body.params = fact.params;
      return {
        ...base,
        kind: "span_start",
        name: SPAN_TOOL_EXECUTE,
        scope: { toolCallId: fact.toolCallId },
        attributes: { toolName: fact.toolName, toolCallId: fact.toolCallId },
        body,
      };
    }
    case "tool_progress":
      if (!content) return null;
      return {
        ...base,
        kind: "event",
        name: "tool.execute.progress",
        scope: { toolCallId: fact.toolCallId },
        attributes: { toolCallId: fact.toolCallId },
        body: { partial: fact.partial },
      };
    case "tool_ended": {
      const r = fact.result;
      const body: Record<string, unknown> = {
        toolName: fact.toolName,
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
        scope: { toolCallId: fact.toolCallId },
        attributes: { toolName: fact.toolName, toolCallId: fact.toolCallId, isError: r.isError },
        body,
      };
    }
  }
}

export const loopFactDescriptor: CapabilityFactDescriptor<LoopFact> = {
  instrumentation: LOOP_INSTRUMENTATION,
  project: projectLoopFact,
};
