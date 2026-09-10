// ObservationSequencer：recordId、seq、observedAt 与 canonical append 顺序的
// **唯一 owner**。producer 只提交 draft；identity、normalize、batch、live 扇出全在这里。
//
// 两条 lane 两种 API：
//   · `offer()`：bounded lane。**同步、永不抛、没有 Promise**。预留 seq → normalize → 进 ring。ring 满或编码
//     失败 → 该 seq 当场成 hole，并在任何后续 producer 取得 seq 之前预留下一个 seq 写 `CanonicalObservationGap`。
//   · `appendBoundary()`：boundary lane。可等待；装一个 prefix barrier，worker 先把 `< B` 的全部 record/gap 排空，
//     在含 B 及其 RunIndex mutation 的同一事务提交并 read-back 到 `committedPrefix >= B` 才 resolve。
//
// committed prefix 只越过两类位置：已 committed 的 record，或被后续 gap 精确覆盖的 hole。
// live 扇出严格在 COMMIT/read-back 之后按 seq 进行；rollback / indeterminate 的 candidate 永远不可见。

import type { Diagnostic } from "../errors.ts";
import type { Clock } from "../schedule/clock.ts";
import type { BoundaryObservationDraft, BoundedObservationDraft, ObservationDraft, RunAcceptedBodyV1, RunObservationHeaderSeed } from "./draft.ts";
import { RUN_BOUNDARY_NAMES } from "./draft.ts";
import {
  ObservationEncodingError,
  boundaryEncodingLimits,
  canonicalDigest,
  encodeCanonical,
  envelopeFramingLimits,
  syncEncodingLimits,
  type EncodingLimits,
  type StagedBlob,
} from "./normalize.ts";
import { redactError, redactedLabel, toSafeError } from "./redact.ts";
import { sha256Hex } from "./hash.ts";
import { assertIdentifier, materializeRecordFrame, materializeScope } from "./identity.ts";
import { ObservationCorruptionError, ObservationStoreUnavailableError, runIndexDigest } from "./store.ts";
import { decodeObservationEnvelope } from "./materialize.ts";
import { preflightTerminalProjection } from "./terminal.ts";
import type { CanonicalObservationStore, CanonicalRecordCandidate, CommitBatchInput, RunIndexMutation } from "./store.ts";
import type {
  ObservationCapturePolicy,
  ObservationEnvelope,
  ObservationGap,
  ObservationGapReason,
  ObservationHealth,
  ObservationPersistenceState,
  RunClosedBodyInput,
  RunClosedBodyV1,
  RunIndexEntryV1,
  SinkDeliveryGap,
  SinkHealth,
} from "./types.ts";

/* ══════════════════ 公共（Host-internal）接口 ══════════════════ */

/**
 * 从**可能带敌意 getter 的** scope 容器里 total 地取一次 runId。取不到就是 runtime-scoped。
 * 只在失败路径用：成功路径一律用 `candidate.runId`（那是物化后的值）。
 */
function safeRunIdOf(scope: unknown): string | undefined {
  const m = materializeScope(scope);
  return m.ok ? m.scope.runId : m.runId;
}

/** `reserveProjectionFailureGap()` 的明确结果。不用 `{omittedSeq, gapSeq}` 伪造一个「已预留」。 */
export type ProjectionFailureOutcome = "gap-reserved" | "writer-unavailable";

export interface ObservationIngest {
  /** 同步预留 identity、normalize 并尝试进入 bounded ring；永不抛、没有 Promise。 */
  offer<TInput>(draft: BoundedObservationDraft<TInput>): void;
  /** 同步预留/normalize identity，返回「本 boundary exact committed，prefix 已至少推进到它」的 durability 结果。 */
  appendBoundary<TInput>(draft: BoundaryObservationDraft<TInput>): Promise<ObservationEnvelope>;
  /**
   * **descriptor 投影失败也必须留痕**：预留失败身份 S，并在 S+1 挂一条 safe `CanonicalObservationGap`。
   *
   * 起因（2026-08-27 review 实测）：`factSinkToIngest()` 在进 Sequencer **之前**调 `descriptor.project()`，
   * 它抛错时只报一条 `observation_fact_dropped` 诊断——`committed=0`、`canonicalGapCount=0`，
   * 事实已经不见，而 RunObservation 仍可标 complete。canonical 路径上「记录数对不上必然有 gap」这条
   * 不变量因此是假的。诊断不是 canonical 证据，两者不能互相替代。
   *
   * 归到 `encoding_error`：从 canonical 记录的角度，投影失败与 normalize/序列化失败是同一件事
   * ——**没能把这条事实变成可提交的 bytes**。细分类进诊断，不为它加一个新的公共 gap reason。
   *
   * 只有 Host 拥有的 adapter 会调它（Capability 拿到的是 `CapabilityFactSink`，看不见这个方法）。
   *
   * **writer 进入 terminal 后这条保证不再可能兑现**：gap 也是要提交的记录。那时返回
   * `"writer-unavailable"`，什么都不预留，调用方只发一次安全的 live 诊断。
   */
  reserveProjectionFailureGap(input: Readonly<{ runId: string | undefined }>): ProjectionFailureOutcome;
}

/** 不属于 ObservationIngest：仅 permit finalizer 的内部封口通道可调用。 */
export interface SequencerFinalizationPrivate {
  reserveOptionalProjectionGap(
    input: Readonly<{
      runId: string;
      subjectId: "run.final_snapshot" | "run.final_snapshot.capabilities";
      reason: "capture_limit";
    }>,
  ): Readonly<{ omittedSeq: number; gapSeq: number }>;
}

export type SequencerLimits = Readonly<{
  maxBatchRecords: number;
  maxBatchBytes: number;
  maxBatchDelayMs: number;
  /** bounded lane 未提交 candidate 的上限；boundary lane 不计入。 */
  ringCapacity: number;
  /** `appendBoundary()` 的 durability deadline；到期按 canonical persistence failure 处理。 */
  boundaryDeadlineMs: number;
  subscriberQueueCapacity: number;
  /** read-after-error 明确 not-found 时的重试上限。 */
  maxCommitAttempts: number;
  /**
   * 内存里留多少条已 committed 的 envelope 供 `subscribe()` 回放；更早的从 store 分页读。
   * 上一版 `committed` 数组无界——常驻 agent 跑多久涨多久（2026-09-06）。
   */
  replayWindowRecords: number;
}>;

export const DEFAULT_SEQUENCER_LIMITS: SequencerLimits = {
  maxBatchRecords: 256,
  maxBatchBytes: 1024 * 1024,
  maxBatchDelayMs: 20,
  ringCapacity: 4096,
  boundaryDeadlineMs: 5000,
  subscriberQueueCapacity: 1024,
  maxCommitAttempts: 3,
  replayWindowRecords: 1024,
};

/** 从 store 回放时一页读多少条：读完一页、交付完再读下一页，内存里最多只有一页。 */
const REPLAY_PAGE_RECORDS = 256;

export type ObservationSequencerOptions = Readonly<{
  runtimeId: string;
  /** RuntimeGeneration 标识，盖进每条 envelope 的 `generation.runtime`。 */
  runtimeGeneration: string;
  /** admission 时冻结的 capture policy；这里只用于 health 快照，不参与投影（投影在 tap/adapter）。 */
  capturePolicy: ObservationCapturePolicy;
  store: CanonicalObservationStore;
  clock: Clock;
  limits?: Partial<SequencerLimits>;
  report?: (d: Diagnostic) => void;
}>;

export type ObservationSubscribeItem = ObservationEnvelope | SinkDeliveryGap;
export type ObservationSubscribeListener = (item: ObservationSubscribeItem) => void;

export type ObservationSubscribeOptions = Readonly<{
  /** exclusive：从 afterSeq + 1 起回放 committed prefix，再接 live。 */
  afterSeq: number;
  listener: ObservationSubscribeListener;
  sinkId?: string;
  runId?: string;
}>;

export const SEQUENCER_INSTRUMENTATION = { name: "echo.observation.sequencer", version: "1" } as const;

/** 已关闭 sink 的 tombstone 上限：`status:"closed"` 与 lastErrorDigest 要在 health 里可见，但不能无界增长。 */
export const MAX_CLOSED_SINK_TOMBSTONES = 32;

/**
 * 单个 sink 保留的 `SinkDeliveryGap` 条数上限。队列有界了、账本却无界，常驻运行时照样涨
 * （review 实测 100 次 overflow/drain 循环 → 100 条 gap，`health()` 每次还全量拷贝，tombstone 又长期持有）。
 * 超出后丢最旧的，并把丢弃条数记进 `droppedGapCount`——少记可以，假装没丢不行。
 */
export const MAX_SINK_GAPS = 32;

/** 把可注入的 reporter 包成 no-throw：它是外部给的，抛错就会击穿 `offer()` 的 no-throw 契约（review 实测）。 */
function safeReporter(report: ((d: Diagnostic) => void) | undefined): (d: Diagnostic) => void {
  if (report === undefined) return () => {};
  let disabled = false;
  return (d) => {
    if (disabled) return;
    try {
      // **只挡同步 throw 是不够的**（2026-08-27 review P0）：`(d) => void` 同样放行 `async` reporter，
      // 它 reject 时是进程级 unhandled rejection——观测故障又一次击穿主流程。
      const r: unknown = report(d);
      if (typeof r === "object" && r !== null && typeof (r as { then?: unknown }).then === "function") {
        // **吞掉 rejection 还不够，得停用它**（同轮 review P1）：只吞不停的话，每条诊断仍会调一次违规
        // reporter——实测 10,000 条诊断 = 10,000 次调用 + 10,000 个 pending Promise，诊断通道自己成了
        // 资源放大器。与 tap 同一处置：接口要求同步，返回 thenable 即停用。
        disabled = true;
        Promise.resolve(r as PromiseLike<unknown>).then(
          () => {},
          () => {},
        );
      }
    } catch {
      // 诊断通道自己坏了，没有第二条诊断通道可报——只能吞
    }
  };
}

/* ══════════════════ 内部状态 ══════════════════ */

type IndexEffect =
  | Readonly<{ kind: "accepted"; seed: RunObservationHeaderSeed }>
  | Readonly<{ kind: "started" }>
  | Readonly<{ kind: "closed"; body: RunClosedBodyV1 }>
  | Readonly<{ kind: "record" }>
  | Readonly<{ kind: "gap" }>;

type CandidateSlot = {
  readonly kind: "candidate";
  readonly seq: number;
  readonly lane: "bounded" | "boundary";
  readonly envelope: ObservationEnvelope;
  readonly bytes: Uint8Array;
  readonly blobs: readonly StagedBlob[];
  readonly runId: string | undefined;
  readonly indexEffect: IndexEffect | undefined;
};

type HoleSlot = {
  readonly kind: "hole";
  readonly seq: number;
  readonly reason: ObservationGapReason;
  /**
   * 覆盖本 hole 的 gap 的 seq（总是 > seq）。`undefined` = 还没预留：这是一段**尚未收口的连续 buffer_overflow 区间**里的
   * hole，整段共用一条 gap，等区间收口（下一次别的预留，或 flush 走到这里）时才定下来（2026-09-09）。
   */
  readonly coveredBy: number | undefined;
};

