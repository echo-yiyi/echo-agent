// Permission ledger：Agent 私有的 pending ask 账本。
//
// 它回答三件事，且每件都在同一个同步临界区里裁决（JS 单线程，方法内不 await）：
//   - open：只有真正进入 ask 才生成 ID、登记 pending、挂 timeout/abort；
//   - answer：当前 open 的 ID → accepted（并唤醒 waiter）；已封口的 ID → closed(原因)；不认识的 → stale；
//   - settle：answer / timeout / run abort / dispose 四条路只能有一条先赢，赢了就封口进 tombstone。
// tombstone 有界（FIFO 淘汰），至少活到 run 封口；淘汰之后旧 ID 只能是 stale(unknown)。

import type {
  PermissionAnswer,
  PermissionAnswerResult,
  PermissionAsk,
  PermissionAskHandle,
  PermissionSettlement,
  PermissionVerdict,
} from "./types.ts";

type ClosedReason = Extract<PermissionAnswerResult, { kind: "closed" }>["reason"];

type OpenEntry = {
  readonly ask: PermissionAsk;
  readonly resolve: (s: PermissionSettlement) => void;
  readonly cleanup: () => void;
};

type Tombstone = { readonly reason: ClosedReason; readonly runId: string; readonly toolCallId: string };

/** run 封口后 tombstone 进有界池；池满淘汰最早封口的（那之后旧 ID 只能是 stale(unknown)）。 */
const ARCHIVE_LIMIT = 256;

export class PermissionLedger {
  private readonly open = new Map<string, OpenEntry>();
  /** 全部已封口的 ask（未封口 run 的 + 有界池里的）。 */
  private readonly tombstones = new Map<string, Tombstone>();
  /** 未封口 run 的 tombstone id：**run 没封口，一条都不丢**——同一 run 第 257 个 ask 不能把第一个挤成 unknown。 */
  private readonly liveRuns = new Map<string, Set<string>>();
  /** 已封口 run 的 tombstone id，FIFO；只有这里受 ARCHIVE_LIMIT 约束。 */
  private readonly archivedOrder: string[] = [];
  private disposed = false;

  /** 有没有还在等人的 ask（Inspector / 诊断用）。 */
  get pending(): readonly PermissionAsk[] {
    return [...this.open.values()].map((e) => e.ask);
  }

  /**
   * 进入 ask：生成 ID、登记、挂 timeout 与 run abort。返回的 `settled` 恰好 fulfill 一次，绝不 reject——
   * 四种封口都是正常分支。
   */
  openAsk(
    input: Omit<PermissionAsk, "permissionId">,
    opts: { readonly timeoutMs: number | null; readonly signal: AbortSignal },
  ): PermissionAskHandle {
    const permissionId = crypto.randomUUID();
    const ask: PermissionAsk = Object.freeze({ ...input, permissionId });
    if (this.disposed) {
      // 已经 dispose 的 Agent 不该再进 ask；诚实起见给一个已封口的 handle，而不是挂死。
      this.remember(permissionId, ask, "runtime-disposed");
      return { permissionId, settled: Promise.resolve({ kind: "cancelled", reason: "runtime-disposed" }) };
    }

    let resolve!: (s: PermissionSettlement) => void;
    const settled = new Promise<PermissionSettlement>((r) => {
      resolve = r;
    });
    const timer =
      opts.timeoutMs !== null
        ? setTimeout(() => {
            this.settle(permissionId, "timed-out", { kind: "deny", decidedBy: "timeout", reason: `等待授权超时（${opts.timeoutMs}ms）` });
          }, opts.timeoutMs)
        : undefined;
    const onAbort = (): void => {
      this.settle(permissionId, "run-aborted", { kind: "cancelled", reason: "run-aborted" });
    };
    if (opts.signal.aborted) {
      // 进 ask 那一刻 run 已经在中止：不等了，直接封口。
      if (timer !== undefined) clearTimeout(timer);
      this.remember(permissionId, ask, "run-aborted");
      return { permissionId, settled: Promise.resolve({ kind: "cancelled", reason: "run-aborted" }) };
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });

