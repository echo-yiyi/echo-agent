// 观测线程里的宿主：每个 runtime 一份 Sequencer + 文档写入端，处理主线程发来的工作消息（worker-protocol.ts）。
//
// 进程里只有一条观测线程（入口 observation-worker.ts），所有 `createEcho()` 的 runtime 共用。每个 runtime 的消息按到达顺序
// 一条一条处理——那就是主线程上探针被调的顺序；runtime 之间互不等。主循环不等这里的任何结果
// （决策：docs/decisions/implemented/2026-09-14-observation-off-main-loop.md）。
//
// 这里做的是原来在主线程节点上做的活：run 边界与状态快照的构造、各种摘要（能力状态、装配、模型绑定、记忆路径 HMAC、
// 错误原文）、scope 物化、normalize / 编码（Sequencer）、写文件（document-store.ts，经主线程的存储）。
//
// **什么时候开始写**：runtime 第一次有 run（`run.accepted`）或第一次被读（flush / subscribe）才打开写入端、开始落盘；
// 在那之前事实只进 Sequencer 的 ring（有界，满了记缺口）。收摊时还没开始写的 runtime 直接丢掉：一句话都没说过的会话，
// 状态根会被整个删掉（create-agent.ts 的 `removeIfEmptySession`），不能有迟到的文件把目录重新建出来。
//
// **出了问题不往外报**：观测本身就是日志，它坏了再发诊断没有意义（2026-09-14 拍板）。丢掉的事实照旧留 hole + gap，
// 写入端的状态在 Sequencer 的 health 里（`snapshot()`），此外什么都不发。
//
// 本文件不 import `node:` 模块，逻辑可以同线程直接跑；线程入口只是把消息接进来。

import type { Diagnostic } from "../errors.ts";
import type { Model } from "../provider/types.ts";
import type { StorageDir } from "../storage/types.ts";
import { AGENT_INSTRUMENTATION } from "../agent-observe.ts";
import { sealAgentAssemblyObservation, snapshotRunModelBinding } from "./assembly.ts";
import { DocumentObservationStore } from "./document-store.ts";
import { RUN_ASSEMBLY_RECORD, type BoundaryObservationDraft, type BoundedObservationDraft, type RunAcceptedBodyV1, type RunAssemblyBodyV1, type RunObservationHeaderSeed, type RunStartedBodyV1 } from "./draft.ts";
import type { ObservationFactProjection } from "./fact-sink.ts";
import { hmacSha256Hex, sha256Hex } from "./hash.ts";
import { freezeInstrumentation, freezeOwner, materializeScope } from "./identity.ts";
import { canonicalJson } from "./normalize.ts";
import { redactedLabel } from "./redact.ts";
import { ObservationSequencer, type ObservationIngest, type ProjectionFailureOutcome } from "./sequencer.ts";
import type { CanonicalObservationStore } from "./store.ts";
import { materializeObservableState } from "./terminal.ts";
import type { AgentAssemblyObservationSnapshot, EchoObservableState, ObservationCapturePolicy, ObservationOwner, ObservationRecordKind, RunClosedBodyInput, RunClosedOutcomeObservation } from "./types.ts";
import { OBSERVATION_BOUNDARY_LIMITS } from "./types.ts";
import {
  reviveError,
  serializeError,
  type FromObservationThread,
  type ObservableStateInput,
  type ObservationWork,
  type RunIdentity,
  type RunOutcomeData,
  type StorageOp,
  type ThreadHealth,
  type ToObservationThread,
} from "./worker-protocol.ts";

/** run 边界与装配快照记录的 instrumentation：admission 这条路。 */
export const RUN_ADMISSION_INSTRUMENTATION = { name: "echo.run-admission", version: "1" } as const;

