// `@echo-agent/core/engine` —— **Web-standard 公共面**。设计真相源：docs/design/AGENT-CORE.md §13（D9 / D16）。
//
// 边界一句话：**Agent 管机制，用户换策略与基础设施**（§13.3）。
// 本入口额外多一条约束：**只有不拖 `node:` 的那部分**——落盘默认件在根入口。
//
// **与根入口 `.` 的差别只有落盘那几件**（2026-08-17 实测，不是估计）：整个 `src/` 里直接
// import `node:` 的只有三个文件——`storage/file-dir.ts`、`skill/loader.ts`、`task/fs.ts`——
// 而它们**只被入口引用**，没有任何能力模块依赖它们。于是规则很简单：
// **本入口 = 根入口减掉前两个文件的导出**（`task/fs.ts` 早已住在自己的子路径 `./task/fs`）。
// 具体是哪些符号、各有多少，查 `test/api-snapshot.txt`——那份是脚本生成的，这里不复述。
//
// 这条纯度不是注释里的一句承诺：`test/engine-purity.test.ts` 从**本文件**出发遍历模块闭包，
// 拒绝 `node:` / 裸内建 / 未登记的裸运行时依赖，并且换 `lib` 重新类型检查（DOM 与 WebWorker
// 各一套），连 `process.cwd()` 这种不 import 任何东西的宿主全局都会判红。
//
// ## 这一层放什么（2026-08-24 收窄，§13.5 / D13）
//
// **只放「完整 Agent 的创建、命令、状态和事件」**，外加两类必需词汇：
// 配 provider 的（`createAgent({ provider })` 是唯一必填项）与写工具的（最常见的扩展）。
//
// **能力的构造器与操作面下沉子路径**。判据是 §13.5 那句：「普通用户不 import 这些子路径
// 也已经得到工作的默认能力，**只有替换默认件或开发扩展时才进入子路径**」。
//
// **现在真的存在的只有四条**：`@echo-agent/core/tools` · `/task` · `/skill` · `/background`
// （以 `package.json#exports` 为准，那才是外部开发者能 import 的东西）。
// `memory` / `schedule` / `storage` / `session` / `inbox` 五类**目前不在公共面**——
// 子路径建了又撤，因为「exports 表无死条目」判红：它们眼下没有任何消费者。
// 别在这里写成「已经下沉」——那是**承诺一个不存在的扩展面**，外部开发者照着文档 import
// 会直接失败（2026-08-24 review 点出，此前这段就是这么写的）。
// 什么时候开：`docs/ISSUES.md` 的 `OSS-3b`——先写替换实现的 conformance（它必须 import
// 那些构造器才写得出来），子路径随之有了正当消费者，再开放稳定入口。**顺序不能反。**
//
// 留在这里的能力**类型**（`AgentMemories` / `AgentSchedule` / `TaskSnapshot` …）不是例外：
// 它们出现在 `AgentOptions` 与 `AgentState` 的签名里，**读状态就得念得出它们的名字**。
// 值（怎么造、怎么改）才是子路径的事。
//
// 往这里加导出前先问两件：① 它的闭包会不会拖进 `node:`？② 它是「用 agent」还是「造零件」？
// 后者放子路径。
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
export type { PromptSection, PromptSource, PromptTier } from "./prompt/types.ts";

// 各能力的容器类型——它们出现在 `AgentOptions` / `AgentState` 的签名里
export type { AgentMemories } from "./memory/harness.ts";
export type { AgentSchedule } from "./schedule/harness.ts";
export type { InboxStore } from "./inbox/store.ts";
// §14.2.4：durable ingress 的公共协议（`agent.ingress` 的类型）与两份持久 schema。
// `DurableDeliveryDeferred` 是 Host-internal 的 adapter 转接口，**不出**。
export type { DurableDeliveryRequest, DurableDeliveryResult, DurableIngressPort } from "./inbox/ingress.ts";
export type { InboxBatchAckCommitV1, InboxRecordV1 } from "./inbox/records.ts";
export type { SessionService } from "./session/service.ts";
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
export type { AgentContext, CompactionConfig, LoopResult, TransformContext } from "./loop/types.ts";
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

// §15.6（OR14）：`/engine` 的构造期只读观测口——consumer seam，不暴露 canonical writer / identity / 查询 / renderer。
// `agentEventTapFor(tap)` 把它接到 `AgentOptions.observationTap`（O1a 的被动 tap 接缝）。
export type { EngineObservationFact, EngineObservationScope, EngineObservationTap } from "./observability/engine-tap.ts";
export { agentEventTapFor } from "./observability/agent-events.ts";