    this.open.set(permissionId, {
      ask,
      resolve,
      cleanup: () => {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
      },
    });
    return { permissionId, settled };
  }

  /** 可信宿主的回答。同步裁决：并发回答只有第一个 accepted，其余 closed(answered)。 */
  answer(input: PermissionAnswer): PermissionAnswerResult {
    const { permissionId } = input;
    if (this.disposed) return { kind: "closed", permissionId, reason: "runtime-disposed" };
    const entry = this.open.get(permissionId);
    if (entry !== undefined) {
      const decision = input.decision;
      const settlement: PermissionSettlement =
        decision === "allow"
          ? { kind: "allow", decidedBy: "human" }
          : { kind: "deny", decidedBy: "human", reason: input.reason ?? "裁决人拒绝" };
      this.settle(permissionId, "answered", settlement);
      return { kind: "accepted", permissionId, runId: entry.ask.runId, toolCallId: entry.ask.toolCallId, decision };
    }
    const tomb = this.tombstones.get(permissionId);
    if (tomb !== undefined) {
      // **同一 run、同一 tool call** 若已经有一份新的 open ask（重试路径），告诉调用方该答哪一份——
      // 但绝不代它重投旧 decision。身份是 runId + toolCallId：不同 run 会复用同一 toolCallId，只按
      // toolCallId 判会把旧 run 的 ID 错指向新 run 的 ask（实测）。
      const current = this.openIdFor(tomb.runId, tomb.toolCallId);
      if (current !== undefined) return { kind: "stale", permissionId, reason: "superseded", currentPermissionId: current };
      return { kind: "closed", permissionId, reason: tomb.reason };
    }
    return { kind: "stale", permissionId, reason: "unknown" };
  }

  /**
   * run 封口：该 run 的 tombstone 从「一条不丢」转进有界 FIFO 池。**retention 至少持续到 run closure**——
   * run 还没封口时，第 257 个 ask 不能把第一个挤成 stale(unknown)。
   */
  closeRun(runId: string): void {
    const ids = this.liveRuns.get(runId);
    if (ids === undefined) return;
    this.liveRuns.delete(runId);
    for (const id of ids) this.archivedOrder.push(id);
    while (this.archivedOrder.length > ARCHIVE_LIMIT) {
      const oldest = this.archivedOrder.shift();
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
  }

  /** 全部 pending ask 一起封口（run abort 由各自的 signal 处理；这里是 dispose）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.open.keys()]) {
      this.settle(id, "runtime-disposed", { kind: "cancelled", reason: "runtime-disposed" });
    }
  }

  private settle(permissionId: string, reason: ClosedReason, settlement: PermissionSettlement): void {
    const entry = this.open.get(permissionId);
    if (entry === undefined) return; // 已被另一条路先封口：晚到的一律无效
    this.open.delete(permissionId);
    entry.cleanup();
    this.remember(permissionId, entry.ask, reason);
    entry.resolve(settlement);
  }

  private remember(permissionId: string, ask: PermissionAsk, reason: ClosedReason): void {
    this.tombstones.set(permissionId, { reason, runId: ask.runId, toolCallId: ask.toolCallId });
    let ids = this.liveRuns.get(ask.runId);
    if (ids === undefined) {
      ids = new Set();
      this.liveRuns.set(ask.runId, ids);
    }
    ids.add(permissionId);
  }

  private openIdFor(runId: string, toolCallId: string): string | undefined {
    for (const [id, e] of this.open) if (e.ask.runId === runId && e.ask.toolCallId === toolCallId) return id;
    return undefined;
  }
}

/**
 * authorization 的返回**在运行时穷举验形**——TypeScript 挡不住 JS 调用方或 `as never`：
 * 上一版 loop 里最后一个 else 默认代表 allow，策略返回 `{ kind: "bogus" }` 工具照样执行（实测）。
 * 现在：不是 allow / ask / deny 三者之一、ask/deny 缺 reason、根本不是对象，一律 deny（fail-closed）。
 * Agent 的 stage 与 loop 各验一次：loop 不信任任何 PermissionStage 实现。
 */
export function normalizeVerdict(v: unknown): PermissionVerdict {
  if (typeof v === "object" && v !== null) {
    const kind = (v as { kind?: unknown }).kind;
    if (kind === "allow") return { kind: "allow" };
    const reason = (v as { reason?: unknown }).reason;
    if ((kind === "deny" || kind === "ask") && typeof reason === "string" && reason.length > 0) {
      return { kind, reason };
    }
  }
  let shown: string;
  try {
    shown = JSON.stringify(v) ?? String(v);
  } catch {
    shown = String(v);
  }
  return { kind: "deny", reason: `authorization 返回非法裁决（fail-closed 拦下）：${shown}` };
}

/** 参数里出现了冻不住的值：不能原样放行，只能拒（fail-closed）。 */
export class UnfreezableParamsError extends Error {
  constructor(
    readonly path: string,
    readonly kind: string,
  ) {
    super(`${path} 是 ${kind}，不是可冻结的 plain data（参数只能是 JSON 形状的对象/数组/原始值）`);
    this.name = "UnfreezableParamsError";
  }
}

/**
 * 把最终参数冻成不可变快照：递归覆盖**全部可达**的 plain object / array。
 *   - **不因当前节点已冻结就跳过子节点**：调用方浅 `Object.freeze()` 过的顶层，嵌套照样可改（实测绕过）；
 *   - cycle-safe：用 WeakSet 记已访问，循环引用不会栈溢出；
 *   - 非 plain 可变对象（class 实例、Map/Set、Date、TypedArray）与函数**一律拒绝**——冻不住的东西不能原样放行；
 *     需要它们的工具在 execute 里自己从 plain 值构造。
 */
export function deepFreezePlain<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (v: unknown, path: string): void => {
    if (typeof v === "function") throw new UnfreezableParamsError(path, "函数");
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    const proto = Object.getPrototypeOf(v);
    const plain = Array.isArray(v) || proto === Object.prototype || proto === null;
    if (!plain) throw new UnfreezableParamsError(path, describe(v));
    Object.freeze(v);
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) visit(child, `${path}.${k}`);
  };
  visit(value, "params");
  return value;
}

function describe(v: object): string {
  const name = v.constructor?.name;
  return name !== undefined && name !== "" ? `${name} 实例` : "非 plain 对象";
}
