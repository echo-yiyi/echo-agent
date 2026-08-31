// Observation 公共 ABI（AGENT-CORE §15.4.1 / §15.5.1 / §15.6 / §15.12，逐字照录；O2a B1）。
//
// **只放 JSON-safe 的值与形状**：persist / query / render 面上只出现 `ObservationValue`，任何运行期对象
// （Error、Uint8Array、bigint、Map……）都在 Sequencer 的 `normalizeObservationValue()` 里归一或被拒，
// 不靠 `JSON.stringify()` 静默删字段（§15.4.1）。
//
// `ObservationDraft` 系列是 Host-internal producer 输入，**不在这里**（见 `./draft.ts`），
// 绝不从 observability 公共子路径导出。

/* ══════════════════ §15.4.1 值与 envelope ══════════════════ */

export type ObservationScalar = null | boolean | number | string;

export type ObservationValue =
  | ObservationScalar
  | readonly ObservationValue[]
  | { readonly [key: string]: ObservationValue };

export type ObservationError = Readonly<{
  name: string;
  message: string;
  code?: string;
  /**
   * stack 的 SHA-256。`stackTruncated` 为 true 时它是**有界前缀**的 digest，不是完整 stack 的指纹
   * ——两者不可跨条目对账，字段语义由 `stackTruncated` 决定（见 `MAX_STACK_DIGEST_INPUT`）。
   */
  stackDigest?: string;
  /** true = `stackDigest` 只覆盖前 `MAX_STACK_DIGEST_INPUT` 个 code unit。 */
  stackTruncated?: boolean;
  /** 原始 stack 的 code unit 数；只在 `stackTruncated` 时出现。 */
  stackChars?: number;
}>;

export type ObservationBlobRef = Readonly<{
  digest: string;
  mediaType?: string;
  size: number;
}>;

export type ObservationRef = Readonly<{
  runtimeId: string;
  recordId: string;
}>;

export type RunObservationRef = Readonly<{
  runtimeId: string;
  runId: string;
}>;

export type ObservationOwner =
  | Readonly<{
      status: "known";
      entryId: string;
      // §14 Entry generation 是内容/换代 identity，保持 string，不另造数值代号。
      entryGeneration: string;
      via: "assembly" | "registry" | "fiber";
    }>
  | Readonly<{ status: "unknown"; reason: string }>
  | Readonly<{ status: "not-applicable" }>;

export type ObservationLane = "boundary" | "bounded";
export type ObservationRecordKind = "event" | "span_start" | "span_end" | "snapshot" | "health";

export type ObservationEnvelope<T extends ObservationValue = ObservationValue> = Readonly<{
  schemaVersion: 1;
  recordId: string;
  seq: number; // 当前 runtimeId journal 内单调且唯一
  lane: ObservationLane;
  occurredAt: number;
  observedAt: number; // 只由 Sequencer 分配
  sourceSeq?: number; // 如 concrete AgentEvent.seq；绝不充当 canonical seq

  kind: ObservationRecordKind;
  name: string;
  scope: Readonly<{
    runtimeId: string;
    agentId?: string;
    agentInstanceId?: string;
    sessionId?: string;
    runId?: string;
    turnId?: string;
    activityId?: string;
    submissionId?: string;
    toolCallId?: string;
    permissionId?: string;
    reloadId?: string;
  }>;
  correlation: Readonly<{
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    causationId?: string;
    links?: readonly ObservationRef[];
  }>;
  generation: Readonly<{
    runtime: string;
    agentAssembly?: string;
  }>;
  owner: ObservationOwner;
  disposeOwner?: Readonly<{ kind: "agent" | "fiber"; id: string }>;
  instrumentation: Readonly<{ name: string; version: string }>;
  subject?: Readonly<{ kind: string; id: string }>;
  attributes: Readonly<Record<string, string | number | boolean>>;
  body: T;
}>;

/* ══════════════════ §15.3.3 Snapshot ══════════════════ */

export type ObservationSnapshot<T extends ObservationValue> = Readonly<{
  throughSeq: number;
  at: number;
  state: T;
}>;

/* ══════════════════ §14 里被 §15 引用的 Runtime 类型 ══════════════════ */
// 这三个的定义权在 §14.2（EchoRuntime）。O3a 落 `createEcho()` 时从 runtime 模块导出并在这里 re-export；
// 现在先住这里，避免两份定义漂移。

export type RuntimePhase = "bootstrapping" | "ready" | "reconfiguring" | "failed" | "disposing" | "disposed";

// 兼容的人读投影；内部真相始终是 phase + observation persistence 两轴。
export type EchoRuntimeStatus = RuntimePhase | "degraded";