/**
 * 连续 buffer_overflow 的合并区间（2026-09-09 拍板改不变量，review 2026-09-07 #45）：此前每条溢出各自 hole + gap，
 * 一次 1 000 条的突发就是 2 000 个 seq、1 000 条 canonical gap、1 000 次 digest 滚动——ring 越满，账本越长，正好反过来。
 * 现在同一 run（或同为 runtime-scoped）的连续溢出只占各自的 hole seq，共用**一条** gap，放在区间末尾；
 * 任何别的预留（成功的 offer、boundary、别的 gap）先把它收口，gap 因此永远紧跟区间最后一个 hole。
 *
 * 登记（review 2026-09-09，未做）：区间内每条丢弃仍各占一个 `HoleSlot`，内存与 commit 时的遍历是 n 不是常量
 * （实测 100 万条丢弃 119 MB）。下一步是用一个 range slot `{ firstSeq, lastSeq, coveredBy }` 代替逐条 hole，
 * `collectWindow` / `applyCommitted` / `pendingBytesExceedLimits` 直接跳到 `lastSeq + 1`。
 */
type OverflowRun = { firstSeq: number; lastSeq: number; readonly runId: string | undefined };

/** 封口后还留在内存里的 run 数（RunIndex 查询缓存 + 重复 `run.accepted` 的同步判据）。更老的只在 store 里。 */
const CLOSED_RUN_RETENTION = 256;

type Slot = CandidateSlot | HoleSlot;

type Waiter = {
  readonly seq: number;
  readonly resolve: (env: ObservationEnvelope) => void;
  readonly reject: (e: Error) => void;
  readonly cancelDeadline: () => void;
  settled: boolean;
};

/**
 * subscribe 要的 afterSeq 早于内存窗口时，从 store 分页回放的进度。`undefined` = 不在回放（或已回放完）。
 * 回放期间 live 记录照常进 `queue`，但先交付 `replay.queue` 里的旧记录——顺序仍按 seq。
 */
type ReplayState = {
  /** 已读到的 seq（exclusive）。 */
  cursor: number;
  /** 回放到这里为止（inclusive）：内存窗口最旧那条的前一条。 */
  readonly upto: number;
  readonly queue: ObservationSubscribeItem[];
  fetching: boolean;
};

type Subscriber = {
  readonly id: string;
  readonly listener: ObservationSubscribeListener;
  readonly runId: string | undefined;
  readonly queue: ObservationSubscribeItem[];
  replay: ReplayState | undefined;
  lastDeliveredSeq: number;
  status: "healthy" | "degraded" | "closed";
  readonly gaps: SinkDeliveryGap[];
  droppedGapCount: number;
  /** 正在累积的连续丢弃区间（首/末 seq），下一条成功入队时先把它作为 notice 交付。 */
  pendingDrop: { first: number; last: number } | undefined;
  draining: boolean;
  /** 是否有一条 async 交付在途。有的话 drain 停下等它 settle——异步 listener 不许绕过 bounded queue。 */
  inFlight: boolean;
  lastErrorDigest: string | undefined;
};

type Window = Readonly<{
  slots: readonly CandidateSlot[];
  nextPrefix: number;
}>;

function once(clock: Clock, fn: () => void, ms: number): () => void {
  let fired = false;
  const cancel = clock.setInterval(() => {
    if (fired) return;
    fired = true;
    cancel();
    fn();
  }, ms);
  return () => {
    fired = true;
    cancel();
  };
}

