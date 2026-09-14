// ObservationRuntime（O3a）：完整 Runtime 里 canonical writer 的宿主——
// 持有唯一的 Sequencer 与观测写入端（状态根里的文档，见 document-store.ts），是 run 三条边界（`run.accepted / run.started / run.closed`）的**唯一 emission owner**，
// 并按 `capabilitySink(descriptor, owner)` 给各执行节点发探针（循环、压缩、Agent 自身、各能力模块）。
// **不订阅、不转发 AgentEvent**：那是给壳的事件协议，观测是插桩（`docs/design/observability.md`）。
//
// 失败语义（2026-09-03 用户拍板：**观测不得影响 agent 主线**，放弃 fail-closed admission）：
//   · `run.accepted` / `run.assembly` / `run.started` 只**同步预留 seq**（顺序由预留决定，不由落盘决定），提交是
//     fire-and-forget；落不下去只降级 persistence + 诊断，**永远不拒 run、不让 run 等**；
//   · `run.closed` 仍等它 COMMIT——它在 run 的活干完之后，`send()` 靠它如实报 `observationPersistence`；等待有界
//     （`boundaryDeadlineMs`），到期即降级返回；
//   · 观测层任何异常都不进 Agent 控制流——这里每个公开方法都不抛。
//
// 过期规则归产品（`expiry`），这里只执行：持锁之后（`activate()`）先补齐以前进程没写完的派生文件、再过期一次；
// 之后每个 run 封口落盘再过期一次；`observations.expire()` 随时可调。都在后台跑、撞在一起时合并，交还 lease 或丢锁前停下。
//
// 由 `createAgent()` 构造并经 `attachObservationHost()` 挂到 Agent 上；低层 `new Agent()` 没有它。

import type { Clock } from "../schedule/clock.ts";
import type { Diagnostic } from "../errors.ts";
import type { AgentEvent, AgentOutcome } from "../events.ts";
import type { RunModelBinding } from "../admission/types.ts";
import type { Model } from "../provider/types.ts";
import { BUILTIN_GENERATION } from "../extension/builtin.ts";
import { snapshotRunModelBinding } from "./assembly.ts";
import { RUN_ASSEMBLY_RECORD, type BoundaryObservationDraft, type RunAcceptedBodyV1, type RunAssemblyBodyV1, type RunObservationHeaderSeed, type RunStartedBodyV1 } from "./draft.ts";
import { LiveEchoObservations } from "./query.ts";
import { factSinkToIngest, type CapabilityFactDescriptor, type CapabilityFactSink } from "./fact-sink.ts";
import { sha256Hex } from "./hash.ts";
import { redactedLabel } from "./redact.ts";
import { ObservationSequencer, type SequencerLimits } from "./sequencer.ts";
import type { DocumentObservationStore } from "./document-store.ts";
import type {
  AgentAssemblyObservationSnapshot,
  EchoObservableState,
  ObservationCapturePolicy,
  ObservationOwner,
  ObservationRecordKind,
  ObservedRunSource,
  RunClosedBodyInput,
  RunClosedOutcomeObservation,
  RunIndexEntryV1,
  RunObservationHeader,
  RuntimePhase,
} from "./types.ts";
import { OBSERVATION_BOUNDARY_LIMITS as BOUNDARY_LIMITS } from "./types.ts";

/** run 边界与装配快照记录的 instrumentation：admission 这条路，与 AgentEvent tap（`echo.agent-event`）分开。 */
export const RUN_ADMISSION_INSTRUMENTATION = { name: "echo.run-admission", version: "1" } as const;

/** builtin Entry 的 owner（OR13 known）。按需构造而不是模块顶层常量：避免与 extension/builtin.ts 的环状 import 在求值期撞 TDZ。 */
export function builtinOwner(entryId: string): ObservationOwner {
  return { status: "known", entryId, entryGeneration: BUILTIN_GENERATION, via: "assembly" };
}

/** Agent 循环自己发的事实（run 边界、turn / model / tool span）都归 `echo:agent` 这一 builtin Entry。 */
export const AGENT_ENTRY_ID = "echo:agent";
/** 三个 O3a 领域行的 owner：与 extension/builtin.ts 的 tool pack 同名。 */
export const MEMORY_ENTRY_ID = "echo:memory";
export const TASKS_ENTRY_ID = "echo:tasks";
export const SCHEDULER_ENTRY_ID = "echo:scheduler";