/** `finishReason` 等安全串的构造上限（UTF-8 ≤ maxSafeStringBytes）；超出按 code unit 截断并标记。 */
function clipSafeString(s: string): string {
  const max = OBSERVATION_BOUNDARY_LIMITS.maxSafeStringBytes;
  if (new TextEncoder().encode(s).byteLength <= max) return s;
  let out = s;
  while (out.length > 0 && new TextEncoder().encode(`${out}…`).byteLength > max) out = out.slice(0, -1);
  return `${out}…`;
}

/** run 的结果 → 有界的 terminal outcome：正文 / message 不进 boundary，只留 code + digest。 */
export function toRunClosedOutcome(outcome: RunOutcomeData): RunClosedOutcomeObservation {
  switch (outcome.kind) {
    case "completed":
      return { status: "completed" };
    case "aborted":
      return outcome.reason === undefined ? { status: "aborted" } : { status: "aborted", finishReason: clipSafeString(outcome.reason) };
    case "error":
      return { status: "error", errorCode: clipSafeString(outcome.code), errorDigest: sha256Hex(outcome.message) };
  }
}

/**
 * Agent 拍的状态 → `EchoObservableState`：补上各能力的摘要，与观测线程自己的 persistence。
 * `stateDigest` 覆盖能判断「状态变没变」的最小表示；entry 的 `digest` 覆盖整条摘要。
 */
export function completeObservableState(input: ObservableStateInput, persistence: EchoObservableState["runtime"]["observationPersistence"]): EchoObservableState {
  const phase = input.runtime.phase;
  return {
    runtime: {
      phase,
      status: phase === "ready" && persistence !== "healthy" ? "degraded" : phase,
      observationPersistence: persistence,
      generation: input.runtime.generation,
      activeEntryCount: input.runtime.activeEntryCount,
    },
    agent: input.agent,
    capabilities: input.capabilities.map((c) => {
      const summary = { schemaVersion: 1 as const, stateDigest: sha256Hex(canonicalJson(c.state)), counters: c.counters, detailBytes: 0, detailTruncated: false };
      return { id: c.id, digest: sha256Hex(canonicalJson(summary)), summary };
    }),
    omittedCapabilitySummaryCount: 0,
  };
}

/** 投影要的摘要 → body 上的字段。 */
export function applyProjectionDigests(body: unknown, digests: NonNullable<ObservationFactProjection["digests"]>, key: Uint8Array | undefined): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("带摘要的投影 body 必须是普通对象");
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const [field, d] of Object.entries(digests)) {
    if (d.keyed === true) {
      if (key === undefined) throw new Error("路径摘要 key 不可用");
      out[field] = hmacSha256Hex(key, d.text);
    } else {
      out[field] = sha256Hex(d.text);
    }
  }
  return out;
}

/** 一根探针在观测线程这一侧的身份：构造期冻结的副本。 */
export type SinkIdentity = Readonly<{ owner: ObservationOwner; instrumentation: Readonly<{ name: string; version: string }> }>;

/**
 * 冻结探针身份并校长度。只校验不复制的话，构造完把 `instrumentation.name` 改成 9,000 字节，之后每条事实都成 gap（review 实测）。
 * 超长抛 `ObservationIdentityError`。
 */
export function freezeSinkIdentity(owner: ObservationOwner, instrumentation: Readonly<{ name: string; version: string }>): SinkIdentity {
  return { owner: freezeOwner(owner, "owner"), instrumentation: freezeInstrumentation(instrumentation, "descriptor.instrumentation") };
}

/**
 * 探针事实进 Sequencer 时要的上下文。`state` 同一根探针共用：writer terminal 之后的失败只报第一次；
 * reporter 返回过 thenable 就停用它。
 */
export type FactIngestContext = Readonly<{
  runtimeId: string;
  runtimeGeneration: string;
  sink: SinkIdentity;
  report: (d: Diagnostic) => void;
  state: { terminalReported: boolean; reporterDisabled: boolean };
}>;

