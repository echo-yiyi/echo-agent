// `@echo-agent/core` —— **唯一入口**。设计真相源：docs/design/AGENT-CORE.md §13（D13 / D16）。
//
// 边界一句话：**Agent 管机制，用户换策略与基础设施**（§13.3）。
// 状态机、恢复与提交顺序归 core 自己拥有；用户注入的是 Store / Strategy / Source / Clock / Executor / Lock，
// 它们只换介质与策略，换不掉语义。
//
// **两个使用高度，都在这条入口上**（§14.2）：
//   - 高：`createEcho()` —— **唯一**的装配现场，端口与内建能力都已备好；
//   - 低：`new Agent()` —— 自己给端口、自己注册工具。
//
// **能力的构造器与操作面下沉子路径**。判据是 §13.5 那句：「普通用户不 import 这些子路径
// 也已经得到工作的默认能力，**只有替换默认件或开发扩展时才进入子路径**」。
// 现在真的存在的是：`./tools` · `./task` · `./task/fs` · `./background` · `./extension` · `./mcp`
// （以 `package.json#exports` 为准，那才是外部开发者能 import 的东西）。
// `memory` / `schedule` / `storage` / `session` / `inbox` 五类**目前不在公共面**——
// 子路径建了又撤，因为「exports 表无死条目」判红：它们眼下没有任何消费者。
// 别在这里写成「已经下沉」——那是**承诺一个不存在的扩展面**，外部开发者照着文档 import
// 会直接失败（2026-08-24 review 点出）。
//
// 留在本文件的能力**类型**（`AgentMemories` / `AgentSchedule` / `TaskSnapshot` …）不是例外：
// 它们出现在 `AgentOptions` 与 `AgentState` 的签名里，**读状态就得念得出它们的名字**。
// 值（怎么造、怎么改）才是子路径的事。
//
// 测试替身不在这条面上——它走 `@echo-agent/core/testing`。

export { Agent, DEFAULT_MAX_ITERATIONS } from "./agent.ts";
export type { AgentOptions, AgentState, AgentStatus } from "./agent.ts";

export * from "./messages.ts";
export * from "./events.ts";
export * from "./errors.ts";

export { EventStream, AssistantMessageEventStream, finalizeError, emptyAssistant, withPartial } from "./event-stream.ts";

/* ───────────── 配 provider：`createAgent({ provider })` 的唯一必填项 ───────────── */

export { createProvider, Models, InMemoryCredentialStore } from "./provider/models.ts";
export type { CreateProviderOptions } from "./provider/models.ts";
export { createProviderStreams, DEFAULT_RETRY_POLICY } from "./provider/dialect.ts";
export type { Dialect, RetryPolicy } from "./provider/dialect.ts";
export { lazyApi, lazyStream } from "./provider/lazy.ts";
export {
  openAiDialect,
  kimiProvider,
  deepseekProvider,
  openaiProvider,
  zaiCodingProvider,
  minimaxProvider,
  OPENAI_COMPLETIONS_API,
} from "./provider/openai.ts";
export type { OpenAiDialectOptions, BuiltinProviderOptions } from "./provider/openai.ts";
export type {
  Credential,
  CredentialStore,
  Model,
  ModelCapabilities,
  ModelCost,
  Provider,
  ProviderAuth,
  ProviderStreams,
  StreamFn,
  StreamOptions,
  ThinkingLevel,
} from "./provider/types.ts";

/* ───────────── 写工具：最常见的扩展，留在门口 ───────────── */

export { toolOk, toolError, isModelTool, isModelVisible, toolSchemas } from "./tools/types.ts";
export type {
  AgentTool,
  AgentToolResult,
  InternalTool,
  McpTool,
  ModelTool,
  ToolExecutionContext,
} from "./tools/types.ts";

/* ───────────── hooks：`AgentOptions.hooks` 收的就是它 ───────────── */

export { HookRuntime, INTERCEPTABLE, isInterceptable } from "./hooks/runtime.ts";
export type {
  ExternalHookConfig,
  ExternalRunner,
  HookContext,
  HookHandler,
  HookHandlerReturn,
  HookResult,
  HookRuntimeOptions,
  HookWorkset,
  InterceptableType,
  Interception,
  LifecycleEventListener,
  NotifyOnlyType,
  Patchable,
} from "./hooks/runtime.ts";

