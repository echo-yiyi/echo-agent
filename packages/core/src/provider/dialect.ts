// Dialect 工厂：把「方言翻译」加工成完整的 ProviderStreams。
//
// **它不是一层，是造 ProviderStreams 的工厂**——可选的便利：想全权控制的后端，
// 手写一个 ProviderStreams 即可，createProvider 分不出也不需要分出。
//
// 工厂焊进去的公共逻辑（写一次，全家共用）：瞬时重试与退避、partial 累积、
// 错误抢救、EventStream 包装。**写新方言的人碰不到也不需要碰**——
// v1 里 cli-provider 忘写重试那类病，在这个结构下没有地方可以忘。

import { agentError, classifyUnknown, type AgentError } from "../errors.ts";
import { emptyAssistant, withPartial } from "../event-stream.ts";
import type { ProviderEvent, StreamItem } from "../events.ts";
import type { AssistantMessage, Context, ContentBlock, ToolUseBlock } from "../messages.ts";
import { lazyStream } from "./lazy.ts";
import type { Model, ProviderStreams, StreamOptions } from "./types.ts";

export type RetryPolicy = {
  maxAttempts: number;
  backoffMs(attempt: number): number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: (attempt) => Math.min(1000 * 2 ** (attempt - 1), 30_000),
};

/**
 * 写一家新模型服务时，你**只写这个**。
 *
 * DO：守块不变量（串行块、恰好一个终结）；最低实现只发 done；
 *     预期失败编码成 `error` 事件——**stream 不许 throw**（throw 只留给 bug）。
 * DON'T：不重试（壳管）、不累积 partial（壳管）、**不编造数据**
 *     ——没有 usage 就是 null，不许填 0 冒充报了账。
 */
export interface Dialect {
  readonly api: string;
  request(model: Model, context: Context, options?: StreamOptions): AsyncIterable<ProviderEvent>;
  /** 自家错误归类（自家最懂自家错误体）。认不出返回 null，走通用兜底。 */
  classifyError?(e: unknown): AgentError | null;
}

export function createProviderStreams(dialect: Dialect, retry: RetryPolicy = DEFAULT_RETRY_POLICY): ProviderStreams {
  return {
    stream: (model, context, options) => lazyStream(async () => pump(dialect, model, context, options, retry)),
  };
}

async function* pump(
  dialect: Dialect,
  model: Model,
  context: Context,
  options: StreamOptions | undefined,
  retry: RetryPolicy,
): AsyncGenerator<StreamItem> {
  const acc = new MessageAccumulator(model);

  for (let attempt = 1; ; attempt++) {
    let retrying = false;

    try {
      for await (const ev of dialect.request(model, context, options)) {
        if (ev.type === "error" && ev.error.retryable && attempt < retry.maxAttempts) {
          // 可重试的终结：吞掉它，重来一次。增量从头流——定稿权威兜住正确性。
          retrying = true;
          acc.reset();
          const delayMs = clampDelay(retry.backoffMs(attempt), options?.maxRetryDelayMs);
          yield withPartial(retryEvent(attempt, retry.maxAttempts, delayMs, ev.error.code), acc.partial());
          await sleep(delayMs);
          break;
        }

        yield withPartial(ev, acc.apply(ev));
        for (const w of acc.takeWarnings()) yield withPartial(w, acc.partial());
        if (ev.type === "done" || ev.type === "error") return;
      }

      if (retrying) continue;

      // 流干涸却没有终结事件 = 方言违约。合成一个 error，保「恰好一个终结」。
      yield withPartial(
        { type: "error", error: agentError("provider", "protocol", `方言 '${dialect.api}' 的流结束但没有终结事件`, false) },
        acc.partial(),
      );
      return;
    } catch (e) {
      // 走到这说明方言 throw 了（违约或 bug）。壳仍然不上抛。
      const err = dialect.classifyError?.(e) ?? classifyUnknown(e);
      if (err.retryable && attempt < retry.maxAttempts) {
        acc.reset();
        const delayMs = clampDelay(retry.backoffMs(attempt), options?.maxRetryDelayMs);
        yield withPartial(retryEvent(attempt, retry.maxAttempts, delayMs, err.code), acc.partial());
        await sleep(delayMs);
        continue;
      }
      yield withPartial({ type: "error", error: err }, acc.partial());
      return;
    }
  }
}

function retryEvent(attempt: number, maxAttempts: number, delayMs: number, code: string): ProviderEvent {
  return { type: "retry", code, attempt, maxAttempts, delayMs };
}

