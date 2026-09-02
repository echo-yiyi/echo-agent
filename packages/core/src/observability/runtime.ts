// ObservationRuntime（§15.5.2 / §15.12，O3a）：完整 Runtime 里 canonical writer 的宿主——
// 持有唯一的 Sequencer 与 SQLite store，是 run 三条边界（`run.accepted / run.started / run.closed`）的**唯一 emission owner**，
// 并把 AgentEvent 经 `factSinkToIngest(agentEventDescriptor)` 送进 bounded lane。
//
// 失败语义照 §15.12：
//   · `run.accepted` 落不下去 → 不颁发 permit（admission 返回 `rejected(observation-unavailable)`）；
//   · `run.started` / `run.closed` 落不下去 → 业务 run 照跑、照返回真实 outcome，只有 persistence 降级 + 诊断；
//   · 观测层任何异常都不进 Agent 控制流——这里每个公开方法都不抛。
//
// 由 `createAgent()` 构造并经 `attachObservationHost()` 挂到 Agent 上；`/engine` 的 `new Agent()` 没有它。

import type { Clock } from "../schedule/clock.ts";
import type { Diagnostic } from "../errors.ts";
import type { AgentEvent, AgentOutcome } from "../events.ts";
import type { RunModelBinding, RunSource } from "../admission/types.ts";
import type { Model } from "../provider/types.ts";
import { BUILTIN_GENERATION } from "../extension/builtin.ts";
import { agentEventDescriptor } from "./agent-events.ts";
import { snapshotRunModelBinding } from "./assembly.ts";
import { RUN_ASSEMBLY_RECORD, type BoundaryObservationDraft, type RunAcceptedBodyV1, type RunAssemblyBodyV1, type RunObservationHeaderSeed, type RunStartedBodyV1 } from "./draft.ts";
import { LiveEchoObservations } from "./query.ts";
import { factSinkToIngest, type CapabilityFactSink } from "./fact-sink.ts";
import { sha256Hex } from "./hash.ts";
import { redactedLabel } from "./redact.ts";
import { ObservationSequencer, type SequencerLimits } from "./sequencer.ts";
import type { SqliteCanonicalObservationStore } from "./sqlite-store.ts";
import type {
  AgentAssemblyObservationSnapshot,
  EchoObservableState,
  ObservationCapturePolicy,
  ObservationOwner,
  ObservationRecordKind,
  RunClosedBodyInput,
  RunClosedOutcomeObservation,
  RunIndexEntryV1,
  RuntimePhase,
} from "./types.ts";
import { OBSERVATION_BOUNDARY_LIMITS as BOUNDARY_LIMITS } from "./types.ts";

/** run 边界与装配快照记录的 instrumentation：admission 这条路，与 AgentEvent tap（`echo.agent-event`）分开。 */
export const RUN_ADMISSION_INSTRUMENTATION = { name: "echo.run-admission", version: "1" } as const;

/** Agent 循环自己发的事实（run 边界、turn / model / tool span）都归 `echo:agent` 这一 builtin Entry。 */
export const AGENT_OWNER: ObservationOwner = Object.freeze({ status: "known", entryId: "echo:agent", entryGeneration: BUILTIN_GENERATION, via: "assembly" });

export type ObservationRuntimeOptions = Readonly<{
  runtimeId: string;
  /** §14 RuntimeGeneration；O3a 只有 boot 一代。 */
  runtimeGeneration: string;
  capturePolicy: ObservationCapturePolicy;
  store: SqliteCanonicalObservationStore;
  clock: Clock;
  /** `createAgent()` 封口的 builtin 槽快照；每个 run 的 `run.assembly` 记录引用它。 */
  assembly: AgentAssemblyObservationSnapshot;
  limits?: Partial<SequencerLimits>;
}>;

