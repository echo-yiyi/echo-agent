// Observation 公共 ABI（AGENT-CORE §15.4.1 / §15.5.1 / §15.6 / §15.12，逐字照录；O2a B1）。
//
// **只放 JSON-safe 的值与形状**：persist / query / render 面上只出现 `ObservationValue`，任何运行期对象
// （Error、Uint8Array、bigint、Map……）都在 Sequencer 的 `normalizeObservationValue()` 里归一或被拒，
// 不靠 `JSON.stringify()` 静默删字段（§15.4.1）。
//
// `ObservationDraft` 系列是 Host-internal producer 输入，**不在这里**（见 `./draft.ts`），
// 绝不从 observability 公共子路径导出。

/* ══════════════════ §15.4.1 值与 envelope ══════════════════ */

/** JSON-safe 标量：canonical envelope 里能出现的叶子值。 */
export type ObservationScalar = null | boolean | number | string;

/** JSON-safe 值（§15.4.1）：body / attributes / snapshot 都先成为它，才能进 canonical journal 与 renderer。 */
export type ObservationValue =
  | ObservationScalar
  | readonly ObservationValue[]
  | { readonly [key: string]: ObservationValue };

/** Error 的安全投影：name / message / code 与 stack 的 digest，不带原始 stack（§15.11 采集边界）。 */
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

/** 大正文的 content-addressed 引用（§15.4.2.4）；O3a 只定形状，真正的 blob CAS 接线在 O3b。 */
export type ObservationBlobRef = Readonly<{
  digest: string;
  mediaType?: string;
  size: number;
}>;

/** 指向某条 canonical record（runtimeId + recordId）。 */
export type ObservationRef = Readonly<{
  runtimeId: string;
  recordId: string;
}>;

/** 指向一次 run 的观测记录（runtimeId + runId）；`EchoRunResult.observation` 就是它。 */
export type RunObservationRef = Readonly<{
  runtimeId: string;
  runId: string;
}>;

/** 事实归谁（OR13）：known = 某个 Entry@generation；unknown 带理由；not-applicable = Runtime 自身。 */
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

/** 两条 lane：boundary 同步等 COMMIT（run 边界、gap），bounded 进有界 ring 批量提交（高频事实）。 */
export type ObservationLane = "boundary" | "bounded";
/** 四种原始信号（§15.3）加 health。 */
export type ObservationRecordKind = "event" | "span_start" | "span_end" | "snapshot" | "health";

/** canonical record 的 envelope（§15.4.1）：identity（recordId / seq / observedAt）由 Sequencer 分配，producer 只给 body 与 descriptor。 */
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

/** 此刻权威状态的只读投影（§15.3.3）：`throughSeq` 说明它相对 journal 的新鲜度。 */
export type ObservationSnapshot<T extends ObservationValue> = Readonly<{
  throughSeq: number;
  at: number;
  state: T;
}>;

/* ══════════════════ §14 里被 §15 引用的 Runtime 类型 ══════════════════ */
// 这三个的定义权在 §14.2（EchoRuntime）。O3a 落 `createEcho()` 时从 runtime 模块导出并在这里 re-export；
// 现在先住这里，避免两份定义漂移。

/** §14 Runtime 生命周期 phase；与 observation persistence 正交（§15.12）。 */
export type RuntimePhase = "bootstrapping" | "ready" | "reconfiguring" | "failed" | "disposing" | "disposed";

/** 兼容的人读投影：phase，或 phase=ready 且 persistence 非 healthy 时的 `"degraded"`；内部真相始终是两轴。 */
export type EchoRuntimeStatus = RuntimePhase | "degraded";

// `RunSource` 的定义权归 §14.2.4 admission（`../admission/types.ts`）——这里只转发，不留第二份定义。
import type { RunSource } from "../admission/types.ts";
import type { AgentOutcome } from "../events.ts";
export type { RunSource };

/* ══════════════════ §15.5.1 RunObservation 家族 ══════════════════ */

/** 采集档位（OR9）：off 只留身份骨架与安全 outcome；metadata 缺省；content 才带正文（需显式打开）。 */
export type ObservationCapturePolicy = "off" | "metadata" | "content";