/** 一根新探针的上下文。 */
export function factIngestContext(input: Readonly<{ runtimeId: string; runtimeGeneration: string; sink: SinkIdentity; report: (d: Diagnostic) => void }>): FactIngestContext {
  return { ...input, state: { terminalReported: false, reporterDisabled: false } };
}

function reportSafely(ctx: FactIngestContext, d: Diagnostic): void {
  if (ctx.state.reporterDisabled) return;
  try {
    // **只挡同步 throw 不够**（2026-08-27 review P0）：`(d) => void` 同样放行 async reporter，它 reject 时是进程级
    // unhandled rejection；只吞不停的话每条诊断仍调一次违规 reporter，诊断通道自己成了资源放大器。返回 thenable 即停用。
    const r: unknown = ctx.report(d);
    if (typeof r === "object" && r !== null && typeof (r as { then?: unknown }).then === "function") {
      ctx.state.reporterDisabled = true;
      Promise.resolve(r as PromiseLike<unknown>).then(
        () => {},
        () => {},
      );
    }
  } catch {
    // 诊断通道自己坏了，没有第二条诊断通道可报——只能吞；绝不击穿探针的 no-throw
  }
}

/**
 * canonical 路径的失败出口：**先占失败身份 + 挂 safe gap，再报诊断**——顺序要紧，诊断报完才预留的话，报诊断途中任何抛错
 * 都会让这个洞彻底消失。writer terminal 之后每条失败都报一次的话，诊断通道自己成了无界增长面；terminal 是持续状态，只报第一次。
 * `error`：探针在主线程那一侧抛出物的原文，这里只做成脱敏标签。
 */
export function ingestFactFailure(ingest: ObservationIngest, ctx: FactIngestContext, runId: string | undefined, why: string, error?: string): void {
  const name = ctx.sink.instrumentation.name;
  const message = `${why}${error === undefined ? "" : redactedLabel(error)}`;
  let outcome: ProjectionFailureOutcome = "writer-unavailable";
  try {
    outcome = ingest.reserveProjectionFailureGap({ runId });
  } catch (inner) {
    // Sequencer 内部 bug：没有第二条 canonical 通道可用，只能升一条诊断
    reportSafely(ctx, { code: "observation_sequencer_internal", message: `${name}：gap 预留失败 ${redactedLabel(inner)}` });
  }
  if (outcome !== "gap-reserved") {
    // writer 已 terminal：canonical 那条路不存在了，诊断如实说明「这条只剩 live 证据」
    if (ctx.state.terminalReported) return;
    ctx.state.terminalReported = true;
    reportSafely(ctx, { code: "observation_fact_dropped", message: `${name}：${message}（writer 已 terminal，此后的失败只有 live 证据、无 canonical gap；只报第一次）` });
    return;
  }
  reportSafely(ctx, { code: "observation_fact_dropped", message: `${name}：${message}` });
}

/**
 * 一条投影进 Sequencer：物化 scope、算投影声明的摘要、拼 draft、`offer`。任何一步失败都成 hole + gap，永不抛。
 * 物化失败**不当作「没有 scope」**——run 归属不可知的事实不能冒充 runtime-scoped 正常记录。
 * 带 `keyed` 摘要的投影要 `pathDigestKey`；给不出就成 gap。
 */
