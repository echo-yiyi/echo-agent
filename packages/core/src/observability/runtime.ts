// ObservationRuntime：完整 Runtime 在主线程上的观测入口。它只**交东西出去**——探针的投影、run 三条边界
// （`run.accepted / run.started / run.closed`）的输入、Agent 此刻的状态——交给进程里那条观测线程（thread.ts）；
// 编码、摘要、seq、落盘都在那边（thread-host.ts）。
// **不订阅、不转发 AgentEvent**：那是给壳的事件协议，观测是插桩（`docs/design/observability.md`）。
//
// 硬规矩（2026-09-14 用户拍板，决策：docs/decisions/implemented/2026-09-14-observation-off-main-loop.md）：
// **观测的任何功能都不出现在主机制、主循环里**——admission 不等 run.closed、`createEcho()` 不等打开存储、`stop()` 不等写完、
// 不挂 lease、不在任何流程节点上过期。这里每个方法都同步返回、不抛、不等观测线程。
// **观测出问题不往外报**：不进 agent 的诊断 / 通知通道，也不打日志——观测本身就是日志（2026-09-14 拍板）。
// 过期是产品自己调的独立函数（expiry.ts），agent 里没有。
//
// 由 `createAgent()` 构造并经 `attachObservationHost()` 挂到 Agent 上；低层 `new Agent()` 没有它。

import type { Clock } from "../schedule/clock.ts";
import type { AgentOutcome } from "../events.ts";
import type { RunModelBinding } from "../admission/types.ts";
import type { Model } from "../provider/types.ts";
import type { StorageDir } from "../storage/types.ts";
import { BUILTIN_GENERATION } from "../extension/builtin.ts";
import type { BuiltinSlotContribution } from "./assembly.ts";
import { DocumentObservationReader } from "./document-store.ts";
import { factSinkToThread, type CapabilityFactDescriptor, type CapabilityFactSink } from "./fact-sink.ts";
import { freezeInstrumentation, freezeOwner } from "./identity.ts";
import { LiveEchoObservations } from "./query.ts";
import type { SequencerLimits } from "./sequencer.ts";
import { ObservationThread } from "./thread.ts";
import type { ObservationCapturePolicy, ObservationOwner, ObservedRunSource, RuntimePhase } from "./types.ts";
import type { ObservableStateInput, ObservationWork, RunIdentity, RunOutcomeData } from "./worker-protocol.ts";

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

export type ObservationRuntimeOptions = Readonly<{
  runtimeId: string;
  /** RuntimeGeneration；O3a 只有 boot 一代。 */
  runtimeGeneration: string;
  capturePolicy: ObservationCapturePolicy;
  /** 观测文档所在的存储：状态根的，或 `observation.store` 注入的。 */
  store: StorageDir;
  /** 给人看的位置（诊断用）。 */
  storePath: string;
  /** 事实到达的时刻（记录的 observedAt）从这里取。 */
  clock: Clock;
  /** `createAgent()` 直接构造的 builtin 槽；观测线程据此封 AgentAssembly 快照，每个 run 的 `run.assembly` 记录引用它。 */
  assembly: readonly BuiltinSlotContribution[];
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
  /** finalizer 冻结时 Agent 的状态；观测线程补摘要。 */
  finalState: ObservableStateInput | null;
}>;

export type ObservationScopeSupplier = () => Readonly<Record<string, string>>;

function outcomeData(outcome: AgentOutcome): RunOutcomeData {
  switch (outcome.kind) {
    case "completed":
      return { kind: "completed" };
    case "aborted":
      return outcome.reason === undefined ? { kind: "aborted" } : { kind: "aborted", reason: outcome.reason };
    case "error":
      return { kind: "error", code: outcome.error.code, message: outcome.error.message };
  }
}

export class ObservationRuntime {
  readonly runtimeId: string;
  readonly runtimeGeneration: string;
  readonly capturePolicy: ObservationCapturePolicy;
  /** live 查询面（`echo.observations`）：读之前等观测线程写完，再读同一个存储上的文档。 */
  readonly observations: LiveEchoObservations;
  private readonly clock: Clock;
  private readonly thread: ObservationThread;
  private scopeSupplier: ObservationScopeSupplier = () => ({});
  private phase: RuntimePhase = "ready";
  /** 已在观测线程里登记的探针身份 → 编号。 */
  private readonly sinks = new Map<string, number>();

  constructor(opts: ObservationRuntimeOptions) {
    this.runtimeId = opts.runtimeId;
    this.runtimeGeneration = opts.runtimeGeneration;
    this.capturePolicy = opts.capturePolicy;
    this.clock = opts.clock;
    this.thread = ObservationThread.get();
    this.thread.open(opts.runtimeId, opts.store, {
      runtimeGeneration: opts.runtimeGeneration,
      capturePolicy: opts.capturePolicy,
      storePath: opts.storePath,
      boundaryOwner: builtinOwner(AGENT_ENTRY_ID),
      assembly: opts.assembly,
      ...(opts.limits === undefined ? {} : { limits: opts.limits }),
    });
    const rt = opts.runtimeId;
    this.observations = new LiveEchoObservations({
      runtimeId: rt,
      reader: new DocumentObservationReader(opts.store, opts.storePath),
      clock: opts.clock,
      phase: () => this.phase,
      flush: () => this.thread.flush(rt),
      health: () => this.thread.health(rt),
      subscribe: (options) => this.thread.subscribe(rt, options),
    });
  }