// `RunSource` 的定义权归 §14.2.4 admission（`../admission/types.ts`）——这里只转发，不留第二份定义。
import type { RunSource } from "../admission/types.ts";
export type { RunSource };

/* ══════════════════ §15.5.1 RunObservation 家族 ══════════════════ */

export type ObservationCapturePolicy = "off" | "metadata" | "content";

export type RunObservationStatus = "running" | "completed" | "aborted" | "error" | "interrupted";

export type ObservationIntegrity = "complete" | "partial";

export type AgentAssemblyObservationSnapshot = Readonly<{
  digest: string;
  slots: readonly Readonly<{
    slot: string;
    entryId: string;
    entryGeneration: string;
    owner: ObservationOwner;
    digest: string;
  }>[];
}>;

export type RunModelBindingObservationSnapshot = Readonly<{
  providerId: string;
  modelId: string;
  catalogRevision: string;
  configDigest: string;
}>;

export type ActiveEntrySnapshot = Readonly<{
  entryId: string;
  generation: string;
  scope: "process" | "agent";
  status: "active" | "unloading";
  sourceDigest: string;
  configDigest: string;
}>;

export type TurnWorksetObservation = Readonly<{
  turnId: string;
  tools: readonly Readonly<{ id: string; digest: string; owner: ObservationOwner }>[];
  hooks: readonly Readonly<{ id: string; digest: string; owner: ObservationOwner }>[];
  promptSources: readonly Readonly<{ id: string; digest: string; owner: ObservationOwner }>[];
}>;

export type AgentOutcomeObservation = Readonly<{
  status: "completed" | "aborted" | "error";
  // RunObservation 聚合层可从更早的 bounded content record 还原；run.closed body 不直接携带该正文。
  finishReason?: string;
  output?: ObservationValue;
  error?: ObservationError;
}>;

export type RunClosedOutcomeObservation = Readonly<{
  status: "completed" | "aborted" | "error";
  finishReason?: string; // UTF-8 <= maxSafeStringBytes
  outputBytes?: number;
  outputDigest?: string;
  errorCode?: string; // UTF-8 <= maxSafeStringBytes
  errorDigest?: string;
}>;

export type CapabilityObservationSummary = Readonly<{
  schemaVersion: 1;
  stateDigest: string;
  counters: Readonly<Record<string, number>>; // descriptor 固定 key；至多 maxCapabilityCounters
  flags?: Readonly<Record<string, boolean>>; // descriptor 固定 key；至多 maxCapabilityFlags
  detailBytes: number;
  detailTruncated: boolean;
}>;

export type EchoObservableState = Readonly<{
  runtime: Readonly<{
    phase: RuntimePhase;
    status: EchoRuntimeStatus;
    observationPersistence: ObservationPersistenceStatus;
    generation: string;
    activeEntryCount: number;
  }>;
  agent: Readonly<{
    status: string;
    activeRunId: string | null;
    activeTurnId: string | null;
    iteration: number;
    messageCount: number;
  }>;
  capabilities: readonly Readonly<{
    id: string;
    digest: string;
    summary: CapabilityObservationSummary;
  }>[];
  omittedCapabilitySummaryCount: number;
}>;

/**
 * finalizer 提交给 `appendBoundary("run.closed")` 的 body：**只有** outcome 与可选 snapshot。
 * capture 的计数与 digest 不在这里——它们由 Sequencer 从自己的 canonical gap 账本填（唯一真相源）；
 * caller 即便塞了同名字段也会被丢弃，不存在「caller 报一个、Sequencer 报另一个」的二义。
 */
export type RunClosedBodyInput = Readonly<{
  outcome: RunClosedOutcomeObservation;
  finalSnapshot: ObservationSnapshot<EchoObservableState> | null;
}>;

/** 落进 journal 的 `run.closed` body：在 caller 的 input 之上，由 Sequencer 补齐 capture 事实。 */
export type RunClosedBodyV1 = RunClosedBodyInput &
  Readonly<{
    captureGapCountBeforeClose: number;
    captureGapDigest?: string;
  }>;

export type RunObservationSummary = Readonly<{
  durationMs: number | null;
  recordCount: number;
  canonicalGapCount: number;
  model: Readonly<{
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalDurationMs: number;
  }>;
  tools: readonly Readonly<{
    toolId: string;
    owner: ObservationOwner;
    calls: number;
    successes: number;
    errors: number;
    denied: number;
    totalDurationMs: number;
    criticalPathMs: number;
    argsBytes: number;
    resultBytes: number;
  }>[];
}>;

export type RunObservationHeader = Readonly<{
  schemaVersion: 1;
  runId: string;
  submissionId?: string;
  source: RunSource;
  runtimeId: string;
  agentId: string;
  agentInstanceId: string;
  sessionId: string | null;
  runtimeGeneration: string;
  capturePolicy: ObservationCapturePolicy;
  acceptedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  status: RunObservationStatus;
  integrity: ObservationIntegrity;
  persistence: "stored" | "degraded";
}>;