export function ingestFact(ingest: ObservationIngest, ctx: FactIngestContext, input: Readonly<{ scope: unknown; projection: ObservationFactProjection; pathDigestKey?: Uint8Array }>): void {
  const s = materializeScope(input.scope);
  let gapRunId = s.ok ? s.scope.runId : s.runId;
  if (!s.ok) {
    ingestFactFailure(ingest, ctx, gapRunId, `scope 物化失败：${s.violation}`);
    return;
  }
  try {
    const p = input.projection;
    const scope = { ...s.scope, ...p.scope, runtimeId: ctx.runtimeId };
    if (typeof scope.runId === "string") gapRunId = scope.runId;
    const body = p.digests === undefined ? p.body : applyProjectionDigests(p.body, p.digests, input.pathDigestKey);
    const draft: BoundedObservationDraft<unknown> = {
      lane: "bounded",
      occurredAt: p.occurredAt,
      ...(p.sourceSeq === undefined ? {} : { sourceSeq: p.sourceSeq }),
      kind: p.kind,
      name: p.name,
      scope,
      correlation: {},
      generation: { runtime: ctx.runtimeGeneration },
      owner: ctx.sink.owner,
      instrumentation: ctx.sink.instrumentation,
      attributes: p.attributes,
      body,
      ...(p.subject === undefined ? {} : { subject: p.subject }),
    };
    // draft 里的 identity 由 Sequencer 再物化一次（它才是 canonical 的 owner）；这里不重复校验
    ingest.offer(draft);
  } catch (e) {
    ingestFactFailure(ingest, ctx, gapRunId, redactedLabel(e));
  }
}

type OpenWork = Extract<ObservationWork, { t: "open" }>;

/** 主线程那个存储在观测线程里的样子：每个操作是一次往返。 */
class ThreadStorage implements StorageDir {
  readonly lock?: StorageDir["lock"];

  constructor(
    private readonly host: ObservationThreadHost,
    private readonly rt: string,
    hasLock: boolean,
  ) {
    if (hasLock) {
      this.lock = async (name: string) => {
        const id = (await this.call({ op: "lock", name })) as number;
        return async () => void (await this.call({ op: "unlock", lock: id }));
      };
    }
  }

  read(path: string): Promise<string | null> {
    return this.call({ op: "read", path }) as Promise<string | null>;
  }

  async write(path: string, content: string): Promise<void> {
    await this.call({ op: "write", path, content });
  }

  remove(path: string): Promise<boolean> {
    return this.call({ op: "remove", path }) as Promise<boolean>;
  }

  list(prefix: string): Promise<string[]> {
    return this.call({ op: "list", prefix }) as Promise<string[]>;
  }

  private call(op: StorageOp): Promise<unknown> {
    return this.host.storage(this.rt, op);
  }
}

/** 一个 runtime 在观测线程里的全部状态。 */
class ThreadRuntime {
  readonly sequencer: ObservationSequencer;
  private readonly storage: ThreadStorage;
  private readonly assembly: AgentAssemblyObservationSnapshot;
  private readonly sinks = new Map<number, FactIngestContext>();
  /** run 开头状态快照这条记录的探针上下文（owner `echo:agent`、instrumentation `echo.agent`）。 */
  private readonly stateSnapshot: FactIngestContext;
  private readonly subscriptions = new Map<number, () => void>();
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  /** 正在处理的那条消息的时刻：Sequencer 盖 observedAt 用它（事实到达主线程的时刻，不是观测线程处理到的时刻）。 */
  private at: number | undefined;
  private writer: Promise<DocumentObservationStore> | undefined;
  private writerOpen = false;
  private resolveWriter!: (store: DocumentObservationStore) => void;
  private rejectWriter!: (e: Error) => void;
  private readonly writerReady: Promise<DocumentObservationStore>;
  private done = false;

  constructor(
    private readonly host: ObservationThreadHost,
    readonly runtimeId: string,
    private readonly open: OpenWork,
  ) {
    this.storage = new ThreadStorage(host, runtimeId, open.storageLock);
    this.stateSnapshot = factIngestContext({ runtimeId, runtimeGeneration: open.runtimeGeneration, sink: freezeSinkIdentity(open.boundaryOwner, AGENT_INSTRUMENTATION), report: () => {} });
    this.assembly = sealAgentAssemblyObservation(open.assembly);
    this.writerReady = new Promise((resolve, reject) => {
      this.resolveWriter = resolve;
      this.rejectWriter = reject;
    });
    // 丢弃时没人等它：别变成 unhandled rejection
    this.writerReady.catch(() => {});
    const store = this.deferredStore();
    this.sequencer = new ObservationSequencer({
      runtimeId,
      runtimeGeneration: open.runtimeGeneration,
      capturePolicy: open.capturePolicy,
      store,
      clock: {
        now: () => this.at ?? Date.now(),
        setInterval: (fn, ms) => {
          const handle = setInterval(fn, ms);
          return () => clearInterval(handle);
        },
      },
      ...(open.limits === undefined ? {} : { limits: open.limits }),
    });
  }

