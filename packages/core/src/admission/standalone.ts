// StandaloneRunAdmission（§14.2.4）：standalone Agent 自带的 run admission——单 permit 的串行 actor。
//
// 规则（都是 ABI 结算规则，conformance 锁着）：
//   - 一次只有一个 permit；foreground（user / inbox）高于 maintenance（Dream）：没有 active permit、没有排队的
//     foreground 时才给 Dream；Dream 在跑时 foreground 到达 → abort Dream 的 scope signal、等它 close、再跑 foreground；
//     还没拿到 permit 的 maintenance ticket 被 foreground 挤掉 → rejected(superseded)；
//   - 每个 request 的 execute **至多调用一次**；rejected 的零次；
//   - 每个 ticket 的 settled **恰好 fulfill 一次**，绝不 reject：四种正常 rejected 也是 fulfill；
//   - execute 同步 throw / 异步 reject 由这里捕获，交给 Host 的 normalizer 合成配对的终结事件与 LoopResult，
//     ticket 以 callback-error fulfill——不逃成 ticket rejection，也不跳过 permit close；
//   - 调度永远在当前 callback 返回、permit 已 close 之后（微任务）：execute 里再 enqueue 不会递归执行。
//
// RunPermit、binding 的来源、失败规范化都由 deps 注入；这个类本身不认识 Agent。

import type { LoopResult } from "../loop/types.ts";
import type { AgentError } from "../errors.ts";
import { errText } from "../errors.ts";
import type {
  AgentAdmissionExecuteScope,
  AgentAdmissionPort,
  AgentAdmissionResult,
  AgentAdmissionTicket,
  AgentInternalRunRequest,
  RunModelBinding,
  RunSource,
} from "./types.ts";
import { assertInternalRunRequest } from "./request.ts";

export type AdmissionDeps = Readonly<{
  /** 为这次 admission 冻结 model seam。契约：不抛（standalone 在装备 setter 就验过 model）。 */
  binding(input: { source: RunSource; purpose: "foreground" | "maintenance" }): RunModelBinding;
  /**
   * execute 抛错的规范化（Host-internal、non-throwing）：该 run 尚无终态 → 合成终结事件 + LoopResult；
   * 已有终态 → 复用暂存的 LoopResult、只记 callback contract failure，不发第二个 agent_end。
   */
  normalizeFailure(input: { runId: string; source: RunSource; error: unknown; aborted: boolean }): Promise<LoopResult>;
  /** inbox request 的 reservation 核对：同步，抛 = 受保护接线的编程不变量破坏，enqueue 在创建 ticket 前抛出去。 */
  assertReserved?(reservationId: string, orderedRecordIds: readonly string[]): void;
  /** runId 生成（缺省 `run:<uuid>` / `dream:<uuid>`）。 */
  runId?(source: RunSource): string;
}>;

type Priority = "foreground" | "maintenance";

type Slot = {
  readonly requestId: string;
  readonly source: RunSource;
  readonly purpose: "foreground" | "maintenance";
  readonly priority: Priority;
  readonly execute: (scope: AgentAdmissionExecuteScope) => Promise<LoopResult>;
  readonly settle: (result: AgentAdmissionResult) => void;
};

type Active = {
  readonly slot: Slot;
  readonly runId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
};

export type ClosedReason = "stopping" | "lease-lost";

export class StandaloneRunAdmission implements AgentAdmissionPort {
  private readonly foreground: Slot[] = [];
  private maintenance: Slot | null = null;
  private active: Active | null = null;
  private closed: ClosedReason | null = null;
  private pumpScheduled = false;
  private seq = 0;

  constructor(private readonly deps: AdmissionDeps) {}

  /** 正在持有 permit 的 run（Inspector / 测试用）。 */
  get activeRun(): Readonly<{ runId: string; source: RunSource; purpose: "foreground" | "maintenance" }> | null {
    const a = this.active;
    return a === null ? null : { runId: a.runId, source: a.slot.source, purpose: a.slot.purpose };
  }
  get pendingForeground(): number {
    return this.foreground.length;
  }
  get pendingMaintenance(): boolean {
    return this.maintenance !== null;
  }