/** run 的业务终态；`interrupted` 只由跨进程 recovery 封（O3b）。 */
export type RunObservationStatus = "running" | "completed" | "aborted" | "error" | "interrupted";

/** canonical 记录完整性：本 run 有任何 CanonicalObservationGap 即 partial；与业务 status 正交。 */
export type ObservationIntegrity = "complete" | "partial";

/** sealed AgentAssembly 的只读快照：只有槽 / Entry / 代 / owner / digest，不含对象本体。 */
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

/** run 冻结的模型绑定：provider / model id、目录 revision 与安全配置 digest，绝无凭据。 */
export type RunModelBindingObservationSnapshot = Readonly<{
  providerId: string;
  modelId: string;
  catalogRevision: string;
  configDigest: string;
}>;

/** run 期间生效的 Entry@generation；O2b 接上正式 Entry owner 才填，O3a 恒空。 */
export type ActiveEntrySnapshot = Readonly<{
  entryId: string;
  generation: string;
  scope: "process" | "agent";
  status: "active" | "unloading";
  sourceDigest: string;
  configDigest: string;
}>;

/** 每个 turn 真正拿到的 Tool / Hook / Prompt 注入及 owner（O1b workset）；O3a 恒空。 */
export type TurnWorksetObservation = Readonly<{
  turnId: string;
  tools: readonly Readonly<{ id: string; digest: string; owner: ObservationOwner }>[];
  hooks: readonly Readonly<{ id: string; digest: string; owner: ObservationOwner }>[];
  promptSources: readonly Readonly<{ id: string; digest: string; owner: ObservationOwner }>[];
}>;

/** 聚合层的业务 outcome：从 `run.closed` 的有界 outcome 派生；`output` 只在 content 档从更早的 bounded record 还原。 */
export type AgentOutcomeObservation = Readonly<{
  status: "completed" | "aborted" | "error";
  // RunObservation 聚合层可从更早的 bounded content record 还原；run.closed body 不直接携带该正文。
  finishReason?: string;
  output?: ObservationValue;
  error?: ObservationError;
}>;

/** `run.closed` body 里的有界 outcome：状态、有限 finish / error code 与正文 digest，绝不带 message / stack。 */
export type RunClosedOutcomeObservation = Readonly<{
  status: "completed" | "aborted" | "error";
  finishReason?: string; // UTF-8 <= maxSafeStringBytes
  outputBytes?: number;
  outputDigest?: string;
  errorCode?: string; // UTF-8 <= maxSafeStringBytes
  errorDigest?: string;
}>;

/** 单个 Capability 的固定 counters / flags / digest 摘要（各有上限，§15.5.1）；正文与列表不进这里。 */
export type CapabilityObservationSummary = Readonly<{
  schemaVersion: 1;
  stateDigest: string;
  counters: Readonly<Record<string, number>>; // descriptor 固定 key；至多 maxCapabilityCounters
  flags?: Readonly<Record<string, boolean>>; // descriptor 固定 key；至多 maxCapabilityFlags
  detailBytes: number;
  detailTruncated: boolean;
}>;

/** finalSnapshot 的状态形状：Runtime 两轴 + Agent 低基数字段 + Capability 摘要（按 id 排序、有上限）。 */
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

/** 从 records 确定性派生的 run 摘要：时长、记录数、gap 数、模型与 Tool 聚合。 */
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

/** run 的 header：唯一持久真相是 RunIndex 里 materialized 的那份，不是某条会被原地改的 record。 */
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

/** RunIndex 行（`observation_run_index`，§15.4.2.2）：retention 之后 header 的唯一真相源；与 records 同事务更新。 */
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

/** 一次 run 的硬产物（§15.5.1）：header + 冻结快照 + records + 派生的 gaps / summary；整体可按 canonical JSON round-trip。 */
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

/** `getRun()` / `lastRun()` 的三态：found / pruned（header 还在、body 已清）/ unknown（从未有过或已出 header 窗口）。 */
export type RunLookupResult =
  | Readonly<{ kind: "found"; observation: RunObservation }>
  | Readonly<{
      kind: "pruned";
      header: RunObservationHeader;
      gaps: readonly ObservationGap[];
    }>
  | Readonly<{ kind: "unknown" }>;

/* ══════════════════ §15.12 gap 三族与 sink / persistence health ══════════════════ */