  /** 有没有还没做完、需要拖住进程的活：消息没处理完，或已经在写而还有没提交的记录。没开始写的 runtime 手上的记录不算。 */
  get busy(): boolean {
    if (this.pending > 0) return true;
    if (!this.writerOpen) return false;
    return this.sequencer.persistenceState.status === "healthy" && this.sequencer.reservedSeq > this.sequencer.committedSeq;
  }

  accept(work: ObservationWork): void {
    this.pending += 1;
    this.chain = this.chain
      .then(() => this.handle(work))
      // 观测线程自己的意外：这条消息的事实不记，接着处理下一条
      .catch(() => {})
      .finally(() => {
        this.pending -= 1;
        this.host.scheduleIdleCheck();
      });
  }

  private async handle(work: ObservationWork): Promise<void> {
    if (this.done) {
      // 收摊之后才轮到的请求：与 runtime 已不在表里时同一种回信
      if (work.t === "flush") this.host.send({ t: "reply", id: work.id, ok: true, value: undefined });
      else if (work.t === "health" || work.t === "subscribe") this.host.send({ t: "reply", id: work.id, ok: false, error: { name: "Error", message: "观测 runtime 已收摊" } });
      return;
    }
    switch (work.t) {
      case "open":
        return;
      case "sink":
        this.sinks.set(
          work.sink,
          factIngestContext({ runtimeId: this.runtimeId, runtimeGeneration: this.open.runtimeGeneration, sink: freezeSinkIdentity(work.owner, work.instrumentation), report: () => {} }),
        );
        return;
      case "fact":
        return this.onFact(work);
      case "fact-failed": {
        const ctx = this.sinks.get(work.sink);
        if (ctx !== undefined) this.withAt(work.at, () => ingestFactFailure(this.sequencer, ctx, work.runId, work.why, work.error));
        return;
      }
      case "run-accepted":
        return this.withAt(work.at, () => this.onRunAccepted(work));
      case "run-started":
        return this.withAt(work.at, () => this.onRunStarted(work));
      case "run-closed":
        return this.withAt(work.at, () => this.onRunClosed(work));
      case "flush":
        await this.startWriting().catch(() => {});
        await this.sequencer.flushPending();
        this.host.send({ t: "reply", id: work.id, ok: true, value: undefined });
        return;
      case "health": {
        const value: ThreadHealth = { health: this.sequencer.health(), committedSeq: this.sequencer.committedSeq };
        this.host.send({ t: "reply", id: work.id, ok: true, value });
        return;
      }
      case "subscribe": {
        try {
          await this.startWriting().catch(() => {});
          const sub = work.sub;
          const unsubscribe = this.sequencer.subscribe({
            afterSeq: work.afterSeq,
            ...(work.runId === undefined ? {} : { runId: work.runId }),
            listener: (item) => this.host.send({ t: "item", rt: this.runtimeId, sub, item }),
          });
          this.subscriptions.set(sub, unsubscribe);
          this.host.send({ t: "reply", id: work.id, ok: true, value: undefined });
        } catch (e) {
          this.host.send({ t: "reply", id: work.id, ok: false, error: serializeError(e) });
        }
        return;
      }
      case "unsubscribe":
        this.subscriptions.get(work.sub)?.();
        this.subscriptions.delete(work.sub);
        return;
      case "close":
        // 开始写了就写完（写入端还在打开也等它：存储慢不等于没开始）；从没开始写的直接丢
        if (this.writer !== undefined) {
          const store = await this.writer.catch(() => undefined);
          if (store !== undefined) {
            await this.sequencer.flushPending();
            await store.close();
          }
        }
        this.finish();
        return;
      case "discard":
        this.finish();
        return;
    }
  }

