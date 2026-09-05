// Question ledger：Agent 私有的 pending 提问账本，`permission/ledger.ts` 的同款、去掉 run 维度的那一版。
// 同一个同步临界区里裁决（方法内不 await）：answer / timeout / abort / dispose 四条路只有一条先赢，
// 赢了就封口进 tombstone；tombstone 有界（FIFO），淘汰之后旧 ID 只能是 stale(unknown)。

import type { QuestionAnswer, QuestionAnswerResult, QuestionAsk, QuestionAskHandle, QuestionSettlement } from "./types.ts";

type ClosedReason = Extract<QuestionAnswerResult, { kind: "closed" }>["reason"];

type OpenEntry = {
  readonly ask: QuestionAsk;
  readonly resolve: (s: QuestionSettlement) => void;
  readonly cleanup: () => void;
};

const ARCHIVE_LIMIT = 256;

export class QuestionLedger {
  private readonly open = new Map<string, OpenEntry>();
  private readonly tombstones = new Map<string, ClosedReason>();
  private readonly archivedOrder: string[] = [];
  private disposed = false;

  /** 还在等人的提问（壳子重挂时据此补摆）。 */
  get pending(): readonly QuestionAsk[] {
    return [...this.open.values()].map((e) => e.ask);
  }

  /** 登记一次提问：生成 ID、挂 timeout 与 abort。`settled` 恰好 fulfill 一次，绝不 reject。 */
  openAsk(input: Omit<QuestionAsk, "questionId">, opts: { readonly timeoutMs: number | null; readonly signal: AbortSignal }): QuestionAskHandle {
    const questionId = crypto.randomUUID();
    const ask: QuestionAsk = Object.freeze({ ...input, questionId, options: Object.freeze(input.options.map((o) => Object.freeze({ ...o }))) });
    if (this.disposed) {
      this.remember(questionId, "runtime-disposed");
      return { questionId, ask, settled: Promise.resolve({ kind: "unanswered", reason: "runtime-disposed" }) };
    }
    if (opts.signal.aborted) {
      this.remember(questionId, "run-aborted");
      return { questionId, ask, settled: Promise.resolve({ kind: "unanswered", reason: "run-aborted" }) };
    }
    let resolve!: (s: QuestionSettlement) => void;
    const settled = new Promise<QuestionSettlement>((r) => {
      resolve = r;
    });
    const timer =
      opts.timeoutMs !== null
        ? setTimeout(() => this.settle(questionId, "timed-out", { kind: "unanswered", reason: "timed-out" }), opts.timeoutMs)
        : undefined;
    const onAbort = (): void => this.settle(questionId, "run-aborted", { kind: "unanswered", reason: "run-aborted" });
    opts.signal.addEventListener("abort", onAbort, { once: true });
    this.open.set(questionId, {
      ask,
      resolve,
      cleanup: () => {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
      },
    });
    return { questionId, ask, settled };
  }

  /** 可信宿主的回答。并发回答只有第一个 accepted，其余 closed(answered)。 */
  answer(input: QuestionAnswer): QuestionAnswerResult {
    const { questionId } = input;
    if (this.disposed) return { kind: "closed", questionId, reason: "runtime-disposed" };
    const entry = this.open.get(questionId);
    if (entry !== undefined) {
      this.settle(questionId, "answered", {
        kind: "answered",
        selected: [...input.selected],
        ...(input.text !== undefined && input.text !== "" ? { text: input.text } : {}),
      });
      return { kind: "accepted", questionId, toolCallId: entry.ask.toolCallId };
    }
    const tomb = this.tombstones.get(questionId);
    if (tomb !== undefined) return { kind: "closed", questionId, reason: tomb };
    return { kind: "stale", questionId, reason: "unknown" };
  }

  /** 全部 pending 一起封口（Agent dispose）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.open.keys()]) this.settle(id, "runtime-disposed", { kind: "unanswered", reason: "runtime-disposed" });
  }

  private settle(questionId: string, reason: ClosedReason, settlement: QuestionSettlement): void {
    const entry = this.open.get(questionId);
    if (entry === undefined) return; // 已被另一条路先封口：晚到的一律无效
    this.open.delete(questionId);
    entry.cleanup();
    this.remember(questionId, reason);
    entry.resolve(settlement);
  }

  private remember(questionId: string, reason: ClosedReason): void {
    this.tombstones.set(questionId, reason);
    this.archivedOrder.push(questionId);
    while (this.archivedOrder.length > ARCHIVE_LIMIT) {
      const oldest = this.archivedOrder.shift();
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
  }
}