export type RunIndexEntryV1 = Readonly<{
  schemaVersion: 1;
  runtimeId: string;
  runId: string;
  acceptedRecordId: string;
  startedRecordId?: string;
  terminalRecordId?: string;
  header: RunObservationHeader;
  firstSeq: number;
  lastSeq: number;
  bodyState: "retained" | "pruned";
  prunedAt?: number;
}>;

export type RunObservation = RunObservationHeader &
  Readonly<{
    agentAssembly: AgentAssemblyObservationSnapshot;
    modelBinding: RunModelBindingObservationSnapshot;
    outcome: AgentOutcomeObservation | null;

    records: readonly ObservationEnvelope[];
    finalSnapshot: ObservationSnapshot<EchoObservableState> | null;
    activeEntries: readonly ActiveEntrySnapshot[];
    turnWorksets: readonly TurnWorksetObservation[];
    gaps: readonly ObservationGap[];

    // gaps 是 records 中 CanonicalObservationGap.body 的确定性派生；全部字段都不是第二条写路径。
    summary: RunObservationSummary;
  }>;

export type RunLookupResult =
  | Readonly<{ kind: "found"; observation: RunObservation }>
  | Readonly<{
      kind: "pruned";
      header: RunObservationHeader;
      gaps: readonly ObservationGap[];
    }>
  | Readonly<{ kind: "unknown" }>;

/* ══════════════════ §15.12 gap 三族与 sink / persistence health ══════════════════ */

export type ObservationGapReason =
  | "buffer_overflow"
  | "encoding_error"
  | "capture_limit"
  | "store_failure"
  | "canonical_flush_timeout"
  | "lease_lost"
  | "retention";

export type ObservationGap = Readonly<{
  afterSeq: number;
  beforeSeq: number;
  dropped: number;
  reason: ObservationGapReason;
}>;

/** 唯一可持久化的 gap：占 boundary seq、进 journal、推进 committed prefix；body 才是 `ObservationGap`。 */
export type CanonicalObservationGap = ObservationEnvelope<ObservationGap> &
  Readonly<{
    lane: "boundary";
    kind: "health";
    name: "observation.gap";
  }>;

/** retention 回放缺口的临时传输通知：无 recordId / canonical seq，不进 journal，不改 integrity。 */
export type ObservationReplayGap = Readonly<{
  kind: "retention-gap";
  gap: ObservationGap & Readonly<{ reason: "retention" }>;
}>;

/** subscriber / exporter 自己慢、超时、关闭或出错；只进 SinkHealth，不污染 canonical integrity。 */
export type SinkDeliveryGap = Readonly<{
  sinkId: string;
  afterSeq: number;
  beforeSeq: number;
  dropped: number;
  reason: "subscriber_slow" | "exporter_timeout" | "shutdown_timeout" | "sink_failure";
}>;

export type SinkHealth = Readonly<{
  sinkId: string;
  status: "healthy" | "degraded" | "closed";
  lastDeliveredSeq: number;
  /** 有界保留（最新若干条）；被挤掉的计入 `droppedGapCount`，不假装没丢过。 */
  gaps: readonly SinkDeliveryGap[];
  droppedGapCount: number;
  lastErrorDigest?: string;
}>;

export type ObservationPersistenceStatus = "healthy" | "degraded" | "recovering" | "sealed" | "lost-lease";

export type ObservationPersistenceState =
  | Readonly<{ status: "healthy" }>
  | Readonly<{
      status: "degraded" | "recovering";
      since: number;
      lastErrorDigest: string;
      reopenAttempts: number;
    }>
  /**
   * **terminal 也必须带证据**（2026-08-27 review P1）：上一版只有一个 `status`，于是 health 对 sealed
   * 只能报 `reopenAttempts: 0`，用户看不到**什么时候、因为什么**停的——写不动了却查不出原因，
   * 等于把最需要证据的那一刻做成了空白。
   *
   * `since` 的语义与 degraded/recovering 一致：**当前 status 自身的起点**，这里就是进入 terminal 的时刻。
   * 之前若经历过 degraded/recovering，首次 degradation 的时刻另记在 `degradedSince`——两个时间都要，
   * 但不能挤进同一个字段（review 点出的歧义）。`lastErrorDigest` 是 `redactError()` 的完整 digest，
   * **不是原始 message**：seal 的成因往往就是第三方错误正文，那里面出现过 `Authorization: Bearer …`。
   */
  | Readonly<{
      status: "sealed" | "lost-lease";
      since: number;
      degradedSince?: number;
      lastErrorDigest: string;
      reopenAttempts: number;
    }>;