/** 过期规则的返回值：要删的 run，与 run 之外记录的回收线。都不给 = 这一次什么都不删。 */
export type ObservationExpiryDecision = Readonly<{
  /** 要删掉的 run。当前进程还在跟踪的 run 拒删（报诊断）。 */
  runs?: readonly string[];
  /** 早于这个时刻（毫秒时间戳，比记录的 observedAt）的 run 之外记录可以回收。不给 = run 之外的记录不删。 */
  activityBefore?: number;
}>;

/** 产品给的过期规则：拿到全部 run 的 header（按 acceptedAt 倒序）与此刻，返回要删什么。不给规则 = 永不删。 */
export type ObservationExpiryRule = (runs: readonly RunObservationHeader[], now: number) => ObservationExpiryDecision;

export type ObservationRuntimeOptions = Readonly<{
  runtimeId: string;
  /** RuntimeGeneration；O3a 只有 boot 一代。 */
  runtimeGeneration: string;
  capturePolicy: ObservationCapturePolicy;
  store: DocumentObservationStore;
  clock: Clock;
  /** 过期规则（产品给）。不给 = 永不删。 */
  expiry?: ObservationExpiryRule;
  /** `createAgent()` 封口的 builtin 槽快照；每个 run 的 `run.assembly` 记录引用它。 */
  assembly: AgentAssemblyObservationSnapshot;
  limits?: Partial<SequencerLimits>;
}>;

export type RunAcceptInput = Readonly<{
  runId: string;
  source: ObservedRunSource;
  agentId: string;
  agentInstanceId: string;
  sessionId: string | null;
  modelBinding: RunModelBinding;
}>;

export type RunCloseInput = Readonly<{
  runId: string;
  outcome: AgentOutcome;
  /** finalizer 冻结的可观测状态；`capturePolicy:"off"` 时调用方给 null（不投影）。 */
  finalState: EchoObservableState | null;
}>;

export type ObservationScopeSupplier = () => Readonly<Record<string, string>>;

/** `finishReason` 等安全串的构造上限（UTF-8 ≤ maxSafeStringBytes）；超出按 code unit 截断并标记。 */
function clipSafeString(s: string): string {
  const max = BOUNDARY_LIMITS.maxSafeStringBytes;
  if (new TextEncoder().encode(s).byteLength <= max) return s;
  let out = s;
  while (out.length > 0 && new TextEncoder().encode(`${out}…`).byteLength > max) out = out.slice(0, -1);
  return `${out}…`;
}

/** `AgentOutcome` → 有界的 terminal outcome：正文 / message 不进 boundary，只留 code + digest。 */
export function toRunClosedOutcome(outcome: AgentOutcome): RunClosedOutcomeObservation {
  switch (outcome.kind) {
    case "completed":
      return { status: "completed" };
    case "aborted":
      return outcome.reason === undefined ? { status: "aborted" } : { status: "aborted", finishReason: clipSafeString(outcome.reason) };
    case "error":
      return { status: "error", errorCode: clipSafeString(outcome.error.code), errorDigest: sha256Hex(outcome.error.message) };
  }
}

export class ObservationRuntime {
  readonly runtimeId: string;
  readonly runtimeGeneration: string;
  readonly capturePolicy: ObservationCapturePolicy;
  readonly assembly: AgentAssemblyObservationSnapshot;
  readonly store: DocumentObservationStore;
  readonly sequencer: ObservationSequencer;
  /** live 查询面（`echo.observations`）：同一个 Sequencer + 同一个写入端的只读查询。 */
  readonly observations: LiveEchoObservations;
  private readonly clock: Clock;
  /** 随库首建、永不改写；库关了之后挂 sink（stop 后再 start 的拒绝路径）也不能再去读它。 */
  private readonly pathDigestKeyBytes: Uint8Array;
  private report: (d: Diagnostic) => void = () => {};
  private scopeSupplier: ObservationScopeSupplier = () => ({});
  private phase: RuntimePhase = "ready";
  private disposing: Promise<void> | undefined;
  private readonly expiry: ObservationExpiryRule | undefined;
  /** 持着 lease：补齐与过期只在这期间做。 */
  private active = false;
  /** 在跑的补齐 / 过期；撞上时记一笔跑完再来一次。 */
  private maintenance: Promise<void> | null = null;
  private maintenanceAgain = false;
  private repairPending = false;