  private withAt(at: number, fn: () => void): void {
    this.at = at;
    try {
      fn();
    } finally {
      this.at = undefined;
    }
  }

  /** 收摊：退订、让还在等写入端的提交失败掉，不再发任何消息。 */
  private finish(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.done = true;
    if (!this.writerOpen) this.rejectWriter(new Error("观测 runtime 已收摊，没有开始写"));
    this.host.finished(this.runtimeId);
  }

  /** 开始落盘：读或建 key，打开写入端。只开一次。 */
  private startWriting(): Promise<DocumentObservationStore> {
    return (this.writer ??= DocumentObservationStore.open({ dir: this.storage, path: this.open.storePath }).then(
      (store) => {
        this.writerOpen = true;
        this.resolveWriter(store);
        return store;
      },
      (e: unknown) => {
        // 打不开：之后的提交都失败，Sequencer 降级 / 封口，health 里看得到
        const err = e instanceof Error ? e : new Error(String(e));
        this.rejectWriter(err);
        throw err;
      },
    ));
  }

  /** Sequencer 看到的存储：没开始写之前，提交在这里等着。 */
  private deferredStore(): CanonicalObservationStore {
    const writer = (): Promise<DocumentObservationStore> => this.writerReady;
    return {
      commitBatchIfAbsent: async (input) => (await writer()).commitBatchIfAbsent(input),
      readRecordBytes: async (recordId) => (await writer()).readRecordBytes(recordId),
      readRunIndex: async (runId) => (await writer()).readRunIndex(runId),
      readCommittedPrefix: async (runtimeId) => (await writer()).readCommittedPrefix(runtimeId),
      readRecordsAfter: async (runtimeId, afterSeq, limit) => (await writer()).readRecordsAfter(runtimeId, afterSeq, limit),
    };
  }

  private async onFact(work: Extract<ObservationWork, { t: "fact" }>): Promise<void> {
    const ctx = this.sinks.get(work.sink);
    if (ctx === undefined) return; // 没登记的探针：主线程那边的 bug，这条不记
    // 记忆路径的 HMAC 要这个状态根的 key：key 在写入端里，要它就得开始写（这类事实只在 run 里出现，run.accepted 时已经开始了）
    let pathDigestKey: Uint8Array | undefined;
    const digests = work.projection.digests;
    if (digests !== undefined && Object.values(digests).some((d) => d.keyed === true)) {
      pathDigestKey = await this.startWriting().then(
        (store) => store.readPathDigestKey(),
        () => undefined,
      );
    }
    this.withAt(work.at, () => ingestFact(this.sequencer, ctx, { scope: work.scope, projection: work.projection, ...(pathDigestKey === undefined ? {} : { pathDigestKey }) }));
  }

  /* ───────── run 三条边界（唯一 emission owner） ───────── */

  /** `run.accepted`（RunIndex 种子）与紧跟的 `run.assembly` 快照。这个 runtime 从这里开始落盘。 */
  private onRunAccepted(work: Extract<ObservationWork, { t: "run-accepted" }>): void {
    void this.startWriting().catch(() => {});
    const header: RunObservationHeaderSeed = {
      runId: work.runId,
      source: work.source,
      runtimeId: this.runtimeId,
      agentId: work.identity.agentId,
      agentInstanceId: work.identity.agentInstanceId,
      sessionId: work.identity.sessionId,
      runtimeGeneration: this.open.runtimeGeneration,
      capturePolicy: this.open.capturePolicy,
      acceptedAt: work.at,
    };
    const scope = this.runScope(work.runId, work.identity);
    const accepted: RunAcceptedBodyV1 = { header };
    this.fireBoundary(this.boundary("run.accepted", "event", scope, work.at, accepted));
    let assembly: RunAssemblyBodyV1;
    try {
      const m = work.model;
      const model = { provider: m.provider, id: m.id, api: m.api, params: m.params, thinkingLevelMap: m.thinkingLevelMap, capabilities: m.capabilities, cost: m.cost } as unknown as Model;
      // RunModelSnapshot 与 `Model` 的数据字段同形（api / params / thinkingLevelMap / capabilities / cost），digest 同一把尺
      assembly = { agentAssembly: this.assembly, modelBinding: snapshotRunModelBinding(model, m.catalogRevision) };
    } catch {
      return; // 模型绑定编码不了：这个 run 没有装配快照
    }
    this.fireBoundary(this.boundary(RUN_ASSEMBLY_RECORD, "snapshot", scope, work.at, assembly));
  }