/* ───────────── permission：§14.10.3 固定 stage 的公共词汇（`AgentOptions.permission` 收的就是 PermissionPolicy） ───────────── */

export type {
  PermissionAnswer,
  PermissionAnswerResult,
  PermissionAsk,
  PermissionAskHandle,
  PermissionAuthorizeInput,
  PermissionAuthorizer,
  PermissionPolicy,
  PermissionPolicyConfig,
  PermissionSettlement,
  PermissionStage,
  PermissionVerdict,
} from "./permission/types.ts";

/* ───────────── 状态与 options 的词汇：**类型在这里，值在子路径** ───────────── */

// 端口：调用方自己实现或从子路径拿默认件
export type { StorageDir } from "./storage/types.ts";
export type { Lease, StateLock } from "./storage/lock.ts";
export type { AgentMcpPort, McpConnectOutcome, McpServerSnapshot } from "./mcp/port.ts";
export { PROMPT_ORDER, type AssembleContext, type PromptSection, type PromptSource, type PromptVariable } from "./prompt/types.ts";
export { PromptVariableError } from "./prompt/assemble.ts";
export { sectionFromMarkdown } from "./prompt/import.ts";
export { fenceSafe, truncateMarked } from "./prompt/sanitize.ts";

// 各能力的容器类型——它们出现在 `AgentOptions` / `AgentState` 的签名里
export type { AgentMemories } from "./memory/harness.ts";
export type { AgentSchedule } from "./schedule/harness.ts";
export type { InboxStore } from "./inbox/store.ts";
// §14.2.4：durable ingress 的公共协议（`agent.ingress` 的类型）与两份持久 schema。
// `DurableDeliveryDeferred` 是 Host-internal 的 adapter 转接口，**不出**。
export type { DurableDeliveryRequest, DurableDeliveryResult, DurableIngressPort } from "./inbox/ingress.ts";
export type { InboxBatchAckCommitV1, InboxRecordV1 } from "./inbox/records.ts";
/**
 * 会话的语义所有者。**值导出**（2026-09-01）：产品要在装配前挑「续哪一段」（`--continue`），
 * 得自己在状态根的 `FileDir` 上开一个实例调 `list()`——列表归 core，不让产品各自扫 meta 文件。
 */
export { SessionService } from "./session/service.ts";
export type { AgentBackground, BackgroundLimits } from "./background/types.ts";
export type { ActiveSkill, Skill, SkillActivation, SkillCreation } from "./skill/types.ts";
export type { SessionData, SessionEntry, SessionInfo, SessionManager, SessionStore } from "./session/types.ts";
export type {
  TaskBrief,
  TaskCreateResult,
  TaskDerived,
  TaskFilter,
  TaskGraph,
  TaskItem,
  TaskLink,
  TaskLinkResult,
  TaskPatch,
  TaskSnapshot,
  TaskSpec,
  TaskStatus,
  TaskStore,
  TaskView,
  TaskWriteResult,
} from "./task/types.ts";