function clampDelay(ms: number, cap?: number): number {
  return cap === undefined ? ms : Math.min(ms, cap);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 块规则的执行者：维护「此刻的完整 partial」。
 *
 * 三个取舍：
 *  ① **thinking 进 content**（2026-08-28 订正；原来的取舍是「不进 convo」，那条对单轮成立、
 *     对**多轮工具循环不成立**）：Z.AI Coding Plan、MiniMax M2.x 这类开着 preserved thinking 的家，
 *     要求工具结果回来时原样带回上一轮 reasoning，否则 tool loop 在服务端不闭合。
 *     所以思考既走事件流（给 UI 实时看），也落成 `ThinkingBlock`（给下一轮带回去）。
 *  ② **违约的裸 delta 容忍并累积**（没有 start 就来 delta）：退化后端仍能工作，
 *     与「补发 start」是同一种姿态——不因对方不规范就把整轮丢掉。
 *  ③ 参数 JSON 解不开的工具调用**丢弃并告警**，不塞半截参数给模型。
 */
class MessageAccumulator {
  private blocks: ContentBlock[] = [];
  private open: { kind: "text" | "thinking" | "toolcall"; buf: string; id?: string; name?: string } | null = null;
  private warnings: ProviderEvent[] = [];

  constructor(private readonly model: Model) {}

  apply(ev: ProviderEvent): AssistantMessage {
    switch (ev.type) {
      case "text_start":
        this.open = { kind: "text", buf: "" };
        break;
      case "thinking_start":
        this.open = { kind: "thinking", buf: "" };
        break;
      case "toolcall_start":
        this.open = { kind: "toolcall", buf: "", id: ev.toolCallId, name: ev.name };
        break;

      case "text_delta":
        this.append("text", ev.text);
        break;
      case "thinking_delta":
        this.append("thinking", ev.text);
        break;
      case "toolcall_delta":
        this.append("toolcall", ev.argsText);
        break;

      case "thinking_end":
        // 收尾时把 provider 的不透明回放数据一并封进块里
        this.seal({ ...(ev.signature !== undefined ? { signature: ev.signature } : {}), ...(ev.redacted === true ? { redacted: true } : {}) });
        break;
      case "text_end":
      case "toolcall_end":
        this.seal();
        break;

      case "done":
        return ev.message; // 权威定稿：自算的 partial 到此作废
      default:
        break;
    }
    return this.partial();
  }

  private append(kind: "text" | "thinking" | "toolcall", chunk: string): void {
    if (this.open === null) this.open = { kind, buf: "" }; // 容忍裸 delta
    this.open.buf += chunk;
  }

  private seal(thinkingMeta: { signature?: string; redacted?: boolean } = {}): void {
    const open = this.open;
    this.open = null;
    if (open === null) return;
    if (open.kind === "thinking") {
      // **进 content**（2026-08-28 订正）：开了 preserved thinking 的 provider 要求工具结果回来时
      // 原样带回上一轮 reasoning，丢掉它多轮 tool loop 在服务端不闭合。
      // 被安全过滤器抹掉的那种（正文空、只剩签名）也要留——签名才是续上下一轮的东西。
      if (open.buf.length === 0 && thinkingMeta.redacted !== true) return;
      this.blocks.push(this.thinkingBlock(open.buf, thinkingMeta));
      return;
    }
    if (open.kind === "text") {
      if (open.buf.length > 0) this.blocks.push({ type: "text", text: open.buf });
      return;
    }
    const parsed = parseArgs(open.buf);
    if (parsed === null) {
      this.warnings.push({
        type: "warning",
        code: "tool_call_dropped",
        message: `工具调用 '${open.name ?? "?"}' 的参数 JSON 不可解析，已丢弃（未执行）`,
      });
      return;
    }
    const block: ToolUseBlock = { type: "tool_use", id: open.id ?? "", name: open.name ?? "", input: parsed };
    this.blocks.push(block);
  }

  /**
   * 造一个带**来源**的 thinking 块。来源是回放边界的判据（同 provider + 同 api + 同 model 才回放），
   * 由这里盖——方言是唯一同时知道「这段思考是谁产的」和「它长什么样」的地方。
   */
  private thinkingBlock(text: string, meta: { signature?: string; redacted?: boolean }): ContentBlock {
    return {
      type: "thinking",
      thinking: text,
      ...meta,
      origin: { provider: this.model.provider, api: this.model.api, model: this.model.id },
    };
  }

  partial(): AssistantMessage {
    const content = [...this.blocks];
    // **未收口的那一块也要能被看见**，text 与 thinking 一视同仁。
    // 上一版只放 text：于是 `thinking_start → thinking_delta → error` 这条路
    // 最终恢复出的失败消息是 `content: []`，与「失败轮保留已流出的 partial」直接冲突
    //（review 三轮 P1 实测）。thinking 尤其不能丢——它往往是失败前唯一的产出。
    if (this.open !== null && this.open.buf.length > 0) {
      if (this.open.kind === "text") content.push({ type: "text", text: this.open.buf });
      // 还没收口 → 签名尚未到达（它随 `thinking_end` 来）。**不编一个签名**：
      // 没有签名的 thinking 块回放时会被降级处理，那是对的——半截思考本就不该当可回放数据用。
      else if (this.open.kind === "thinking") content.push(this.thinkingBlock(this.open.buf, {}));
    }
    return {
      role: "assistant",
      content,
      stopReason: "end_turn",
      usage: null,
      model: { provider: this.model.provider, id: this.model.id },
    };
  }

  takeWarnings(): ProviderEvent[] {
    if (this.warnings.length === 0) return [];
    const w = this.warnings;
    this.warnings = [];
    return w;
  }

  reset(): void {
    this.blocks = [];
    this.open = null;
    this.warnings = [];
  }
}

function parseArgs(raw: string): Record<string, unknown> | null {
  const s = raw.trim();
  if (s === "") return {}; // 无参工具：空串等价于 {}
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export { emptyAssistant };