  /** 真正进入 loop 的那一拍，紧跟着 run 开头的状态（与结尾的 finalSnapshot 同形、同一个校验器，一比就知道这个 run 改了什么）。 */
  private onRunStarted(work: Extract<ObservationWork, { t: "run-started" }>): void {
    const started: RunStartedBodyV1 = { startedBy: work.startedBy };
    this.fireBoundary(this.boundary("run.started", "event", this.runScope(work.runId, work.identity), work.at, started));
    if (this.open.capturePolicy === "off") return;
    const scope = { ...this.identityScope(work.identity), runId: work.runId, runtimeId: this.runtimeId };
    try {
      const state = materializeObservableState(completeObservableState(work.state, this.sequencer.persistenceState.status));
      this.sequencer.offer({
        lane: "bounded",
        occurredAt: work.at,
        kind: "snapshot",
        name: "agent.state",
        scope,
        correlation: {},
        generation: { runtime: this.open.runtimeGeneration },
        owner: this.open.boundaryOwner,
        instrumentation: AGENT_INSTRUMENTATION,
        attributes: { moment: "run_started", capabilities: state.capabilities.length },
        body: { moment: "run_started", state },
      });
    } catch (e) {
      ingestFactFailure(this.sequencer, this.stateSnapshot, work.runId, redactedLabel(e));
    }
  }

  /** 封口：业务 outcome 已冻结；capture gap 的 count / digest 由 Sequencer 从自己的账本填（`RunClosedBodyV1`）。 */
  private onRunClosed(work: Extract<ObservationWork, { t: "run-closed" }>): void {
    let body: RunClosedBodyInput;
    try {
      body = {
        outcome: toRunClosedOutcome(work.outcome),
        finalSnapshot:
          this.open.capturePolicy === "off" || work.finalState === null
            ? null
            : { throughSeq: this.sequencer.committedSeq, at: work.at, state: completeObservableState(work.finalState, this.sequencer.persistenceState.status) },
      };
    } catch {
      // 状态摘要算不出来（状态里有编码不了的值）：outcome 照封，快照不要
      body = { outcome: toRunClosedOutcome(work.outcome), finalSnapshot: null };
    }
    this.fireBoundary(this.boundary("run.closed", "event", this.runScope(work.runId, work.identity), work.at, body));
  }

  /**
   * 提交不等的 boundary。`appendBoundary()` 的同步段做完 lifecycle 检查 / seq 预留 / RunIndex 登记才返回 Promise，
   * 所以顺序已定；落不下去的结果只在 Sequencer 的 health 里，这里接住 rejection 不让它成为 unhandled。
   */
  private fireBoundary(draft: BoundaryObservationDraft<unknown>): void {
    try {
      this.sequencer.appendBoundary(draft).catch(() => {});
    } catch {
      // 预留失败（lifecycle 不合法等）：这条边界不记
    }
  }

  private identityScope(identity: RunIdentity): Readonly<Record<string, string>> {
    return {
      agentId: identity.agentId,
      agentInstanceId: identity.agentInstanceId,
      ...(identity.sessionId === null ? {} : { sessionId: identity.sessionId }),
    };
  }