// `prompt()` 的返回值与它认的几个配置形状
export type { AgentContext, LoopCompactionConfig, LoopResult, TransformContext } from "./loop/types.ts";
/* 压缩（2026-09-02）：状态与阶段契约给写策略的人；视图与估算给他们算字节；缺省阶梯与 prompt 给想改一段的人 */
export {
  COMPACTION_SLACK_RATIO,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_SECTION_TOKENS,
  EMPTY_COMPACTION,
  isEmptyCompaction,
} from "./compaction/types.ts";
export type {
  CompactionBudget,
  CompactionInput,
  CompactionModelCall,
  CompactionOptions,
  CompactionReason,
  CompactionSpan,
  CompactionStage,
  CompactionState,
} from "./compaction/types.ts";
export {
  assertCompactionFits,
  buildWorkingMessages,
  clearedNotice,
  estimateText,
  estimateTokens,
  isLegalCut,
  isTurnStart,
  measureContext,
  normalizeCompaction,
  omissionNotice,
  projectRange,
  sameCompaction,
  snapBack,
  snapForward,
} from "./compaction/view.ts";
export type { ContextAnchor } from "./compaction/view.ts";
export {
  COLLAPSE_INSTRUCTION,
  COLLAPSE_MAX_SECTIONS,
  COLLAPSE_SYSTEM,
  OVERFLOW_KEEP_TOKENS,
  SUMMARY_INSTRUCTION,
  SUMMARY_SYSTEM,
  chooseTailStart,
  collapseStage,
  defaultCompactionStages,
  frameFull,
  frameSection,
  snipStage,
  stripAnalysis,
  summaryStage,
  toolResultsStage,
} from "./compaction/builtin.ts";
export type { CompactionPackConfig } from "./compaction/builtin.ts";
export { TRANSCRIPT_READ_TOOL, renderTranscript, transcriptReadTool } from "./compaction/tool.ts";
export type { TranscriptReadParams } from "./compaction/tool.ts";
// §14.2.3：steer / followUp 的显式结果（accepted 或带原因的 rejected；不抛、不静默入队）
export type { FollowUpResult, SteerResult } from "./loop/intake.ts";
// §14.2.4：run admission 的 host port 面——request / ticket / result / execute scope，与每次 admission 冻结的 model seam。
// RunPermit、StandaloneRunAdmission、失败规范化是 Host 私有，不出。
export type {
  AgentAdmissionExecuteScope,
  AgentAdmissionPort,
  AgentAdmissionResult,
  AgentAdmissionTicket,
  AgentInternalRunRequest,
  ModelSnapshotValue,
  RunModelBinding,
  RunModelSnapshot,
  RunSource,
} from "./admission/types.ts";
export { normalizeModelSnapshot, ModelSnapshotError } from "./admission/model-snapshot.ts";

// §15.6（OR14）：构造期只读观测口——consumer seam，不暴露 canonical writer / identity / 查询 / renderer。
// `agentEventTapFor(tap)` 把它接到 `AgentOptions.observationTap`（O1a 的被动 tap 接缝）。
export type { EngineObservationFact, EngineObservationScope, EngineObservationTap } from "./observability/engine-tap.ts";
export { agentEventTapFor } from "./observability/agent-events.ts";

/* ───────────── 落盘：node-only 的 first-party 默认件 ───────────── */

/** 真盘的 `StorageDir` 实现（`node:fs` / `node:os` / `node:path`）。`expandHome` 是 `ECHO_HOME=~/x` 的展开——凭据与设置文件共用同一条根解析规则。 */
export { FileDir, echoHome, expandHome } from "./storage/file-dir.ts";

/**
 * 落盘的 `CredentialStore`：`$ECHO_HOME/credentials.json`（0600，跨 agent 共享）。
 * 端口 `CredentialStore` 与内存实现 `InMemoryCredentialStore` 在上半段。
 */
export { FileCredentialStore, CREDENTIALS_FILE } from "./provider/file-credentials.ts";

/** first-party 的 single-writer 文件锁（`node:fs`）。端口 `StateLock` 本身是纯的，在上半段。 */
export { fileStateLock, inspectStateLock } from "./storage/file-lock.ts";
export type { PeekedLockRecord, StateLockInspection } from "./storage/file-lock.ts";

/**
 * **两个使用高度，一个 composition root**（§14.2）：
 *   - 高 = `createEcho()`，**唯一**的装配现场；
 *   - 低 = `new Agent()`，自己给端口、自己注册工具。
 *
 * `createAgent` **不在公共面上**（2026-08-31 收）：它曾经是第二个 composition root，
 * 与 §14.2 的标题「一个包、两个使用高度、**一个** composition root」直接冲突。
 * 现在它降为 `create-agent.ts` 里的内部装配函数，只有 `createEcho()` 调它。
 * 模型解析与状态根解析这两个纯函数仍然导出——它们是**判据**不是装配现场，
 * 消费方（Runner / 测试）要先算出 `stateDir` 或校验模型 id 时用得上。
 */
export { resolveModel, resolveStateDir } from "./create-agent.ts";
export {
  createEcho,
  discoverExtensionFiles,
  loadExtensionFile,
  resolveExtensionDirs,
  ExtensionLoadError,
  EXTENSIONS_DIR,
} from "./create-echo.ts";
export type { CreateEchoOptions, Echo, LoadedExtension } from "./create-echo.ts";

/** skill 加载器：扫目录读文件（`node:fs/promises`）。skill 的形状与操作是纯的，在上半段。 */
export { loadSkills, loadSkillsFromDir, SKILL_ENTRY_FILE } from "./skill/loader.ts";
export type { LoadedSkills } from "./skill/loader.ts";