  enqueue<TResult extends LoopResult>(
    request: AgentInternalRunRequest,
    execute: (scope: AgentAdmissionExecuteScope) => Promise<TResult>,
  ): AgentAdmissionTicket<TResult> {
    // 受保护接线的不变量：形状按 source.kind 穷举（request.ts）、reservation 不存在或已消费——创建 ticket 前同步 fail-loud
    assertInternalRunRequest(request);
    if (request.source.kind === "inbox") {
      const r = request as Extract<AgentInternalRunRequest, { source: { kind: "inbox" } }>;
      this.deps.assertReserved?.(r.reservationId, r.reservedRecordIds);
      return this.submit({ kind: "inbox" }, "foreground", "foreground", execute);
    }
    return this.submit({ kind: "dream" }, "maintenance", "maintenance", execute);
  }

  /** Host 私有：用户 run（standalone 的 prompt / continue）。不在 AgentAdmissionPort 上。 */
  admitUser<TResult extends LoopResult>(
    execute: (scope: AgentAdmissionExecuteScope) => Promise<TResult>,
  ): AgentAdmissionTicket<TResult> {
    return this.submit({ kind: "user" }, "foreground", "foreground", execute);
  }

  /** 前台抢占 / 收摊共用：还没拿到 permit 的 Dream → superseded；在跑的 Dream → abort 并等它 close。 */
  async abortMaintenance(): Promise<void> {
    this.supersedeMaintenance();
    const a = this.active;
    if (a !== null && a.slot.priority === "maintenance") {
      a.controller.abort();
      await a.done;
    }
  }

  /** Host 私有：abort 正在持有 permit 的 run（shutdown-grade abort；可信宿主的 `--abort-run` 走这里）。没有在跑的就 no-op。 */
  abortActive(): void {
    this.active?.controller.abort();
  }

  /** 关门：之后的 enqueue 一律 rejected(reason)；排队的全部 rejected；在跑的 abort 并等它 close。 */
  async close(reason: ClosedReason): Promise<void> {
    this.closed = reason;
    for (const s of this.foreground.splice(0)) s.settle({ kind: "rejected", reason });
    if (this.maintenance !== null) {
      const m = this.maintenance;
      this.maintenance = null;
      m.settle({ kind: "rejected", reason });
    }
    const a = this.active;
    if (a !== null) {
      a.controller.abort();
      await a.done;
    }
  }

  private submit<TResult extends LoopResult>(
    source: RunSource,
    priority: Priority,
    purpose: "foreground" | "maintenance",
    execute: (scope: AgentAdmissionExecuteScope) => Promise<TResult>,
  ): AgentAdmissionTicket<TResult> {
    const requestId = `req:${++this.seq}`;
    let settle!: (r: AgentAdmissionResult) => void;
    const settled = new Promise<AgentAdmissionResult<TResult>>((resolve) => {
      settle = resolve as (r: AgentAdmissionResult) => void;
    });
    const slot: Slot = { requestId, source, purpose, priority, execute, settle };
    if (this.closed !== null) {
      settle({ kind: "rejected", reason: this.closed });
      return { requestId, settled };
    }
    if (priority === "foreground") {
      this.foreground.push(slot);
      // 前台到了：还没拿到 permit 的 Dream 让位
      this.supersedeMaintenance();
    } else {
      this.supersedeMaintenance(); // 只留最新的一个 maintenance 请求
      this.maintenance = slot;
    }
    this.schedulePump();
    return { requestId, settled };
  }

  private supersedeMaintenance(): void {
    if (this.maintenance === null) return;
    const m = this.maintenance;
    this.maintenance = null;
    m.settle({ kind: "rejected", reason: "superseded" });
  }