  get runtimePhase(): RuntimePhase {
    return this.phase;
  }

  /**
   * Agent 把「此刻的 run / turn 归属」供给挂进来（`observationScope()`）：所有 sink 在事实到达时刻读一次它。
   * 没挂之前供给返回 `{}`（runtime-scoped）——供给必须返回对象，返回 undefined 会被判成归属不可知而开 gap。
   */
  bindScope(supplier: ObservationScopeSupplier): void {
    this.scopeSupplier = supplier;
  }

  /** 等观测线程把此刻之前交出去的全部写完（`echo.observations.flush()`）。永不 reject。 */
  flush(): Promise<void> {
    return this.thread.flush(this.runtimeId);
  }

  /**
   * 一个执行节点上的探针：descriptor 归语义 owner。instrumentation / owner 在构造期**冻结副本**并校长度——
   * 只校验不复制的话，构造完把 `instrumentation.name` 改成 9,000 字节，之后每条事实都成 gap（review 实测）。
   * `scope` 缺省用 `bindScope()` 挂上的供给（runId / turnId 只有 Agent 知道）；descriptor 自己投影的 scope 优先。
   */
  capabilitySink<T>(descriptor: CapabilityFactDescriptor<T>, owner: ObservationOwner, scope?: ObservationScopeSupplier): CapabilityFactSink<T> {
    const instrumentation = freezeInstrumentation(descriptor.instrumentation, "descriptor.instrumentation");
    const frozenOwner = freezeOwner(owner, "owner");
    const rt = this.runtimeId;
    // 同一身份（instrumentation + owner）在观测线程里只登记一次：子循环每次都新建记忆探针，不能让那边的表一直涨
    const identity = JSON.stringify([instrumentation.name, instrumentation.version, frozenOwner]);
    let sink = this.sinks.get(identity);
    if (sink === undefined) {
      sink = this.sinks.size + 1;
      this.sinks.set(identity, sink);
      this.post({ t: "sink", rt, sink, owner: frozenOwner, instrumentation });
    }
    const id = sink;
    return factSinkToThread(descriptor, {
      capturePolicy: this.capturePolicy,
      now: () => this.clock.now(),
      scope: scope ?? (() => this.scopeSupplier()),
      handoff: {
        fact: (at, raw, projection) => {
          try {
            this.thread.post({ t: "fact", rt, sink: id, at, ...(raw === undefined ? {} : { scope: raw }), projection });
          } catch {
            // 投影里有过不了线程的值（函数、symbol …）：留 hole + gap
            this.post({ t: "fact-failed", rt, sink: id, at });
          }
        },
        failed: (at, runId) => {
          this.post({ t: "fact-failed", rt, sink: id, at, ...(runId === undefined ? {} : { runId }) });
        },
      },
    });
  }

  /* ───────── run 三条边界（交给观测线程，不等） ───────── */

  /** admission 颁发 permit 时。 */
  acceptRun(input: RunAcceptInput): void {
    const model = input.modelBinding.model as Model;
    this.post({
      t: "run-accepted",
      rt: this.runtimeId,
      at: this.clock.now(),
      runId: input.runId,
      source: input.source,
      identity: { agentId: input.agentId, agentInstanceId: input.agentInstanceId, sessionId: input.sessionId },
      model: {
        provider: model.provider,
        id: model.id,
        api: model.api,
        params: model.params,
        thinkingLevelMap: model.thinkingLevelMap,
        capabilities: model.capabilities,
        cost: model.cost,
        catalogRevision: input.modelBinding.catalogRevision,
      },
    });
  }

  /** 真正进入 loop 的那一拍（permit executor，或派出隔离子循环的 Agent），带 run 开头的状态。 */
  startRun(runId: string, identity: RunIdentity, startedBy: "permit-executor" | "subloop", state: ObservableStateInput): void {
    this.post({ t: "run-started", rt: this.runtimeId, at: this.clock.now(), runId, identity, startedBy, state });
  }

  /** permit finalizer：业务 outcome 已冻结之后封口。 */
  closeRun(input: RunCloseInput, identity: RunIdentity): void {
    this.post({ t: "run-closed", rt: this.runtimeId, at: this.clock.now(), runId: input.runId, identity, outcome: outcomeData(input.outcome), finalState: input.finalState });
  }

  /** 收摊：告诉观测线程写完手上的就收，**不等**。进程会等观测线程写完才退出（thread.ts 头注）。 */
  dispose(): Promise<void> {
    if (this.phase !== "disposed") {
      this.phase = "disposed";
      this.thread.close(this.runtimeId);
    }
    return Promise.resolve();
  }

  /** 状态根要被整个删掉：此刻起不再为它写任何文件，观测线程直接丢掉手上的。 */
  discard(): void {
    this.phase = "disposed";
    this.thread.discard(this.runtimeId);
  }

  /** 交出去的消息过不了线程：是这边构造的数据有问题，这条不记（不往外报）。 */
  private post(work: ObservationWork): void {
    try {
      this.thread.post(work);
    } catch {
      // 不记
    }
  }
}