/** canonical gap 的原因（§15.12）。 */
export type ObservationGapReason =
  | "buffer_overflow"
  | "encoding_error"
  | "capture_limit"
  | "store_failure"
  | "canonical_flush_timeout"
  | "lease_lost"
  | "retention";

/** 缺失区间：`(afterSeq, beforeSeq)` 两端 exclusive，`dropped === beforeSeq - afterSeq - 1`。 */
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

/** 单个 subscriber / exporter 的交付健康：慢、超时、关闭只进这里，不污染 canonical integrity。 */
export type SinkHealth = Readonly<{
  sinkId: string;
  status: "healthy" | "degraded" | "closed";
  lastDeliveredSeq: number;
  /** 有界保留（最新若干条）；被挤掉的计入 `droppedGapCount`，不假装没丢过。 */
  gaps: readonly SinkDeliveryGap[];
  droppedGapCount: number;
  lastErrorDigest?: string;
}>;

/** canonical persistence 的五态（§15.12）；与 RuntimePhase 正交。 */
export type ObservationPersistenceStatus = "healthy" | "degraded" | "recovering" | "sealed" | "lost-lease";

/** persistence 状态带证据：非 healthy 时必有 since / lastErrorDigest / reopenAttempts。 */
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

/** persistence × capture × sinks 三面的 health；live `snapshot()` 用，不回填进历史 run。 */
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

/* ══════════════════ §15.6 用户取得与渲染的公共面 ══════════════════ */

/**
 * 完整 Runtime `send()` 的返回（OR5）：业务 outcome 与观测三元组正交——
 * `observationIntegrity` 来自 RunIndex（canonical gap 派生），`observationPersistence` 是**当前 Runtime** 对这次
 * terminal COMMIT 的投影（stored = 已 COMMIT 且 read-back 可见；degraded = 尾写失败，磁盘 index 仍 running）。
 */
export type EchoRunResult = Readonly<{
  runId: string;
  outcome: AgentOutcome;
  observation: RunObservationRef;
  observationIntegrity: ObservationIntegrity;
  observationPersistence: "stored" | "degraded";
}>;

/** submission 级观测（Inbox / Extension source，O2b）；O3a 的 `getSubmission()` 恒 null。 */
export type SubmissionObservation = Readonly<{
  schemaVersion: 1;
  submissionId: string;
  status: "accepted" | "waiting-admission" | "running" | "completed" | "cancelled" | "error";
  runId: string | null;
  outcome: AgentOutcomeObservation | null;
  records: readonly ObservationEnvelope[];
}>;

/** 完整 Runtime 此刻的观测快照：phase × persistence 两轴、committed head、活动 run。 */
export type EchoObservationSnapshot = Readonly<{
  schemaVersion: 1;
  runtimeId: string;
  phase: RuntimePhase;
  /** phase + health.persistence.status 的派生投影。 */
  status: EchoRuntimeStatus;
  throughSeq: number;
  at: number;
  health: ObservationHealth;
  activeRuns: readonly RunObservationHeader[];
  activeSubmissions: readonly SubmissionObservation[];
}>;

/** `listRuns()` 的分页参数；缺省 20 条，上限 200。 */
export type ListRunsOptions = Readonly<{
  limit?: number;
  /** 上一页的 `nextCursor`；opaque，过期 / 篡改 fail-loud。 */
  cursor?: string;
}>;

/** `listRuns()` 的一页：按 `(acceptedAt, runId)` 倒序的 header 与下一页游标（null = 没有下一页）。 */
export type RunObservationPage = Readonly<{
  items: readonly RunObservationHeader[];
  nextCursor: string | null;
}>;

/** `subscribe()`：`afterSeq` 是 exclusive，回放 `(afterSeq, head]` 再接 live；`snapshot().throughSeq` 可直接当 afterSeq。 */
export type ObservationSubscribeOptions = Readonly<{
  afterSeq: number;
  runId?: string;
  submissionId?: string;
  listener: (record: ObservationEnvelope | ObservationReplayGap | SinkDeliveryGap) => void;
}>;

