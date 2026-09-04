// 事件流：同一个流，既能 for await 逐字消费（UI），又能 await result() 一把梭
// （评测 / 摘要 / 子 agent）。
//
// **单消费者契约**：waiter 是单槽——循环是唯一的 for-await 方；UI 看的是循环转播的
// AgentEvent，不直接喝这条流。要多消费者得加广播缓冲，复杂度不值。

import { agentError, type AgentError } from "./errors.ts";
import type { AssistantMessage } from "./messages.ts";
import type { ProviderEvent, StreamItem } from "./events.ts";

export class EventStream<T, R> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;
  private readonly final: Promise<R>;
  private resolveFinal!: (r: R) => void;

  constructor(
    private readonly isComplete: (e: T) => boolean,
    private readonly extractResult: (e: T) => R,
  ) {
    this.final = new Promise<R>((res) => {
      this.resolveFinal = res;
    });
  }

  push(e: T): void {
    // 终结后到达的事件一律丢弃：重试残响、迟到的 delta 都无害地消失（幂等）。
    if (this.closed) return;
    if (this.isComplete(e)) {
      this.closed = true;
      this.resolveFinal(this.extractResult(e));
    }
    const w = this.waiter;
    if (w !== null) {
      this.waiter = null;
      w({ value: e, done: false });
    } else {
      this.queue.push(e);
    }
  }

  /** 跑完拿最终结果。终结事件 push 的那一刻兑现。 */
  result(): Promise<R> {
    return this.final;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const buffered = this.queue.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return; // 终结事件已吐完
      const r = await new Promise<IteratorResult<T>>((res) => {
        this.waiter = res;
      });
      if (r.done === true) return;
      yield r.value;
    }
  }
}

/**
 * 助手消息流的特化：完成 = done | error；结果 = done 取 message、error 取抢救出的消息。
 *
 * **抢救只写这一处**：适配器只管报错（`error` 事件），把「用已流出的 partial 拼一条
 * stopReason:"error" 的消息」这件事集中在这里——否则每家适配器都要实现一遍。
 */
export class AssistantMessageEventStream extends EventStream<StreamItem, AssistantMessage> {
  constructor() {
    super(
      (e) => e.type === "done" || e.type === "error",
      (e) => (e.type === "done" ? e.message : finalizeError(e.partial, (e as { error: AgentError }).error)),
    );
  }
}

/** 把「已经流出来的半截」+ 错误，合成一条完整的失败助手消息——partial 不丢弃。 */
export function finalizeError(partial: AssistantMessage, error: AgentError): AssistantMessage {
  return {
    ...partial,
    stopReason: error.code === "aborted" ? "aborted" : "error",
    ...(error.code === "aborted" ? {} : { error }),
  };
}

export function emptyAssistant(): AssistantMessage {
  return { role: "assistant", content: [], stopReason: "error", usage: null };
}

/** 给事件挂上此刻的 partial（累积由适配器外壳做，见 provider/dialect.ts）。 */
export function withPartial(ev: ProviderEvent, partial: AssistantMessage): StreamItem {
  return { ...ev, partial } as StreamItem;
}

export function protocolViolation(what: string): AgentError {
  return agentError("provider", "protocol", what, false);
}