export type RunAcceptInput = Readonly<{
  runId: string;
  source: RunSource;
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

/** `AgentOutcome` → 有界的 terminal outcome：正文 / message 不进 boundary，只留 code + digest（§15.5.1）。 */
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
  readonly store: SqliteCanonicalObservationStore;
  readonly sequencer: ObservationSequencer;
  /** live 查询面（`echo.observations`）：同一个 Sequencer + 同一条 SQLite connection 的只读查询。 */
  readonly observations: LiveEchoObservations;
  private readonly clock: Clock;
  private report: (d: Diagnostic) => void = () => {};
  private phase: RuntimePhase = "ready";
  private disposing: Promise<void> | undefined;

  constructor(opts: ObservationRuntimeOptions) {
    this.runtimeId = opts.runtimeId;
    this.runtimeGeneration = opts.runtimeGeneration;
    this.capturePolicy = opts.capturePolicy;
    this.assembly = opts.assembly;
    this.store = opts.store;
    this.clock = opts.clock;
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
    });
  }

  /** Agent 拉：观测层的诊断走 Agent 的诊断通道（与 InboxStore.attachDiagnostics 同款）。 */
  attachDiagnostics(report: (d: Diagnostic) => void): void {
    this.report = report;
  }

  get runtimePhase(): RuntimePhase {
    return this.phase;
  }

  /** 当前 Runtime 对某 run 的 persistence 投影：终态已 COMMIT 进 RunIndex 才是 stored，否则 degraded（§15.5.1）。 */
  persistenceOf(runId: string): "stored" | "degraded" {
    const idx = this.sequencer.committedRunIndex(runId);
    return idx !== undefined && idx.terminalRecordId !== undefined ? "stored" : "degraded";
  }

  runIndexOf(runId: string): RunIndexEntryV1 | undefined {
    return this.sequencer.committedRunIndex(runId);
  }

  /**
   * AgentEvent → bounded lane 的 sink。`scope` 在每条事实到达时刻读一次（runId / turnId 只有 Agent 知道）。
   * 由 Agent 在 `processEvents()` 的 state apply + required persistence 之后同步调用（§15.12）。
   */
  eventSink(scope: ObservationScopeSupplier): CapabilityFactSink<AgentEvent> {
    return factSinkToIngest(agentEventDescriptor, this.sequencer, {
      runtimeId: this.runtimeId,
      runtimeGeneration: this.runtimeGeneration,
      capturePolicy: this.capturePolicy,
      owner: AGENT_OWNER,
      report: (d) => this.report(d),
      scope,
    });
  }

  /* ───────── run 三条边界（唯一 emission owner） ───────── */

  /**
   * admission 颁发 permit 之前：`run.accepted`（RunIndex 种子）必须 COMMIT，否则不颁发。
   * 紧跟的 `run.assembly` 快照是**可选**投影：落不下去只记诊断，run 照跑——一条快照不值得拒掉业务。
   */
  async acceptRun(input: RunAcceptInput): Promise<"accepted" | "unavailable"> {
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
    try {
      await this.sequencer.appendBoundary(this.boundary("run.accepted", "event", scope, acceptedAt, body));
    } catch (e) {
      this.report({ code: "observation_run_rejected", message: `run ${input.runId}：run.accepted 落不下去，不颁发 permit：${redactedLabel(e)}` });
      return "unavailable";
    }
    const assembly: RunAssemblyBodyV1 = {
      agentAssembly: this.assembly,
      // RunModelSnapshot 与 `Model` 的数据字段同形（api / params / thinkingLevelMap / capabilities / cost），digest 同一把尺
      modelBinding: snapshotRunModelBinding(input.modelBinding.model as unknown as Model, input.modelBinding.catalogRevision),
    };
    try {
      await this.sequencer.appendBoundary(this.boundary(RUN_ASSEMBLY_RECORD, "snapshot", scope, acceptedAt, assembly));
    } catch (e) {
      this.report({ code: "observation_boundary_failed", message: `run ${input.runId}：run.assembly 落不下去（run 照跑）：${redactedLabel(e)}` });
    }
    return "accepted";
  }

  /** permit executor 真正进入 loop 的那一拍。失败不取消 run（§15.12）。 */
  async startRun(runId: string, identity: Readonly<{ agentId: string; agentInstanceId: string; sessionId: string | null }>): Promise<void> {
    const body: RunStartedBodyV1 = { startedBy: "permit-executor" };
    try {
      await this.sequencer.appendBoundary(this.boundary("run.started", "event", this.runScope(runId, identity), this.clock.now(), body));
    } catch (e) {
      this.report({ code: "observation_boundary_failed", message: `run ${runId}：run.started 落不下去（run 照跑）：${redactedLabel(e)}` });
    }
  }

  /**
   * permit finalizer：业务 outcome 已冻结之后封口。body 只有有界 outcome 与可选 finalSnapshot；
   * capture gap 的 count / digest 由 Sequencer 从自己的账本填（`RunClosedBodyV1`）。失败 = 该 run persistence degraded。
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
    }
  }

  /** 收摊：先把 ring 里的尾巴写完，再关 SQLite。single-flight。 */
  dispose(): Promise<void> {
    return (this.disposing ??= (async () => {
      this.phase = "disposing";
      try {
        await this.sequencer.flushPending();
      } finally {
        this.store.close();
        this.phase = "disposed";
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
      owner: AGENT_OWNER,
      instrumentation: RUN_ADMISSION_INSTRUMENTATION,
      attributes: {},
      body,
    };
  }
}