  private runScope(runId: string, identity: RunIdentity): Readonly<Record<string, string>> {
    return { runtimeId: this.runtimeId, runId, ...this.identityScope(identity) };
  }

  private boundary<T>(name: string, kind: ObservationRecordKind, scope: Readonly<Record<string, string>>, occurredAt: number, body: T): BoundaryObservationDraft<T> {
    return {
      lane: "boundary",
      occurredAt,
      kind,
      name,
      scope: scope as BoundaryObservationDraft["scope"],
      correlation: {},
      generation: { runtime: this.open.runtimeGeneration, agentAssembly: this.assembly.digest },
      owner: this.open.boundaryOwner,
      instrumentation: RUN_ADMISSION_INSTRUMENTATION,
      attributes: {},
      body,
    };
  }
}

/**
 * 观测线程的宿主：收主线程的消息、分给各 runtime、替它们向主线程要存储操作、判断空闲。
 * `send` 是发回主线程的通道（线程入口里是 `parentPort.postMessage`）。
 */
export class ObservationThreadHost {
  private readonly runtimes = new Map<string, ThreadRuntime>();
  private readonly storageCalls = new Map<number, Readonly<{ resolve: (value: unknown) => void; reject: (e: Error) => void }>>();
  private nextStorageCall = 1;
  /** 收到的最大工作消息编号。 */
  private through = 0;
  private reportedIdle = -1;
  private idleCheck: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly send: (message: FromObservationThread) => void) {}

  receive(message: ToObservationThread): void {
    if (message.t === "storage-reply") {
      const call = this.storageCalls.get(message.id);
      this.storageCalls.delete(message.id);
      if (call !== undefined) {
        if (message.ok) call.resolve(message.value);
        else call.reject(reviveError(message.error));
      }
      this.scheduleIdleCheck();
      return;
    }
    this.through = message.n;
    if (message.t === "open") {
      if (!this.runtimes.has(message.rt)) {
        try {
          this.runtimes.set(message.rt, new ThreadRuntime(this, message.rt, message));
        } catch {
          // 起不来（装配快照编码不了）：这个 agent 不记观测
          this.send({ t: "closed", rt: message.rt });
        }
      }
      this.scheduleIdleCheck();
      return;
    }
    const runtime = this.runtimes.get(message.rt);
    if (runtime === undefined) {
      // 已收摊或没起来的 runtime：请求照样回信，别让主线程等一个永远不来的回复
      if (message.t === "flush") this.send({ t: "reply", id: message.id, ok: true, value: undefined });
      else if (message.t === "health" || message.t === "subscribe") this.send({ t: "reply", id: message.id, ok: false, error: { name: "Error", message: "观测 runtime 已收摊" } });
      this.scheduleIdleCheck();
      return;
    }
    runtime.accept(message);
    this.scheduleIdleCheck();
  }

  /** 替 runtime 向主线程要一次存储操作。 */
  storage(rt: string, op: StorageOp): Promise<unknown> {
    const id = this.nextStorageCall++;
    return new Promise((resolve, reject) => {
      this.storageCalls.set(id, { resolve, reject });
      this.send({ t: "storage", id, rt, ...op });
    });
  }

  /** runtime 收完摊：从表里拿掉，告诉主线程。 */
  finished(rt: string): void {
    this.runtimes.delete(rt);
    this.send({ t: "closed", rt });
    this.scheduleIdleCheck();
  }

  /** 事件循环空下来之后看一眼：没有在途的存储操作、每个 runtime 都不忙，就告诉主线程处理到了哪一条。 */
  scheduleIdleCheck(): void {
    if (this.idleCheck !== undefined) return;
    this.idleCheck = setTimeout(() => {
      this.idleCheck = undefined;
      if (this.storageCalls.size > 0) return;
      for (const runtime of this.runtimes.values()) if (runtime.busy) return;
      if (this.reportedIdle === this.through) return;
      this.reportedIdle = this.through;
      this.send({ t: "idle", through: this.through });
    }, 0);
  }
}