  constructor(opts: ObservationRuntimeOptions) {
    this.runtimeId = opts.runtimeId;
    this.runtimeGeneration = opts.runtimeGeneration;
    this.capturePolicy = opts.capturePolicy;
    this.assembly = opts.assembly;
    this.store = opts.store;
    this.clock = opts.clock;
    this.expiry = opts.expiry;
    this.pathDigestKeyBytes = opts.store.readPathDigestKey();
    this.sequencer = new ObservationSequencer({
      runtimeId: opts.runtimeId,
      runtimeGeneration: opts.runtimeGeneration,
      capturePolicy: opts.capturePolicy,
      store: opts.store,
      clock: opts.clock,
      ...(opts.limits === undefined ? {} : { limits: opts.limits }),
      // Sequencer 构造在 Agent 之前：诊断先经这层代理，Agent 起来后 `attachDiagnostics` 换目标
      report: (d) => this.report(d),
    });
    this.observations = new LiveEchoObservations({
      runtimeId: opts.runtimeId,
      sequencer: this.sequencer,
      store: opts.store,
      clock: opts.clock,
      phase: () => this.phase,
      expire: () => this.expireNow(),
    });
  }

  /** Agent 拉：观测层的诊断走 Agent 的诊断通道（与 InboxStore.attachDiagnostics 同款）。 */
  attachDiagnostics(report: (d: Diagnostic) => void): void {
    this.report = report;
  }

  get runtimePhase(): RuntimePhase {
    return this.phase;
  }

  /** 当前 Runtime 对某 run 的 persistence 投影：终态已 COMMIT 进 RunIndex 才是 stored，否则 degraded。 */
  persistenceOf(runId: string): "stored" | "degraded" {
    const idx = this.sequencer.committedRunIndex(runId);
    return idx !== undefined && idx.terminalRecordId !== undefined ? "stored" : "degraded";
  }

  runIndexOf(runId: string): RunIndexEntryV1 | undefined {
    return this.sequencer.committedRunIndex(runId);
  }

  /**
   * Agent 把「此刻的 run / turn 归属」供给挂进来（`observationScope()`）：所有 sink 在事实到达时刻读一次它。
   * 没挂之前供给返回 `{}`（runtime-scoped）——供给必须返回对象，返回 undefined 会被 sink 判成归属不可知而开 gap。
   */
  bindScope(supplier: ObservationScopeSupplier): void {
    this.scopeSupplier = supplier;
  }

  /** 本 state root 的 Memory path HMAC key：只给 writer 侧的 descriptor，永不进 envelope。构造期读一次，之后不碰库。 */
  get pathDigestKey(): Uint8Array {
    return this.pathDigestKeyBytes;
  }

  /**
   * 一个执行节点上的探针（循环 / 压缩 / Agent 自身 / Memory / Task / Schedule …）：descriptor 归语义 owner，
   * 这里只把它转成 `ObservationIngest.offer()`，identity / owner / runtime 身份在构造期钉住。
   * `scope` 缺省用 `bindScope()` 挂上的供给（runId / turnId 只有 Agent 知道）；descriptor 自己投影的 scope 优先。
   */
  capabilitySink<T>(descriptor: CapabilityFactDescriptor<T>, owner: ObservationOwner, scope?: ObservationScopeSupplier): CapabilityFactSink<T> {
    return factSinkToIngest(descriptor, this.sequencer, {
      runtimeId: this.runtimeId,
      runtimeGeneration: this.runtimeGeneration,
      capturePolicy: this.capturePolicy,
      owner,
      report: (d) => this.report(d),
      scope: scope ?? (() => this.scopeSupplier()),
    });
  }

  /* ───────── run 三条边界（唯一 emission owner） ───────── */