  /** 调度永远在微任务里：enqueue 的调用方（可能正在别的 execute 里）先返回。 */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.active !== null) {
      // Dream 在跑、前台来了：abort 它；它 close 后 run() 末尾会再 pump
      if (this.active.slot.priority === "maintenance" && this.foreground.length > 0) this.active.controller.abort();
      return;
    }
    const next = this.foreground.shift() ?? this.takeMaintenance();
    if (next === undefined) return;
    void this.run(next);
  }

  private takeMaintenance(): Slot | undefined {
    if (this.maintenance === null || this.foreground.length > 0) return undefined;
    const m = this.maintenance;
    this.maintenance = null;
    return m;
  }

  /**
   * 一次 permit 的生命周期。**清 active、结算 ticket、唤醒队列三件事在不可失败的 finally 里**：
   * runId() / binding() / execute / normalizeFailure 任何一处抛错，都不能让 ticket 永久 pending、后续 admission 全部卡住（实测）。
   */
  private async run(slot: Slot): Promise<void> {
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((r) => {
      finish = r;
    });
    let runId = `${slot.source.kind === "dream" ? "dream" : "run"}:unassigned`;
    let result: AgentAdmissionResult | null = null;
    try {
      runId = this.deps.runId?.(slot.source) ?? defaultRunId(slot.source);
      this.active = { slot, runId, controller, done };
      let failure: { readonly error: unknown } | null = null;
      try {
        const binding = this.deps.binding({ source: slot.source, purpose: slot.purpose });
        const scope: AgentAdmissionExecuteScope = Object.freeze({ runId, signal: controller.signal, modelBinding: binding });
        // execute 同步 throw 也落进这个 catch（await 一个同步抛错的调用 = rejection）
        const r = await slot.execute(scope);
        result = { kind: "executed", runId, result: r };
      } catch (e) {
        failure = { error: e };
      }
      if (failure !== null) {
        const aborted = controller.signal.aborted;
        let normalized: LoopResult;
        try {
          normalized = await this.deps.normalizeFailure({ runId, source: slot.source, error: failure.error, aborted });
        } catch (sinkError) {
          // normalizer 自己也抛：actor 兜底造最小 LoopResult——ticket 仍要恰好 fulfill 一次
          normalized = minimalFailureResult(aborted, failure.error, sinkError);
        }
        result = { kind: "callback-error", runId, result: normalized, error: toAgentError(failure.error, aborted) };
      }
    } catch (e) {
      // runId() 抛、或上面兜底之外的任何意外：仍按 callback-error 封口，绝不留 pending
      const aborted = controller.signal.aborted;
      result = { kind: "callback-error", runId, result: minimalFailureResult(aborted, e, null), error: toAgentError(e, aborted) };
    } finally {
      // permit close：先撤 active，再结算 ticket，最后才调度下一个（微任务）——execute 里 enqueue 的不会递归执行
      this.active = null;
      slot.settle(result ?? { kind: "callback-error", runId, result: minimalFailureResult(false, "run() 未产生结果", null), error: toAgentError("run() 未产生结果", false) });
      finish();
      this.schedulePump();
    }
  }
}

/** normalizer 不可用时的最小 LoopResult：non-retryable internal error / aborted，messages 空。 */
function minimalFailureResult(aborted: boolean, error: unknown, sinkError: unknown | null): LoopResult {
  if (aborted) return { outcome: { kind: "aborted" }, messages: [] };
  const message = sinkError === null ? errText(error) : `${errText(error)}（failure normalizer 自身也失败：${errText(sinkError)}）`;
  return { outcome: { kind: "error", error: { source: "internal", code: "internal", retryable: false, message } }, messages: [] };
}

function defaultRunId(source: RunSource): string {
  return `${source.kind === "dream" ? "dream" : "run"}:${crypto.randomUUID()}`;
}

function toAgentError(e: unknown, aborted: boolean): AgentError {
  return {
    source: "internal",
    code: aborted ? "aborted" : "internal",
    retryable: false,
    message: `run callback 违约：${errText(e)}`,
  };
}