function isRunBoundaryName(name: string): name is (typeof RUN_BOUNDARY_NAMES)[number] {
  return (RUN_BOUNDARY_NAMES as readonly string[]).includes(name);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `RunObservationHeaderSeed` 的键集。RunIndex 是 retention 之后 header 的唯一真相源，这里必须封闭。 */
const HEADER_REQUIRED_KEYS: readonly string[] = [
  "runId",
  "source",
  "runtimeId",
  "agentId",
  "agentInstanceId",
  "sessionId",
  "runtimeGeneration",
  "capturePolicy",
  "acceptedAt",
];
const HEADER_OPTIONAL_KEYS: readonly string[] = ["submissionId"];

/* ══════════════════ Sequencer ══════════════════ */

export class ObservationSequencer implements ObservationIngest, SequencerFinalizationPrivate {
  private readonly runtimeId: string;
  private readonly runtimeGeneration: string;
  private readonly capturePolicy: ObservationCapturePolicy;
  private readonly store: CanonicalObservationStore;
  private readonly clock: Clock;
  private readonly limits: SequencerLimits;
  private readonly report: (d: Diagnostic) => void;

  private lastReserved = 0;
  private committedPrefix = 0;
  private readonly slots = new Map<number, Slot>();
  private pendingBounded = 0;
  private readonly waiters = new Map<number, Waiter>();
  /**
   * **只有开着的 run**（2026-09-09，review 2026-09-07 #46）：封口落库那一刻删。此前两张表只进不出，常驻 agent 每跑一个 run
   * 各涨一条。封口后的 run 挪进 `closedRuns`（有界，最老的先出）：它同时是 `committedRunIndex()` 的查询缓存与
   * 「同一 runId 第二次 run.accepted」的同步判据；出了缓存的老 run 若再被 accepted，由 store 的 RunIndex CAS
   * （期望不存在、实际存在）判红——那是 writer 的 bug，不是运行态。
   */
  private readonly runBoundaries = new Map<string, { accepted?: number; started?: number; closed?: number }>();
  private readonly runIndexCache = new Map<string, RunIndexEntryV1>();
  private readonly closedRuns = new Map<string, RunIndexEntryV1>();
  private overflow: OverflowRun | undefined;
  /**
   * 每个 run 的 canonical gap 账本，**常量空间**：每生成一条 exact canonical gap，就用它的 canonical bytes
   * 滚一次 digest。存数组再在封口时重编是错的——700 个 gap 就能让 `run.closed` 因 nodes_exceeded 永远封不了口，
   * 而失败路径还会再追加一个 gap（review 实测）；数组只留 `{seq, reason}` 也分辨不出 subject 不同的两条 gap。
   */
  private readonly runGaps = new Map<string, { count: number; rolling: string }>();
  private canonicalGapCount = 0;
  /** 最近 `replayWindowRecords` 条已 committed 的 envelope（按 seq，hole 不在其中）。更早的只在 store 里。 */
  private readonly recentCommitted: ObservationEnvelope[] = [];

  private persistence: ObservationPersistenceState = { status: "healthy" };
  private droppedWhileUnavailable = 0;

  private flushing = false;
  private flushRequested = false;
  private cancelDelayedFlush: (() => void) | undefined;
  private idleResolvers: (() => void)[] = [];

  private readonly subscribers = new Map<string, Subscriber>();
  private subscriberSerial = 0;
  private readonly closedSinks: SinkHealth[] = [];

  constructor(opts: ObservationSequencerOptions) {
    // 构造期就把只出现在 envelope、不出现在 ephemeral fact 的身份字段钉住——否则「engine 永不比 Runtime 宽」
    // 这条不变量没有依据可言（review：5,000 字节的 runtimeId / generation 即可让两面裁决分叉）。
    assertIdentifier(opts.runtimeId, "runtimeId");
    assertIdentifier(opts.runtimeGeneration, "runtimeGeneration");
    this.runtimeId = opts.runtimeId;
    this.runtimeGeneration = opts.runtimeGeneration;
    this.capturePolicy = opts.capturePolicy;
    this.store = opts.store;
    this.clock = opts.clock;
    this.limits = { ...DEFAULT_SEQUENCER_LIMITS, ...opts.limits };
    this.report = safeReporter(opts.report);
  }

  /* ───────── 只读面 ───────── */

  get committedSeq(): number {
    return this.committedPrefix;
  }

  get reservedSeq(): number {
    return this.lastReserved;
  }

  get persistenceState(): ObservationPersistenceState {
    return this.persistence;
  }

  /** 内存窗口里最近 `replayWindowRecords` 条已 committed 的 envelope（按 seq，hole 不在其中）。完整历史在 store。 */
  committedRecords(): readonly ObservationEnvelope[] {
    return this.recentCommitted;
  }

  committedRunIndex(runId: string): RunIndexEntryV1 | undefined {
    return this.runIndexCache.get(runId) ?? this.closedRuns.get(runId);
  }

  /**
   * 某个 run 当前的 capture accumulator（只读）。封口落库后返回 `undefined`——per-run 状态在那时释放。
   * 两个字段定长，与 gap 条数无关。
   */
  captureStateOf(runId: string): Readonly<{ count: number; rolling: string }> | undefined {
    const acc = this.runGaps.get(runId);
    return acc === undefined ? undefined : { count: acc.count, rolling: acc.rolling };
  }

  health(): ObservationHealth {
    const p = this.persistence;
    return {
      persistence: {
        status: p.status,
        lastCommittedSeq: this.committedPrefix,
        ...(p.status === "degraded" || p.status === "recovering"
          ? { degradedSince: p.since, lastErrorDigest: p.lastErrorDigest, reopenAttempts: p.reopenAttempts }
          : p.status === "sealed" || p.status === "lost-lease"
            ? {
                // terminal 也要交出「什么时候、因为什么」：只报 reopenAttempts:0 等于把最需要证据的一刻做成空白
                terminalSince: p.since,
                ...(p.degradedSince === undefined ? {} : { degradedSince: p.degradedSince }),
                lastErrorDigest: p.lastErrorDigest,
                reopenAttempts: p.reopenAttempts,
              }
            : { reopenAttempts: 0 }),
      },
      capture: { policy: this.capturePolicy, canonicalGapCount: this.canonicalGapCount },
      sinks: [...[...this.subscribers.values()].map((s) => this.sinkHealthOf(s)), ...this.closedSinks],
    };
  }

  /** 等到没有 flush 在途。延迟 flush 的定时器不算（测试先拨 clock 再等）。 */
  idle(): Promise<void> {
    if (!this.flushing) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /**
   * 收摊前排空：把 ring 里还没到批量阈值的 candidate 立刻提交，等到 flush 全部 settle。
   * 不是 close——writer 状态不变，之后仍可 offer；只是 Runtime 关 SQLite 之前必须先把尾巴写完。
   * writer 已 terminal 时直接返回（没有可提交的东西，也不再有定时器）。
   */
  async flushPending(): Promise<void> {
    for (;;) {
      const s = this.persistence.status;
      if (s === "sealed" || s === "lost-lease") return;
      if (this.slots.size === 0 && !this.flushing) return;
      this.scheduleFlush("now");
      await this.idle();
      // flush 结束后 ring 可能又被填了一批（flush 期间到达）：再来一轮，直到彻底空
      if (this.slots.size === 0 && !this.flushing) return;
    }
  }

  /* ───────── bounded lane ───────── */

  /**
   * writer 进入 terminal 后**任何**预留入口都必须先过这道门（2026-08-27 review P1）。
   *
   * 原来只有 `offer()` 挡了：`appendBoundary()` 会拒、`flushOnce()` 不再消费，但
   * `reserveProjectionFailureGap()` 没挡——sealed 之后每条 projection/scope 失败仍旧预留 seq + hole + gap，
   * 实测 100 次失败让 `lastReserved` 从 1 涨到 201、`slots` 201、`canonicalGapCount` +100。
   * 那些 gap **永远不可能成为 canonical record**，内存却一直涨，健康数字也跟着失真。
   * 返回 true = 已丢弃（调用方立刻返回）。
   */
  private unavailable(what: string): boolean {
    const s = this.persistence.status;
    if (s !== "sealed" && s !== "lost-lease") return false;
    this.droppedWhileUnavailable += 1;
    if (this.droppedWhileUnavailable === 1) {
      this.report({ code: "observation_offer_dropped", message: `writer ${s}，${what} 丢弃（只报第一次）` });
    }
    return true;
  }

  offer<TInput>(draft: BoundedObservationDraft<TInput>): void {
    let seq: number | undefined;
    try {
      if (this.unavailable("bounded record")) return;
      // ring 满：不编码、不物化，并进当前的溢出区间（一段连续溢出共用一条 gap，见 `OverflowRun`）。
      // 判在预留之前：这条 seq 只会是 hole，而且不该让它把上一段区间收口
      if (this.pendingBounded >= this.limits.ringCapacity) {
        this.overflowHole(safeRunIdOf(draft.scope));
        return;
      }
      seq = this.reserve();
      let candidate: CandidateSlot;
      try {
        // **不许直接读 `draft.scope.runId`**（2026-08-27 review P1）：`draft.scope` 是调用方构造的对象，
        // 一个抛错的 runId getter 会让「已预留 seq」既没有 candidate 也没有 hole/gap，
        // committed prefix 就此永久卡死，而 writer 还声称 healthy（实测 reserved=2、committed=0、gaps=0）。
        // effect 改由 encodeCandidate 从**物化后的** identity 推导（`"auto"`）。
        candidate = this.encodeCandidate(draft, seq, syncEncodingLimits(), "auto");
      } catch (e) {
        // 失败路径只做**一次 total 的 scope 物化**来找回 runId；找不回就是 runtime-scoped gap。
        // 绝不回头再读一次原容器——那正是上面这个洞的成因。
        this.markHole(seq, safeRunIdOf(draft.scope), "encoding_error", undefined, e);
        return;
      }
      // **record 也不许引用一个不存在的 run**（2026-08-27 review P0）：上一轮只在 gap 那侧收了口，
      // 普通 record 照样带着 `scope.runId` 落库，而 RunIndex 是 null——实测得到一条
      // `{name:"x", scope:{runId:"ghost"}}` 的 committed record、`index=null`、`prefix=1`。
      // 「有 canonical record、无 RunIndex」正是 retention 之后查询面无从解释的那种状态。
      // 不静默把 runId 抹掉（那会假装成功还丢了归属），而是把这个 seq 裁决成 hole + runtime-scoped gap。
      if (candidate.runId !== undefined && !this.isRunOpen(candidate.runId)) {
        this.report({ code: "observation_boundary_rejected", message: `record 引用了未建立或已封口的 run，已裁决为 gap` });
        this.markHole(seq, undefined, "encoding_error", undefined, undefined);
        return;
      }
      this.slots.set(seq, candidate);
      this.pendingBounded += 1;
      this.scheduleFlush(this.pendingBytesExceedLimits() ? "now" : "delayed");
    } catch (e) {
      // 最后一道：`offer()` 的契约是永不抛。走到这里是 Sequencer 自己的 bug，只能报诊断。
      this.report({ code: "observation_sequencer_internal", message: redactedLabel(e) });
      // **但预留过的 seq 必须有裁决**：留一个空洞等于把 committed prefix 永久钉死在它前面。
      if (seq !== undefined && !this.slots.has(seq)) {
        try {
          this.markHole(seq, undefined, "encoding_error", undefined, undefined);
        } catch {
          // markHole 自己坏了（已 seal）：没有第二条通道，诊断上面已经报过
        }
      }
    }
  }

  /* ───────── boundary lane ───────── */

  appendBoundary<TInput>(draft: BoundaryObservationDraft<TInput>): Promise<ObservationEnvelope> {
    if (this.persistence.status === "sealed" || this.persistence.status === "lost-lease") {
      return Promise.reject(new ObservationStoreUnavailableError(`canonical writer ${this.persistence.status}`, this.persistence));
    }
    // **整份 draft 先浅拷贝成快照，之后只用快照**（2026-08-27 review P0）：原来 `draft.name` / `draft.scope` /
    // `draft.body` 在 boundary registry、RunIndex effect、canonical envelope 三处各读各的，于是一个变脸的
    // name getter 能让 journal 里落 `run.accepted` 而 RunIndex 根本没有这条（实测 nameReads=3、
    // journal=["run.accepted"]、runIndexHas=false）；变脸的 body 能让 canonical 记 `agent-safe`、
    // RunIndex 记 `agent-index-evil`——OR4 的「record 与 index 同事务一致」当场破。
    let toEncode: BoundaryObservationDraft<unknown>;
    let name: string;
    let runId: string | undefined;
    try {
      const shallow = { ...draft } as BoundaryObservationDraft<unknown>;
      name = shallow.name;
      const scope = { ...(shallow.scope as Record<string, unknown>) };
      runId = safeRunIdOf(scope);
      toEncode = { ...shallow, name, scope } as BoundaryObservationDraft<unknown>;
    } catch (e) {
      // draft 自己的 getter 抛错：还没预留 seq，直接拒即可
      return Promise.reject(toSafeError(e, "boundary draft 读取失败"));
    }
    const isBoundary = isRunBoundaryName(name);
    let effect: IndexEffect | undefined;
    if (isBoundary) {
      const problem = this.checkRunLifecycle(name as (typeof RUN_BOUNDARY_NAMES)[number], runId);
      if (problem !== undefined) {
        this.report({ code: "observation_boundary_rejected", message: `${name}(${runId ?? "?"}) 被拒：${problem}` });
        return Promise.reject(new Error(`${name} 被拒：${problem}`));
      }
      if (name === "run.closed" && runId !== undefined) {
        // 先把开着的溢出区间收口：封口 body 里的 capture 计数 / digest 从 `runGaps` 读，而区间要到收口才滚进去；
        // 靠下面 `reserve()` 顺带收口就晚了——body 已经冻结（review 2026-09-09 复现：count 0、index 却 partial）
        this.closeOverflow();
        // 在预留 run.closed 的 seq **之前** preflight。可选 projection 超限只留 capture_limit
        // gap 再以安全 body 封口，不降级、不关 admission；只有 required safe body 仍非法才走 required failure。
        try {
          const raw = toEncode.body as RunClosedBodyInput;
          // 只取 caller 真正拥有的两件事实。capture 计数/digest 即便被塞进来也丢掉——
          // 它们的唯一真相源是 Sequencer 自己的 gap 账本（review P1：曾出现 count 被覆盖、digest 却留着 caller 旧值）。
          const p = preflightTerminalProjection({ outcome: raw.outcome, finalSnapshot: raw.finalSnapshot });
          for (const subjectId of p.projectionGaps) this.reserveOptionalProjectionGap({ runId, subjectId, reason: "capture_limit" });
          toEncode = { ...toEncode, body: this.sealCaptureState(runId, p.body) };
        } catch (e) {
          const seq = this.reserve();
          this.markHole(seq, runId, "encoding_error", undefined, e);
          return Promise.reject(toSafeError(e, "run.closed preflight 失败"));
        }
      }
    }

    const seq = this.reserve();
    let candidate: CandidateSlot;
    try {
      candidate = this.encodeCandidate(toEncode, seq, boundaryEncodingLimits(), undefined);
    } catch (e) {
      // 先裁决 hole/health，再拒绝（required safe body 编码失败）
      this.markHole(seq, runId, "encoding_error", undefined, e);
      return Promise.reject(toSafeError(e, "boundary 编码失败"));
    }
    // **一致性闸**：物化后的 identity 必须与上面用于 registry 裁决的那一份完全一致。
    // 快照之后理论上不可能不一致，但这是 OR4「record 与 index 同事务一致」的最后一道断言——
    // 不一致就当编码失败处理，绝不半推半就地写出去。
    if (candidate.runId !== runId || candidate.envelope.name !== name) {
      const e = new ObservationEncodingError("unsupported_value", "$", "boundary identity 物化后与裁决时不一致");
      this.markHole(seq, runId, "encoding_error", undefined, e);
      return Promise.reject(toSafeError(e, "boundary identity 不一致"));
    }
    // RunIndex effect 从**已编码的 envelope body** 推导，不是从 producer 的原 body——
    // 后者能在两次读取之间换内容，让 canonical 与 index 记下不同的事实（review P0 第二个复现）。
    if (isBoundary) {
      // body schema 在**预留之后**判，且只吃已归一化冻结的 envelope body：失败是数据失败，必须留 hole+gap
      const bodyProblem = runId === undefined ? undefined : this.boundaryBodyViolation(name as (typeof RUN_BOUNDARY_NAMES)[number], runId, candidate.envelope.body);
      if (bodyProblem !== undefined) {
        const e = new ObservationEncodingError("unsupported_value", "$.body", bodyProblem);
        this.markHole(seq, runId, "encoding_error", undefined, e);
        return Promise.reject(toSafeError(e, `${name} body 非法`));
      }
      effect = this.effectFor(name as (typeof RUN_BOUNDARY_NAMES)[number], candidate.envelope.body);
      if (effect.kind === "accepted" && effect.seed.runId !== runId) {
        const e = new ObservationEncodingError("unsupported_value", "$.body.header", "RunIndex seed 与 scope.runId 不一致");
        this.markHole(seq, runId, "encoding_error", undefined, e);
        return Promise.reject(toSafeError(e, "RunIndex seed 不一致"));
      }
    } else if (runId !== undefined) {
      if (!this.isRunOpen(runId)) {
        const e = new ObservationEncodingError("unsupported_value", "$.scope.runId", "record 引用了未建立或已封口的 run");
        this.markHole(seq, undefined, "encoding_error", undefined, undefined);
        return Promise.reject(toSafeError(e, "record 引用了未建立或已封口的 run"));
      }
      effect = { kind: "record" };
    }
    const slot: CandidateSlot = { ...candidate, indexEffect: effect };
    if (isBoundary && runId !== undefined) this.recordRunBoundary(name as (typeof RUN_BOUNDARY_NAMES)[number], runId, seq);
    this.slots.set(seq, slot);

    const promise = new Promise<ObservationEnvelope>((resolve, reject) => {
      const cancelDeadline = once(this.clock, () => this.onBoundaryDeadline(seq), this.limits.boundaryDeadlineMs);
      this.waiters.set(seq, { seq, resolve, reject, cancelDeadline, settled: false });
    });
    this.scheduleFlush("now");
    return promise;
  }

  reserveOptionalProjectionGap(
    input: Readonly<{ runId: string; subjectId: "run.final_snapshot" | "run.final_snapshot.capabilities"; reason: "capture_limit" }>,
  ): Readonly<{ omittedSeq: number; gapSeq: number }> {
    // 同一个同步 critical section：被省略 slot 取得真实 seq S，gap 紧跟在 S+1
    const omittedSeq = this.reserve();
    const gapSeq = this.markHole(omittedSeq, input.runId, input.reason, { kind: "capture", id: input.subjectId }, undefined);
    return { omittedSeq, gapSeq };
  }

  reserveProjectionFailureGap(input: Readonly<{ runId: string | undefined }>): ProjectionFailureOutcome {
    // writer 已经 terminal 时**什么都不预留**：再挂的 gap 永远提交不了，只会把内存和 canonicalGapCount 撑大。
    // 返回值是明确结果而不是伪造的 `{omittedSeq:0, gapSeq:0}`——0 是合法 seq 的邻居，伪造它等于制造假证据。
    if (this.unavailable("projection failure")) return "writer-unavailable";
    // 与上面同构：失败身份先占 seq，gap 紧跟其后，committed prefix 上就留下了「这里少了一条」。
    const omittedSeq = this.reserve();
    this.markHole(omittedSeq, input.runId, "encoding_error", undefined, undefined);
    return "gap-reserved";
  }

  /* ───────── live 订阅 ───────── */

  subscribe(opts: ObservationSubscribeOptions): () => void {
    this.subscriberSerial += 1;
    const id = opts.sinkId ?? `subscriber-${this.subscriberSerial}`;
    // **重复 sinkId 一律拒**（2026-08-27 review P2）：原来是静默覆盖，于是旧句柄 unsubscribe 时按 ID
    // 把**新** subscriber 从 Map 里删掉——实测两个订阅都一条都收不到，health 只留一个 `closed` tombstone。
    // sinkId 是调用方给的稳定身份，撞了就是接线错误，fail-loud 好过静默吞掉一路订阅。
    if (this.subscribers.has(id)) throw new Error(`observation sink id 重复：${id}`);
    const sub: Subscriber = {
      id,
      listener: opts.listener,
      runId: opts.runId,
      queue: [],
      replay: undefined,
      lastDeliveredSeq: opts.afterSeq,
      status: "healthy",
      gaps: [],
      droppedGapCount: 0,
      pendingDrop: undefined,
      draining: false,
      inFlight: false,
      lastErrorDigest: undefined,
    };
    // critical section：固定当时的 committed head、登记 live、回放 (afterSeq, head]——中间没有 await，没有漏窗。
    // 内存窗口之前的那段从 store 分页读（异步），但 live 与窗口内的记录此刻已经入队，drain 会先交付回放的旧记录。
    this.subscribers.set(id, sub);
    const oldest = this.recentCommitted[0]?.seq;
    if (oldest !== undefined && opts.afterSeq + 1 < oldest) sub.replay = { cursor: opts.afterSeq, upto: oldest - 1, queue: [], fetching: false };
    for (const env of this.recentCommitted) {
      if (env.seq > opts.afterSeq) this.enqueue(sub, env);
    }
    if (sub.replay !== undefined) this.scheduleDrain(sub);
    return () => this.closeSink(sub);
  }

  /* ───────── identity / encode ───────── */

  /** 预留下一个 seq。开着的溢出区间先收口——它的 gap 必须紧跟区间最后一个 hole，不能被这次预留插在中间。 */
  private reserve(): number {
    this.closeOverflow();
    return this.reserveRaw();
  }

  private reserveRaw(): number {
    this.lastReserved += 1;
    return this.lastReserved;
  }

  /** ring 满时的裁决：占一个 hole seq，并进当前区间；不同 run 的溢出分开记（gap 的归属要对）。 */
  private overflowHole(rawRunId: string | undefined): void {
    const runId = this.gapRunIdFor(rawRunId);
    if (this.overflow !== undefined && this.overflow.runId !== runId) this.closeOverflow();
    const seq = this.reserveRaw();
    this.slots.set(seq, { kind: "hole", seq, reason: "buffer_overflow", coveredBy: undefined });
    if (this.overflow === undefined) this.overflow = { firstSeq: seq, lastSeq: seq, runId };
    else this.overflow.lastSeq = seq;
    this.scheduleFlush("delayed");
  }

  /**
   * 给开着的溢出区间预留并编码它那**一条** gap：`afterSeq = 首 hole − 1`，`beforeSeq = gap 自己的 seq`（紧跟末 hole），
   * `dropped` = 区间长度——`dropped === beforeSeq − afterSeq − 1` 这条不变量与单 hole 的 gap 相同。
   * 没有开着的区间就什么都不做。
   */
  private closeOverflow(): void {
    const open = this.overflow;
    if (open === undefined) return;
    this.overflow = undefined;
    const gapSeq = this.reserveRaw();
    const dropped = open.lastSeq - open.firstSeq + 1;
    const gap = this.encodeGap(gapSeq, open.runId, "buffer_overflow", { afterSeq: open.firstSeq - 1, beforeSeq: gapSeq, dropped, reason: "buffer_overflow" }, { coveredSeq: open.firstSeq, coveredThrough: open.lastSeq }, undefined);
    if (gap === undefined) return; // 已 seal：区间里的 hole 永远不会 commit，也不再需要覆盖
    for (let seq = open.firstSeq; seq <= open.lastSeq; seq++) {
      this.slots.set(seq, { kind: "hole", seq, reason: "buffer_overflow", coveredBy: gapSeq });
    }
    this.slots.set(gapSeq, gap);
    this.canonicalGapCount += 1;
    if (open.runId !== undefined) this.rollGap(open.runId, gap.bytes);
    this.report({ code: "observation_hole", message: `seq ${open.firstSeq}..${open.lastSeq} → hole(buffer_overflow) ×${dropped}，gap @ ${gapSeq}` });
    this.scheduleFlush("delayed");
  }

  /**
   * 编码一条 canonical gap 的 candidate。gap 的 body 是内建常量，编不出来 = Sequencer 自己坏了：seal 并返回 `undefined`
   * （调用方不能留一个未裁决的 hole，但 seal 之后也没有第二条通道）。
   */
  private encodeGap(
    gapSeq: number,
    runId: string | undefined,
    reason: ObservationGapReason,
    body: ObservationGap,
    attributes: Readonly<Record<string, string | number | boolean>>,
    subject: Readonly<{ kind: string; id: string }> | undefined,
  ): CandidateSlot | undefined {
    const gapDraft: BoundaryObservationDraft<ObservationGap> = {
      lane: "boundary",
      occurredAt: this.clock.now(),
      kind: "health",
      name: "observation.gap",
      scope: runId === undefined ? { runtimeId: this.runtimeId } : { runtimeId: this.runtimeId, runId },
      correlation: {},
      generation: { runtime: this.runtimeGeneration },
      owner: { status: "not-applicable" },
      instrumentation: SEQUENCER_INSTRUMENTATION,
      attributes: { reason, ...attributes },
      body,
      ...(subject === undefined ? {} : { subject }),
    };
    try {
      return this.encodeCandidate(gapDraft, gapSeq, boundaryEncodingLimits(), runId === undefined ? undefined : { kind: "gap" });
    } catch (e) {
      this.seal(new Error(`canonical gap 编码失败：${redactedLabel(e)}`));
      return undefined;
    }
  }

  /**
   * `effect` 传 `"auto"` = 由**物化后的** identity 推导（有 runId 就记一条 record index）。
   * bounded lane 必须走这条：它原来在调用前直接读 `draft.scope.runId`，那是 producer 的对象。
   */
  private encodeCandidate(draft: ObservationDraft, seq: number, limits: EncodingLimits, effect: IndexEffect | "auto" | undefined): CandidateSlot {
    // **每个 draft 字段只读一次**，容器先浅拷贝（getter 因此只被调用一次），再整体物化成冻结的 plain data；
    // 之后只编码这份快照。校验完还用 producer 的原对象，就留下 check/encode 之间的 TOCTOU 窗口——
    // Proxy 第二次读能换成别的内容或类型，正文照样落盘且没有 gap、没有诊断（review 实测）。
    const lane = draft.lane;
    const body = draft.body;
    if (lane !== "bounded" && lane !== "boundary") throw new ObservationEncodingError("unsupported_value", "$.lane", "非法取值");

    // frame 物化只有 `materializeRecordFrame` 这一处：kind / occurredAt / sourceSeq / attributes / identity 同一把尺。
    const framing = materializeRecordFrame({
      kind: draft.kind,
      occurredAt: draft.occurredAt,
      ...(draft.sourceSeq === undefined ? {} : { sourceSeq: draft.sourceSeq }),
      name: draft.name,
      attributes: { ...draft.attributes },
      scope: { ...draft.scope, runtimeId: this.runtimeId },
      correlation: { ...draft.correlation },
      owner: { ...draft.owner },
      instrumentation: { ...draft.instrumentation },
      generation: { ...draft.generation, runtime: this.runtimeGeneration },
      ...(draft.subject === undefined ? {} : { subject: { ...draft.subject } }),
      ...(draft.disposeOwner === undefined ? {} : { disposeOwner: { ...draft.disposeOwner } }),
    });
    if (!framing.ok) throw new ObservationEncodingError("unsupported_value", "$", framing.violation);
    const frame = framing.frame;
    const id = frame.identity;
    const kind = frame.kind;
    const occurredAt = frame.occurredAt;
    const sourceSeq = frame.sourceSeq;
    const attributes = frame.attributes;

    const recordId = `${this.runtimeId}:${seq}`;
    const observedAt = this.clock.now();
    const input: Record<string, unknown> = {
      schemaVersion: 1,
      recordId,
      seq,
      lane,
      occurredAt,
      observedAt,
      kind,
      name: id.name,
      scope: id.scope ?? {},
      correlation: id.correlation ?? {},
      generation: id.generation ?? { runtime: this.runtimeGeneration },
      owner: id.owner ?? { status: "not-applicable" },
      instrumentation: id.instrumentation ?? SEQUENCER_INSTRUMENTATION,
      attributes,
      body,
    };
    if (sourceSeq !== undefined) input.sourceSeq = sourceSeq;
    if (id.disposeOwner !== undefined) input.disposeOwner = id.disposeOwner;
    if (id.subject !== undefined) input.subject = id.subject;

    // 框架探针：只量**ephemeral fact 不背的那部分**。两边共有的 kind / name / occurredAt / sourceSeq /
    // 业务 scope id / attributes / body 都不进探针——把它们算进来等于同一段内容在两边被记进不同预算，
    // 反而造出新的不对称。配合 `OBSERVATION_IDENTITY_LIMITS` 的上限，额外框架的上界是可算的，
    // 「engine 永不比 Runtime 宽」才有依据。探针吃的也是物化后的快照。
    const scope = id.scope ?? {};
    const probe: Record<string, unknown> = {
      schemaVersion: 1,
      recordId,
      seq,
      lane,
      observedAt,
      runtimeId: this.runtimeId,
      correlation: input.correlation,
      generation: input.generation,
      owner: input.owner,
      instrumentation: input.instrumentation,
    };
    if (scope.submissionId !== undefined) probe.submissionId = scope.submissionId;
    if (scope.permissionId !== undefined) probe.permissionId = scope.permissionId;
    if (scope.reloadId !== undefined) probe.reloadId = scope.reloadId;
    if (id.disposeOwner !== undefined) probe.disposeOwner = id.disposeOwner;
    if (id.subject !== undefined) probe.subject = id.subject;
    encodeCanonical(probe, envelopeFramingLimits());
    const encoded = encodeCanonical(input, limits);
    // **O2a 没有 blob CAS seam，就不许提交 BlobRef**（2026-08-27 review P1）：`buildCommitInput()` 只把
    // record bytes 交给 store，`CanonicalObservationStore` 也没有 blob staging/读取面；candidate 随 commit
    // 释放后原始 bytes 永久消失，留下一条**指向不存在内容的 ref**——「悬空 ref」是明禁的。
    // 在 seam 落地（O3b）之前，binary 一律判红 → hole + gap，不写一个假装可解析的 digest。
    if (encoded.blobs.length > 0) {
      throw new ObservationEncodingError("unsupported_value", "$", "binary 需要 blob CAS seam（O3b），O2a 不得提交 BlobRef");
    }
    return {
      kind: "candidate",
      seq,
      lane,
      envelope: encoded.value as unknown as ObservationEnvelope,
      bytes: encoded.bytes,
      blobs: encoded.blobs,
      runId: scope.runId,
      indexEffect: effect === "auto" ? (scope.runId === undefined ? undefined : { kind: "record" }) : effect,
    };
  }

  /**
   * 把 seq 记为 hole，并**立刻**在下一个 seq 预留精确覆盖它的 `CanonicalObservationGap`。返回 gap 的 seq。
   * 两次 reserve 在同一个同步段里完成，所以后续 producer 拿不到夹在中间的 seq。
   */
  /**
   * gap 能不能挂 runId：**只有 `run.accepted` 成功、RunIndex 条目已建立之后才能挂**（2026-08-27 review P0）。
   *
   * 起因：失败的 `run.accepted` 会产生一条 run-scoped gap，而那时 RunIndex 根本还不存在——实测磁盘状态是
   * `gap.scope.runId="r1"`、`committedPrefix=2`、`RunIndex("r1")=null`。这直接违反
   * 「run-scoped gap 同事务更新 RunIndex」与「retention 窗口内 index 缺失即 corruption」。
   * 两个副作用同样实在：`rollGap("r1")` 会污染随后**用同一 runId 重试成功**的那个 run（新 run 一上来就被
   * 标 partial）；而永远不会 accepted 成功的 runId 则一直留在 `runGaps` 里，成为内存增长面。
   */
  private gapRunIdFor(runId: string | undefined): string | undefined {
    if (runId === undefined) return undefined;
    return this.isRunOpen(runId) ? runId : undefined;
  }

  /**
   * 这个 runId 现在**还收不收记录**：RunIndex 条目已建立（`run.accepted` 编码成功那一刻就登记，
   * 所以「同一 batch 里 accepted → record」合法），**且尚未封口**。
   *
   * 「尚未封口」这半边是 2026-08-27 review P0 补的：只查 accepted 时，`run.closed` **之后**到达的记录照收
   * ——实测 journal 里 seq 3 的 `late` 落在 `terminalRecordId=rt:2`、`status=completed` 之后，
   * RunIndex 的 `lastSeq` 被推到 3；而**编码失败**的迟到记录更糟：它把 index 从 complete 改成 partial、
   * `lastSeq` 变 4，还把封口时**已经释放**的 capture accumulator 重新创建出来（既标错 partial 又是内存增长面）。
   * 封口是终态：终态之后这个 run 不再接受任何 record / gap。
   */
  private isRunOpen(runId: string): boolean {
    const st = this.runBoundaries.get(runId);
    return st?.accepted !== undefined && st.closed === undefined;
  }

  private markHole(
    seq: number,
    rawRunId: string | undefined,
    reason: ObservationGapReason,
    subject: Readonly<{ kind: string; id: string }> | undefined,
    cause: unknown,
  ): number {
    const runId = this.gapRunIdFor(rawRunId);
    // 这里的 seq 是调用方刚 `reserve()` 的，溢出区间已在那次预留时收口；这条 gap 紧跟它
    const gapSeq = this.reserveRaw();
    const gap = this.encodeGap(gapSeq, runId, reason, { afterSeq: seq - 1, beforeSeq: seq + 1, dropped: 1, reason }, { coveredSeq: seq }, subject);
    if (gap === undefined) return gapSeq;
    this.slots.set(seq, { kind: "hole", seq, reason, coveredBy: gapSeq });
    this.slots.set(gapSeq, gap);
    this.canonicalGapCount += 1;
    if (runId !== undefined) this.rollGap(runId, gap.bytes);
    if (cause !== undefined) {
      const code = cause instanceof ObservationEncodingError ? cause.code : "unknown";
      this.report({ code: "observation_hole", message: `seq ${seq} → hole(${reason}: ${code})，gap @ ${gapSeq}` });
    }
    this.scheduleFlush("delayed");
    return gapSeq;
  }

  /* ───────── run 边界登记 ───────── */

  /**
   * **只查生命周期，不碰 body**（2026-08-27 review P1）。原来这里顺手读 `body.header` / `body.outcome`，
   * 三个后果：① 那些读取在 `appendBoundary()` 的 try 之外，getter 抛错时它**同步抛出**而不是返回
   * rejected Promise；② 非法 body 在**预留 seq 之前**被拒，于是没有文档要求的 hole+gap；
   * ③ 违规说明里 `String(status)` 把原值回显进诊断与错误（实测 `Authorization: Bearer sk-secret` 整条泄漏）。
   * 生命周期错（缺 runId / 重复 / 缺前置）是调用方协议错误，本来就不该留记录，pre-reservation 拒是对的；
   * body 形状错是**数据失败**，必须留痕——拆开之后各归各的。
   */
  private checkRunLifecycle(name: (typeof RUN_BOUNDARY_NAMES)[number], runId: string | undefined): string | undefined {
    if (runId === undefined) return "scope.runId 缺失";
    const st = this.runBoundaries.get(runId);
    switch (name) {
      case "run.accepted":
        return st !== undefined || this.closedRuns.has(runId) ? "run.accepted 已发过（唯一 emission owner）" : undefined;
      case "run.started":
        if (st?.accepted === undefined) return this.closedRuns.has(runId) ? "run 已封口" : "run.accepted 尚未发";
        if (st.started !== undefined) return "run.started 已发过";
        if (st.closed !== undefined) return "run 已封口";
        return undefined;
      case "run.closed":
        if (st?.accepted === undefined) return this.closedRuns.has(runId) ? "run.closed 已发过" : "run.accepted 尚未发";
        if (st.closed !== undefined) return "run.closed 已发过";
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * run boundary 的 **exact body schema**：只吃**已归一化冻结**的 envelope body（plain data，读它不触发任何
   * trap），逐条按固定键集判，**违规说明全是固定串、绝不回显原值**。失败由调用方走 required boundary hole+gap。
   *
   * `run.started` 原来完全不验 body——metadata 档下 `{authorization:"Bearer sk-secret"}` 能直接进 canonical
   * journal（实测）。boundary body 是**我们自己定义的固定 schema**，不是 producer 的自由字段区。
   */
  private boundaryBodyViolation(name: (typeof RUN_BOUNDARY_NAMES)[number], runId: string, body: unknown): string | undefined {
    const keysOf = (v: unknown): readonly string[] | undefined => (isRecord(v) ? Object.keys(v) : undefined);
    switch (name) {
      case "run.accepted": {
        const keys = keysOf(body);
        if (keys === undefined || keys.length !== 1 || keys[0] !== "header") return "run.accepted body 必须恰好是 { header }";
        const header = (body as Record<string, unknown>).header;
        if (!isRecord(header)) return "run.accepted body.header 必须是对象";
        return this.headerViolation(header, runId);
      }
      case "run.started": {
        const keys = keysOf(body);
        if (keys === undefined || keys.length !== 1 || keys[0] !== "startedBy") return "run.started body 必须恰好是 { startedBy }";
        if ((body as Record<string, unknown>).startedBy !== "permit-executor") return "run.started body.startedBy 取值非法";
        return undefined;
      }
      case "run.closed": {
        // body 由本 Sequencer 的 preflight 构造，这里是最后一道自检（非法 status 早在 preflight 就抛了）
        if (!isRecord(body) || !isRecord(body.outcome)) return "run.closed body.outcome 缺失";
        const status = body.outcome.status;
        if (status !== "completed" && status !== "aborted" && status !== "error") return "run.closed body.outcome.status 取值非法";
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * `run.accepted` 的 header **逐字段** exact schema（2026-08-27 review P0）。
   *
   * 上一版只查了 `{header}` 这层外壳：`{header:{runId:"r1"}}` 照样提交成功、RunIndex 被标 stored/complete，
   * 却缺 `source`/`runtimeId`/`agentId`/`capturePolicy`/`acceptedAt`；反方向往 header 里塞
   * `authorization: "Bearer sk-secret"` 会**同时进 canonical record 与 RunIndex**（实测）。
   * 这不是普通 schema 小事：**RunIndex 是 retention 之后 header 的唯一真相源**，
   * 让一个不满足 `RunIndexEntryV1` 的对象落库，等于把查询面的地基做成沙子。
   *
   * 所以：键集封闭（未登记字段一律拒）、必填齐全、逐字段验形，并与 **Sequencer 自身配置对齐**
   * （`runtimeId` / `runtimeGeneration` / `capturePolicy`）——那三项不是 producer 说了算的。
   * 所有违规说明都是固定串，**不回显原值**。
   */
  private headerViolation(header: Record<string, unknown>, runId: string): string | undefined {
    const keys = Object.keys(header);
    for (const k of keys) {
      if (!HEADER_REQUIRED_KEYS.includes(k) && !HEADER_OPTIONAL_KEYS.includes(k)) return "run.accepted body.header 含未登记字段";
    }
    for (const k of HEADER_REQUIRED_KEYS) {
      if (!keys.includes(k)) return `run.accepted body.header 缺必填字段 ${k}`;
    }
    if (header.runId !== runId) return "run.accepted body.header.runId 与 scope.runId 不一致";
    if (header.runtimeId !== this.runtimeId) return "run.accepted body.header.runtimeId 与 Runtime 不一致";
    if (header.runtimeGeneration !== this.runtimeGeneration) return "run.accepted body.header.runtimeGeneration 与 Runtime 不一致";
    if (header.capturePolicy !== this.capturePolicy) return "run.accepted body.header.capturePolicy 与 Runtime 不一致";
    for (const k of ["agentId", "agentInstanceId"] as const) {
      const v = header[k];
      if (typeof v !== "string" || v.length === 0) return `run.accepted body.header.${k} 必须是非空 string`;
    }
    const sessionId = header.sessionId;
    if (sessionId !== null && (typeof sessionId !== "string" || sessionId.length === 0)) {
      return "run.accepted body.header.sessionId 必须是非空 string 或 null";
    }
    const submissionId = header.submissionId;
    if (submissionId !== undefined && (typeof submissionId !== "string" || submissionId.length === 0)) {
      return "run.accepted body.header.submissionId 必须是非空 string";
    }
    const acceptedAt = header.acceptedAt;
    if (typeof acceptedAt !== "number" || !Number.isSafeInteger(acceptedAt) || acceptedAt < 0) {
      return "run.accepted body.header.acceptedAt 必须是非负安全整数";
    }
    const source = header.source;
    if (!isRecord(source)) return "run.accepted body.header.source 必须是对象";
    const sourceKeys = Object.keys(source);
    const kind = source.kind;
    if (kind === "user" || kind === "inbox" || kind === "dream") {
      if (sourceKeys.length !== 1) return "run.accepted body.header.source 含未登记字段";
      return undefined;
    }
    if (kind === "extension") {
      if (sourceKeys.length !== 3) return "run.accepted body.header.source 含未登记字段";
      for (const k of ["entryId", "sourceId"] as const) {
        const v = source[k];
        if (typeof v !== "string" || v.length === 0) return `run.accepted body.header.source.${k} 必须是非空 string`;
      }
      return undefined;
    }
    return "run.accepted body.header.source.kind 取值非法";
  }

  private effectFor(name: (typeof RUN_BOUNDARY_NAMES)[number], body: unknown): IndexEffect {
    switch (name) {
      case "run.accepted":
        return { kind: "accepted", seed: (body as RunAcceptedBodyV1).header };
      case "run.started":
        return { kind: "started" };
      case "run.closed":
        return { kind: "closed", body: body as RunClosedBodyV1 };
      default:
        return { kind: "record" };
    }
  }

  private gapCountOf(runId: string): number {
    return this.runGaps.get(runId)?.count ?? 0;
  }

  /** 滚动 digest：`H(prev ‖ H(gap canonical bytes))`。O(1) 空间，且因为吃的是 exact bytes，subject 不同必然不同。 */
  private rollGap(runId: string, gapBytes: Uint8Array): void {
    const prev = this.runGaps.get(runId) ?? { count: 0, rolling: "" };
    this.runGaps.set(runId, {
      count: prev.count + 1,
      rolling: sha256Hex(`${prev.rolling}:${canonicalDigest(gapBytes)}`),
    });
  }

  /**
   * 给 `run.closed` 盖上 append 前的 capture 事实。**计数与 digest 同源**——都从 Sequencer 自己的 gap 账本算，
   * 一起进 body。之前只覆盖 count 而保留 caller 的 digest，能造出「count=1、digest 还是 caller 旧值」的记录。
   */
  private sealCaptureState(runId: string, body: RunClosedBodyInput): RunClosedBodyV1 {
    const acc = this.runGaps.get(runId);
    if (acc === undefined || acc.count === 0) return { ...body, captureGapCountBeforeClose: 0 };
    // 两个定长字段，与 gap 条数无关——封口 body 的大小因此不随 run 长度增长
    return { ...body, captureGapCountBeforeClose: acc.count, captureGapDigest: acc.rolling };
  }

  private recordRunBoundary(name: (typeof RUN_BOUNDARY_NAMES)[number], runId: string, seq: number): void {
    const st = this.runBoundaries.get(runId) ?? {};
    if (name === "run.accepted") st.accepted = seq;
    else if (name === "run.started") st.started = seq;
    else st.closed = seq;
    this.runBoundaries.set(runId, st);
  }

  /* ───────── flush / batch ───────── */

  private pendingBytesExceedLimits(): boolean {
    let records = 0;
    let bytes = 0;
    for (let seq = this.committedPrefix + 1; ; seq++) {
      const slot = this.slots.get(seq);
      if (slot === undefined) return false;
      if (slot.kind !== "candidate") continue;
      records += 1;
      bytes += slot.bytes.byteLength;
      if (records >= this.limits.maxBatchRecords || bytes >= this.limits.maxBatchBytes) return true;
    }
  }

  private scheduleFlush(mode: "now" | "delayed"): void {
    if (mode === "now") {
      this.cancelDelayedFlush?.();
      this.cancelDelayedFlush = undefined;
      void this.flush();
      return;
    }
    if (this.cancelDelayedFlush !== undefined || this.flushing) {
      if (this.flushing) this.flushRequested = true;
      return;
    }
    this.cancelDelayedFlush = once(
      this.clock,
      () => {
        this.cancelDelayedFlush = undefined;
        void this.flush();
      },
      this.limits.maxBatchDelayMs,
    );
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushRequested = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushRequested = false;
        const before = this.committedPrefix;
        await this.flushOnce();
        // barrier 还没到：继续一批批推进（受 batch 上限约束）；没进展且没人再要求就停，防空转
        if (this.barrierPending() && this.committedPrefix > before) this.flushRequested = true;
      } while (this.flushRequested && this.persistence.status !== "sealed");
    } catch (e) {
      this.seal(toSafeError(e, "flush 失败"));
    } finally {
      this.flushing = false;
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const r of resolvers) r();
    }
    // 循环退出时 ring 里还可能剩不足一批的 candidate（flush 期间到达、又没触发限额）：
    // 必须重新安排一次，否则它们会一直躺到下一个 offer——delayed flush 的定时器早被 "now" 取消了。
    if (this.slots.size > 0 && this.persistence.status !== "sealed" && this.persistence.status !== "lost-lease") {
      this.scheduleFlush(this.pendingBytesExceedLimits() || this.waiters.size > 0 ? "now" : "delayed");
    }
  }

  private barrierPending(): boolean {
    for (const w of this.waiters.values()) if (!w.settled && w.seq > this.committedPrefix) return true;
    return false;
  }

  private collectWindow(): Window | undefined {
    const slots: CandidateSlot[] = [];
    let seq = this.committedPrefix + 1;
    let records = 0;
    let bytes = 0;
    // batch 上限对 boundary 与 gap 一视同仁（review P1，两轮）：
    //   · barrier 不搭便车——靠 flush 循环一批批推进 prefix，不为了抵达 B 把 <B 全塞进一笔事务；
    //   · hole 也不搭便车——hole 与覆盖它的 gap 必须同窗（prefix 只能连着 gap 一起越过 hole），
    //     但**装不下就停在 hole 之前**，让下一批从这个 hole 开始，而不是把 gap 强塞进这一批
    //     （连续 hole 曾因此撑出 [3,1]）。
    for (;;) {
      const slot = this.slots.get(seq);
      if (slot === undefined) break;
      if (slot.kind === "hole") {
        if (slot.coveredBy === undefined) {
          // 走到了还没收口的溢出区间：前面的都已进窗（或已 commit），此刻收口——gap 落在区间末尾，同一轮就能收进来。
          // 收口失败（已 seal）时 hole 仍无覆盖：停在它前面，别死循环
          this.closeOverflow();
          if (this.slots.get(seq)?.kind === "hole" && (this.slots.get(seq) as HoleSlot).coveredBy === undefined) break;
          continue;
        }
        const gap = this.slots.get(slot.coveredBy);
        const gapBytes = gap !== undefined && gap.kind === "candidate" ? gap.bytes.byteLength : 0;
        const wouldExceed = records + 1 > this.limits.maxBatchRecords || bytes + gapBytes > this.limits.maxBatchBytes;
        if (wouldExceed && records > 0) break;
        seq += 1; // 覆盖它的 gap 在后面（单 hole 紧跟其后；溢出区间在区间末尾），跨过去的 hole 与 gap 必须同窗
        continue;
      }
      const overLimit = records >= this.limits.maxBatchRecords || bytes + slot.bytes.byteLength > this.limits.maxBatchBytes;
      if (overLimit && records > 0) break;
      slots.push(slot);
      records += 1;
      bytes += slot.bytes.byteLength;
      seq += 1;
    }
    if (records === 0) return undefined;
    const nextPrefix = seq - 1;
    // 窗口尾巴不能停在一个未被同窗 gap 覆盖的 hole 上（gap 总在 hole 之后，越过 hole 时 mustReach 已抬到 gap）
    const last = this.slots.get(nextPrefix);
    if (last === undefined || last.kind !== "candidate") return undefined;
    return { slots, nextPrefix };
  }

  private buildCommitInput(window: Window): CommitBatchInput {
    const staged = new Map<string, RunIndexEntryV1>();
    const expected = new Map<string, string | null>();
    const touch = (runId: string): RunIndexEntryV1 | undefined => {
      if (!staged.has(runId)) {
        const cur = this.runIndexCache.get(runId);
        expected.set(runId, cur === undefined ? null : runIndexDigest(cur));
        if (cur !== undefined) staged.set(runId, cur);
      }
      return staged.get(runId);
    };
    for (const slot of window.slots) {
      const effect = slot.indexEffect;
      const runId = slot.runId;
      if (effect === undefined || runId === undefined) continue;
      const cur = touch(runId);
      switch (effect.kind) {
        case "accepted": {
          // **状态转换契约**（2026-08-27 review P0）：accepted 只允许「index 原先不存在」。
          // 少了这道闸，一条绕过第一层的 accepted effect 会把已封口的 index **整个重置**
          // ——实测 acceptedRecordId 变 rt:3、firstSeq/lastSeq 变 3、status 回到 running、
          // terminalRecordId 被抹成 null，而 persistence 还是 healthy。终态就这么没了。
          if (cur !== undefined) throw new ObservationCorruptionError("run.accepted 落在已存在的 RunIndex 条目上");
          const seed = effect.seed;
          staged.set(runId, {
            schemaVersion: 1,
            runtimeId: this.runtimeId,
            runId,
            acceptedRecordId: slot.envelope.recordId,
            header: {
              ...seed,
              schemaVersion: 1,
              startedAt: null,
              endedAt: null,
              status: "running",
              integrity: this.gapCountOf(runId) > 0 ? "partial" : "complete",
              persistence: "stored",
            },
            firstSeq: slot.seq,
            lastSeq: slot.seq,
            bodyState: "retained",
          });
          break;
        }
        case "started": {
          // **不能静默跳过**（2026-08-27 review P0 的第二层防御）：`cur === undefined` 说明这条 record 引用的
          // run 在 index 里根本不存在，继续提交就会造出「有 canonical record、无 RunIndex」的状态。
          // 这是 corruption，必须 seal，不能拆批、不能继续推进 head。
          if (cur === undefined) throw new ObservationCorruptionError("run effect 引用了不存在的 RunIndex 条目");
          if (cur.terminalRecordId !== undefined) throw new ObservationCorruptionError("run.started 落在已封口的 run 上");
          if (cur.startedRecordId !== undefined) throw new ObservationCorruptionError("run.started 已经登记过");
          staged.set(runId, { ...cur, startedRecordId: slot.envelope.recordId, header: { ...cur.header, startedAt: slot.envelope.occurredAt }, lastSeq: slot.seq });
          break;
        }
        case "closed": {
          // **不能静默跳过**（2026-08-27 review P0 的第二层防御）：`cur === undefined` 说明这条 record 引用的
          // run 在 index 里根本不存在，继续提交就会造出「有 canonical record、无 RunIndex」的状态。
          // 这是 corruption，必须 seal，不能拆批、不能继续推进 head。
          if (cur === undefined) throw new ObservationCorruptionError("run effect 引用了不存在的 RunIndex 条目");
          // 封口只能发生一次：绕过第一层的第二条 closed effect 会**覆盖终态**
          // （实测 terminalRecordId 变 rt:3、status 从 completed 变 error，persistence 仍 healthy）。
          if (cur.terminalRecordId !== undefined) throw new ObservationCorruptionError("run.closed 落在已封口的 run 上");
          const integrity = this.gapCountOf(runId) > 0 ? "partial" : cur.header.integrity;
          staged.set(runId, {
            ...cur,
            terminalRecordId: slot.envelope.recordId,
            header: { ...cur.header, status: effect.body.outcome.status, endedAt: slot.envelope.occurredAt, integrity },
            lastSeq: slot.seq,
          });
          break;
        }
        case "gap": {
          // **不能静默跳过**（2026-08-27 review P0 的第二层防御）：`cur === undefined` 说明这条 record 引用的
          // run 在 index 里根本不存在，继续提交就会造出「有 canonical record、无 RunIndex」的状态。
          // 这是 corruption，必须 seal，不能拆批、不能继续推进 head。
          if (cur === undefined) throw new ObservationCorruptionError("run effect 引用了不存在的 RunIndex 条目");
          // 同一条不变量的封口侧：已有 terminalRecordId 还来改 index，说明第一层被绕过了。
          // 迟到记录会把 lastSeq 推过终态、把 complete 改回 partial——那不是「补记」，是把终态改写了。
          if (cur.terminalRecordId !== undefined) throw new ObservationCorruptionError("run effect 落在已封口的 run 上");
          staged.set(runId, { ...cur, header: { ...cur.header, integrity: "partial" }, lastSeq: slot.seq });
          break;
        }
        case "record": {
          // **不能静默跳过**（2026-08-27 review P0 的第二层防御）：`cur === undefined` 说明这条 record 引用的
          // run 在 index 里根本不存在，继续提交就会造出「有 canonical record、无 RunIndex」的状态。
          // 这是 corruption，必须 seal，不能拆批、不能继续推进 head。
          if (cur === undefined) throw new ObservationCorruptionError("run effect 引用了不存在的 RunIndex 条目");
          // 同一条不变量的封口侧：已有 terminalRecordId 还来改 index，说明第一层被绕过了。
          // 迟到记录会把 lastSeq 推过终态、把 complete 改回 partial——那不是「补记」，是把终态改写了。
          if (cur.terminalRecordId !== undefined) throw new ObservationCorruptionError("run effect 落在已封口的 run 上");
          staged.set(runId, { ...cur, lastSeq: slot.seq });
          break;
        }
        default:
          break;
      }
    }
    const mutations: RunIndexMutation[] = [];
    for (const [runId, next] of staged) {
      const exp = expected.get(runId) ?? null;
      const cur = this.runIndexCache.get(runId);
      if (cur !== undefined && runIndexDigest(cur) === runIndexDigest(next)) continue; // 没变就不写
      mutations.push({ runId, expectedRunIndexDigest: exp, nextRunIndex: next });
    }
    const records: CanonicalRecordCandidate[] = window.slots.map((s) => ({
      recordId: s.envelope.recordId,
      runtimeId: this.runtimeId,
      seq: s.seq,
      ...(s.envelope.scope.runId === undefined ? {} : { runId: s.envelope.scope.runId }),
      canonicalEnvelopeBytes: s.bytes,
    }));
    return {
      runtimeId: this.runtimeId,
      expectedCommittedPrefix: this.committedPrefix,
      nextCommittedPrefix: window.nextPrefix,
      records,
      runIndexMutations: mutations,
    };
  }

  /** writer 已进终态（sealed / lost-lease）。单独一个方法：同一函数里两次读 `this.persistence.status`，TS 会把第二次窄成不可能。 */
  private terminal(): boolean {
    const s = this.persistence.status;
    return s === "sealed" || s === "lost-lease";
  }

  private async flushOnce(): Promise<void> {
    if (this.terminal()) return;
    const window = this.collectWindow();
    // collectWindow 会给溢出区间收口，收口失败会 seal：terminal 之后这个窗口不能再提交（waiter 已被告知 not durable）
    if (window === undefined || this.terminal()) return;
    const input = this.buildCommitInput(window);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.store.commitBatchIfAbsent(input);
        this.applyCommitted(window, input);
        return;
      } catch (e) {
        if (e instanceof ObservationCorruptionError) {
          this.seal(e);
          return;
        }
        const verdict = await this.readAfterError(input);
        if (verdict === "committed") {
          this.applyCommitted(window, input);
          return;
        }
        if (verdict === "absent" && attempt < this.limits.maxCommitAttempts) {
          this.report({ code: "observation_commit_retry", message: `batch → ${input.nextCommittedPrefix} 第 ${attempt} 次失败（明确未落）：${redactedLabel(e)}` });
          continue;
        }
        this.seal(new Error(`batch → ${input.nextCommittedPrefix} ${verdict === "absent" ? "重试耗尽" : "indeterminate"}：${redactedLabel(e)}`));
        return;
      }
    }
  }

  /** 用同一批 recordId/bytes read-after-error，只有三种结论。 */
  private async readAfterError(input: CommitBatchInput): Promise<"committed" | "absent" | "indeterminate"> {
    try {
      const head = await this.store.readCommittedPrefix(input.runtimeId);
      let present = 0;
      for (const r of input.records) {
        const bytes = await this.store.readRecordBytes(r.recordId);
        if (bytes === null) continue;
        if (bytes.byteLength !== r.canonicalEnvelopeBytes.byteLength) return "indeterminate";
        for (let i = 0; i < bytes.byteLength; i++) if (bytes[i] !== r.canonicalEnvelopeBytes[i]) return "indeterminate";
        present += 1;
      }
      if (present === input.records.length) {
        if (head < input.nextCommittedPrefix) return "indeterminate";
        for (const m of input.runIndexMutations) {
          const idx = await this.store.readRunIndex(m.runId);
          if (idx === null || runIndexDigest(idx) !== runIndexDigest(m.nextRunIndex)) return "indeterminate";
        }
        return "committed";
      }
      if (present === 0 && head === input.expectedCommittedPrefix) return "absent";
      return "indeterminate";
    } catch {
      return "indeterminate";
    }
  }

  private applyCommitted(window: Window, input: CommitBatchInput): void {
    for (let seq = this.committedPrefix + 1; seq <= window.nextPrefix; seq++) {
      const slot = this.slots.get(seq);
      if (slot?.kind === "candidate" && slot.lane === "bounded") this.pendingBounded -= 1;
      this.slots.delete(seq);
    }
    this.committedPrefix = window.nextPrefix;
    for (const m of input.runIndexMutations) this.runIndexCache.set(m.runId, m.nextRunIndex);
    for (const slot of window.slots) this.recentCommitted.push(slot.envelope);
    while (this.recentCommitted.length > this.limits.replayWindowRecords) this.recentCommitted.shift();
    // 封口落库后释放这个 run 的 per-run 状态：gap accumulator、边界登记、index 缓存一起出；index 挪进有界的 `closedRuns`
    // （`send()` 在 run 结束后立刻读一次它，会话列表也读最近的），最老的先出，更老的只在 store 里。
    for (const slot of window.slots) {
      if (slot.indexEffect?.kind !== "closed" || slot.runId === undefined) continue;
      this.runGaps.delete(slot.runId);
      this.runBoundaries.delete(slot.runId);
      const index = this.runIndexCache.get(slot.runId);
      this.runIndexCache.delete(slot.runId);
      if (index !== undefined) {
        this.closedRuns.delete(slot.runId); // 重新插入 = 挪到最新
        this.closedRuns.set(slot.runId, index);
        while (this.closedRuns.size > CLOSED_RUN_RETENTION) this.closedRuns.delete(this.closedRuns.keys().next().value!);
      }
    }
    // 先 resolve barrier，再 live 扇出：两者都在 COMMIT 之后，顺序按 seq
    for (const w of [...this.waiters.values()]) {
      if (w.settled || w.seq > this.committedPrefix) continue;
      w.settled = true;
      w.cancelDeadline();
      this.waiters.delete(w.seq);
      const env = window.slots.find((s) => s.seq === w.seq)?.envelope ?? this.recentCommitted.find((e) => e.seq === w.seq);
      if (env === undefined) w.reject(new Error(`boundary ${w.seq} 已 committed 但找不到 envelope`));
      else w.resolve(env);
    }
    for (const slot of window.slots) this.publish(slot.envelope);
  }

  private onBoundaryDeadline(seq: number): void {
    const w = this.waiters.get(seq);
    if (w === undefined || w.settled) return;
    w.settled = true;
    this.waiters.delete(seq);
    if (this.persistence.status === "healthy") {
      this.persistence = { status: "degraded", since: this.clock.now(), lastErrorDigest: "canonical_flush_timeout", reopenAttempts: 0 };
    }
    this.report({ code: "observation_flush_timeout", message: `boundary seq ${seq} 在 ${this.limits.boundaryDeadlineMs}ms 内未 durable；persistence degraded` });
    w.reject(new ObservationStoreUnavailableError(`boundary seq ${seq} canonical_flush_timeout`, this.persistence));
  }

  private seal(cause: Error): void {
    this.terminate("sealed", cause);
  }

  /**
   * 丢锁 / 交还之后的封口——`StateLeaseLifecycle.onLeaseLost` 接到这里（review 2026-09-07）。
   * 状态根已经不归本进程：**不 flush**，ring 里没写完的留在内存；之后的 offer / boundary 一律经
   * `unavailable()` 丢弃。幂等：已经 terminal 就什么都不做。
   * 下游对 `lost-lease` 的判断（`flushPending` / `unavailable` / health）早就写好了，此前只是没有入口。
   */
  markLeaseLost(cause: Error): void {
    this.terminate("lost-lease", cause);
  }

  private terminate(status: "sealed" | "lost-lease", cause: Error): void {
    if (this.persistence.status === "sealed" || this.persistence.status === "lost-lease") return;
    // **成因先 redact**：seal 往往由第三方错误触发，`cause.message` 里出现过整条
    // `Authorization: Bearer sk-…`，而它会同时进诊断和 boundary waiter 的 rejection（review 实测）。
    // 这与 subscriber failure 那条路已经在用 `redactError()` 也对不上。
    const r = redactError(cause);
    const label = `${r.name}@${r.digest.slice(0, 8)}`;
    const prev = this.persistence;
    const now = this.clock.now();
    this.persistence = {
      status,
      since: now,
      // 之前经历过 degraded/recovering 就把首次 degradation 的时刻留下；直接从 healthy 掉进来则没有
      ...(prev.status === "degraded" || prev.status === "recovering" ? { degradedSince: prev.since } : {}),
      lastErrorDigest: r.digest, // health 存**完整** digest；对外只露前缀
      reopenAttempts: prev.status === "degraded" || prev.status === "recovering" ? prev.reopenAttempts : 0,
    };
    const message = `canonical writer ${status}：${label}`;
    this.report({ code: status === "sealed" ? "observation_writer_sealed" : "observation_writer_lost_lease", message });
    // 开着的溢出区间不会再有人收口（offer / boundary / flush 都在 terminal 上短路）：那几条丢弃至少要留一句诊断
    const open = this.overflow;
    if (open !== undefined) {
      this.overflow = undefined;
      this.report({ code: "observation_hole", message: `seq ${open.firstSeq}..${open.lastSeq} → hole(buffer_overflow) ×${open.lastSeq - open.firstSeq + 1}，writer 已 ${status}，没有 gap 落盘` });
    }
    for (const w of [...this.waiters.values()]) {
      if (w.settled) continue;
      w.settled = true;
      w.cancelDeadline();
      w.reject(new ObservationStoreUnavailableError(message, this.persistence));
    }
    this.waiters.clear();
    this.cancelDelayedFlush?.();
    this.cancelDelayedFlush = undefined;
  }

  /* ───────── live publish ───────── */

  private publish(env: ObservationEnvelope): void {
    for (const sub of this.subscribers.values()) this.enqueue(sub, env);
  }

  private enqueue(sub: Subscriber, env: ObservationEnvelope): void {
    if (sub.status === "closed") return;
    if (sub.runId !== undefined && env.scope.runId !== sub.runId) return;
    if (sub.queue.length >= this.limits.subscriberQueueCapacity) {
      sub.pendingDrop = sub.pendingDrop === undefined ? { first: env.seq, last: env.seq } : { first: sub.pendingDrop.first, last: env.seq };
      sub.status = "degraded";
      return;
    }
    if (sub.pendingDrop !== undefined) {
      const gap: SinkDeliveryGap = {
        sinkId: sub.id,
        afterSeq: sub.pendingDrop.first - 1,
        beforeSeq: sub.pendingDrop.last + 1,
        dropped: sub.pendingDrop.last - sub.pendingDrop.first + 1,
        reason: "subscriber_slow",
      };
      sub.pendingDrop = undefined;
      sub.gaps.push(gap);
      sub.queue.push(gap);
    }
    sub.queue.push(env);
    this.scheduleDrain(sub);
  }

  private scheduleDrain(sub: Subscriber): void {
    if (sub.draining) return;
    sub.draining = true;
    queueMicrotask(() => {
      sub.draining = false;
      this.drain(sub);
    });
  }

  /**
   * 回放期按页从 store 读旧记录：一页交付完才读下一页（内存里最多一页），读到 `upto` 或读失败都回到 live 队列。
   * 读失败 = 这段只在这个 sink 上缺：出一条 `replay_unavailable` gap、sink 降级，canonical 不受影响。
   */
  private fetchReplayPage(sub: Subscriber): void {
    const replay = sub.replay;
    if (replay === undefined || replay.fetching) return;
    if (replay.cursor >= replay.upto) {
      sub.replay = undefined;
      this.scheduleDrain(sub);
      return;
    }
    replay.fetching = true;
    const requested = Math.min(REPLAY_PAGE_RECORDS, replay.upto - replay.cursor);
    void this.store.readRecordsAfter(this.runtimeId, replay.cursor, requested).then(
      (page) => {
        replay.fetching = false;
        if (sub.status === "closed") return;
        let exhausted = page.length < requested;
        try {
          for (const bytes of page) {
            const env = decodeObservationEnvelope(bytes);
            if (env.seq > replay.upto) {
              exhausted = true;
              break;
            }
            replay.cursor = env.seq;
            if (sub.runId !== undefined && env.scope.runId !== sub.runId) continue;
            replay.queue.push(env);
          }
        } catch (e) {
          this.failReplay(sub, replay, e);
          return;
        }
        if (exhausted) replay.cursor = replay.upto;
        this.scheduleDrain(sub);
      },
      (e: unknown) => {
        replay.fetching = false;
        if (sub.status === "closed") return;
        this.failReplay(sub, replay, e);
      },
    );
  }

  private failReplay(sub: Subscriber, replay: ReplayState, e: unknown): void {
    const gap: SinkDeliveryGap = { sinkId: sub.id, afterSeq: replay.cursor, beforeSeq: replay.upto + 1, dropped: replay.upto - replay.cursor, reason: "replay_unavailable" };
    sub.status = "degraded";
    this.pushSinkGap(sub, gap);
    replay.queue.push(gap); // 走同一条交付路径，落在旧记录之后、live 之前
    replay.cursor = replay.upto;
    this.report({ code: "observation_replay_failed", message: `subscriber ${sub.id} 回放 (${gap.afterSeq}, ${gap.beforeSeq}) 从 store 读不出来：${redactedLabel(e)}` });
    this.scheduleDrain(sub);
  }

  private drain(sub: Subscriber): void {
    if (sub.inFlight) return; // 已有一条在途：等它 settle 再继续，队列在此期间正常积压
    for (;;) {
      if (sub.status === "closed") return;
      let item: ObservationSubscribeItem;
      if (sub.replay !== undefined) {
        // 回放期：先交付 store 读回的旧记录；live 记录在 `queue` 里等着，顺序仍按 seq
        if (sub.replay.queue.length === 0) {
          this.fetchReplayPage(sub); // 异步：页到了（或回放结束）再 scheduleDrain
          return;
        }
        item = sub.replay.queue.shift()!;
      } else {
        if (sub.queue.length === 0) {
          // 队列排空后，中途丢掉的尾巴要当场物化并交付——不能等下一条 record 才说，流尾 / 封口 / shutdown 前
          // 可能永远没有下一条（review P1）。**但它必须走同一条交付路径**：原来这里直接调 listener 且
          // 不设 inFlight，于是 gap 的 Promise 还没 settle 就又开始交付下一条 record（实测 maxActive=2），
          // 单 in-flight 状态机等于被绕过（2026-08-27 review P1）。
          const tail = this.takePendingDrop(sub);
          if (tail === undefined) return;
          sub.queue.push(tail);
        }
        item = sub.queue.shift()!;
      }
      try {
        // listener 类型写的是返回 void，但 TypeScript 放行 `async () => {}`：返回了 thenable 就挂
        // `.then(...)` 把 reject 接住——否则它是 unhandled rejection，Node 下能直接终结常驻进程。
        // 与 Agent.deliverToTap() 同一条规矩：同步 throw 与异步 reject 都只关这一个 sink。
        const r: unknown = sub.listener(item);
        if (isThenable(r)) {
          // **异步 listener 不许绕过 bounded queue**（2026-08-27 review P1）：原来挂完 rejection handler
          // 就继续 shift 下一条并立刻推进 `lastDeliveredSeq`——queue 容量写 1，实测仍能同时挂 100 个
          // 永不 settle 的 Promise，没有一条真正完成，health 却声称已 delivered 到 100、还不产生 gap。
          // 现在**只允许一条在途**，settle 之后才继续 drain；未完成期间队列照常满、照常出 subscriber_slow gap。
          sub.inFlight = true;
          // **必须先用 `Promise.resolve()` 同化**（2026-08-27 review P1）：直接调任意 thenable 的 `.then()`
          // 时，一个同步 resolve 的 thenable 会**同步**回调，于是 `drain()` 就地递归——大批量下直接栈溢出，
          // 还会把一个健康 sink 当成 listener 抛错关掉。同化后回调恒异步、且只 settle 一次。
          Promise.resolve(r).then(
            () => {
              sub.inFlight = false;
              if (sub.status === "closed") return;
              if ("recordId" in item) sub.lastDeliveredSeq = item.seq; // settle 之后才算 delivered
              this.drain(sub);
            },
            (e: unknown) => {
              sub.inFlight = false;
              this.failSink(sub, item, e);
            },
          );
          return;
        }
        if ("recordId" in item) sub.lastDeliveredSeq = item.seq;
      } catch (e) {
        this.failSink(sub, item, e);
        return;
      }
    }
  }

  private failSink(sub: Subscriber, item: ObservationSubscribeItem, e: unknown): void {
    // 第二层兜底：这条路径本身就是「观测出事时」走的，它自己再抛就等于把异常放回主流程
    // （同步 listener 逃出 microtask、async listener 造出新的 unhandled rejection）。
    // `redactError` 已经是 total function，这里再兜一层是因为**隔离层不能有单点**。
    try {
      if (sub.status === "closed") return; // 异步 reject 可能晚于关闭到达
      const seq = "recordId" in item ? item.seq : item.beforeSeq - 1;
      this.pushSinkGap(sub, { sinkId: sub.id, afterSeq: seq - 1, beforeSeq: seq + 1, dropped: 1, reason: "sink_failure" });
      // 名字叫 digest 就不能装原文：第三方 listener 的 message 曾把整条 Authorization 头带进可查询的 health。
      const r = redactError(e);
      sub.lastErrorDigest = r.digest;
      this.report({ code: "observation_subscriber_failed", message: `subscriber ${sub.id} 抛错，已关闭：${r.name}@${r.digest.slice(0, 8)}` });
      this.closeSink(sub);
    } catch {
      try {
        sub.status = "closed";
        this.subscribers.delete(sub.id);
      } catch {
        // 无路可走也不能抛
      }
    }
  }

  /** 关闭并留 tombstone：`status:"closed"` 与 lastErrorDigest 在 `health()` 里仍可见（有界，最旧的先出）。 */
  private closeSink(sub: Subscriber): void {
    if (sub.status === "closed") return;
    this.takePendingDrop(sub); // 只入账，不交付（sink 正在关闭）
    sub.status = "closed";
    sub.queue.length = 0;
    sub.replay = undefined; // 在途的那页读回来会看到 closed 直接丢掉
    // **按身份删，不按 ID 删**：同 ID 的旧句柄 unsubscribe 时会把新 subscriber 从 Map 里删掉（review P2）。
    if (this.subscribers.get(sub.id) === sub) this.subscribers.delete(sub.id);
    this.closedSinks.push(this.sinkHealthOf(sub));
    while (this.closedSinks.length > MAX_CLOSED_SINK_TOMBSTONES) this.closedSinks.shift();
  }

  /** 把累积的连续丢弃区间物化成 `SinkDeliveryGap`（进 health；`deliver` 时还交付给 listener）。 */
  private takePendingDrop(sub: Subscriber): SinkDeliveryGap | undefined {
    const drop = sub.pendingDrop;
    if (drop === undefined) return undefined;
    sub.pendingDrop = undefined;
    const gap: SinkDeliveryGap = {
      sinkId: sub.id,
      afterSeq: drop.first - 1,
      beforeSeq: drop.last + 1,
      dropped: drop.last - drop.first + 1,
      reason: "subscriber_slow",
    };
    this.pushSinkGap(sub, gap);
    return gap;
  }

  /** 有界追加：超出 `MAX_SINK_GAPS` 丢最旧的，并累加 `droppedGapCount`。 */
  private pushSinkGap(sub: Subscriber, gap: SinkDeliveryGap): void {
    sub.gaps.push(gap);
    while (sub.gaps.length > MAX_SINK_GAPS) {
      sub.gaps.shift();
      sub.droppedGapCount += 1;
    }
  }

  private sinkHealthOf(sub: Subscriber): SinkHealth {
    const gaps = [...sub.gaps];
    const drop = sub.pendingDrop;
    if (drop !== undefined) {
      // 快照时刻仍在累积的丢弃也要可见，不等它物化
      gaps.push({ sinkId: sub.id, afterSeq: drop.first - 1, beforeSeq: drop.last + 1, dropped: drop.last - drop.first + 1, reason: "subscriber_slow" });
    }
    return {
      sinkId: sub.id,
      status: sub.status,
      lastDeliveredSeq: sub.lastDeliveredSeq,
      gaps,
      droppedGapCount: sub.droppedGapCount,
      ...(sub.lastErrorDigest === undefined ? {} : { lastErrorDigest: sub.lastErrorDigest }),
    };
  }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}