  /**
   * admission 颁发 permit 时：`run.accepted`（RunIndex 种子）与紧跟的 `run.assembly` 快照都只同步预留 seq，
   * 提交不等——admission 不因观测层的任何状态拒 run 或等 run。`appendBoundary()` 的预留、RunIndex 登记都在
   * 同步段，所以不等也保序；落不下去的结果只进诊断与 persistence health。
   */
  acceptRun(input: RunAcceptInput): void {
    const acceptedAt = this.clock.now();
    const header: RunObservationHeaderSeed = {
      runId: input.runId,
      source: input.source,
      runtimeId: this.runtimeId,
      agentId: input.agentId,
      agentInstanceId: input.agentInstanceId,
      sessionId: input.sessionId,
      runtimeGeneration: this.runtimeGeneration,
      capturePolicy: this.capturePolicy,
      acceptedAt,
    };
    const body: RunAcceptedBodyV1 = { header };
    const scope = this.runScope(input.runId, input);
    this.fireBoundary(input.runId, "run.accepted", this.boundary("run.accepted", "event", scope, acceptedAt, body));
    const assembly: RunAssemblyBodyV1 = {
      agentAssembly: this.assembly,
      // RunModelSnapshot 与 `Model` 的数据字段同形（api / params / thinkingLevelMap / capabilities / cost），digest 同一把尺
      modelBinding: snapshotRunModelBinding(input.modelBinding.model as unknown as Model, input.modelBinding.catalogRevision),
    };
    this.fireBoundary(input.runId, RUN_ASSEMBLY_RECORD, this.boundary(RUN_ASSEMBLY_RECORD, "snapshot", scope, acceptedAt, assembly));
  }

  /** 真正进入 loop 的那一拍（permit executor，或派出隔离子循环的 Agent）。同样只预留、不等（started 失败本来就不取消 run）。 */
  startRun(runId: string, identity: Readonly<{ agentId: string; agentInstanceId: string; sessionId: string | null }>, startedBy: RunStartedBodyV1["startedBy"]): void {
    const body: RunStartedBodyV1 = { startedBy };
    this.fireBoundary(runId, "run.started", this.boundary("run.started", "event", this.runScope(runId, identity), this.clock.now(), body));
  }

  /**
   * 预留即返回、提交不等的 boundary。`appendBoundary()` 的同步段做完 lifecycle 检查 / seq 预留 / RunIndex 登记才返回
   * Promise，所以顺序已定；这里只负责把 rejection 接住变成诊断——否则是进程级 unhandled rejection。
   */
  private fireBoundary(runId: string, name: string, draft: BoundaryObservationDraft<unknown>): void {
    let pending: Promise<unknown>;
    try {
      pending = this.sequencer.appendBoundary(draft);
    } catch (e) {
      this.report({ code: "observation_boundary_failed", message: `run ${runId}：${name} 预留失败（run 照跑）：${redactedLabel(e)}` });
      return;
    }
    pending.then(
      () => {},
      (e: unknown) => this.report({ code: "observation_boundary_failed", message: `run ${runId}：${name} 落不下去（run 照跑，persistence 降级）：${redactedLabel(e)}` }),
    );
  }

  /**
   * permit finalizer：业务 outcome 已冻结之后封口。body 只有有界 outcome 与可选 finalSnapshot；
   * capture gap 的 count / digest 由 Sequencer 从自己的账本填（`RunClosedBodyV1`）。
   * 这一条**等 COMMIT**（有界：`boundaryDeadlineMs`）——它在 run 的活干完之后，`send()` 靠它如实报 persistence；
   * 到期 / 失败 = 该 run persistence degraded，outcome 不变。
   */
  async closeRun(input: RunCloseInput, identity: Readonly<{ agentId: string; agentInstanceId: string; sessionId: string | null }>): Promise<void> {
    const now = this.clock.now();
    const body: RunClosedBodyInput = {
      outcome: toRunClosedOutcome(input.outcome),
      finalSnapshot: this.capturePolicy === "off" || input.finalState === null ? null : { throughSeq: this.sequencer.committedSeq, at: now, state: input.finalState },
    };
    try {
      await this.sequencer.appendBoundary(this.boundary("run.closed", "event", this.runScope(input.runId, identity), now, body));
    } catch (e) {
      this.report({ code: "observation_boundary_failed", message: `run ${input.runId}：run.closed 落不下去（outcome 不变，persistence degraded）：${redactedLabel(e)}` });
      return;
    }
    // 封口落盘了：按规则过期一次（后台，不让 send() 等）
    if (this.expiry !== undefined) void this.expireNow();
  }