export type ObservationHealth = Readonly<{
  persistence: Readonly<{
    status: ObservationPersistenceStatus;
    lastCommittedSeq: number;
    /** 首次 degradation 的时刻（terminal 之前若经历过 degraded/recovering 才有）。 */
    degradedSince?: number;
    /** 进入 terminal（sealed / lost-lease）的时刻。 */
    terminalSince?: number;
    lastErrorDigest?: string;
    reopenAttempts: number;
  }>;
  capture: Readonly<{
    policy: ObservationCapturePolicy;
    canonicalGapCount: number;
  }>;
  sinks: readonly SinkHealth[];
}>;

/* ══════════════════ §15.4.2 同步预算（硬门，不是建议） ══════════════════ */

/** `offer()` 的同步预算：超出任一项按 encoding failure 裁决，不静默截断成另一份事实。 */
export const OBSERVATION_SYNC_LIMITS = {
  maxCanonicalDraftBytes: 64 * 1024,
  maxValueDepth: 32,
  maxValueNodes: 4_096,
  maxBlobChunkBytes: 1 * 1024 * 1024,
} as const;

/**
 * canonical envelope 的**框架**（recordId / seq / lane / observedAt / correlation / generation / owner /
 * instrumentation …）在 body 之外占的预算。
 *
 * 它存在只为一件事：让 ephemeral `EngineObservationFact` 与 canonical record **共用同一个 admission
 * boundary**。ephemeral fact 不背这些框架字段，若两边用同一个 64 KiB 数字，同一条事实就会在评测面进、
 * 在 Runtime 面成 gap（实测 body 65,248 时正是如此）。于是：`/engine` 一侧按「同步预算减去这份保留」量自己
 * 的 fact，Sequencer 一侧断言实际框架不超过这份保留——**engine 因此永不比 Runtime 宽**，最多在一个保留宽度内
 * 更严。
 */
export const OBSERVATION_ENVELOPE_RESERVE = {
  bytes: 8 * 1024,
  nodes: 128,
} as const;

/**
 * 身份/框架字符串的**构造期**上限。
 *
 * 光有 `OBSERVATION_ENVELOPE_RESERVE` 证明不了「engine 永不比 Runtime 宽」：runtimeId / generation /
 * owner / instrumentation / subject 这些只出现在 canonical envelope、不出现在 ephemeral fact 的字段，
 * 若长度无约束，一个 5,000 字节的 `instrumentation.name` 就能让 Runtime 成 gap 而 `/engine` 照收
 * （review 实测）。于是它们全部按这里的上限**在构造时 fail-loud**——Sequencer 建的时候校 runtimeId /
 * generation，fact sink 建的时候校 descriptor 的 instrumentation 与 owner。
 * 字段数固定 + 每个有上限 ⇒ 额外框架的总量有可算的上界，保留额才真的兜得住。
 */
export const OBSERVATION_IDENTITY_LIMITS = {
  /** 单个身份字符串（id / name / generation / reason / digest…）的 UTF-8 上限。 */
  maxIdentifierBytes: 128,
  /** `correlation.links` 的条数上限。 */
  maxLinks: 4,
  /** `attributes` 的键数上限——它是低基数安全值的容器，不是第二个 body。 */
  maxAttributeKeys: 32,
  /**
   * `attributes` 里字符串值的字节上限。**与身份串分开声明**：attribute 装的是 toolName / customEventType
   * 这类展示值，既允许空串、也可能比身份串长；套用身份串那把尺（非空 + 128 字节）等于给了一条没写进
   * 契约的 ABI——129 字节的 toolName 会直接变 drop/gap（review 点出）。
   */
  maxAttributeStringBytes: 512,
} as const;

/** `appendBoundary()` 的构造上限：boundary body 必须按构造有界，不能把 bounded lane 的「有上限」类推成没上限。 */
export const OBSERVATION_BOUNDARY_LIMITS = {
  maxCanonicalBoundaryBytes: 64 * 1024,
  maxValueDepth: 16,
  maxValueNodes: 2_048,
  maxCapabilitySummaries: 32,
  /**
   * capability 容器的**扫描上限**。finalSnapshot 是可选投影，却跑在 Agent 的同步封口路径上：
   * 一个 5,000,000 长度的稀疏数组能把 finalizer 卡住（实测约 79ms，且数组最大长度还能更糟）。
   * 超过就整份丢掉、开 `run.final_snapshot` gap——可选投影不值得让封口等。
   */
  maxCapabilityScan: 1_024,
  maxCapabilitySummaryBytes: 1 * 1024,
  maxCapabilityCounters: 24,
  maxCapabilityFlags: 24,
  maxSafeStringBytes: 256,
} as const;