/** 完整 Runtime 的 live 查询面（`echo.observations`）。 */
export interface EchoObservations {
  getRun(runId: string): Promise<RunLookupResult>;
  getSubmission(submissionId: string): Promise<SubmissionObservation | null>;
  lastRun(): Promise<RunLookupResult>;
  listRuns(options?: ListRunsOptions): Promise<RunObservationPage>;
  snapshot(): Promise<EchoObservationSnapshot>;
  subscribe(options: ObservationSubscribeOptions): Promise<() => void>;
}

/** 离线 reader（observe CLI 的唯一入口）：read-only 连接，不取 StateLock、不起 Runtime；用完必须 `close()`。 */
export interface EchoObservationReader {
  getRun(runId: string): Promise<RunLookupResult>;
  getSubmission(submissionId: string): Promise<SubmissionObservation | null>;
  lastRun(): Promise<RunLookupResult>;
  listRuns(options?: ListRunsOptions): Promise<RunObservationPage>;
  snapshot(): Promise<EchoObservationSnapshot>;
  close(): Promise<void>;
}

/* ══════════════════ §15.7 renderer ViewModel ══════════════════ */

/** Timeline 的一行：相对 acceptedAt 的时间、层级与（span_end 才有的）耗时。 */
export type RunObservationTimelineItem = Readonly<{
  seq: number;
  relativeMs: number;
  kind: ObservationRecordKind;
  name: string;
  depth: number;
  durationMs?: number;
  attributes: Readonly<Record<string, string | number | boolean>>;
  body?: ObservationValue;
}>;

/** 人读 / HTML / JSON 都消费这一份；由 `buildRunObservationViewModel()` 从 RunObservation 确定性派生。 */
export type RunObservationViewModel = Readonly<{
  schemaVersion: 1;
  rendererVersion: 1;
  header: RunObservationHeader;
  identity: Readonly<{
    agentId: string;
    agentInstanceId: string;
    sessionId: string | null;
    runtimeGeneration: string;
    assemblyDigest: string;
    activeEntries: readonly ActiveEntrySnapshot[];
  }>;
  assembly: AgentAssemblyObservationSnapshot;
  modelBinding: RunModelBindingObservationSnapshot;
  outcome: AgentOutcomeObservation | null;
  timeline: readonly RunObservationTimelineItem[];
  finalState: EchoObservableState | null;
  /** finalState 为 null 的原因：policy off / capture_limit gap / 尚未封口。renderer 据此选文案，不猜数组空不空。 */
  finalStateAbsence: "captured" | "not-captured-by-policy" | "omitted-by-capture-limit" | "not-closed";
  summary: RunObservationSummary;
  health: Readonly<{
    canonicalGaps: readonly ObservationGap[];
    persistence: "stored" | "degraded";
    redacted: boolean;
  }>;
}>;

/** `renderRunObservation()` 的选项：text 给人读，json 是 ViewModel 的 canonical JSON；body 与 timeline 上限只影响 text。 */
export type RenderRunObservationOptions = Readonly<{
  format: "text" | "json";
  includeBody?: boolean;
  maxTimelineRecords?: number;
}>;

/** 渲染结果：带 rendererVersion 与 mediaType 的一段 content。 */
export type RenderedRunObservation = Readonly<{
  rendererVersion: 1;
  format: "text" | "json";
  mediaType: "text/plain" | "application/json";
  content: string;
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
 * producer 侧（AgentEvent projector 的正文预算）按「同步预算减去这份保留」量自己的投影，Sequencer 一侧断言
 * 实际框架不超过这份保留——于是 projector 认为装得下的记录，落库时不会因为框架开销变成 gap
 * （实测 body 65,248 时正是那种错位）。
 */
export const OBSERVATION_ENVELOPE_RESERVE = {
  bytes: 8 * 1024,
  nodes: 128,
} as const;

/**
 * 身份/框架字符串的**构造期**上限。
 *
 * 光有 `OBSERVATION_ENVELOPE_RESERVE` 兜不住框架：runtimeId / generation / owner / instrumentation / subject
 * 这些框架字段若长度无约束，一个 5,000 字节的 `instrumentation.name` 就能让每条记录都成 gap（review 实测）。
 * 于是它们全部按这里的上限**在构造时 fail-loud**——Sequencer 建的时候校 runtimeId / generation，
 * fact sink 建的时候校 descriptor 的 instrumentation 与 owner。
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