  /**
   * 拿到 lease 之后（lease 生命周期端口的 `afterLeaseAcquired`）：从此可以碰别的进程留下的东西。
   * 立即返回，活放后台：先补齐以前进程没写完的派生文件，再按规则过期一次。
   */
  activate(): void {
    this.active = true;
    this.repairPending = true;
    void this.runMaintenance();
  }

  /** 交还 lease 或丢锁之前：不再开始新的补齐 / 过期，等在跑的那一次做完（丢锁时调用方不必等）。 */
  async deactivate(): Promise<void> {
    this.active = false;
    this.maintenanceAgain = false;
    await this.maintenance;
  }

  /** 按规则过期一次。没规则、没持 lease 时是空操作；撞上在跑的就记一笔跑完再来。不抛。 */
  expireNow(): Promise<void> {
    if (this.expiry === undefined || !this.active) return Promise.resolve();
    return this.runMaintenance();
  }

  private runMaintenance(): Promise<void> {
    if (this.maintenance !== null) {
      this.maintenanceAgain = true;
      return this.maintenance;
    }
    const work = (async () => {
      do {
        this.maintenanceAgain = false;
        if (!this.active) return;
        if (this.repairPending) {
          this.repairPending = false;
          try {
            await this.store.repairDerived();
          } catch (e) {
            this.report({ code: "observation_repair_failed", message: `补齐观测派生文件失败：${redactedLabel(e)}` });
          }
        }
        if (this.active && this.expiry !== undefined) await this.expireOnce(this.expiry);
      } while (this.maintenanceAgain && this.active);
    })().finally(() => {
      this.maintenance = null;
    });
    this.maintenance = work;
    return work;
  }

  private async expireOnce(rule: ObservationExpiryRule): Promise<void> {
    try {
      const headers = (await this.store.readAllRunIndex()).map((e) => e.header);
      const decision = rule(headers, this.clock.now());
      if (!this.active) return;
      const outcome = await this.store.expire(decision, (runId) => this.sequencer.isTrackingRun(runId));
      if (outcome.refusedRuns.length > 0) {
        this.report({ code: "observation_expiry_refused", message: `过期规则点名了还在跑的 run，不删：${outcome.refusedRuns.join(", ")}` });
      }
    } catch (e) {
      this.report({ code: "observation_expiry_failed", message: `观测过期失败：${redactedLabel(e)}` });
    }
  }

  /** 收摊：停下补齐 / 过期，把 ring 里的尾巴写完，再等写入端的队排空。single-flight。 */
  dispose(): Promise<void> {
    return (this.disposing ??= (async () => {
      this.phase = "disposing";
      try {
        await this.deactivate();
        await this.sequencer.flushPending();
      } finally {
        try {
          await this.store.close();
        } finally {
          this.phase = "disposed";
        }
      }
    })());
  }

  private runScope(runId: string, identity: Readonly<{ agentId: string; agentInstanceId: string; sessionId: string | null }>): Readonly<Record<string, string>> {
    return {
      runtimeId: this.runtimeId,
      runId,
      agentId: identity.agentId,
      agentInstanceId: identity.agentInstanceId,
      ...(identity.sessionId === null ? {} : { sessionId: identity.sessionId }),
    };
  }

  private boundary<T>(name: string, kind: ObservationRecordKind, scope: Readonly<Record<string, string>>, occurredAt: number, body: T): BoundaryObservationDraft<T> {
    return {
      lane: "boundary",
      occurredAt,
      kind,
      name,
      scope: scope as BoundaryObservationDraft["scope"],
      correlation: {},
      generation: { runtime: this.runtimeGeneration, agentAssembly: this.assembly.digest },
      owner: builtinOwner(AGENT_ENTRY_ID),
      instrumentation: RUN_ADMISSION_INSTRUMENTATION,
      attributes: {},
      body,
    };
  }
}
