// Agent 类：状态的唯一所有者。设计见 docs/design/AGENT-CORE.md §2。
//
// 为什么是类不是函数（三条，函数形态给不出）：
//   ① 生命周期跨越多次调用——`streamingMessage` / `pendingToolCalls` 这些「正在发生什么」
//      在函数里无处安放，UI 也就永远拿不到逐字流。
//   ② 状态需要唯一所有者——`apply` 私有，「状态只能被事件改」从纪律升级成**结构保证**。
//   ③ 决策点需要具名外露——convertToLlm / transformContext / streamFunction / hooks
//      是公共可替换字段：上层换行为不改内核，评测塞假 streamFn 就能跑。

import { redactedLabel } from "./observability/redact.ts";
import { errText, type AgentError } from "./errors.ts";
import type { AgentEvent, AgentEventInput, AgentListener, AgentOutcome } from "./events.ts";
import { observationHostOf } from "./observability/host-wiring.ts";
import { builtinOwner, MEMORY_ENTRY_ID, SCHEDULER_ENTRY_ID, TASKS_ENTRY_ID, type ObservationRuntime } from "./observability/runtime.ts";
import { memoryFactDescriptor } from "./memory/observe.ts";
import { attachTaskObserver, taskFactDescriptor } from "./task/observe.ts";
import { scheduleFactDescriptor } from "./schedule/observe.ts";
import type { CapabilityFactSink } from "./observability/fact-sink.ts";
import { ObservationStoreUnavailableError } from "./observability/store.ts";
import type { EchoObservableState, RuntimePhase } from "./observability/types.ts";
import { HookRuntime, type HookContext, type LifecycleEventListener } from "./hooks/runtime.ts";
import { PermissionLedger, normalizeVerdict } from "./permission/ledger.ts";
import type { PermissionAnswer, PermissionAnswerResult, PermissionPolicy, PermissionStage } from "./permission/types.ts";
import {
  defaultConvertToLlm,
  userMessage,
  type AgentMessage,
  type ContentBlock,
  type ConvertToLlm,
  type ImageBlock,
  type Usage,
} from "./messages.ts";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./provider/dialect.ts";
import type { Model, StreamFn, ThinkingLevel } from "./provider/types.ts";
import { runAgentLoop, runAgentLoopContinue } from "./loop/run-loop.ts";
import { RunIntakeGate, type FollowUpResult, type IntakeLeftovers, type SteerResult } from "./loop/intake.ts";
import { StandaloneRunAdmission } from "./admission/standalone.ts";
import { normalizeModelSnapshot } from "./admission/model-snapshot.ts";
import type { AgentAdmissionExecuteScope, AgentAdmissionResult, AgentAdmissionTicket, RunModelBinding, RunSource } from "./admission/types.ts";
import type { AgentContext, AgentLoopConfig, LoopResult, TransformContext } from "./loop/types.ts";
import { EMPTY_COMPACTION, type CompactionOptions, type CompactionStage, type CompactionState } from "./compaction/types.ts";
import { defaultCompactionPack } from "./compaction/builtin.ts";
import { clampCalibration, runCompaction, type CompactionOutcome } from "./compaction/pipeline.ts";
import { buildWorkingMessages, estimateText, estimateTokens } from "./compaction/view.ts";
import type { CompactResult } from "./extension/runtime.ts";
import type { SessionEntryInput, SessionService } from "./session/service.ts";
import type { SessionPhase } from "./session/status.ts";
import type { Lease, StateLock } from "./storage/lock.ts";
import { InboxAckError, InboxStore } from "./inbox/store.ts";
import { systemClock, type Clock } from "./schedule/clock.ts";
import { environmentDedupeKey, scheduleDedupeKey } from "./inbox/records.ts";
import { stateHostOf } from "./state/host-wiring.ts";
import { DurableDeliveryDeferred, type DurableDeliveryRequest, type DurableDeliveryResult, type DurableIngressPort } from "./inbox/ingress.ts";
import {
  disposeMemory,
  dreamTask,
  markDreamed,
  memoryObserver,
  memoryPromptSections,
  memoryTool,
  shouldDream,
  type AgentMemories,
} from "./memory/harness.ts";
import {
  disposeSchedule,
  loadSchedule,
  settleTick,
  startSchedule,
  stopSchedule,
  type AgentSchedule,
} from "./schedule/harness.ts";
import { makeScheduleTools } from "./schedule/tools.ts";
import { assembleSystem } from "./prompt/assemble.ts";
import { PROMPT_ORDER, type AssembleContext, type PromptSection, type PromptSource, type PromptVariable } from "./prompt/types.ts";
import { newSessionId } from "./session/types.ts";
import { toolError, type AgentTool, type AgentToolResult } from "./tools/types.ts";
import { activeTools, registerTool, registerTools, resolveTool, toolSchemasOf, type ToolMap } from "./tools/harness.ts";
import type { Diagnostic } from "./errors.ts";
import type { StorageDir } from "./storage/types.ts";
import type { ResourceChange } from "./events.ts";
import { addSkills, listActiveSkills, type ActiveSkillMap, type SkillMap } from "./skill/harness.ts";
import { makeSkillTools } from "./skill/tools.ts";
import { renderSkillCatalog, renderSkillInjections } from "./skill/compose.ts";
import type { ActiveSkill, Skill } from "./skill/types.ts";
import { parseSkillText, roundTripError, serializeSkill, skillEntryPath, skillNameOfEntry } from "./skill/format.ts";
import type { AgentMcpPort, McpServerSnapshot } from "./mcp/port.ts";
import { killAllBackground } from "./background/harness.ts";
import type { AgentBackground, BackgroundLimits } from "./background/types.ts";
import { createTasks, loadTasks, saveTasks, taskSnapshot, type TaskMap } from "./task/harness.ts";
import { makeTaskTools, taskInjections } from "./task/tools.ts";
import type { BuiltinToolGroups } from "./extension/builtin.ts";
import type { TaskItem, TaskSnapshot, TaskSpec, TaskStore } from "./task/types.ts";

export type AgentStatus = "idle" | "generating" | "acting" | "compacting";

/**
 * 多久重扫一次自己的 inbox 目录（毫秒）。**不做成参数**：它是「别的进程写进来的消息多快被看见」的
 * 下限，不是要按部署调的旋钮。一秒对「另一段 session 发来一句话」这个场景足够快，
 * 对盘的负担也只是一次目录列举。要更快就由宿主装 watcher 主动调 `consumeInbox()`。
 */
const INBOX_POLL_MS = 1_000;

export type AgentState = {
  /* 装备（慢变；仅 idle 可换） */
  readonly model: Model;
  /** **工作集**：本轮摆给模型的工具。池在 `agent.tools.list()`——读取时从 harness 算出的派生视图。 */
  readonly tools: readonly AgentTool[];
  readonly thinkingLevel: ThinkingLevel;
  /* 对话：唯一真源，只 push */
  readonly messages: readonly AgentMessage[];
  /**
   * **工作集**：本轮实际在用的 skill（激活的那些），不是池。
   * 池在 `agent.skills.list()`——两层模型：注册进来几百个，这一轮只摆一部分给模型。
   * 读取时从 harness 算出来（派生视图，不是第二份存储）。
   */
  readonly activeSkills: readonly ActiveSkill[];
  /** 接了哪些 MCP 服务器、各自什么状态、给了哪些工具。派生视图；未装端口时恒空。 */
  readonly mcp: readonly McpServerSnapshot[];
  /**
   * 任务清单的投影：总数、按状态计数、当前可做的、正在做的。派生视图。
   * 全图在 `agent.tasks.graph()`——与 `tools` 只给工作集同一个口径。
   */
  readonly tasks: TaskSnapshot;
  /* 运行态（易失；idle 时归零） */
  readonly status: AgentStatus;
  readonly startedAt: number | null;
  readonly iteration: number;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly retryCount: number;
  /**
   * 压缩状态（`compaction/types.ts`）：作用在 `messages` 上的视图——messages 永远全量原文，送模时按它投影。
   * 运行时与盘上同一个形状、同一套下标；只有压缩流水线（compaction_end）会改它。
   */
  readonly compaction: CompactionState;
  /**
   * 当前送模上下文大约多大（token）：每轮以 provider 报的 usage 刷新，压缩后以估算刷新；null = 还没有过任何依据。
   * 状态栏的「上下文占用」读它配 `model.capabilities.contextWindow`。
   */
  readonly contextTokens: number | null;
  readonly lastError: AgentError | null;
  readonly usage: Usage;
  /* 会话指针：指向盘上那段；null = 未落盘的临时对话 */
  readonly sessionId: string | null;
  /**
   * 这个 session 在哪个目录里干活：文件工具的边界与起点、`{{workspace}}`。
   * **session 级事实**（2026-09-01）：新建 session 时由宿主给，resume 时以盘上为准。
   */
  readonly workspace: string;
};

type MutableAgentState = { -readonly [K in keyof AgentState]: AgentState[K] };

export type AgentOptions = {
  model: Model;
  streamFunction: StreamFn;
  tools?: AgentTool[];
  thinkingLevel?: ThinkingLevel;
  maxIterations?: number;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  maxRetryDelayMs?: number;
  /** 压缩：触发阈值、内建阶梯的参数、要不要内建那组（`compaction/types.ts`）。策略本身经 `AgentCompaction` registry 注册。 */
  compaction?: CompactionOptions;
  toolExecution?: "sequential" | "parallel";
  convertToLlm?: ConvertToLlm;
  transformContext?: TransformContext;
  hooks?: HookRuntime;
  /**
   * 授权策略（§14.10.3 固定 stage）。不给 = 全部放行（低层 Agent 的默认）。
   * `askTimeoutMs:null` 时必须显式声明 `responder`（"host" = 宿主会 `subscribeLifecycle()` 后回答；
   * "none" = 诚实缺席，ask 当 policy deny）——两者都不给，构造期 fail-loud。
   */
  permission?: PermissionPolicy;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  sessionId?: string;
  /**
   * 工作目录的**缺省值**：纯内存 agent 直接用它；有 session 时它只在**新建** session 那一刻写进
   * `SessionInfo.workspace`，resume 以盘上为准。宿主给绝对路径；不给就是 "/"——
   * **不用 process.cwd()**：core 是纯 JS（零 `node:` import），要能在浏览器 / Worker / 边缘运行时里跑，
   * 工作目录是宿主知识，core 自己从不解释它，只透传给工具与 prompt。
   */
  workspace?: string;
  /** 初始 skill（加载器扫盘产出的那些）。装进来只是「可用」，**不激活**。 */
  skills?: Skill[];
  /**
   * skill 的持久化端口（D3：端口收窄成与 `StorageDir` 同形的**字节面**，语义进 core）。
   * 它是 `skills/` 这一层目录的视图：Agent 在里面按生态的目录式布局读写 `<name>/SKILL.md`
   *（格式在 `skill/format.ts`），**发现**在 `start()`（§13.6「发现 Skills」），
   * **落盘**在 `skill_create` 工具路径上、经单写者租约门。
   *
   * 给了它，Agent 就自己装 `skill_activate` + `skill_create` 两件（池随时会长出来，
   * 「零 skill 别装」的教训针对的是没有 create 的 agent）；不给 = 不支持创建，
   * 构造期池非空时只装 activate（老规矩）。
   *
   * `createAgent` 用状态根的 `skills/` 前缀视图接它；要自己的存法走低层 `new Agent()`。
   * 撞名先到先得 + 诊断（构造期 `skills` 先进池，显式传的赢过发现的）。
   */
  skillStore?: StorageDir;
  /** 初始任务清单。 */
  tasks?: TaskSpec[];
  /**
   * 任务清单的落盘端口。不传 = 纯内存（清单仍在，只是不跨进程）。
   * 文件实现走 `@echo-agent/core/task/fs`。**`loadTasks()` 不自动调**——与 `connectAllMcp()` 同款仪式。
   */
  taskStore?: TaskStore;
  /**
   * MCP 端口。不传 = 本 agent 不认识 MCP（`agent.mcp` 为 `undefined`，`state.mcp` 恒空）。
   * 实现在 `@echo/mcp`——服务器配置、传输、超时都是**它**的词汇，core 不认识。
   * **装配 ≠ 连接**：`await agent.mcp?.connectAll()` 才连。
   */
  mcp?: AgentMcpPort;
  /** 后台任务的闸（并发 8 / 总量 64 / 每任务 64k）。 */
  backgroundLimits?: BackgroundLimits;
  /**
   * 持久记忆。**不传 = 没有记忆**，agent 照跑——记忆是「跨任务变好」，不是「本次任务能完成」。
   * 传了 = 三件自动接线：memory 工具与记忆段交给 `echo:memory` builtin 注册、每次 run 把记忆段拼进
   * system 快照（冻结快照：run 内写盘立即可读，system 下个 run 才刷新）、dispose 链。
   */
  memory?: AgentMemories;
  /**
   * 定时任务。不传 = 没有闹钟能力。传了 = attach + 注册三个内核工具
   * （schedule_create/list/cancel）+ dispose 链（内含 stop，不留野定时器）。
   * **不自动 start**——「agent 会自己醒」是强行为，`agent.schedule.start()` 显式开。
   */
  schedule?: AgentSchedule;
  /**
   * 回到 idle 时自动消费 inbox（外面发生的事 → 自动开一轮）。
   *
   * **缺省关**：「agent 会自己醒来」是很强的行为，应当显式打开。
   * 评测与一次性跑天然是关的；常驻 agent 显式开——**这就是「常驻」在机制上的全部区别**。
   */
  autoConsumeInbox?: boolean;
  /**
   * 回到 idle 时自动跑 Dream（记忆整理）。**缺省关**，理由同 `autoConsumeInbox`——
   * 「agent 会自己整理记忆」是很强的行为。`createAgent` + `start()` 会打开它（D4/C6）。
   *
   * 门控本身在 `shouldDream()`：间隔、写入数、轮数、文件数四道，全满足才跑。
   */
  autoDream?: boolean;
  /**
   * 会话的语义所有者（D3）。传了 `start()` 才会 create-or-resume；不传 = 不做会话持久化。
   * 注入的 store 就是**这一段 session 的目录**（2026-09-03：状态根 = session 目录）。
   */
  sessionService?: SessionService;
  /**
   * 状态根的单写者资格（D6）。传了 `start()` 会取 lease，**拿不到就 fail-loud**；
   * 丢锁时按 §13.12.3 的四步收场。不传 = 不做互斥（评测与一次性跑天然如此）。
   */
  stateLock?: StateLock;
  /**
   * 时间与定时器（`schedule/clock.ts` 的端口）。不给用真时钟；测试给 `FakeClock` 才能零 sleep 地驱动
   * inbox 轮询。**Agent 自己只用它做一件事**：定期重扫 inbox 目录（见 `INBOX_POLL_MS`）。
   */
  clock?: Clock;
  /** agent 身份（D5，缺省 `"default"`）。目前只用于 lease 的 holder 标识。 */
  agentId?: string;
  /**
   * 会话归属名（2026-09-01 用户拍板：会话身份 = workspace + agent）。写进每个新建会话的
   * `SessionInfo.agent`；产品（`echo-agent` / `echo-coding`）各给各的名字，同一目录里就各有各的对话。
   * 缺省与 `agentId` 相同——低层用户不区分产品时，一个状态根一个名字。
   */
  agentName?: string;
  /**
   * inbox 的持久面（§13.9 第 10 条）。传了 = 投进来的入站事实先落盘，
   * run 结束后才删；**崩在半路的会在 `start()` 时重放**。不传 = 纯内存（崩了就丢）。
   */
  inboxStore?: InboxStore;
  /** 跟 agent 一起收摊的东西。agent 只在 dispose 时调它们，**不解释它们干什么**。 */
  disposables?: readonly { dispose(): Promise<void> }[];
  /**
   * **最后才收的**：`disposables` 全部 settle 之后，逐个串行跑。
   *
   * 为共享资源准备的。装配层（`createAgent`）把一个 `StorageDir` 同时交给
   * Memory / Schedule / Tasks / Inbox / Session，那它就该由**装配层唯一持有并关闭一次**：
   * 放进 `disposables` 会和 `saveTasks()` 并发（可能写还没完就关了），
   * 让各个 harness 自己关则会**并发关两次**（`StorageDir.close()` 的契约没要求幂等，
   * 注入一个第二次关闭就报错的合法实现，默认 `agent.stop()` 当场失败——实测）。
   */
  finalDisposables?: readonly { dispose(): Promise<void> }[];
};

type ActiveRun = { promise: Promise<void>; resolve: () => void; abortController: AbortController };
/** 拿到 permit 之后真正跑循环的那段：scope 给 runId / binding，signal 是本 Agent 的（scope 的 abort 会级联进来）。 */
type RunExecutor = (scope: AgentAdmissionExecuteScope, signal: AbortSignal) => Promise<LoopResult>;

/**
 * `prompt()` / `continue()` 的返回：LoopResult 加上 admission 分配的 `runId`——完整 Runtime 的 `send()` 靠它把
 * outcome 与 RunObservation 关联（§15.6 `EchoRunResult`）。纯增量：期望 `LoopResult` 的调用方照旧可用。
 */
export type AgentRunResult = LoopResult & Readonly<{ runId: string }>;

/** `_state.tasks` 只是占位——真值在 `get state()` 里从 harness 现算（派生视图，不存第二份）。 */
const EMPTY_TASK_SNAPSHOT: TaskSnapshot = { total: 0, counts: {}, ready: [], active: [] };

export const DEFAULT_MAX_ITERATIONS = 20;

/**
 * `deliver()` 与 schedule adapter 的 dedupeKey 派生：有稳定事实身份（environment 的 source + ref，比如
 * schedule incarnation、background 任务 id）就用它；**没有自然身份的每次都生成唯一 UUID**——那等价于
 * 主动关闭跨调用去重，比复用一个固定常量诚实（后者会让互不相干的事实互相吞掉）。
 */
function dedupeKeyOf(message: AgentMessage): string {
  if (message.role === "environment" && typeof message.ref === "string" && message.ref !== "") {
    return environmentDedupeKey(message.source, message.ref);
  }
  return `delivery:${crypto.randomUUID()}`;
}

const NO_LEASE_MESSAGE =
  "本 agent 没有持有状态根的单写者租约（还没 start()，或者租约已经丢失）。";

/**
 * 一笔任务落盘的结局。**「取消」不是「成功」**——盘上什么都没有，调用方不许把它当写完了
 * （2026-08-24 第三轮 review：上一版两者都是 resolve，于是丢锁之后工具照样回执成功）。
 * 真正的写失败走 rejection，不在这个联合里。
 */
type TaskWriteOutcome = "written" | "cancelled";

/**
 * 会通知的 `TaskMap`。**唯一目的**：让「谁改了任务清单」这件事有一个统一的出口，
 * 而不是只有那四个内核工具被包了一层。
 *
 * 它是 `Map` 的子类而不是新接口——`TaskMap` 就是 `Map<string, TaskItem>`，
 * `createTasks()` / `updateTask()` / `removeTask()` / `loadTasks()` 全都直接对它 `set`/`delete`，
 * 换个子类它们一行都不用改，也不会有第二种「任务清单」的类型在公共面上。
 */
class ObservedTaskMap extends Map<string, TaskItem> {
  /** 由 Agent 在构造期接上；在此之前（字段初始化顺序）改动不通知，那时也还没有 store。 */
  onChange: () => void = () => {};

  override set(key: string, value: TaskItem): this {
    super.set(key, value);
    this.onChange();
    return this;
  }

  override delete(key: string): boolean {
    const removed = super.delete(key);
    if (removed) this.onChange();
    return removed;
  }

  override clear(): void {
    const had = this.size > 0;
    super.clear();
    if (had) this.onChange();
  }
}

export class Agent {
  private _state: MutableAgentState;

  /* ── agent 拥有的东西。**就是数据本身**，没有包装类型、没有 store 中间层
        （2026-08-05 用户拍定）。操作它们的方法在各自的 `xxx/harness.ts` 里，
        都是纯函数：`registerTool(agent.tools, t)`、`activateSkill(agent.skills, agent.activeSkills, "h5")`。 ── */
  /** 工具池。「能用 / 禁用」是工具自己的状态（`tool.disabled`），不外挂。 */
  readonly tools: ToolMap = new Map();
  /**
   * 内建能力**造好但尚未注册**的工具，按 §14 owner 表分四组。
   *
   * **Host-internal**：装配层（`createEcho`）拿它去 mount `echo:*` builtin Extension，
   * 由那条路经 `AgentTools.register` 注册。低层 `new Agent()` 的用户看到它是空注册状态——
   * 要工具就自己 `registerTool()`，或者走 `createEcho()`。
   * 不进 `AgentState`：它是装配期的一次性交接，不是运行态。
   */
  readonly builtinTools: BuiltinToolGroups;
  /** skill 池：装进来的全部。 */
  readonly skills: SkillMap = new Map();
  private readonly skillStore?: StorageDir;
  /** skill 工作集：激活的那些（Map 保插入序 = 激活顺序）。 */
  readonly activeSkills: ActiveSkillMap = new Map();
  /** 后台活动的一整包（任务表 + 回调 + 闸）——传给 `startBackground(agent.background, spec)`。 */
  readonly background: AgentBackground;
  /**
   * 任务清单。**改它就会落盘**——`ObservedTaskMap` 把每一次 `set`/`delete`/`clear` 挂到
   * `schedulePersistTasks()` 上。此前只有那四个内核工具被包了一层，于是公开的
   * `createTasks()` / `updateTask()` 直接改 map 时要一直等到 `stop()` 才写回去，
   * 与「Task 变化由 Agent 自动持久化」这句话不符（2026-08-24 review 的第 1 条）。
   */
  readonly tasks: TaskMap = new ObservedTaskMap();
  private readonly listeners = new Set<AgentListener>();
  private seq = 0;

  /* 三条队列，消费时机各不相同（分界见 §5B）：
     steering —— 人/hook 放，**内层轮末**消费：「顺便注意一下 X」，不打断，并入当前任务
     followUp —— 人/hook 放，**内层收尾后、同一次 run 内**：「这件做完接着做下一件」
     inbox    —— **环境**放（后台结束、定时到点、webhook），**回 idle 后开新的 run**：「外面发生了一件事」
     前两条是「同一个任务里的追加」，inbox 是「一个新任务的由头」。
     定时投递不单设队列——它就是「延时往 inbox 塞一条」，定时器归产品。 */
  /** steering / followUp 两条队列住在 RunIntakeGate 里：裁决与入队同一同步步（§14 RunIntakeGate）。 */
  private readonly intake: RunIntakeGate;
  /** run admission（§14.2.4）：prompt / continue / Inbox / Dream 都经它取 permit；单 permit、前台高于 Dream。 */
  private readonly admission: StandaloneRunAdmission;
  /** 用户 run 从 enqueue 到 settle 之间：prompt() 的重入检查要看它（permit 落位之前 activeRun 还是空）。 */
  private userRunPending = false;
  /**
   * run 的终态：在 processEvents 应用 agent_end 那一刻锁存（**早于任何可能抛错的 listener / 持久化**），
   * callback 之后再抛，normalizer 复用它、不发第二个 agent_end。只在 executor 返回后才写会漏掉「agent_end 已应用、
   * listener 随后抛、executor 因此 reject」这条路（实测 ends === 2）。
   */
  private readonly terminalByRun = new Map<string, LoopResult>();
  /** 本 run 开始时 transcript 的长度：锁存终态时据此切出「本次新增的消息」。 */
  private runMessagesBefore = 0;
  private inboxTicketOutstanding = false;
  private dreamTicketOutstanding = false;
  /**
   * Inbox 账本裁决为 indeterminate 之后的**可见失败**（§14.2.4「进入可见 FAILED」）：
   * 账本已 seal，状态根处于无法裁决的状态——不再接新工作、不再消费 inbox，也不假装健康。
   * 只有重启（restore 重新裁决 marker）能解封，本进程不得自行重试。
   */
  private inboxFailure: Error | null = null;
  /** standalone 没有 catalog：model 换一次 revision +1，binding 固定到它。 */
  private catalogRevision = 0;
  /**
   * Inbox 账本（§14.2.4）：pending records、dedupe index、reservation ledger、batch-ack marker 的**唯一 owner**。
   * 装了持久 inbox 就是那一份；没装则是同一个类的纯内存模式——语义一致，只差写不写盘。
   */
  private readonly inbox: InboxStore;
  /**
   * Host-internal canonical writer（`attachObservationHost`，只有 `createAgent()` 会挂）：首次用到时从 WeakMap 解析，
   * 顺手把它的诊断接到本 Agent 的诊断通道。低层 `new Agent()` 没有它——那条路没有 journal，也没有观测面。
   */
  private observation: ObservationRuntime | undefined;
  private observationResolved = false;
  /** AgentEvent → bounded lane 的 sink（`factSinkToIngest(agentEventDescriptor)`），与 `observation` 同时解析。 */
  private observationSink: CapabilityFactSink<AgentEvent> | undefined;
  /** tap 的按 seq 释放缓冲（见 releaseToTap）。 */
  private tapNextSeq = 0;
  private readonly tapPending = new Map<number, AgentEvent>();

  /** 持久记忆的操作面：`agent.memory?.shouldDream()`。undefined = 本 agent 没有记忆。 */
  readonly memory?: AgentMemories;
  /** 定时任务的操作面：`agent.schedule?.start()`。undefined = 本 agent 没有闹钟。 */
  readonly schedule?: AgentSchedule;
  /** MCP 端口：`agent.mcp?.connectAll()`。undefined = 本 agent 没接 MCP。 */
  readonly mcp?: AgentMcpPort;
  /** 任务清单的落盘端口。不传 = 纯内存。 */
  readonly taskStore?: TaskStore;
  /** D3 的会话语义所有者。一个 Agent 实例 = 一段 session。 */
  private readonly sessionService?: SessionService;
  private readonly stateLock?: StateLock;
  private readonly clock: Clock;
  /** inbox 轮询的取消函数。非 undefined = 正在轮询（只有 running 才轮）。 */
  private inboxPollCancel?: () => void;
  private readonly agentId: string;
  /** 新建会话时写进 `SessionInfo.agent` 的名字（`AgentOptions.agentName`，缺省 = `agentId`）。 */
  private readonly agentName: string;
  /** 本代 Agent 的进程内身份：写入格与 RunIntakeGate 共用同一个。 */
  private readonly agentInstanceId: string;
  /**
   * 状态根写入总闸与 lease lifecycle port（§14.9 / §14.5，**Host-internal**）：由同包的 composition root 经
   * `attachStateHost()` 挂上，不进公共 `AgentOptions`。低层 `new Agent()` 没挂 = 不设闸。
   */
  private get gate(): import("./state/write-gate.ts").StateWriteGate | undefined {
    return stateHostOf(this)?.gate;
  }
  private get leaseLifecycle(): import("./state/lease-lifecycle.ts").StateLeaseLifecycle | undefined {
    return stateHostOf(this)?.leaseLifecycle;
  }
  /**
   * 装配现场转过来的所有权账本（§14.5.1）。**`stop()` 是排空它的唯一触发点**——
   * provider 侧只撤 slot metadata，不许再 dispose 同一个值。低层 `new Agent()` 没挂 = 没有账本要排。
   */
  private get adoption(): import("./assembly/ledger.ts").AdoptionLedger | undefined {
    return stateHostOf(this)?.adoption;
  }
  /** install 之后启动失败：写入格已 revoke，本实例作废（不能清空复用）。 */
  private startFencedError: Error | null = null;
  /** 跨进程可确认的入站口（§14.2.4）：`deliver()` 是它的 fire-and-forget 便捷面。 */
  readonly ingress: DurableIngressPort;
  /**
   * **在飞的 durable write**（inbox 落盘、任务清单落盘）。`stop()` 要等它们 settle，
   * 否则释放 lease 之后还在写状态根。
   */
  private readonly pendingWrites = new Set<Promise<unknown>>();
  /**
   * 任务落盘的**写链尾**。`enqueueTaskWrite()` 一律串在它后面——**single writer**。
   *
   * 上一版是「标脏 → microtask 里写一次」，而 `tasksDirty = false` 排在 `await` **之前**：
   * 于是第二次改动能立刻排出第二笔并发写，慢 Store 下新快照先落、旧快照后落，
   * 旧的把新的盖掉（2026-08-24 review 的第 2 条，用「第一笔阻塞、第二笔立刻完成」的
   * Store 确定性复现过）。串行之后这个窗口不存在。
   */
  private taskWriteTail: Promise<void> = Promise.resolve();
  /** 同一拍里排着、还没开始写的那一笔。自动挂钩与工具路径**共用**它——各排各的就是双写。 */
  private taskPending?: Promise<TaskWriteOutcome>;
  /** 最近一笔落盘的**真实结局**（失败会 reject）。`flushTasks()` 在没有排队时等它。 */
  private taskLastWrite?: Promise<TaskWriteOutcome>;
  /** 恢复期与收摊之后**不许**自动落盘：前者会把刚读进来的东西原样写回，后者 store 已经关了。 */
  private taskPersistSuppressed = false;
  /**
   * 丢锁后**永久**封死任务写面（`watchLease` 的第 ① 步「停止一切持久化」）。
   *
   * 与 `taskPersistSuppressed` 分开是因为语义不同：那个是「这一段先别写」（会复位），
   * 这个是「这个 Agent 再也不许写」——租约归了别人，新 holder 可能已经在写同一份文件。
   */
  private persistSealed = false;
  /**
   * 正在落盘、还没入队的 `(source, ref)` → **那次投递的结果**。去重的另一半（见 `deliverDurable()`）。
   *
   * 存 promise 不是存 key：撞上在飞的那次时要**跟着它一起等**，成败一并继承。
   * 只存 key、命中就 return 的话，第二个调用方会提前拿到「已接受」，
   * 而首个落盘随后失败时盘上其实什么都没有。
   */

  /** `start()` 取到的租约。`stop()` 释放它；丢锁时它已经不作数。 */
  private lease?: Lease;
  /** 丢锁后置真：拒绝一切新工作（§13.12.3 第 ③ 步）。 */
  private leaseLostError: Error | null = null;
  /**
   * 生命周期状态。**只有带持久化装配的 Agent 才受它约束**——低层 `new Agent()`
   * 不取锁、不恢复，`phase` 恒为 `"new"`，行为与从前一致。
   *
   * `stopped` 是**终态**：`stop()` 之后不能再 start，也不能再接受工作。
   * 没有这条时实测过：旧 Agent `stop()`、另一个 holder 拿到锁之后，
   * 旧 Agent 仍能写进两条 session message——**单写者当场破**。
   */
  /**
   * 生命周期相位（§14 的相位图）。仓库里一直叫 `running`，规格里那张图写的是 `active`——**同一个相位**，
   * 沿用既有词、不另造。O2d-2 新增两个：
   *   - `restored`：持有租约、durable 恢复做完了，但 timer / Dream / Inbox consumer **还没自己动**；
   *   - `pausing`：`pauseManagedWork()` 正在把受管工作 drain 干净（handoff 专用的接缝）。
   *
   *   new → starting → restored(deferred-start) → activate → running
   *                                     running → pausing → restored(paused) → resumeManagedWork → running
   *          restored / running → stopping → stopped
   *          restored / running ── 丢锁 ──→ lost
   */
  private phase: "new" | "starting" | "restored" | "running" | "pausing" | "stopping" | "stopped" | "lost" = "new";
  /** `restored` 是怎么来的：两种 reason 各有各的消费者，调错必须 fail-loud。 */
  private restoredReason: "deferred-start" | "paused" | null = null;
  /**
   * **唯一的 lifecycle actor**：start / activate / pauseManagedWork / resumeManagedWork / stop 与丢锁善后
   * 全排在这一条链上。上一版只串行了中间三个，于是 `activate()` 卡在 catch-up 时 `stop()` 能插进来先
   * release Lease，随后 activation 接着起 timer、把已经停掉的 Agent 写回 running（实测）。
   */
  private lifecycleChain: Promise<unknown> = Promise.resolve();
  /**
   * lifecycle 入队票号。**in-flight 共享只在「自己仍是最后入队的那一个」时成立**——
   * 上一版只看 `startInFlight !== undefined`，于是 `start()`（卡在 acquire）→ `stop()` → `start()` 时
   * 第二次 start 复用了第一次的 promise，成功返回之后 stop 才把 Agent 停掉：调用方拿到一个
   * 「start 成功但已经 stopped」的 Agent（实测）。
   */
  private lifecycleSeq = 0;
  private lastQueuedTicket = 0;
  /** 在飞的 `start()` 用的是哪种 activation：并发调用参数不同必须 fail-loud，不能静默采用先到者。 */

  /** 进行中的 `start()`。并发调用共享它——那才叫幂等（见 `start()` 的注释）。 */
  private startInFlight?: { readonly ticket: number; readonly activation: "immediate" | "deferred"; readonly promise: Promise<void> };
  /** 进行中的 `stop()`。同上；另外 `stop()` 要靠 `startInFlight` 等启动收完再动手。 */
  private stopInFlight?: { readonly ticket: number; readonly promise: Promise<void> };
  /** `dispose()` 幂等的落点：第二次调用等第一次，不再跑一遍收摊（§14.7.5 第 6 条）。 */
  private disposeInFlight?: Promise<void>;
  public autoConsumeInbox: boolean;
  public autoDream: boolean;
  /** 正在跑的整理。**与 activeRun 分开**——它可被前台抢占，不占并发闸。 */
  private readonly disposables: readonly { dispose(): Promise<void> }[];
  private readonly finalDisposables: readonly { dispose(): Promise<void> }[];
  private activeRun?: ActiveRun;

  /* 闸与策略 */
  public maxIterations: number;
  public timeoutMs?: number;
  public retryPolicy: RetryPolicy;
  public maxRetryDelayMs?: number;
  public compaction: CompactionOptions;
  /**
   * 压缩阶段表（按名）。**只经 `AgentCompaction` registry 写**（`extension/registries.ts`），内建的
   * `echo:compaction` 与产品 / 第三方的策略走同一条路；流水线每次跑之前从这里重取（热插拔在轮边界生效）。
   */
  readonly compactionStages: Map<string, CompactionStage> = new Map();
  /**
   * 上一次 usage 算出的校准比（真 token / 字符估）与当时 system prompt 的字符估。手动压缩发生在 run 之外、
   * 新 run 的首轮还没有 usage——这两处没有基准，裸字符估对中文会低 2–4 倍，就沿用这份。`reset()` 归 1。
   */
  private lastCalibration = 1;
  private lastSystemEstimate = 0;
  public toolExecution: "sequential" | "parallel";

  /* 可替换的决策点 */
  public convertToLlm: ConvertToLlm;
  public transformContext?: TransformContext;
  public streamFunction: StreamFn;
  public hooks: HookRuntime;
  /** permission ask 账本（§14.10.3）：只有 `answerPermission()` 与 loop 的 ask 路径碰它。 */
  private readonly permissions = new PermissionLedger();
  private readonly permissionPolicy: PermissionPolicy;
  /** 当前 run 的稳定身份；permission ask 与事件关联引用它。 */
  private currentRunId: string | null = null;
  public getApiKey?: AgentOptions["getApiKey"];
  /**
   * system prompt 的两张表：段（按名）与变量（按名）。**只经 `AgentPrompt` registry 写**
   * （`extension/registries.ts`），内建的 `echo:*` 与产品的 extension 走同一条路；
   * `assemblePrompt()` 每次 run 读一次。Agent 自己一行都不往里塞。
   */
  readonly promptSections: Map<string, PromptSection> = new Map();
  readonly promptVariables: Map<string, PromptVariable> = new Map();

  constructor(opts: AgentOptions) {
    this._state = {
      model: opts.model,
      tools: [],
      thinkingLevel: opts.thinkingLevel ?? "off",
      messages: [],
      status: "idle",
      startedAt: null,
      iteration: 0,
      streamingMessage: undefined,
      pendingToolCalls: new Set(),
      retryCount: 0,
      compaction: EMPTY_COMPACTION,
      contextTokens: null,
      lastError: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      sessionId: opts.sessionId ?? null,
      workspace: opts.workspace ?? "/",
      activeSkills: [],
      mcp: [],
      tasks: EMPTY_TASK_SNAPSHOT,
    };
    this.autoConsumeInbox = opts.autoConsumeInbox ?? false;
    this.autoDream = opts.autoDream ?? false;
    this.disposables = opts.disposables ?? [];
    this.finalDisposables = opts.finalDisposables ?? [];
    this.taskStore = opts.taskStore;

    // **回调逐个显式给,不打包**（2026-08-05 拆掉 HarnessHost 之后的形态；
    // 全局约定：优先显式依赖注入,不用全局 holder）。
    const onChanged = (c: ResourceChange): void => void this.processEvents({ type: "resource_changed", ...c });
    const report = (d: Diagnostic): void => void this.reportDiagnostic(d);
    const deliver = (m: AgentMessage): void => this.deliver(m);

    this.background = {
      tasks: new Map(),
      onChanged,
      deliver,
      report,
      ...(opts.backgroundLimits !== undefined ? { limits: opts.backgroundLimits } : {}),
    };


    // 初始数据直接进集合。**都是数据,不是实现**。
    if (opts.tools !== undefined) registerTools(this.tools, opts.tools);
    if (opts.skills !== undefined) addSkills(this.skills, opts.skills);
    this.skillStore = opts.skillStore;
    if (opts.tasks !== undefined) createTasks(this.tasks, opts.tasks);

    // **Task 与 Skill 是 Agent 自己的能力，不是产品层的挂件**（2026-08-23 用户拍板）。
    // 此前它们的工具只有 `@echo/coding-agent` 注册，于是默认装配出来的 agent
    // 工具面只有 memory + schedule 四件，「由 Agent 创建 Task / 激活 Skill」
    // （§13.9 第 4 条）根本走不通。现在与 memory / schedule 同一个模式：能力在，工具就在。
    //
    // 两者的装法不同，理由不同：
    //   · **task 恒装**——`this.tasks` 总是存在，没有「能力不在」这个状态；
    //   · **skill 池非空才装**——空可选集的工具每轮白占 token，严格 provider 还会拒收
    //     （v1 的教训，`skill/tools.ts` 的注释里记着）。构造之后才 `addSkills` 的用法
    //     仍由装配方自己注册，`@echo/coding-agent` 走的就是那条。
    // **改完就落盘，不等到 stop()。** 此前 `saveTasks` 只在 `dispose()` 里调一次：
    // 模型 `TaskCreate` 拿到「已建 1 条任务」的成功回执之后进程崩掉，那条任务就没了——
    // 工具说成功、盘上没有，是最坏的一种谎。resident 测试此前用干净 stop 掩盖了这个缺口。
    // 任何人改 `tasks`（工具、公开的 `createTasks()`、甚至直接 `map.set`）都会落盘
    (this.tasks as ObservedTaskMap).onChange = (): void => {
      // **取消也要说出来。** 工具路径有回执可以承载这件事，这条路径（公开的 `createTasks()`
      // 之类直接改 map）没有返回值——上一版只 `.catch()`，而 `"cancelled"` 是**正常返回值
      // 不是异常**，于是「改动进了内存、盘上什么都没有」是完全静默的。
      // 这正是「绝不静默降级」要拦的那种：调用方以为存下了。
      void this.schedulePersistTasks().then(
        (outcome) => {
          if (outcome !== "cancelled") return;
          this.reportDiagnostic({
            code: "tasks_persist_skipped",
            message:
              "任务清单的改动没有落盘：本 agent 没有持有状态根的单写者租约" +
              "（还没 start()，或者租约已经丢失）。改动只在当前进程内有效，重启会丢失",
          });
        },
        (e: unknown) => this.reportDiagnostic({ code: "tasks_persist_failed", message: errText(e) }),
      );
    };
    // **造在这里，注册不在这里**（2026-08-31 用户拍板：「用构造函数在 core 构造，
    // 但机制必须同一份，都要走 extension」）。工具连同持久化 / 租约包装都在构造期造好，
    // 交给 `builtinTools`；由装配层经 `echo:*` builtin Extension 走 `AgentTools.register` 注册。
    // 低层 `new Agent()` 因此**工具面为空**——那正是「两个使用高度」的低那一头：自己给端口、自己注册。
    const taskTools = makeTaskTools(this.tasks).map((t) => this.persistingTaskTool(t));
    const skillDeps = { skills: this.skills, active: this.activeSkills, hasTool: (n: string) => this.tools.has(n) };
    const skillTools =
      this.skillStore !== undefined
        ? // 有持久化端口 = 支持创建 → 两件都装，create 套单写者租约门（同 Task 工具的形状）
          makeSkillTools({ ...skillDeps, onCreate: (name) => this.saveSkill(name) }).map((t) => this.guardedSkillCreate(t))
        : this.skills.size > 0
          ? makeSkillTools(skillDeps)
          : []; // 池空 = 能力在、零工具（skill 池是 Agent 恒有的），所以是空数组不是 undefined

    // `undefined` = **这个能力不在**（与「在但零工具」的空数组是两件事，见 `builtinEntries()`）：
    // `withoutMemory` 装出来的 agent 不该在能力清单里出现 `echo:memory`——那是报告一个不存在的能力。
    let memoryTools: readonly AgentTool[] | undefined;
    let scheduleTools: readonly AgentTool[] | undefined;
    this.memory = opts.memory;
    if (this.memory !== undefined) {
      this.memory.report = report;
      // 无特权通道：与第三方扩展同一条注册路（见 `extension/builtin.ts`）。
      memoryTools = [memoryTool(this.memory)];
      // **轮次门的唯一进料口**。没有这一行时 `turnsSinceDream` 恒为 0，
      // `minTurnsSinceLast` 这道门永远不满足，而且**静默**——看起来配了，实际从没起过作用。
      // 装配方「记得订阅」不是契约，装了记忆就该自动接上。
      this.subscribe(memoryObserver(this.memory));
    }
    this.schedule = opts.schedule;
    if (this.schedule !== undefined) {
      // 触发 = 投递进 inbox，不是执行。
      // **接的是有确认语义的那条**：schedule 要等 inbox 真的接受了才敢记 fired
      // （删一次性任务 / 刷 lastFiredAt），否则落盘失败时两边都不剩那个事实。
      this.schedule.deliver = (m: AgentMessage): Promise<void> => this.deliverForSchedule(m);
      this.schedule.report = report;
      scheduleTools = makeScheduleTools(this.schedule);
    }
    // 每组带上它自己的 prompt 段（谁拥有工具，谁拥有讲它怎么用的段）：
    //   · skills：目录段。字节何时变：池增删时；**激活/停用不影响本段**（激活不打 system 缓存）。
    //     门控按真实状态：skill_activate 不在工具面，目录就是死文本（教模型用它没有的工具）。
    //   · memory：记忆段（格式归 memory/compose.ts），沉底。
    //   · tasks / scheduler：不出段——description 已经装下契约。
    const skillsSection: PromptSection = {
      name: "skills",
      order: PROMPT_ORDER.skills,
      render: () => (this.tools.has("skill_activate") ? renderSkillCatalog(this.skills) : ""),
    };
    this.builtinTools = {
      tasks: { tools: taskTools },
      skills: { tools: skillTools, sections: [skillsSection] },
      memory: memoryTools === undefined || this.memory === undefined ? undefined : { tools: memoryTools, sections: memoryPromptSections(this.memory) },
      scheduler: scheduleTools === undefined ? undefined : { tools: scheduleTools },
      // 压缩阶梯 + transcript_read + 习惯段：与 memory 同款——`builtin: false` 就是「这组不在」，
      // 流水线与 registry 仍在，等别的扩展注册阶段。`transcript_read` 读的是活的 transcript。
      compaction: opts.compaction?.builtin === false ? undefined : defaultCompactionPack(opts.compaction ?? {}, () => this._state.messages),
    };
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.timeoutMs = opts.timeoutMs;
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.maxRetryDelayMs = opts.maxRetryDelayMs;
    this.compaction = opts.compaction ?? {};
    this.toolExecution = opts.toolExecution ?? "sequential";
    this.convertToLlm = opts.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = opts.transformContext;
    this.streamFunction = opts.streamFunction;
    this.hooks = opts.hooks ?? new HookRuntime();
    this.permissionPolicy = validatePermissionPolicy(opts.permission);
    this.getApiKey = opts.getApiKey;
    // **放在最后**：attach 可能触发 report → hookContext() → this.hooks，
    // 而 hooks 是上面几行才赋的值（实测踩到：放在前面直接 TypeError）。
    this.mcp = opts.mcp;
    this.mcp?.attach({ tools: this.tools, onChanged, deliver, report });

    this.sessionService = opts.sessionService;
    this.sessionService?.attachDiagnostics((d) => this.reportDiagnostic(d));
    this.clock = opts.clock ?? systemClock;
    this.stateLock = opts.stateLock;
    this.agentId = opts.agentId ?? "default";
    this.agentName = opts.agentName ?? this.agentId;
    this.agentInstanceId = `${this.agentId}@${crypto.randomUUID()}`;
    this.intake = new RunIntakeGate(this.agentInstanceId);
    normalizeModelSnapshot(opts.model); // 装备期就验：binding 在 admission 时冻结 model，不能等到那时才发现它不是 JSON-like
    this.admission = new StandaloneRunAdmission({
      binding: (input) => this.modelBinding(input),
      normalizeFailure: (input) => this.normalizeAdmittedCallbackFailure(input),
      assertReserved: (id, ids) => this.inbox.assertReserved(id, ids),
      // §15.5.2：run.accepted / run.closed 的唯一 emission owner 是 admission；没挂 canonical writer 时 accepted 恒 true
      observe: {
        accepted: (input) => this.observeRunAccepted(input),
        closed: (input) => this.observeRunClosed(input),
      },
    });
    this.inbox = opts.inboxStore ?? new InboxStore(null);
    this.inbox.attachDiagnostics((d) => this.reportDiagnostic(d));
    // 公开面走严格闸（受生命周期管的 Agent 只有 running 才开放）；schedule 补跑走 internal（见 deliverForSchedule）
    this.ingress = { deliverDurable: (request) => this.acceptInboxRecord(request, { internal: false }) };
  }

  /* ───────────── 读面 ───────────── */

  /**
   * 运行时状态快照。`activeSkills` 是**读取时从 harness 算出来的派生视图**——
   * 池的权威在 harness，state 里不存第二份（与 `isStreaming` 同款）。
   */
  get state(): Readonly<AgentState> {
    return {
      ...this._state,
      tools: activeTools(this.tools),
      activeSkills: listActiveSkills(this.activeSkills),
      mcp: this.mcp?.list() ?? [],
      tasks: taskSnapshot(this.tasks),
    };
  }
  get messages(): readonly AgentMessage[] {
    return this._state.messages;
  }
  get status(): AgentStatus {
    return this._state.status;
  }
  /** 派生，不单独存。 */
  get isStreaming(): boolean {
    return this._state.status !== "idle";
  }
  get sessionId(): string | null {
    return this._state.sessionId;
  }
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /**
   * 现在起一轮新 run 会不会被拒。**壳子（TUI / Runner / UI）预判「能不能提交」只能读它。**
   *
   * 与 `prompt()` 同一份判据（`refuseWorkReason()`），不是另写一份近似条件——所以不会漂。
   * 从外面拼不出等价物：五组条件里 `inboxTicketOutstanding` / `inboxFailure` / `leaseLostError` /
   * `phase` 一个都不在公共面上，而 `status` 覆盖不到 Inbox 的 ack 窗口（`closeRun()` 已经把它置回
   * `"idle"`，`ackBatch()` 的裁决还没出来）。
   *
   * **它是即时快照，不是承诺**：读完之后 Agent 可能因为别的 run 落位而变忙。同一个同步段里
   * 「读它 → 调 `prompt()`」是可靠的（中间没有 await，别的 JS 跑不进来）；跨 await 就要重读。
   */
  get acceptsWork(): boolean {
    return this.refuseWorkReason() === null;
  }

  /**
   * 订阅 LifecycleEvent 实时通道（§14.2.3）：与 hook 走同一个 emission point、同一顺序，但只观察、不参与折叠。
   * 可信宿主用它收 `permissionRequest`，再单独调 `answerPermission()`。
   */
  subscribeLifecycle(listener: LifecycleEventListener): () => void {
    return this.hooks.subscribe(listener);
  }

  /**
   * 可信宿主回答一次 ask（§14.10.3）。accepted / stale / closed 都是正常结果、都 fulfill；
   * 只有 JS 边界的坏 shape 才以 TypeError reject。Extension/Tool 拿不到这个入口。
   */
  async answerPermission(input: PermissionAnswer): Promise<PermissionAnswerResult> {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof input.permissionId !== "string" ||
      input.permissionId === "" ||
      (input.decision !== "allow" && input.decision !== "deny") ||
      (input.reason !== undefined && typeof input.reason !== "string")
    ) {
      throw new TypeError("answerPermission：需要 { permissionId: string, decision: \"allow\" | \"deny\", reason?: string }");
    }
    return this.permissions.answer(input);
  }

  /** Inspector 用：还在等人的 ask。 */
  get pendingPermissions(): readonly import("./permission/types.ts").PermissionAsk[] {
    return this.permissions.pending;
  }

  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ───────── 装备面：setter 一律先守 idle ─────────
     跑的中途换装备 = 上下文与工具面撕裂，所以这不是洁癖。 */

  get model(): Model {
    return this._state.model;
  }
  set model(value: Model) {
    this.assertIdle("model");
    normalizeModelSnapshot(value); // fail-loud 在这里：admission 时冻结 binding 不能再抛
    this._state.model = value;
    this.catalogRevision += 1;
  }

  get thinkingLevel(): ThinkingLevel {
    return this._state.thinkingLevel;
  }
  set thinkingLevel(value: ThinkingLevel) {
    this.assertIdle("thinkingLevel");
    this._state.thinkingLevel = value;
  }

  private assertIdle(what: string): void {
    // 已经 enqueue、还没拿到 permit 的 run 也算「正在运行」：permit 在微任务里落位，prompt() 返回那一刻 activeRun 还是空
    if (this.activeRun !== undefined || this.userRunPending || this.inboxTicketOutstanding) {
      throw new Error(`Agent 正在运行，不能更换 ${what}；请先 abort 或等待完成`);
    }
  }

  /* ───────────── 命令面 ───────────── */

  /**
   * 开一轮新任务。重入直接 throw；「一次只跑一个」由 admission 的单 permit 保证（§14.2.4），
   * 这里的重入检查只是给调用方一个即时的答复。
   */
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageBlock[]): Promise<AgentRunResult> {
    // 同步段：拒绝新工作的检查全在 enqueue 之前，之间不许有 await——让出微任务，两个并发 prompt 就都穿过去了（实测踩到过）。
    // 重入那条以前在这里单独写一遍，现在并进 `refuseWorkReason()`（顺序不变，报文不变）：
    // 判据只有一份，外面的 `acceptsWork` 才可能与它永远一致。
    this.assertAcceptsWork();
    return this.runPromptMessages(normalizePrompt(input, images));
  }

  /** 从现有 transcript 续跑：末条是 user / toolResult 才有得续。 */
  async continue(): Promise<AgentRunResult> {
    if (this.activeRun !== undefined || this.userRunPending) throw new Error("Agent 正在处理；等它跑完再 continue");
    const last = this._state.messages[this._state.messages.length - 1];
    if (last === undefined) throw new Error("没有可续跑的消息");
    if (last.role === "assistant") {
      // steer / followUp 只在 run 里 accepted（§14 RunIntakeGate），idle 时两条队列必空——
      // 上一版「末条是 assistant 就捞队列当新一轮」这条路已不存在。
      throw new Error("末条是 assistant，无从续跑；要接着说请用 prompt()");
    }
    this.assertAcceptsWork();
    return this.runContinuation();
  }

  /**
   * 跑的中途插话：只进**当前活动 turn**，轮末并入（§14.2.3）。裁决与入队在 RunIntakeGate 同一同步步里
   * 完成——方法是 async 只为了与 EchoRuntime 同形，返回前没有 await。没有活动 turn 返回
   * `rejected(no-active-turn)`：不抛、不入队等下一个 run。
   */
  async steer(message: AgentMessage | string): Promise<SteerResult> {
    const result = this.intake.steer(typeof message === "string" ? userMessage(message, "steer") : message);
    if (result.kind === "accepted") void this.emit({ type: "queue_update", queue: "steering", size: this.intake.steeringSize });
    return result;
  }

  /**
   * 这件做完接着做下一件：只进**当前 run**（§14.2.3）。没有 run 返回 `rejected(no-active-run)`，
   * 不退化成 prompt()。
   */
  async followUp(message: AgentMessage | string): Promise<FollowUpResult> {
    const result = this.intake.followUp(typeof message === "string" ? userMessage(message, "human") : message);
    if (result.kind === "accepted") void this.emit({ type: "queue_update", queue: "followUp", size: this.intake.followUpSize });
    return result;
  }

  /**
   * 往 inbox 投一条「外面发生的事」。**不打断正在跑的任务**——只入队。
   * 回到 idle 后：`autoConsumeInbox` 开着就自动消费，否则等调用方自己 `consumeInbox()`。
   */
  deliver(message: AgentMessage): void {
    // 同步命令面：投完就走，失败报诊断。**要「投成功了吗」的答复走 `agent.ingress.deliverDurable()`。**
    void this.acceptInboxRecord({ message, dedupeKey: dedupeKeyOf(message) }, { internal: false }).then(
      (r) => {
        if (r.kind === "rejected") this.reportDiagnostic({ code: "inbox_persist_failed", message: `投递未被接受（${r.reason}）${r.errorDigest === undefined ? "" : `：${r.errorDigest}`}` });
      },
      (e: unknown) => this.reportDiagnostic({ code: "inbox_persist_failed", message: errText(e) }),
    );
  }

  /**
   * Schedule 领域端口的适配（§14.2.4）：`ScheduleDeps.deliver` 的签名不改——accepted（含 deduplicated）映射成
   * resolve，schedule 才按既有逻辑推进 `lastFiredAt` / 删一次性任务；任何 structured rejected 映射成
   * `DurableDeliveryDeferred` rejection，于是现有 tick/catch-up 的 catch 路径保留 entry / due occurrence 并报告原因。
   * adapter 不重写 schedule 状态机，也不把 rejected 当已投递。
   */
  private async deliverForSchedule(message: AgentMessage): Promise<void> {
    // **内部通道**：补跑发生在 `start()` 内、restore 之后、phase 还是 starting 的那一段；公开 ingress 那时还没开放，
    // 但补跑必须能投进来。两者的区别只有这一条闸，账本侧完全同路。
    const result = await this.acceptInboxRecord({ message, dedupeKey: await this.scheduleDedupeKeyOf(message) }, { internal: true });
    if (result.kind === "rejected") throw new DurableDeliveryDeferred(result);
  }

  /**
   * Schedule 的 dedupeKey 用 **incarnation**（`hash(agentId, id, createdAt)`，§14 R6）：删掉后以同一 ID 重建的
   * schedule 是另一个事实。只按 `(source, ref)` 时，旧事实还 pending 就会把新 schedule 的那次吞掉——
   * 新 schedule 被记 fired、Inbox 里却只有旧 prompt（实测）。登记表里找不到（已被删）才退回普通派生。
   */
  private async scheduleDedupeKeyOf(message: AgentMessage): Promise<string> {
    const ref = message.role === "environment" ? message.ref : undefined;
    const entry = ref === undefined ? undefined : this.schedule?.entries.get(ref);
    if (entry === undefined) return dedupeKeyOf(message);
    return scheduleDedupeKey(this.agentId, entry.schedule.id, entry.schedule.createdAt);
  }

  /**
   * 真正的接受流程（Host-internal，**不是公开面**：公开的是 `agent.ingress.deliverDurable()`）。
   * 生命周期闸在前、账本在后：闸决定「这一代 Agent 现在收不收」，账本决定「这条事实进不进盘」。
   */
  private async acceptInboxRecord(request: DurableDeliveryRequest, opts: { internal: boolean }): Promise<DurableDeliveryResult> {
    const gate = this.ingressGate(opts.internal);
    if (gate !== null) return gate;
    let accepted: Promise<DurableDeliveryResult>;
    try {
      accepted = this.inbox.accept(request) as Promise<DurableDeliveryResult>;
    } catch (e) {
      // 账本的不变量破坏（序号没恢复就发号）——不是可重试的 I/O 失败，如实报出
      // 原文只进本地诊断：`errorDigest` 是公共协议字段，不放本地路径这类东西
      this.reportDiagnostic({ code: "inbox_invariant_broken", message: errText(e) });
      return { kind: "rejected", reason: "store-error", errorDigest: "ledger-invariant" };
    }
    // stop() 要等在飞的写 settle：不追踪的话，release lease 之后还可能在写
    const tracked = accepted.finally(() => this.pendingWrites.delete(tracked));
    this.pendingWrites.add(tracked);
    const result = await tracked;
    if (result.kind === "accepted" && !result.deduplicated) {
      void this.emit({ type: "queue_update", queue: "inbox", size: this.inbox.pendingCount });
      if (this.autoConsumeInbox && this.activeRun === undefined) void this.consumeInbox();
    }
    return result;
  }

  /**
   * 本代 Agent 现在收不收 durable delivery。standalone 只产生这四种理由；`lease-gap` / `runtime-failed` 属于
   * 完整 Runtime 的 handoff 与 FAILED 语义（O3/O5），standalone 没有可发的场景，不伪造。
   */
  private ingressGate(internal: boolean): Extract<DurableDeliveryResult, { kind: "rejected" }> | null {
    if (this.leaseLostError !== null) return { kind: "rejected", reason: "lease-lost" };
    // **stopping 先判**：`stop()` 内部一定会调 `dispose()`，先判 disposeInFlight 就会把整个收摊过程报成
    // runtime-disposed（实测）。完全 stopped / 直接 dispose 才是 runtime-disposed。
    if (this.stopInFlight !== undefined || this.phase === "stopping") return { kind: "rejected", reason: "stopping" };
    if (this.disposeInFlight !== undefined || this.phase === "stopped") return { kind: "rejected", reason: "runtime-disposed" };
    // 账本没恢复就发号会盖掉盘上已有的 record；restore 后半段失败时 `ready` 仍为 false，这里照样挡住
    if (!this.inbox.ready) return { kind: "rejected", reason: "runtime-not-ready" };
    // **公开 ingress 在「持有租约且恢复完了」之后开放**（§14 restored 方法矩阵）：
    //   - `new` / `starting`：Lease 可能还没拿到、也可能随后失败回退，那时对外承诺「已持久接受」不诚实 → 拒；
    //   - `restored`（deferred-start 与 paused 都算）与 `pausing`：**仍持合法 Lease，target 开着 → accepted 并持久化**，
    //     只是不自动 consume（`autoConsumeInbox` 那时是关的）——handoff 期间外面发生的事一件都不该丢。
    // schedule 的 catch-up 走 internal 通道（见 deliverForSchedule）。
    if (!internal && this.lifecycleManaged && (this.phase === "new" || this.phase === "starting")) {
      return { kind: "rejected", reason: "runtime-not-ready" };
    }
    return null;
  }

    /**
   * 等 barrier 之前已登记的 Background 任务各自 settle。**不 abort**：pause 是 handoff 的 drain 接缝，
   * 不是 shutdown（那条在 `dispose()` 里 `killAllBackground`）。新任务进不来——intake 已经关了。
   */
  private async settleBackground(): Promise<void> {
    const settled = [...this.background.tasks.values()].map((t) => t.settled).filter((p): p is Promise<void> => p !== undefined);
    if (settled.length > 0) await Promise.allSettled(settled);
  }

  /** 等所有在飞的 durable write settle。`stop()` 用它——不等就可能在释放 lease 之后还在写。 */
  private async settleWrites(): Promise<void> {
    // 排着队还没轮到的自动落盘也算在飞的——`pendingWrites` 里同时有它们与写链本身，
    // 所以循环等到集合真空为止（一笔写可能在 settle 时又排出下一笔）。
    for (let i = 0; i < 100 && this.pendingWrites.size > 0; i++) {
      await Promise.allSettled([...this.pendingWrites]);
    }
    // 收尾等的是**同一条写链**，不是另起一个并发写
    await this.taskWriteTail;
  }

  /**
   * 把 inbox 里攒着的**一次性全部取出**跑一轮。
   * 攒批不是优化：三个后台任务同时结束就跑一轮，不是三轮。
   * 正在跑 / 队列空 → 返回 null，不做任何事。
   */
  /**
   * 把运行状态写进 `status.json`（2026-09-03，sessions.md §6）。**只有持有 lease 的进程该写。**
   *
   * 它是给别人看的提示：`session_list` 里「这段能不能马上答话」就读它。失败不影响本段对话——
   * 读方永远还要再看一眼 lease，`alive` 为假时这份 `phase` 一律作废（进程崩在 working 的那种）。
   */
  private publishPhase(phase: SessionPhase): void {
    const id = this._state.sessionId;
    if (id === null || this.phase !== "running") return;
    this.sessionService?.setPhase(id, phase);
  }

  /**
   * inbox 轮询：**别的进程写进来的消息，靠它才看得见**（2026-09-03，sessions.md §5）。
   *
   * 会话之间发消息 = 往对方的 `inbox/` 目录写一条 record，写者可能是另一个进程。`InboxStore`
   * 只在 `restore()` 那一刻读过盘，所以不重扫就等于「要等对方重启才收到」——「A 发 B，B 不重启
   * 就在下一轮看到」这条判据直接不成立。
   *
   * 为什么是轮询而不是 `fs.watch`：core 不 import 任何 `node:`（浏览器 / Worker / 边缘运行时都要能跑），
   * 而 `Clock` 是已有的端口、测试拿 `FakeClock` 就能零 sleep 驱动。真要事件驱动，宿主可以自己在
   * 目录上装 watcher 再调 `agent.consumeInbox()`——那是加速，不是另一套语义。
   */
  private startInboxPoll(): void {
    if (this.inboxPollCancel !== undefined) return; // 幂等：activate 可能被走到两次
    this.inboxPollCancel = this.clock.setInterval(() => void this.pollInbox(), INBOX_POLL_MS);
  }

  private stopInboxPoll(): void {
    this.inboxPollCancel?.();
    this.inboxPollCancel = undefined;
  }

  /**
   * 一拍轮询。**只在真的空着时扫**：有 run 在跑就跳过——那时扫了也不能消费，白读一遍盘。
   * 失败只报诊断：一次读盘失败不该把一个健康的 agent 掀翻，下一拍还会再来。
   */
  private async pollInbox(): Promise<void> {
    if (this.phase !== "running" || this.activeRun !== undefined || this.userRunPending || this.inboxTicketOutstanding) return;
    if (this.inboxFailure !== null) return;
    try {
      const found = await this.inbox.refresh();
      if (found > 0 && this.autoConsumeInbox) await this.consumeInbox();
    } catch (e) {
      this.reportDiagnostic({ code: "inbox_refresh_failed", message: errText(e) });
    }
  }

  async consumeInbox(): Promise<LoopResult | null> {
    if (this.activeRun !== undefined || this.userRunPending || this.inboxTicketOutstanding) return null;
    if (this.inboxFailure !== null) return null; // 账本已封：不再消费，也不假装健康
    if (this.inbox.pendingCount === 0) return null;
    try {
      this.assertAcceptsWork();
    } catch (e) {
      // finishRun 里是 void 调用：拒绝新工作不能变成 unhandled rejection，记诊断、这批留在队列里
      this.reportDiagnostic({ code: "inbox_consume_refused", message: errText(e) });
      return null;
    }
    // 一次 reserve 一批（§14.2.4）：reservationId + 有序 recordIds 随 request 进 admission；新到的 delivery 进下一批
    // **从 reserve 一直立到 ack 裁决结束**：这段时间外部 prompt()/continue() 一律被 assertAcceptsWork 拒。
    // 上一版在 ack 之前就清了标记，于是 marker 还卡着、裁决没出来时新 run 已经拿到 permit——
    // 它可能跑在「这批要重放」或「账本要 seal」之前（实测 agent_start 从 1 变成 2）。
    this.inboxTicketOutstanding = true;
    const batch = this.inbox.reserveBatch();
    if (batch === null) {
      this.inboxTicketOutstanding = false;
      return null;
    }
    try {
      let ticket: AgentAdmissionTicket<LoopResult>;
      try {
        ticket = this.admission.enqueue(
          {
            source: { kind: "inbox" },
            priority: "foreground",
            purpose: "foreground",
            reservationId: batch.reservationId,
            reservedRecordIds: batch.recordIds,
          },
          (scope) => this.executeAdmitted(scope, this.foregroundExecutor(batch.messages, "human")),
        );
      } catch (e) {
        this.inbox.releaseBatch(batch.reservationId); // reserve 之后 enqueue 同步抛：整批放回，不能 drain 了又不还
        throw e;
      }
      const settled = await ticket.settled;
      if (settled.kind === "rejected") {
        // 任一正常 rejected：整批放回（durable facts 一个不丢），不 ack 半批
        this.inbox.releaseBatch(batch.reservationId);
        return null;
      }
      // executed / callback-error 都是封口：先归 idle，再整批 ack。
      // **at-least-once**：崩在 ack 之前 → 重启时那批还在，会重放；ack 了 → 删掉，不会变成死循环。
      // **只归 idle，不排下一轮、也不清 outstanding 标记**：裁决还没出来，可能是 indeterminate（那时一轮都不该再起）。
      this.closeRun();
      // ack 的三态由账本裁决：pre-commit（整批仍 pending，下次重投）与 indeterminate（账本已 seal，后续 intake
      // 一律 fail-loud）都以 reject 报出。run 本身确实发生过，所以这里如实记诊断、照样交出 LoopResult——
      // 不假装 ack 成功，也不把已经跑完的 run 说成没跑。
      let indeterminate = false;
      try {
        await this.inbox.ackBatch(batch.reservationId);
      } catch (e) {
        if (e instanceof InboxAckError && e.verdict === "indeterminate") {
          this.enterInboxFailure(e); // 先进失败态，再清标记——中间不给任何新 run 可乘之机
          indeterminate = true;
        } else {
          this.reportDiagnostic({ code: "inbox_ack_failed", message: errText(e) }); // pre-commit：整批仍 pending，下次重投
        }
      }
      // 裁决出来了才放行：committed / pre-commit 先清标记再排下一轮；indeterminate 只清标记，一轮都不排
      this.inboxTicketOutstanding = false;
      if (!indeterminate) this.scheduleAutonomousWork();
      return settled.result;
    } finally {
      this.inboxTicketOutstanding = false;
    }
  }

  clearSteeringQueue(): void {
    this.intake.clearSteering();
  }
  clearFollowUpQueue(): void {
    this.intake.clearFollowUps();
  }
  clearInbox(): void {
    this.inbox.clear();
  }
  clearAllQueues(): void {
    this.intake.clearSteering();
    this.intake.clearFollowUps();
    this.inbox.clear();
  }

  abort(reason?: string): void {
    void this.hooks.notify({ type: "abortRequested", reason }, this.hookContext());
    this.activeRun?.abortController.abort();
  }

  /** 清 transcript + 运行态 + 队列；**装备与决策点不动**。 */
  reset(): void {
    this.assertIdle("transcript");
    this._state.messages = [];
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set();
    this._state.lastError = null;
    this._state.compaction = EMPTY_COMPACTION;
    this._state.contextTokens = null;
    this.lastCalibration = 1;
    this._state.iteration = 0;
    this._state.usage = { inputTokens: 0, outputTokens: 0 };
    this.clearAllQueues();
  }

  /**
   * 手动压缩（TUI 的 `/compact [指令]`，2026-09-02）：跑与自动压缩**同一条**流水线（`compaction/pipeline.ts`），
   * reason 为 manual、无视阈值，`instructions` 交给摘要阶段。走 admission 拿 permit——忙时 rejected、
   * 模型 binding 冻结——但**不是一个 run**：不发 agent_start / agent_end，只有 compaction_start / compaction_end。
   * 不抛：忙、没注册任何阶段、admission 拒绝，都以 rejected 带原因返回。
   */
  async compact(instructions?: string): Promise<CompactResult> {
    const refuse = this.refuseWorkReason();
    if (refuse !== null) return { kind: "rejected", reason: refuse };
    if (this.compactionStages.size === 0) {
      return { kind: "rejected", reason: "没有注册任何压缩阶段（echo:compaction 未装，也没有别的策略）" };
    }
    const box: { outcome: CompactionOutcome | null } = { outcome: null };
    try {
      await this.admitUserRun(async (scope, signal) => {
        const context = await this.createContextSnapshot(scope);
        const config = this.createLoopConfig(scope);
        box.outcome = await runCompaction(
          { context, config, emit: (e) => this.processEvents(e), signal, streamFn: scope.modelBinding.streamFunction },
          { reason: "manual", ...(instructions !== undefined ? { instructions } : {}), anchor: null, calibration: this.lastCalibration },
        );
        return { outcome: { kind: "completed" }, messages: [] };
      });
    } catch (e) {
      return { kind: "rejected", reason: errText(e) };
    }
    const outcome = box.outcome;
    if (outcome === null) return { kind: "done", stages: [], contextTokens: this._state.contextTokens };
    return { kind: "done", stages: outcome.stages, contextTokens: outcome.contextTokens };
  }

  /* ───────────── 生命周期（D4 / §13.12.3） ───────────── */

  /**
   * 一次做完所有恢复与启动。**幂等**：重复调直接返回。
   *
   * 顺序是契约的一部分（§13.12.3）：取 lease → create-or-resume 默认 Session
   * →（M4/M5 起）恢复 Memory / Skills / Tasks / Schedules / Inbox → 启动后台 → 发 ready。
   *
   * **不变量：中途任何一步失败，必须释放已取得的 lease 再抛**——否则状态根会被一个
   * 起不来的进程永久占住，下次启动只能人工删锁。
   */
  /**
   * 受生命周期管的 Agent = 装配了持久化或单写锁的那种。
   * **两者任一即算**：只给 `sessionService`（单进程用法）同样必须遵守 stop 之后不再写。
   */
  /** 人读的相位（错误信息里用）：`restored` 带上 reason，否则光看 "restored" 分不清是哪一种。 */
  private get phaseLabel(): string {
    return this.phase === "restored" ? `restored(${this.restoredReason ?? "?"})` : this.phase;
  }

  private get lifecycleManaged(): boolean {
    return this.stateLock !== undefined || this.sessionService !== undefined;
  }

  /**
   * 起来。缺省 = durable 恢复 + 立刻开始自己动（保持既有语义）。
   * `activation: "deferred"` 只做恢复，停在 `restored(deferred-start)`：timer / Dream / Inbox consumer 都不启动，
   * 等 composition/handoff 在 atomic swap 之后调 `activate()`（§14 的窄接缝，不是重写恢复逻辑）。
   */
  async start(options: { activation?: "immediate" | "deferred" } = {}): Promise<void> {
    // canonical writer 在 start 入口就接上：恢复期的 Schedule 补跑（catchUp）已经会发领域事实，不能等到第一个 run 才挂 sink
    this.observationRuntime();
    const activation = options.activation ?? "immediate";
    // **外层只做同操作的 in-flight 共享**——一切 phase 判断都在 actor 内（见 `startInActor`）。
    // 在外层判相位等于「读的是入队那一刻的旧相位」：`stop()` 之后同一 tick 调 `start()`，
    // 它读到还没被改写的 running 就直接成功返回，随后 stop 才把 Agent 停掉（实测）。
    //
    // 共享还有第二个前提：**那次 start 仍是队尾**。中间要是插进了 stop / pause / activate / resume / 丢锁，
    // 复用它的 promise 就等于跨过了那些命令——`start()`（卡在 acquire）→ `stop()` → `start()` 时，
    // 第二次 start 会随第一次一起成功，而 Agent 随后被停掉（实测）。这时必须独立入队，让它排在 stop 之后。
    const sharable = this.startInFlight !== undefined && this.startInFlight.ticket === this.lastQueuedTicket;
    if (sharable) {
      const inFlight = this.startInFlight!;
      // 并发 start 共享同一次启动；但**参数不同不能静默采用先到者**——两个调用方要的是不同的东西
      if (inFlight.activation !== activation) {
        throw new Error(`已有一次 start({activation:"${inFlight.activation}"}) 在飞，不能同时按 "${activation}" 启动`);
      }
      return inFlight.promise;
    }

    const { ticket, promise } = this.enqueueLifecycle(() => this.startInActor(activation));
    this.startInFlight = { ticket, activation, promise };
    try {
      await promise;
    } finally {
      if (this.startInFlight?.ticket === ticket) this.startInFlight = undefined;
    }
  }

  /** `start()` 的**全部相位判断与写入**——它整个跑在 lifecycle actor 里，读到的相位一定是轮到自己那一刻的。 */
  private async startInActor(activation: "immediate" | "deferred"): Promise<void> {
    if (this.phase === "running") return; // 幂等
    // 已经恢复完停在 restored(deferred-start)：immediate 语义就是「把它激活」，deferred 则是幂等返回。
    // **直接走内层 transition**，不能回头调 `this.activate()`——那会把自己再排进同一条 actor，当场死锁。
    if (this.phase === "restored" && this.restoredReason === "deferred-start") {
      if (activation === "deferred") return;
      return this.transitionInActor("activate", "deferred-start");
    }
    // **paused 不归 start() 管**：它已经持有租约，再走一遍 acquire 只会拿不到自己的锁、然后把 phase 打回 new，
    // 连 `resumeManagedWork()` 都救不回来（实测）。这里 fail-loud 且**一个字段都不改**。
    if (this.phase === "restored" && this.restoredReason === "paused") {
      throw new Error("Agent 正处于 restored(paused)：handoff 的恢复口是 resumeManagedWork()，不是 start()");
    }
    if (this.phase === "stopping") throw new Error("stop() 正在进行中，不能同时 start()");
    // **终态**：停过就不能再起。要新的实例就重新 createAgent——允许复活会让「谁持有状态根」变成一笔糊涂账。
    if (this.phase === "stopped") throw new Error("这个 Agent 已经 stop() 过了：请新建一个");
    if (this.phase === "lost") throw new Error("这个 Agent 已丢失 single-writer 租约：请新建一个");
    // **install 之后失败是终态**：写入格已 revoke 且不可复用（§14.9「fresh rollback 必须重建一整套」）。
    // 拿锁**之前**失败仍可重试（换状态根、修坏档再来）——这两种失败的契约不一样，不能混成一句「可重试」。
    if (this.startFencedError !== null) {
      throw new Error(`这个 Agent 在取得租约之后启动失败过，写入格已作废：请新建一个（原因：${this.startFencedError.message}）`);
    }
    this.phase = "starting";
    await this.doStart(activation);
  }

  private async doStart(activation: "immediate" | "deferred"): Promise<void> {
    let acquired: Lease | undefined;
    try {
      if (this.stateLock !== undefined) {
        // holder 只是给人看的标识——**不要在这里取 pid**，那是 node 全局，
        // agent.ts 在 engine 面。进程身份由 Lock 的实现自己记。
        const lease = await this.stateLock.acquire({ holder: `agent:${this.agentId}` });
        if (lease === null) {
          // 拿不到就是拿不到——core 不抢占（§13.12.3）。
          // 但**必须说清是谁占着**：不接管的代价是人工删锁，而人工删锁得先看得见对面是谁。
          const who = (await this.stateLock.describeHolder?.()) ?? null;
          throw new Error(
            `状态根已被另一个写者持有（agentId=${this.agentId}）：拒绝启动` +
              (who !== null ? `。当前持有者：${who}` : "。锁的实现报不出持有者信息"),
          );
        }
        acquired = lease;
        this.lease = lease;
        void this.watchLease(lease);
        // acquire 成功后才有写入身份：**cell 与根闸同一步装上**（§14.9），随后才打开 restore-migration。
        // 装之前任何写都 fail-closed——PREPARE / 尚未 start 的 view 就是这个状态。
        this.gate?.install({ agentInstanceId: this.agentInstanceId, acquisitionId: crypto.randomUUID() });
      }
      // 恢复期的写（session 建档、legacy migration、任务回写）走 restore-migration；durable ingress 从
      // 持有租约起就可写（§14.9 的 lane 表），两者到 revoke fence 才关。
      this.gate?.openLane("restore-migration");
      this.gate?.openLane("durable-ingress");

      if (this.sessionService !== undefined) {
        // **缺省每次启动新建会话**（2026-09-01 用户拍板）：续上次是显式动作——给了 `sessionId` 才
        // create-or-resume 那一段。之前缺省按 workspace 派生、启动即 resume，同一目录里起的任何产品
        // 都落进同一段对话（见 `session/types.ts` 的 `newSessionId`）。
        const sessionId = this._state.sessionId ?? newSessionId();
        const data = await this.sessionService.createOrResume(sessionId, {
          workspace: this._state.workspace,
          agent: this.agentName,
        });
        this._state.messages = [...data.messages];
        this._state.compaction = data.compaction;
        this._state.sessionId = data.info.id;
        this._state.workspace = data.info.workspace; // resume 以盘上为准
        await this.hooks.notify(
          {
            type: "sessionStart",
            sessionId: data.info.id,
            resumed: data.messages.length > 0,
            // 壳要把「续了多少」说出来：无声恢复 = 用户以为全新开始、模型脑子里却带着上一场
            messageCount: data.messages.length,
          },
          this.hookContext(),
        );
      }

      // 发现 Skills（§13.6）：从 `skillStore` 读 `<name>/SKILL.md`，撞名先到先得 + 诊断
      //（构造期显式传的赢）。**逐文件容错**：一个 SKILL.md 读失败 / 内容坏 → 诊断 + 跳过，
      // 不拖垮启动——`skills/` 与扫盘目录是同类东西（人也会手放文件），姿态与 loader 一致；
      // 不学 `loadTasks` 的坏档判红（tasks.json 是机器专属档案，坏了就是状态根坏了）。
      if (this.skillStore !== undefined) await this.discoverSkills(this.skillStore);

      // 任务清单：盘上的是权威，覆盖内存里的（`loadTasks` 自己保证坏档判红）。
      // **恢复期抑制自动落盘**：否则每 `set` 一条就排一笔写，把刚读进来的东西原样写回去。
      if (this.taskStore !== undefined) {
        this.taskPersistSuppressed = true;
        try {
          await loadTasks(this.tasks, this.taskStore);
        } finally {
          this.taskPersistSuppressed = false;
        }
      }

      // **相位单调**：进了 lost 就不许再回 running。
      // 没有这条时实测过：启动途中 lease 丢失，`watchLease` 已把 phase 置成 lost、
      // 已 seal、已 abort，而下面那行随后把它盖回 running，`start()` 返回成功——
      // 调用方拿到一个「自以为持有状态根」的 Agent。
      //
      // **位置有讲究**：读盘恢复之后、任何「开始自己动」之前。丢了锁就不该把闹钟启起来，
      // 也不该打开 dream / inbox——那些都会写盘。
      if (this.phase !== "starting") {
        throw new Error(`启动途中状态变成了 ${this.phaseLabel}（多半是丢了 single-writer 租约）：启动失败`);
      }

      // 闹钟：**只读数据，先不补跑**。补跑会 deliver，而 deliver 要往 inbox 写——
      // 必须等 inbox 把序号从盘上初始化之后才行（见下一段）。
      if (this.schedule !== undefined) await loadSchedule(this.schedule);

      // 未消费的入站事实：崩溃前投进来、还没跑完的，在这里重放（§13.9 第 10 条）。
      // `restore()` 顺带把序号排到盘上最大之后——**它必须发生在任何投递之前**，否则新投递会从 000001
      // 重新开始，**盖掉盘上原有的那条**（实测：两条最后只剩一条）。它同时重建 dedupe index、
      // 迁移 legacy record，并按 ack marker 跳过已经逻辑 ack 的那批（§14.2.4）。
      await this.inbox.restore();

      // 恢复结束：关掉 restore-migration。**active business 先不开**——
      // 判据是 OR（lane 开 或 business 开），先把 business 打开就等于 managed-activation 形同虚设：
      // 那条 lane 关着的时候 Schedule 照样写得进去（实测）。
      this.gate?.closeLane("restore-migration");

      // **恢复到此为止**：规则、会话、任务、skill、inbox 都回来了，但一件自己动的事都还没做。
      // deferred 停在这儿等 `activate()`；immediate 直接往下走（保持既有 `start()` 语义）。
      this.assertTransitionAlive("start"); // 恢复途中可能已经丢锁：吸收态不许被写回
      this.phase = "restored";
      this.restoredReason = "deferred-start";
      if (activation === "immediate") await this.beginManagedWork();
    } catch (e) {
      // **把已经起来的东西收干净，再把原错误抛出去。**
      // 顺序上 startSchedule 目前是最后一步、之后不会再抛，但依赖这一点是脆弱的：
      // 以后在它后面加一步，就会漏一个野定时器出去——那种污染跨测试、跨进程都难查。
      this.stopInboxPoll();
      if (this.schedule !== undefined) stopSchedule(this.schedule);
      if (acquired !== undefined) {
        // **revoke 排在 release 之前**：只 release 的话，锁已经还回去了而本代 view 还写得进去——
        // 公开的 `addSchedule(agent.schedule, …)` 就能往已经不归自己的状态根里写（实测）。
        this.gate?.revoke();
        this.startFencedError = e instanceof Error ? e : new Error(String(e));
        this.lease = undefined;
        try {
          await acquired.release();
        } catch {
          /* 释放失败不该盖掉真正的启动错误 */
        }
      }
      // 回到 new：**拿锁之前**失败是可重试的（换个状态根、修好坏档再来），不是终态。
      // install 之后失败则由 `startFencedError` 挡住重试；**lost 也是终态**，不能被这一行打回可重试。
      if (this.phase === "starting" || this.phase === "restored") {
        this.phase = "new";
        this.restoredReason = null;
      }
      throw e;
    }
  }

  /**
   * 从 `restored(deferred-start)` 切到 `running`：**只消费这一种 reason**，调错 fail-loud。
   * 与 `resumeManagedWork()` 复用同一段原子 transition——只有 phase 真的切了才启动 producer。
   */
  async activate(): Promise<void> {
    return this.transitionManaged("activate", "deferred-start");
  }

  /**
   * handoff 专用的 drain 接缝（§14）：`running → pausing → restored(paused)`。
   * 停新的 Schedule / Inbox / Background producer，abort 并 settle 低优先级 Dream，drain 已 accepted 的
   * foreground permit；business gate 在此期间 open→draining，全部 settle 之后 closed。
   * **它不关 durable-ingress target、不 seal、不 flush、不 release Lease**——那些是 `stop()` 的事。
   */
  async pauseManagedWork(input: { reason: "handoff" }): Promise<void> {
    // 参数校验是同步的、与相位无关，留在外层；**相位判断一律在 actor 内**（见 P0 的两条反例）。
    if (input?.reason !== "handoff") throw new Error(`pauseManagedWork 只服务 handoff，收到 reason=${String(input?.reason)}`);
    return this.runLifecycle(async () => {
      this.assertTransitionAlive("pauseManagedWork");
      if (this.phase === "restored" && this.restoredReason === "paused") return;
      if (this.phase !== "running") throw new Error(`pauseManagedWork 只允许从 running 进入，当前是 ${this.phaseLabel}`);
      this.phase = "pausing";
      // ① 关新的 producer intake：Schedule timer、Inbox consumer、Dream，**以及 RunIntakeGate 的
      //    reconfiguration barrier**——不立那道闸的话，drain 期间源源不断的 followUp 能把前台 run 无限延长，
      //    handoff 永远等不到头（实测饥饿）。business gate 同时 open → draining：不接新 permit / operation，
      //    但让 barrier 之前已经在跑的把既有业务写做完。
      this.intake.closeForReconfiguration();
      this.autoConsumeInbox = false;
      this.autoDream = false;
      this.gate?.setActiveBusinessMode("draining");
      this.stopInboxPoll();
      if (this.schedule !== undefined) stopSchedule(this.schedule);

      // ② 等已经登记的受管工作真的做完：
      //    - schedule：`stopSchedule()` 只取消后续 timer，**挡不住已经开始的那一拍**，而那一拍还在写
      //      schedules.json——必须 `settleTick()`；
      //    - Dream 是 maintenance：abort 并等它真停；foreground **不 abort**，正常 drain 到 permit closure；
      //    - Background：等 barrier 之前已登记任务各自的 `settled`（新的进不来，intake 已关）。
      if (this.schedule !== undefined) await settleTick(this.schedule);
      await this.settleDream();
      await this.activeRun?.promise;
      await this.settleBackground();
      await this.settleWrites();

      // ③ 全部 settle 之后才 closed，再进 restored(paused)——
      //    禁止出现 `restored(paused) + draining/open` 的可观察组合。
      //    **提交之前重问一遍**：这段里可能已经 stop() 或丢锁了，那两个是吸收态。
      this.assertTransitionAlive("pauseManagedWork");
      this.gate?.setActiveBusinessMode("closed");
      this.phase = "restored";
      this.restoredReason = "paused";
    });
  }

  /** 从 `restored(paused)` 回到 `running`：**只消费这一种 reason**。 */
  async resumeManagedWork(): Promise<void> {
    return this.transitionManaged("resumeManagedWork", "paused");
  }

  /** `activate()` / `resumeManagedWork()` 的共同实现：同一段原子 transition，只有 reason 对得上才走。 */
  private async transitionManaged(who: string, expected: "deferred-start" | "paused"): Promise<void> {
    // **不在外层读相位**：`pauseManagedWork()` 之后同一 tick 调 `resumeManagedWork()`，外层读到的还是旧的
    // running，于是它「幂等」地提前返回，Agent 最终停在 restored(paused)（实测）。
    return this.runLifecycle(() => this.transitionInActor(who, expected));
  }

  /** actor 内的 transition：相位判断、幂等判断、相位写入全在这儿。 */
  private async transitionInActor(who: string, expected: "deferred-start" | "paused"): Promise<void> {
    this.assertTransitionAlive(who);
    if (this.phase === "running") return; // 幂等（轮到自己时才判）
    if (this.phase !== "restored") throw new Error(`${who} 只能从 restored 进入，当前是 ${this.phaseLabel}`);
    if (this.restoredReason !== expected) {
      throw new Error(`${who} 只消费 restored(${expected})，当前是 ${this.phaseLabel}——调错了接缝`);
    }
    await this.beginManagedWork();
  }

  /**
   * 排进 lifecycle actor。**幂等串行**：并发调用排队，不各跑一半；前一个失败也不阻塞后面的
   * （链上两支都接住，失败由各自的调用方拿到）。
   */
  private runLifecycle<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueueLifecycle(work).promise;
  }

  /** 入队并**发一张票**：调用方据此判断「我还是不是队尾」，决定能不能让后来者共享自己的 promise。 */
  private enqueueLifecycle<T>(work: () => Promise<T>): { ticket: number; promise: Promise<T> } {
    const ticket = ++this.lifecycleSeq;
    this.lastQueuedTicket = ticket;
    const promise = this.lifecycleChain.then(work, work);
    this.lifecycleChain = promise.then(
      () => undefined,
      () => undefined,
    );
    return { ticket, promise };
  }

  /**
   * **每个 await 之后、提交任何相位之前都要重问一遍**：`stopping` / `stopped` / `lost` 是吸收态，
   * 进去了就不许被一个还在飞的 transition 写回 running。写入格不再是 installed 时同理——那说明
   * 租约已经交还或丢失，这一代 Agent 不该再自己动。
   */
  private assertTransitionAlive(who: string): void {
    if (this.leaseLostError !== null || this.phase === "lost") {
      throw new Error(`${who}：已丢失 single-writer 租约，拒绝继续（${this.leaseLostError?.message ?? "lost"}）`);
    }
    if (this.phase === "stopping" || this.phase === "stopped") throw new Error(`${who}：Agent 正在收摊或已停（${this.phaseLabel}）`);
    if (this.gate !== undefined && this.gate.cell.state() !== "installed") {
      throw new Error(`${who}：写入格不是 installed（${this.gate.cell.state()}）——租约已交还或丢失`);
    }
  }

  /**
   * 「开始自己动」：Schedule 补跑 + timer、Dream 与 Inbox consumer 的开关、business gate 打开。
   * `start()`（immediate）、`activate()`、`resumeManagedWork()` 三条路共用这一段——**只有 phase 切成 running
   * 之后才算真的在跑**，producer 也才在那之后启动。
   */
  private async beginManagedWork(): Promise<void> {
    // 补跑的写只走 managed-activation（§14.9 lane 表）：Schedule catch-up 的 delivery / cursor / expired 都在
    // 这条 lane 上，timer 不用它。**business 仍关着**——判据是 OR，先开 business 这条 lane 就形同虚设。
    if (this.schedule !== undefined) {
      const closeActivation = this.gate?.openLane("managed-activation");
      try {
        await startSchedule(this.schedule);
      } finally {
        closeActivation?.();
      }
    }

    // **catch-up 是异步的，这中间可能已经 stop() 或丢锁**——上一版无条件往下写 running，
    // 于是一个已经释放了 Lease 的 Agent 被写回 running、timer 也起来了（实测）。提交之前重问一遍。
    this.assertTransitionAlive("beginManagedWork");

    // 补跑做完、lane 关上，才进入「正常在跑」的写
    this.gate?.setActiveBusinessMode("open");
    this.intake.reopenAfterReconfiguration();

    // 常驻行为（§13.12.4）：**「常驻」在机制上的全部区别就是这两条**——会自己醒（消费 inbox）、会自己整理（dream）。
    // 打开必须在恢复之后：先开的话，dream 可能在 session 还没灌进来时就跑起来。
    if (this.memory !== undefined) this.autoDream = true;
    this.autoConsumeInbox = true;
    this.startInboxPoll();
    this.publishPhase("idle"); // 起来了、还没活干：别人现在问它，它能马上答

    this.phase = "running";
    this.restoredReason = null;

    // **恢复出来的那批要真的被吃掉。** 只把开关拨到 true 是不够的：它只在「下一次有事投进来」时才生效，
    // 没有后续事件的话，恢复的事实会永远躺在队列里（实测；此前的测试是手动调 `consumeInbox()` 才绿的）。
    // 不 await：`start()` 的语义是「起来了」，不是「把积压都跑完了」。
    if (this.inbox.pendingCount > 0) void this.consumeInbox();
  }

  /**
   * 收摊：drain/abort 受管活动 → 等 pending durable write settle → 释放 lease。
   *
   * **Store 面上没有 flush**（§13.12.2）：`write()` resolve 即持久，所以这里等的是
   * 那些还没 settle 的 write，不是「调一个 flush 方法」。
   */
  async stop(): Promise<void> {
    // 外层只做同操作的 in-flight 共享；**幂等（phase === "stopped"）由 `doStop()` 在 actor 内判**——
    // 在外层判等于读入队那一刻的旧相位。共享同样要求「那次 stop 仍是队尾」（理由同 `start()`）。
    if (this.stopInFlight !== undefined && this.stopInFlight.ticket === this.lastQueuedTicket) {
      return this.stopInFlight.promise;
    }
    const { ticket, promise } = this.enqueueLifecycle(() => this.doStop());
    this.stopInFlight = { ticket, promise };
    try {
      await promise;
    } finally {
      if (this.stopInFlight?.ticket === ticket) this.stopInFlight = undefined;
    }
  }

  private async doStop(): Promise<void> {
    // **启动一定已经收干净了**：start / activate / pause / resume / stop 排在同一条 lifecycle actor 上，
    // 轮到 stop 时前面那个 transition 必然已经 settle。上一版靠 `await this.startInFlight` 自己等，
    // 那在「stop 先入队、start 后入队」时会死等一个还没轮到的 promise。
    if (this.phase === "stopped") return; // 等的过程中被别人停掉了
    this.phase = "stopping"; // 吸收态：从这里起任何在飞的 transition 都不许再写回 running

    // **收摊期间租约还在手上，`this.lease` 就不能提前清掉。**
    // 上一版在这里就置 undefined，于是 `watchLease` 的过期判据（`this.lease !== lease`）
    // 把「收摊途中真的丢了锁」误判成「已经正常还回去了」而直接 return——不 seal、不 abort，
    // 于是 `dispose()` 的最终写（tasks / session / inbox）照样写进已经归别人的状态根。
    // 这是 single-writer 那条不变量在收摊路径上的最后一块（2026-08-24 第四轮 review）。
    // 清空挪到 `release()` 之前那一刻：从那时起这把租约才真的不属于本 Agent。
    const lease = this.lease;

    // **释放与状态复位必须发生，无论收摊是否抛错**：lease 若不还回去，状态根会被一个
    // 已经停了的进程永久占住——实测过（注入一个抛错的 disposable，`stop()` reject，
    // 之后第二次 acquire 一直拿不到）。所以这里先各自捕获，最后再决定抛哪个。
    // shutdown 不走 `draining`（那是 handoff 的接缝）：同一段里直接把 active business 关掉、
    // 打开 lifecycle-finalization——abort terminal、session settle/seal、尾写都只走这条 lane（§14.9 第 5 条）。
    // **只有写入格还 installed 时才开这条 lane**：启动失败或丢锁之后格子已 revoke，那时 stop() 仍要把资源关干净，
    // 但一个字节都不该再写状态根。
    const gateUsable = this.gate !== undefined && this.gate.cell.state() === "installed";
    if (gateUsable) {
      this.gate?.setActiveBusinessMode("closed");
      this.gate?.openLane("lifecycle-finalization");
    }

    // **三类错误各收各的**：收摊、lifecycle fence、释放。上一版 fence 失败在 `shutdownError !== null` 时被直接丢弃，
    // 最终只看得到 dispose 那条（实测）。全部执行完之后：一个原样抛，多个 AggregateError。
    const errors: unknown[] = [];
    let shutdownError: { readonly e: unknown } | null = null;
    try {
      // **收摊的全部顺序在 `dispose()` 里**：停新活动 → 等全部落盘 settle → 关一次存储。
      // 这里不再另外补 `settleWrites()` / `sessionService.settle()`——它们排在 `dispose()`
      // 之后就等于排在 `close()` 之后，那正是上一版的 P0。
      await this.dispose();
    } catch (e) {
      shutdownError = { e };
    }
    this.phase = "stopped";

    let releaseError: { readonly e: unknown } | null = null;
    if (shutdownError !== null) errors.push(shutdownError.e);
    try {
      // **最后一站，且 cell 仍 installed**：Host 自己的 writer 在这里 flush / close（§14.5）。
      // 它不拥有 ingress target、也不重复 drain——那些在 dispose() 里已经做完了。
      // **只有仍持合法租约、且没进过 loss fence 时才调**：从没 start() 过、或者已经丢锁走过 `onLeaseLost()` 的，
      // 这条正常释放 fence 根本不该发生（丢锁路径只做 loss-safe 的资源清理）。
      if (gateUsable && lease !== undefined && this.leaseLostError === null) {
        await this.leaseLifecycle?.beforeLeaseRelease({ reason: "stop" });
      }
    } catch (e) {
      errors.push(e);
    }
    try {
      // **固定顺序**：revoke cell + 关根闸 → 再 release。这三步之间禁止任何 state-root I/O，
      // 所以 revoke 必须排在 release 之前——反过来的话，锁已经归别人而本进程的 view 还写得进去。
      this.gate?.revoke();
      this.lease = undefined; // 从这一刻起才不再持有：`watchLease` 之后收到的信号确实过期了
      await lease?.release();
    } catch (e) {
      releaseError = { e };
    }

    // **释放失败绝不能吞**：吞了的话调用方以为安全收摊，而 `.lock` 可能还躺在状态根里，
    // 下一个进程永远起不来（实测过 stop() 照样 resolved）。
    if (releaseError !== null) {
      const e = releaseError.e;
      errors.push(
        new Error(
          `收摊完成但 single-writer 锁没释放掉：${e instanceof Error ? e.message : String(e)}` +
            `——状态根可能仍被占着，需人工确认`,
          { cause: e },
        ),
      );
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `stop() 收摊有 ${errors.length} 处失败（收摊 / lifecycle fence / 释放）`);
  }

  /**
   * 丢锁善后。顺序不可调换（§13.12.3）：
   * ① 停止一切持久化 → ② abort 当前工作 → ③ 拒绝新工作 → ④ 发错误事件。
   *
   * **不能 drain**：drain 的定义是「做完手上的事」，而做完必然要写盘——那正是 ① 禁止的。
   */
  private async watchLease(lease: Lease): Promise<void> {
    const error = await lease.lost;
    if (this.lease !== lease) return; // 已经正常 release 过了，这条信号过期
    // **同步立吸收态**：不排队、不等在飞的 transition——它们会在自己的下一个 await 之后看到 lost 而拒绝提交。
    // ① 的第一刀是 revoke：状态根已经不归本进程，loss fence **不得补 flush**（比只 seal session 硬：
    // 任务清单、skill、inbox 也一起封）。
    this.gate?.revoke();
    this.sessionService?.seal(); // ①
    this.persistSealed = true; // ① 的另一半：任务清单与 skill 落盘也是持久化，此前它们没被封
    this.leaseLostError = error; // ③ 的开关，先置上免得 abort 触发的收尾又开新活
    this.phase = "lost";
    this.intake.closeForReconfiguration(); // 新的 steer / followUp 不再 accepted
    this.abort("lease-lost"); // ②
    // admission 关门：排队的 rejected(lease-lost)，在跑的（含整理）abort 并**等它真停**——
    // 不等的话，租约已经归别人、旧 dream 还在往 memory 里写。
    // 剩下的善后**整段**排进同一次 actor work：与 stop / transition 不交错，中间也不给别的 transition 插空
    await this.runLifecycle(async () => {
      await this.admission.close("lease-lost");
      await this.settleDream();
      // Host 自己的 writer 也要封口（幂等，每份 Lease 至多一次）；它同样不 flush 已失权的状态根
      try {
        await this.leaseLifecycle?.onLeaseLost(error);
      } catch (e) {
        this.reportDiagnostic({ code: "lease_lost_fence_failed", message: `丢锁封口失败：${errText(e)}` });
      }
      this.reportDiagnostic({ code: "lease_lost", message: `single-writer 租约丢失：${error.message}` }); // ④
    });
  }

  /**
   * 给任务工具套一层「改完排一次落盘」。**包在工具上而不是在 `TaskMap` 上**：
   * Map 是裸数据（2026-08-05 拍定的形态），没有改动通知；而工具是 Agent 自己注册的，
   * 这里正好是它知道「刚才可能改了」的唯一确定点。
   *
   * 无论成败都标脏：失败的 `TaskUpdate` 也可能已经改了一半，多写一次盘不亏。
   */
  /** `start()` 的「发现 Skills」：读 `skillStore` 里每个 `<name>/SKILL.md`。逐文件容错，见调用处注释。 */
  private async discoverSkills(store: StorageDir): Promise<void> {
    let keys: string[];
    try {
      keys = await store.list("");
    } catch (e) {
      // 整个目录列不出来才是启动级的问题——那不是「一个坏 skill」，是端口坏了
      throw new Error(`skill 目录列不出来：${errText(e)}`, { cause: e });
    }
    for (const key of keys) {
      const name = skillNameOfEntry(key);
      if (name === null) continue; // 附件或无关文件
      const diagnostics: Diagnostic[] = [];
      let skill: Skill | null = null;
      try {
        const raw = await store.read(key);
        if (raw === null) continue; // list 与 read 之间被删了——不是错误
        skill = parseSkillText(name, raw, diagnostics, key);
      } catch (e) {
        diagnostics.push({ code: "skill_load_failed", message: errText(e), path: key });
      }
      for (const d of diagnostics) this.reportDiagnostic(d);
      if (skill === null) continue;
      if (this.skills.has(skill.name)) {
        this.reportDiagnostic({ code: "skill_name_clash", message: `skill '${skill.name}' 已在池中，忽略发现的同名`, path: key });
        continue;
      }
      this.skills.set(skill.name, skill);
    }
  }

  /**
   * `skill_create` 的落盘（`onCreate`）：进池之后写 `<name>/SKILL.md`。
   * 保真兜底——写出去读回来必须逐字相等，否则**宁可不写**（校验本该已挡住，
   * 这里红了是校验漏了一种情况，也要报出来）。
   *
   * **租约门只在 `guardedSkillCreate` 入口查一次，这里不重查**：从入口到 `store.write`
   * 之间（`createSkill` → `onCreate` → 本函数）没有任何 await，重查永远看到同一个状态——
   * 第一版在这里放了一道「写前重检」，证伪时摘掉零红，那就是死代码，还在注释里声称一个
   * 不存在的窗口。Task 落盘需要执行点重检是因为它**排队**（写链尾），这里不排队。
   * 将来若有人在 `onCreate` 之前插了 await，这条注释就是要回来重新审视的地方。
   */
  private async saveSkill(name: string): Promise<void> {
    const store = this.skillStore;
    const skill = this.skills.get(name);
    if (store === undefined || skill === undefined) throw new Error(`skill '${name}' 刚创建却不在池里`);
    const unfaithful = roundTripError(skill);
    if (unfaithful !== null) throw new Error(`拒绝落盘：${unfaithful}`);
    await store.write(skillEntryPath(name), serializeSkill(skill));
  }

  /**
   * 给 `skill_create` 套单写者租约门：**没有租约就不许进池**，在 `inner` 之前拦——
   * 这里能做到「零副作用地拒绝」（Task 工具做不到，它的 inner 先改 map），就不留局部生效。
   * 别的 skill 工具原样返回。
   */
  private guardedSkillCreate(tool: AgentTool): AgentTool {
    if (tool.kind !== "model" || tool.name !== "skill_create") return tool;
    const inner = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (params: never, ctx: never) => {
        if (!this.persistAllowed) {
          return toolError(`${NO_LEASE_MESSAGE}这次创建**没有执行**（池里也没有）。不要重试；请把这件事告诉用户。`);
        }
        return inner(params, ctx);
      },
    } as AgentTool;
  }

  /**
   * 给四个内核 Task 工具套一层：**返回成功之前先把改动写到盘上**。
   *
   * 上一版只在 `finally` 里排一个 microtask 就返回成功，于是慢 Store 下模型收到
   * 「已建 N 条」而盘上什么都没有（review 第 1 条实测 `persisted:false`）。
   * 现在 `await flushTasks()`——**写失败就不能再说成功**，改成 toolError 让模型看见。
   *
   * `inner` 抛错时也要落盘：它可能已经改了一部分（比如批量建任务建到一半），
   * 那些改动不该因为这次调用失败就留在内存里。
   */
  private persistingTaskTool(tool: AgentTool): AgentTool {
    if (tool.kind !== "model" || this.taskStore === undefined) return tool;
    const inner = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (params: never, ctx: never) => {
        let result: AgentToolResult;
        try {
          result = await inner(params, ctx);
        } catch (e) {
          // 已发生的改动仍要落盘；这次调用的失败照原样往上抛
          void this.flushTasks().catch((err: unknown) =>
            this.reportDiagnostic({ code: "tasks_persist_failed", message: errText(err) }),
          );
          throw e;
        }
        try {
          if ((await this.flushTasks()) === "cancelled") {
            // **取消不是成功**：没拿到单写者租约（还没 `start()`）或已经丢了它，
            // 这一笔根本没写出去。回执必须说出来，否则模型以为清单已经存下了。
            return toolError(
              `任务清单**已经在当前进程里改好了**（清单里能看到），但没有写到盘上：` +
                `这个 agent 没有持有状态根的单写者租约（还没启动，或者租约已经丢失）。` +
                `这次改动重启后会丢失。**不要重试**——重试只会建出重复的任务；请把这件事告诉用户。`,
            );
          }
        } catch (e) {
          // **措辞必须与真实状态一致**：`inner` 已经把清单改了，回执却说「没有生效」，
          // 而下一轮的任务注入里那条任务明明在——模型据此重试就会建出重复任务
          // （2026-08-24 第二轮 review 的第 2 条，实测 `isError:true` 而 `total:1`）。
          // 这里选的是**如实说明局部生效**，不是回滚：回滚要给并行工具调用做序列化，
          // 而且 `inner` 的副作用不止 Map 一处（id 计数器等），假装能整个撤销才是更大的谎。
          return toolError(
            `任务清单**已经在当前进程里改好了**（清单里能看到），但没能写到盘上：${errText(e)}。` +
              `这个进程重启后这次改动会丢失。**不要重试**——重试只会建出重复的任务；` +
              `请把这件事告诉用户。`,
          );
        }
        return result;
      },
    } as AgentTool;
  }

  /**
   * 现在允不允许**自动**落盘任务（`ObservedTaskMap` 的挂钩与工具路径都问它）。
   *
   * 三条，缺一不可（2026-08-24 第二轮 review 的第 1 条，两条复现都是真的）：
   *   · 丢锁 → **永久**不许。租约归了别人，新 holder 可能已经在写同一份文件。
   *   · 受生命周期管 → **只有 running**。`createAgent()` 之后、`start()` 之前根本还没拿锁，
   *     那时写 `tasks.json` 就是在没有单写者资格的情况下动状态根；`stop()` 之后锁已经还了，
   *     同理。
   *   · 不受管的裸 `new Agent()`（没锁也没 session）→ 一直允许：它本来就不在单写者语义里。
   *
   * **收摊那一笔不走这里**——`dispose()` 直接调 `enqueueTaskWrite()`，它只看 seal。
   * 那时 phase 已经是 `stopping`，但 lease **还在手上**（`stop()` 先 dispose 再 release），
   * 所以那一笔是合法的，也是必须的（不写就丢清单）。
   */
  private get taskAutoWriteAllowed(): boolean {
    return !this.taskPersistSuppressed && this.persistAllowed;
  }

  /**
   * **运行期**的持久化许可——任何「工具跑着跑着要写状态根」的路径都问它
   *（任务的自动写、`skill_create` 的落盘）。三条：丢锁后永久不许；受生命周期管时只有
   * `running`；配了 `stateLock` 就必须真的持有租约（从没 `start()` 过的 Agent 拿不到）。
   * 不受管的裸 `new Agent()` 一直允许——它本就不在单写者语义里。
   */
  private get persistAllowed(): boolean {
    if (this.persistSealed) return false;
    if (this.lifecycleManaged && this.phase !== "running") return false;
    return this.stateLock === undefined || this.lease !== undefined;
  }

  /**
   * **收摊那一笔**（`dispose()` 直接调 `enqueueTaskWrite()`）允不允许写。
   *
   * 比 `taskAutoWriteAllowed` 宽一档——它必须允许 `stopping`，那时 phase 已经不是 running
   * 而租约还在手上，不写就丢清单。但**宽的只有 phase 这一项**：
   *
   * · 配了 `stateLock` → **必须真的持有租约**。上一版只看 seal，于是从没 `start()` 过的
   *   Agent（压根没拿过锁）一 `dispose()` / `stop()` 就往状态根写一次——越权，实测复现。
   *   seal 只在「拿到过又丢了」时才置上，拦不住「从没拿到过」。
   * · 没配 `stateLock` → 本来就没有单写者语义，照写。
   */
  private get taskFinalWriteAllowed(): boolean {
    if (this.persistSealed || this.taskPersistSuppressed) return false;
    if (this.stateLock === undefined) return true;
    return this.lease !== undefined;
  }

  /**
   * 把当前快照写到盘上——**串在写链尾**，前一笔 settle 之前不会开始下一笔。
   *
   * 并发地写全量快照会乱序覆盖：慢 Store 下新快照先落、旧快照后落，旧的把新的盖掉
   * （2026-08-24 review 第 2 条，用「第一笔阻塞、第二笔立刻完成」的 Store 复现过）。
   * 快照在**执行那一刻**取，所以排队期间的后续改动会被这一笔顺带写掉——那是合并，不是丢失。
   */
  private enqueueTaskWrite(): Promise<TaskWriteOutcome> {
    const store = this.taskStore;
    if (store === undefined || !this.taskFinalWriteAllowed) return Promise.resolve("cancelled");
    // **执行前再查一次**：排队时还持有租约、轮到自己时已经丢了，是完全可能的时序。
    // 只在排队时查等于「查了个过期的事实」——这一笔就会写进别人正在写的文件。
    const doWrite = async (): Promise<TaskWriteOutcome> => {
      if (!this.taskFinalWriteAllowed) return "cancelled";
      await saveTasks(this.tasks, store);
      return "written";
    };
    // 前一笔失败**不许断链**：断了之后所有后续写都不会发生，而且是静默的
    const write = this.taskWriteTail.then(doWrite, doWrite);
    this.taskWriteTail = write.then(
      () => undefined,
      () => undefined,
    );
    // **留一份没被吞掉错误的**给 `flushTasks()`。`taskWriteTail` 两支都转成 resolve
    // （断链会让后续写全部静默消失），拿它当「上一笔的结果」就等于永远说成功——
    // 实测过：写抛错而工具照样回执 isError:false。
    // 这里先挂一个空 handler 只为**标记 handled**（防 unhandled rejection 报警），
    // 原 promise 仍然可以被 await 并抛出。
    void write.catch(() => undefined);
    this.taskLastWrite = write;
    return write;
  }

  /**
   * 排一笔落盘并返回它。**同一拍里的多次改动合并成一笔**——重复调用拿到的是同一个 promise，
   * 所以「map 改动的自动挂钩」与「工具等落盘」走的是同一笔写，不会各排各的。
   */
  private schedulePersistTasks(): Promise<TaskWriteOutcome> {
    if (this.taskStore === undefined || !this.taskAutoWriteAllowed) return Promise.resolve("cancelled");
    if (this.taskPending !== undefined) return this.taskPending;
    const queued = Promise.resolve().then((): TaskWriteOutcome | Promise<TaskWriteOutcome> => {
      this.taskPending = undefined;
      // **排队与执行之间状态会变**：这一拍里可能刚 `stop()` 完、或刚丢了锁。
      // 排队时那次检查只说明「当时可以」。
      if (!this.taskAutoWriteAllowed) return "cancelled";
      return this.enqueueTaskWrite();
    });
    this.taskPending = queued;
    // 收摊要等它：`pendingWrites` 收的是**已处理过 rejection 的**那份，
    // 否则 `stop()` 里的 allSettled 之外还会多出一个 unhandled rejection。
    const tracked: Promise<void> = queued
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => this.pendingWrites.delete(tracked));
    this.pendingWrites.add(tracked);
    return queued;
  }

  /**
   * 等「此刻为止的全部改动」都落盘，并**如实说出结果**。**工具返回成功之前走这一步。**
   *
   * 返回 `"cancelled"` 而不是 resolve 掉，是 2026-08-24 第三轮 review 的那条：
   * 上一版把「成功写完」与「因为丢锁/没拿锁而取消」都表示成 resolve，
   * 于是工具照样回执成功——**取消不是成功**，盘上什么都没有。
   *
   * 顺序有讲究：
   *   · 有排队的那笔 → 等它（它自己会在执行点重查一次 seal）；
   *   · 没有排队但**此刻不允许写** → 就是被取消了，别拿上一笔的成功冒充这一次；
   *   · 都不是 → 等上一笔的真实结果；连上一笔都没有 = 没有欠账，算写完。
   */
  private flushTasks(): Promise<TaskWriteOutcome> {
    if (this.taskPending !== undefined) return this.taskPending;
    if (!this.taskAutoWriteAllowed) return Promise.resolve("cancelled");
    return this.taskLastWrite ?? Promise.resolve("written");
  }

  /* ───────────── 私有：运行 ───────────── */

  /**
   * 用户输入进 transcript 的**唯一准入口**（§14.7.5 第 3 条）：初始 prompt、steering、followUp 三条路都从这里过
   * `userPromptSubmit` 拦截，事件的 `source` 由入口如实标（human / steer / followUp），不从消息上猜。
   * patch → 改写正文后的消息才进 transcript；block → 不进 transcript，记一条 `user_prompt_blocked` 诊断
   * ——队列里那条消息就此结清，不会静默消失也不会偷偷转成别的入口。
   * 上一版只在初始 prompt 拦、steer/followUp 直接进 transcript，而且把 followUp 记成了 "human"。
   */
  private async admitUserMessages(
    messages: readonly AgentMessage[],
    source: "human" | "steer" | "followUp",
  ): Promise<{ admitted: AgentMessage[]; blocked: number }> {
    const admitted: AgentMessage[] = [];
    let blocked = 0;
    for (const m of messages) {
      if (m.role !== "user") {
        admitted.push(m);
        continue;
      }
      const text = textOf(m);
      const r = await this.hooks.intercept({ type: "userPromptSubmit", text, source }, this.hookContext());
      if (r.decision === "block") {
        blocked += 1;
        this.reportDiagnostic({
          code: "user_prompt_blocked",
          message: `userPromptSubmit（${source}）被 hook 拦下，未进 transcript：${r.reason ?? "无理由"}`,
        });
        continue;
      }
      admitted.push(r.event.text === text ? m : withUserText(m, r.event.text));
    }
    return { admitted, blocked };
  }

  private async runPromptMessages(
    messages: AgentMessage[],
    options: { source?: "human" | "steer" | "followUp" } = {},
  ): Promise<AgentRunResult> {
    return this.admitUserRun(this.foregroundExecutor(messages, options.source ?? "human"));
  }

  private async runContinuation(): Promise<AgentRunResult> {
    return this.admitUserRun(async (scope, signal) =>
      runAgentLoopContinue(await this.createContextSnapshot(scope), this.createLoopConfig(scope), (e) => this.processEvents(e), signal, scope.modelBinding.streamFunction),
    );
  }

  /** 前台 run 的执行体：准入（userPromptSubmit）→ 起循环。prompt 与 Inbox 共用，只有 source 不同。 */
  private foregroundExecutor(messages: readonly AgentMessage[], source: "human" | "steer" | "followUp"): RunExecutor {
    return async (scope, signal) => {
      const { admitted, blocked } = await this.admitUserMessages([...messages], source);
      if (admitted.length === 0 && blocked > 0) {
        // 全部被拦下：**不进 transcript、不起循环**——没有 agent_start，也就没有半截 run。
        return { outcome: { kind: "aborted", reason: `userPromptSubmit（${source}）被 hook 拦下` }, messages: [] };
      }
      return runAgentLoop(admitted, await this.createContextSnapshot(scope), this.createLoopConfig(scope), (e) => this.processEvents(e), signal, scope.modelBinding.streamFunction);
    };
  }

  /**
   * 拒绝新工作的三道检查——prompt / continue / consumeInbox 在 enqueue 之前**同步**调。
   * 它们是**所有 run 入口的必经处**；挂在某一个入口上就会漏掉别的路。
   */
  /**
   * Inbox 的 ack 无法裁决（indeterminate）：状态根处于不确定状态，**本进程不得自行解封**。
   * 关掉 inbox 消费与自动整理、拒绝新工作，并把失败落进 `state.lastError`——它是可见的，不是一条会被刷掉的通知。
   */
  private enterInboxFailure(error: InboxAckError): void {
    if (this.inboxFailure !== null) return;
    this.inboxFailure = error;
    this.autoConsumeInbox = false;
    this.autoDream = false;
    this._state.lastError = { source: "internal", code: "internal", retryable: false, message: error.message };
    this.reportDiagnostic({ code: "inbox_indeterminate", message: `${error.message}——已停止接受新工作，需重启重新裁决` });
  }

  /**
   * **接不接新工作，只有这一份判据**（`acceptsWork` / `assertAcceptsWork()` / `prompt()` 共用）。
   *
   * 拆出来的理由是它曾经散成三份：`prompt()` 自己查一遍重入、`assertAcceptsWork()` 查其余四组、
   * 而外面的壳子（TUI）只能从 `status` 之类的公共读**猜**——猜到第四轮还差一个 Inbox ack 窗口
   *（`closeRun()` 已置 `status = "idle"`，`inboxTicketOutstanding` 要等 `ackBatch()` 裁决才清，
   * 这中间 `prompt()` 照拒）。判据散着就必然有人对不齐，所以收成一处、并开一个只读面出去。
   *
   * @returns 拒绝理由；`null` = 现在可以起一轮新 run。顺序即优先级，与拆分前逐条一致。
   */
  private refuseWorkReason(): string | null {
    if (this.activeRun !== undefined || this.userRunPending) {
      return "Agent 正在处理上一个 prompt；用 steer() 或 followUp() 入队，或等它跑完";
    }
    if (this.inboxTicketOutstanding) {
      // Inbox 的一批从 reserve 到 ack 裁决之间不接新工作：裁决可能是「整批重放」或「封账本」，
      // 新 run 抢在那之前执行会把运行顺序弄坏。
      return "Inbox 的一批还在等 ack 裁决，暂不接受新工作——裁决出来之后再试";
    }
    if (this.inboxFailure !== null) {
      return `Inbox 账本无法裁决，拒绝新工作：${this.inboxFailure.message}`;
    }
    // 丢锁后拒绝新工作（§13.12.3 第 ③ 步）
    if (this.leaseLostError !== null) {
      return `已丢失 single-writer 租约，拒绝新工作：${this.leaseLostError.message}`;
    }
    // **收摊一开始就不接活，受不受生命周期管都一样。**
    // 上一版把这一整段挂在 `lifecycleManaged` 下面，于是低层 `new Agent()` 停掉之后
    // `acceptsWork` 仍报 true，而 `prompt()` 早已被 admission 拒（`run 被 admission 拒绝：stopping`）——
    // 这正好破了这个 API 自己承诺的「与 `prompt()` 同真同假」（review 六轮 P1 实测）。
    // 顺序与 `ingressGate()` 一致：**stopping 先判**，因为 `stop()` 内部一定会调 `dispose()`，
    // 先判 disposeInFlight 会把整个收摊过程报成 runtime-disposed。
    if (this.stopInFlight !== undefined || this.phase === "stopping") {
      return "Agent 正在停止（stopping），不接受新工作";
    }
    if (this.disposeInFlight !== undefined || this.phase === "stopped") {
      return "Agent 已收摊（runtime-disposed），不接受新工作：要新的实例请重新装配";
    }
    // 同理，这几个相位也与「有没有锁」无关：pausing 是 handoff 的 drain 接缝、restored 持锁但还没激活、
    // lost 是租约已经归别人。低层 Agent 走到这几个相位一样不能起 run。
    if (this.phase === "pausing" || this.phase === "restored" || this.phase === "lost") {
      return `Agent 当前状态是 ${this.phaseLabel}，不接受新工作`;
    }
    // **带持久化装配的 Agent 还要求恰好 running**：`new` / `starting` 时锁可能还没拿到、也可能随后回退。
    // 没有这条时实测过：旧 Agent stop() 之后、另一个 holder 已经拿到锁，旧 Agent 仍能写进两条 session message——单写者当场破。
    // 低层 `new Agent()` 不取锁也不恢复，`new` 阶段就能干活——**这是既有语义，唯一保留的那条**。
    if (this.lifecycleManaged && this.phase !== "running") {
      return `Agent 当前状态是 ${this.phaseLabel}，不接受新工作（只有 running 才接）`;
    }
    // 声明了「宿主会回答 ask」却没人订阅——在 run 入口就 fail-loud，不能等到 Tool 已经暂停才发现无人回答（§14.10.3）。
    if (this.permissionPolicy.responder === "host" && this.permissionPolicy.askTimeoutMs === null && !this.hooks.hasSubscribers()) {
      return 'permission 策略声明了 responder:"host" 且 ask 不超时，但没有任何 subscribeLifecycle() 订阅者——无人回答，拒绝开始 run';
    }
    return null;
  }

  private assertAcceptsWork(): void {
    const reason = this.refuseWorkReason();
    if (reason !== null) throw new Error(reason);
  }

  /** 用户 run：经 admission 取 permit、等 ticket 结算。rejected 只来自关门（stopping / lease-lost），抛出来。 */
  private async admitUserRun(executor: RunExecutor): Promise<AgentRunResult> {
    this.userRunPending = true;
    try {
      const ticket = this.admission.admitUser((scope) => this.executeAdmitted(scope, executor));
      const settled = await ticket.settled;
      if (settled.kind === "rejected") {
        // canonical store 在 admission 时不可写：user `send()` 收到的是带 persistence 证据的类型化错误（§15.12）
        if (settled.reason === "observation-unavailable") {
          throw new ObservationStoreUnavailableError(
            "run 被 admission 拒绝：canonical observation store 不可写（run.accepted 落不下去）",
            this.observation?.sequencer.persistenceState ?? { status: "healthy" },
          );
        }
        throw new Error(`run 被 admission 拒绝：${settled.reason}`);
      }
      // permit 已 close、ticket 已结算——这时才归 idle、才排 Inbox / Dream。
      // 先清 pending 标记再 finishRun：它里面的 consumeInbox() 看到 userRunPending 还是 true 就会直接返回（实测漏消费）。
      this.userRunPending = false;
      this.finishRun();
      return { ...settled.result, runId: settled.runId };
    } finally {
      this.userRunPending = false;
    }
  }

  /**
   * 拿到 permit 之后的生命周期外壳：占位 + AbortController（级联 scope 的 abort）+ 运行态置位 + intake 开关门 +
   * 终态暂存。**所有 run 入口共用**（prompt / continue / Inbox）；「一次只跑一个」归 admission 的单 permit，这里只做簿记。
   * 抛错原样往上：admission 捕获后交 `normalizeAdmittedCallbackFailure` 合成配对的终结事件。
   */
  private async executeAdmitted(scope: AgentAdmissionExecuteScope, executor: RunExecutor): Promise<LoopResult> {
    const runId = scope.runId;
    this.currentRunId = runId;
    this.runMessagesBefore = this._state.messages.length;
    // run intake 开门（§14 RunIntakeGate）：与 activeRun 落位同一同步段——从这一刻起 followUp() 才 accepted
    this.intake.openRun(runId);
    const abortController = new AbortController();
    const onScopeAbort = (): void => abortController.abort();
    if (scope.signal.aborted) abortController.abort();
    else scope.signal.addEventListener("abort", onScopeAbort, { once: true });
    let resolvePromise = (): void => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };
    this._state.status = "generating";
    this._state.startedAt = Date.now();
    this._state.lastError = null;
    try {
      // §15.5.2 第 4 步：permit executor 进入 loop 的那一拍 await `run.started`；落不下去只降级，不取消 run
      await this.observeRunStarted(runId);
      const result = await executor(scope, abortController.signal);
      this.terminalByRun.set(runId, result); // 终态已出：之后 callback 再抛，normalizer 复用它
      return result;
    } finally {
      scope.signal.removeEventListener("abort", onScopeAbort);
      // run 关门的兜底（§14 RunIntakeGate）：循环在 agent_end 之前关过了，这里通常 no-op；
      // 只有「全部被准入拦下、没起循环」或抛错的 run 从这里关。accepted 未消费的显式报出——不留给下一个 run。
      this.reportUnconsumed(this.intake.closeRun(), "run 结束");
      // run 封口：本 run 的 permission tombstone 从「一条不丢」转进有界池（§14.10.3 retention 至少到 run closure）
      this.permissions.closeRun(runId);
    }
  }

  /**
   * execute 抛了（循环违约或 bug）也要合成完整的事件序列——**订阅方永远看不到「缺一拍」的事件流**（§14.2.4）。
   * Host-internal、non-throwing：该 run 已有终态 → 复用暂存的 LoopResult，只记 contract failure，不发第二个 agent_end；
   * 尚无终态 → 合成 message/turn/agent 终结事件；sink 自身失败 → non-retryable internal fallback（Observation partial 归 O2f）。
   * Dream 的事件不外发，只给 LoopResult。
   */
  private async normalizeAdmittedCallbackFailure(input: { runId: string; source: RunSource; error: unknown; aborted: boolean }): Promise<LoopResult> {
    const { runId, error, aborted } = input;
    const stored = this.terminalByRun.get(runId);
    if (stored !== undefined) {
      this.reportDiagnostic({
        code: "run_callback_contract_failure",
        message: `run ${runId} 已有终态，callback 之后又抛错：${errText(error)}——复用原终态，不发第二个 agent_end`,
      });
      return stored;
    }
    const err: AgentError = {
      source: "internal",
      code: aborted ? "aborted" : "internal",
      retryable: false,
      message: errText(error),
    };
    const failure: AgentMessage = {
      role: "assistant",
      content: [],
      stopReason: aborted ? "aborted" : "error",
      usage: null,
      at: Date.now(),
      ...(aborted ? {} : { error: err }),
    };
    const outcome: AgentOutcome = aborted ? { kind: "aborted" } : { kind: "error", error: err };
    if (input.source.kind === "dream") return { outcome, messages: [failure] };
    try {
      await this.processEvents({ type: "message_start", role: "assistant" });
      await this.processEvents({ type: "message_end", message: failure });
      await this.processEvents({ type: "turn_end", iteration: this._state.iteration, message: failure as never, toolResults: [] });
      await this.processEvents({ type: "agent_end", outcome });
      return { outcome, messages: [failure] };
    } catch (sinkError) {
      this.reportDiagnostic({
        code: "run_failure_sink_failed",
        message: `run ${runId} 合成终结事件时 sink 失败：${errText(sinkError)}（原错误：${errText(error)}）`,
      });
      return {
        outcome: { kind: "error", error: { source: "internal", code: "internal", retryable: false, message: `终结事件落不下去：${errText(sinkError)}` } },
        messages: [],
      };
    }
  }

  /** 每次 admission 冻结的 model seam（§14.2.4）。standalone 没有 catalog：provider 身份固定为 echo:standalone。 */
  private modelBinding(input: { source: RunSource; purpose: "foreground" | "maintenance" }): RunModelBinding {
    const model = this._state.model;
    return Object.freeze({
      bindingId: `binding:${crypto.randomUUID()}`,
      source: Object.freeze({ ...input.source }),
      purpose: input.purpose,
      catalogRevision: `standalone:${this.catalogRevision}`,
      provider: Object.freeze({ id: model.provider, entryId: "echo:standalone", generation: "0" }),
      model: normalizeModelSnapshot(model),
      streamFunction: this.streamFunction,
      ...(this.getApiKey === undefined ? {} : { getApiKey: this.getApiKey }),
      thinkingLevel: this._state.thinkingLevel ?? "off",
      retryPolicy: Object.freeze({ maxAttempts: this.retryPolicy.maxAttempts, backoffMs: this.retryPolicy.backoffMs }),
      ...(this.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: this.maxRetryDelayMs }),
    });
  }

  /** finally 段。注意 agent_end 只表示「不会再有循环事件」，**idle 比它晚一步**。 */
  private finishRun(): void {
    this.closeRun();
    this.scheduleAutonomousWork();
  }

  /**
   * 归 idle / 关闭当前 run。**不调度下一轮**——那一步拆出去了：Inbox 的一轮在整批 ack 裁决**之后**才允许排下一批，
   * 否则裁决为 indeterminate 时下一轮已经拿到 admission 了（实测两次 agent_start）。
   */
  private closeRun(): void {
    this._state.status = "idle";
    this.publishPhase("idle");
    this._state.startedAt = null;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set();
    this.activeRun?.resolve();
    this.activeRun = undefined;
    if (this.currentRunId !== null) this.terminalByRun.delete(this.currentRunId);
  }

  /**
   * 回到 idle 之后排自主工作。**放在 activeRun 清空之后**——否则 consumeInbox 会被自己的并发闸挡掉；
   * 账本已封（indeterminate）时一轮都不排。
   */
  private scheduleAutonomousWork(): void {
    if (this.inboxFailure !== null) return;
    // inbox 攒着的事先消费（开着才消费）。**inbox 优先于 dream**：外面发生的事比整理旧记忆急，
    // 反过来会让 agent 看起来「在忙自己的事」。
    if (this.autoConsumeInbox && this.inbox.pendingCount > 0) void this.consumeInbox();
    else if (this.autoDream) this.enqueueDream();
  }

  /**
   * Dream 自调度（C6 / D7）：**触发、互斥、预算、中断、提交都在 core**，
   * 装配方不写 timer 也不派 subagent。
   *
   * D7 拍定：**Dream 只整理记忆，不许自建 Task / Schedule**——所以它只拿到 memory 工具。
   * 放开就等于给了它写入未来行为的权力，收回很难。
   */
  /**
   * 现在还允许整理吗。**每个 await 之后都要重问一次**——`stop()` / 丢锁可能就发生在那当中。
   *
   * 判据与前台一致（`lifecycleManaged` 时只有 running 才算数）：整理是纯写操作，
   * 没有任何理由比前台宽松。上一版只看 `leaseLostError`，于是 `stop()` 返回、
   * 新 holder 已经拿到锁之后，旧 Agent 的 dream 仍能往 memory 里写——单写者当场破。
   */
  private get dreamAllowed(): boolean {
    if (this.memory === undefined) return false;
    if (this.leaseLostError !== null) return false;
    return !this.lifecycleManaged || this.phase === "running";
  }

  /** 中断整理并等它真的收完：还没拿到 permit 的 Dream → superseded；在跑的 → abort scope、等 close。stop() / 丢锁共用。 */
  private async settleDream(): Promise<void> {
    await this.admission.abortMaintenance();
  }

  /**
   * finishRun() 里排一次 Dream（§14.2.4）：只做同步标记 + enqueue 拿到即时 ticket，**不 await、不递归进循环**；
   * admission 在当前 callback 返回、permit close 之后才调度它，前台一来就让位（还没跑 → superseded；在跑 → abort）。
   * 门控（shouldDream）在拿到 permit 之后查。
   */
  private enqueueDream(): void {
    if (!this.dreamAllowed || this.dreamTicketOutstanding) return;
    this.dreamTicketOutstanding = true;
    const ticket = this.admission.enqueue({ source: { kind: "dream" }, priority: "maintenance", purpose: "maintenance" }, (scope) => this.executeDream(scope));
    void ticket.settled.then(() => {
      this.dreamTicketOutstanding = false;
    });
  }

  /**
   * Dream 的 execute（C6 / D7）：**触发、互斥、预算、中断、提交都在 core**，装配方不写 timer 也不派 subagent。
   * D7 拍定：**Dream 只整理记忆，不许自建 Task / Schedule**——所以它只拿到 memory 工具。
   * **绝不抛**：失败 → 诊断 + error outcome（Dream 的事件不外发，它的结果体现在记忆文件上）。
   * 内层 loop 用 `scope.modelBinding` 驱动，不闭包捕获前台的 model / stream function。
   */
  private async executeDream(scope: AgentAdmissionExecuteScope): Promise<LoopResult> {
    const memory = this.memory;
    const idle: LoopResult = { outcome: { kind: "completed" }, messages: [] };
    // Dream 也是一次 accepted run：executor 进入即 `run.started`（门控没过也封口成 completed，不留半截）
    await this.observeRunStarted(scope.runId);
    if (memory === undefined || !this.dreamAllowed) return idle;
    try {
      // 门控：间隔、写入数、轮数、文件数四道，全满足才跑
      if (!(await shouldDream(memory))) return idle;
      // await 之后重问：这期间可能已经 stop() / 丢锁 / 前台抢占了
      if (!this.dreamAllowed || scope.signal.aborted) return { outcome: { kind: "aborted" }, messages: [] };
      // 门过了才上锁：dreamTask 有副作用（写 startedAt），不能放在判断之前
      const task = await dreamTask(memory);
      let result: LoopResult;
      try {
        result = await runAgentLoop(
        [userMessage(task.prompt)],
        // **独立 context**：整理不进主 transcript——它是 agent 对自己记忆的操作，不是这次任务的一部分。主 messages 一个字都不动。
        { systemPrompt: null, messages: [], compaction: EMPTY_COMPACTION },
        {
          ...this.createLoopConfig(scope),
          // D7：只给 memory 工具。不是「过滤掉危险的」，是**只给这一件**。
          getTools: () => task.tools,
          knownToolNames: () => task.tools.map((t) => t.name),
          resolveTool: (name) => {
            const tool = task.tools.find((t) => t.name === name);
            return tool === undefined ? { ok: false as const, reason: "not_found" as const } : { ok: true as const, tool };
          },
          // 整理不吃 steering / followUp：那些是给前台 run 的（gate 只认前台 run）
          intake: undefined,
        },
        // **事件不外发**：整理的中间过程不该混进 agent 的对外事件流。
        async () => {},
        scope.signal,
        scope.modelBinding.streamFunction,
      );
      } finally {
        // Dream 也是一次 run：它的 ask tombstone 同样到 run 封口才进有界池——loop 之外（listener / 持久化）抛错也要封，
        // 否则 live-run / tombstone 状态越积越多
        this.permissions.closeRun(scope.runId);
      }
      // **只有真的跑完才算数。** `runAgentLoop` 对失败**不抛**，它把结果放在 outcome 里；
      // 上一版无条件 `markDreamed()`，于是 provider 报错之后 `lastAt` 照样刷新、计数照样清零
      // ——一次失败的整理被记成成功，下一次要等满 24 小时（实测过）。被中断同理不提交：锁会在 DREAM_LOCK_STALE_MS 后过期，下次重来。
      if (scope.signal.aborted) return result;
      if (result.outcome.kind !== "completed") {
        this.reportDiagnostic({ code: "dream_failed", message: `记忆整理没跑完（${result.outcome.kind}）：不记成成功，锁留给下次` });
        return result;
      }
      await markDreamed(memory);
      return result;
    } catch (e) {
      // 实测破坏路径：`shouldDream()` / `dreamTask()` 读写状态文件失败——不能变成 unhandled rejection
      this.reportDiagnostic({ code: "dream_failed", message: `记忆整理失败：${errText(e)}` });
      return { outcome: { kind: "error", error: { source: "internal", code: "internal", retryable: false, message: errText(e) } }, messages: [] };
    }
  }

  private async createContextSnapshot(scope: AgentAdmissionExecuteScope): Promise<AgentContext> {
    // 用 admission 冻结的模型装配——{{model}} 说的必须是这次 run 真用的那个
    const systemPrompt = await this.assemblePrompt(scope.modelBinding.model);
    this.lastSystemEstimate = estimateText(systemPrompt); // usage 到达时算校准比要用同一份 system 的字符估
    return {
      systemPrompt,
      messages: [...this._state.messages], // 快照：循环拿的是那一刻的副本
      compaction: this._state.compaction, // 视图状态随快照走；流水线改了它会经 compaction_end 写回 _state
      // 工具**不进快照**：它是装备，每轮经 config.getTools() 重取
    };
  }

  /**
   * prompt 组装（2026-09-01 改为 extension 出段）：把 `AgentPrompt` registry 里的段按 order 拼起来，
   * `{{变量}}` 从同一 registry 的变量表取值。每次 run 调一次 = **冻结的是时刻,不是内容**：
   * run 内 system 逐字节不变，记忆写盘、skill 激活都动不了它。
   * 两种失败两种档位：段 `render()` 抛错 = 该段隐形 + 诊断留痕；**变量引用错 = 抛**
   * （`PromptVariableError`，作者错误，让这次 run 以 error 收场，不静默）。
   * `model` 缺省取当前装备——外部（测试、诊断）直接调时用；run 内传 admission 冻结的那份。
   */
  async assemblePrompt(model: Readonly<{ provider: string; id: string }> = this._state.model): Promise<string | null> {
    const ctx: AssembleContext = {
      workspace: this._state.workspace,
      model: { provider: model.provider, id: model.id },
      agentId: this.agentId,
      sessionId: this._state.sessionId,
    };
    return assembleSystem([...this.promptSections.values()], this.promptVariables, ctx, ({ section, error }) => {
      void this.hooks.notify(
        { type: "notification", kind: "error", message: `[prompt_section_failed] ${section}: ${errText(error)}` },
        this.hookContext(),
      );
    });
  }

  /**
   * 每轮注入的来源（通道 B）。system 段不再从这里供货——那些经 `AgentPrompt` registry 进两张表。
   * 渲染函数仍住各自模块（`renderSkillInjections` / `taskInjections`：谁拥有数据谁拥有 format）。
   */
  private promptSources(hasTool: (name: string) => boolean): PromptSource[] {
    return [
      // 激活的 skill 正文：每轮从工作集现算，拼消息末尾、不进 transcript
      { turnInjections: () => renderSkillInjections(this.skills, this.activeSkills) },
      // 任务清单（§5D.7）：**每轮重算**，因为 run 中途模型自己就会 TaskCreate / TaskUpdate。
      // 走 turnInjection 而非 system 段的理由写在 `renderTaskInjection` 的注释里（缓存）。
      //
      // **按工具是否真在门控**，与上面 skills 那条同款（2026-08-31）。此前这里写的是
      // 「task 恒装，所以这条不带条件」——那个前提在工具注册搬进 `echo:tasks` builtin Extension
      // 之后就没了：不 mount builtin 的装法（低层 `new Agent()`）会让模型**每轮看见任务清单、
      // 却没有 TaskCreate 可调**。那正是 skills 那行注释说的「教模型用它没有的工具」，同一个病。
      // `hasTool` 读的是**本轮冻结的菜单**（run-turn 传进来），不是活池：turn_start 里才注册的 TaskList
      // 这轮菜单上没有，清单也就不许这轮出现（2026-09-01 review P2）。
      { turnInjections: () => (hasTool("TaskList") ? taskInjections(taskSnapshot(this.tasks)) : []) },
    ];
  }

  /** 循环的入参：装备来自这次 admission 冻结的 binding（§14.2.4 model seam），不再读 Agent 的活字段。 */
  private createLoopConfig(scope: AgentAdmissionExecuteScope): AgentLoopConfig {
    const binding = scope.modelBinding;
    return {
      model: binding.model as Model, // RunModelSnapshot 与 Model 同形——JSON-like 的冻结副本
      runId: scope.runId,
      permission: this.permissionStage(),
      sessionId: this._state.sessionId,
      thinkingLevel: binding.thinkingLevel,
      maxRetryDelayMs: binding.maxRetryDelayMs,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      getApiKey: binding.getApiKey,
      getTools: () => activeTools(this.tools),
      knownToolNames: () => [...this.tools.keys()],
      resolveTool: (name) => resolveTool(this.tools, name),
      // 通道 B:run 中途会变的内容(激活 skill 正文),每轮从各 PromptSource 重算、
      // 拼在消息末尾、不进 transcript。
      getTurnInjections: (visibleTools) => this.promptSources((n) => visibleTools.has(n)).flatMap((s) => s.turnInjections?.() ?? []),
      // RunIntakeGate 的循环侧。两条队列出来的消息同样要过 userPromptSubmit 准入（§14.7.5 第 3 条），source 如实标；
      // 开关门本身是 gate 里的同步步，准入在 drain 之后才 await。
      intake: {
        openTurn: (turnId) => this.intake.openTurn(turnId),
        closeTurn: async () => (await this.admitUserMessages(this.intake.closeTurn(), "steer")).admitted,
        drainFollowUps: async () => (await this.admitUserMessages(this.intake.drainFollowUps(), "followUp")).admitted,
        tryCloseRun: async () => {
          // 关不上 = 有货：准入后若全被拦下，门还开着，再试关——直到关上或有可消费的
          for (;;) {
            const drained = this.intake.tryCloseRun();
            if (drained === null) return null;
            const { admitted } = await this.admitUserMessages(drained, "followUp");
            if (admitted.length > 0) return admitted;
          }
        },
        closeRun: () => this.reportUnconsumed(this.intake.closeRun(), "run 结束"),
      },
      toolExecution: this.toolExecution,
      hooks: this.hooks,
      hookContext: this.hookContext(),
      maxIterations: this.maxIterations,
      timeoutMs: this.timeoutMs,
      retryPolicy: binding.retryPolicy,
      // 阶段每次流水线跑之前重取——registry 里装卸的策略在轮边界生效
      compaction: {
        ...(this.compaction.reserveTokens !== undefined ? { reserveTokens: this.compaction.reserveTokens } : {}),
        getStages: () => [...this.compactionStages.values()],
        calibration: this.lastCalibration,
      },
      workspace: this._state.workspace,
    };
  }

  /** 交给各 harness 的宿主口。**没有 assertMutable**——生效时机靠 ResourceStatus 在轮边界解决，
   *  异步源（MCP 回调、文件监听）没法「先问再改」。 */
  /** harness 的诊断出口：变成一条 notification。**不上报就是静默失败**。 */
  private reportDiagnostic(d: Diagnostic): void {
    void this.hooks.notify(
      { type: "notification", kind: "error", message: `[${d.code}] ${d.message}${d.path !== undefined ? ` (${d.path})` : ""}` },
      this.hookContext(),
    );
  }

  /**
   * 关掉这个 agent。语义定死为一句话:**等一切静默,然后资产归零**。
   *
   * 分工:harness 的 `dispose()` 只负责**收活物**（杀后台任务、关 MCP 连接），
   * 且契约是「返回时真的干净了」；**清空资产是 agent 自己的事**——资产本来就是它的，
   * 不该由 harness 代清（这一条是 2026-08-05 归属拍板的直接推论）。
   */
  async dispose(): Promise<void> {
    // 幂等（§14.7.5 第 6 条）：第二次调用拿到同一个结果，不再跑一遍收摊——
    // 再跑一遍会把已经关掉的存储再关一次、把已经归零的资产再清一次，两者都可能抛。
    if (this.disposeInFlight === undefined) this.disposeInFlight = this.doDispose();
    return this.disposeInFlight;
  }

  private async doDispose(): Promise<void> {
    // 顺序是契约的一部分，三段，**不许调换**：
    //   ① 停止新活动（含等在飞的那些真的停下来）
    //   ② 等**全部落盘**settle —— 循环、dream、定时器那一拍、inbox、session、任务清单
    //   ③ 关一次存储
    // 上一版把 ③ 排在了 ② 前面（`settleWrites()` / `sessionService.settle()` 在
    // `dispose()` **之后**才跑），于是 store 关掉之后 inbox 与 schedule 还在往里写（实测）。
    //
    // **每一档、每一项都要发生**（§14.7.5 第 6 条「全尝试」）：一个 disposer reject 不能让
    // 其余清理和资产归零被跳过。上一版 ② 用 `Promise.all`，第一个 reject 之后剩下的错误全丢、
    // 也不等它们真的做完；③ 用 `for…await`，第一个抛出后后面的存储根本没关。
    // 这里全部 all-settled，最后把收到的错误**聚合**抛出，一个都不吞。
    const errors: unknown[] = [];
    const attempt = async (work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (e) {
        errors.push(e);
      }
    };
    // **每一项都包成 thunk**：`d.dispose()` 若在返回 Promise 之前就同步 throw，直接写在数组字面量里
    // 会让数组构造当场中断——后面的 disposer 和 ③ 段全部跳过，all-settled 形同虚设。
    const job = (work: () => Promise<unknown>): Promise<unknown> => Promise.resolve().then(work);
    const allSettled = async (jobs: readonly Promise<unknown>[]): Promise<void> => {
      for (const r of await Promise.allSettled(jobs)) {
        if (r.status === "rejected") errors.push(r.reason);
      }
    };

    /* ① 停止新活动 */
    // 先关 steer / followUp intake：之后一律 rejected(runtime-disposed)；accepted 未消费的显式报出。
    this.reportUnconsumed(this.intake.dispose(), "dispose");
    // 再封 ask 账本：还在等人的 ask 以 runtime-disposed 封口（早于下面的 abort，否则会被记成 run-aborted）。
    this.permissions.dispose();
    // 关 admission：排队的 rejected(stopping)、在跑的 abort 并等它 close；之后的 enqueue 一律 rejected
    await this.admission.close("stopping");
    if (this.activeRun !== undefined) {
      this.abort("dispose");
      await this.activeRun.promise;
    }
    // **整理也得收干净，而且要等它真停。** 上一版只在 `abort()` 里发了个信号就往下走，
    // 于是 `stop()` 返回、lease 已释放、新 holder 已经拿到锁之后，旧 Agent 的 dream
    // 仍在往 memory 里写——单写者当场破（实测复现）。
    await this.settleDream();
    this.stopInboxPoll(); // 轮询只读盘、不写，所以取消即可，没有「在飞的那一拍」要等
    if (this.schedule !== undefined) {
      // 取消 timer **并等在飞的那一拍**：`stopSchedule()` 只挡后续，挡不住已经开始的那次，
      // 而它还会写 `schedules.json`。
      stopSchedule(this.schedule);
      await settleTick(this.schedule);
    }

    /* ② 收活物 + 等全部落盘 settle */
    // 并发收活物——它们互不依赖，逐个 await 只是白等
    const memory = this.memory;
    const schedule = this.schedule;
    await allSettled([
      job(() => killAllBackground(this.background.tasks, { report: (d) => this.reportDiagnostic(d) })),
      job(() => this.mcp?.dispose() ?? Promise.resolve()),
      // 别把清单丢了：有落盘端口就先写回去。**走写链**不裸调 `saveTasks`——
      // 裸调会与 `pendingWrites` 里在飞的那笔并发，正是 review 第 2 条点的第二处。
      job(() => this.enqueueTaskWrite()),
      ...(memory !== undefined ? [job(() => disposeMemory(memory))] : []),
      ...(schedule !== undefined ? [job(() => disposeSchedule(schedule))] : []),
      ...this.disposables.map((d) => job(() => d.dispose())),
      // adopt 过来的 agent 域值：**本 Agent 是唯一 dispose owner**（§14.5.1 规则 1），这里排空账本。
      // 排在 ③ 之前：agent 域先收、进程域（borrow 的 root store）后关，方向是 consumer → provider。
      job(() => this.adoption?.drain() ?? Promise.resolve()),
    ]);
    // 在飞的 inbox 落盘、会话的未 settle 写——**都必须在关存储之前**
    await attempt(() => this.settleWrites());
    await attempt(async () => await this.sessionService?.settle());
    // **一句话都没说过的那段，收摊时把 meta 撤掉**（2026-09-04，sessions.md §3）：
    // 起来就退出的会话不该留在别人的清单里、也不该被 `--continue` 挑中。
    //
    // 两道闸都必须过：本段没有任何 entry（`discardIfUnused` 自己判），以及
    // **inbox 里没有待消费的记录**——有人给它留过话就不能撤，撤了那条留言就成了孤儿。
    // 撤在 settle 之后：先把该落的落完，再决定这一段算不算数。
    if (this.inbox.pendingCount === 0) {
      const id = this._state.sessionId;
      if (id !== null) await attempt(async () => void (await this.sessionService?.discardIfUnused(id)));
    }

    /* ③ 关一次。顺序保持（关存储有先后），但每一条都要试到。 */
    for (const d of this.finalDisposables) await attempt(() => d.dispose());

    // 活物收完了，东西归零。**先停掉自动落盘**：下面的 `tasks.clear()` 会触发 onChange，
    // 而那时 store 已经在 ③ 里关掉了——写进去只会是一次必然失败的空快照。
    this.taskPersistSuppressed = true;
    this.tools.clear();
    this.skills.clear();
    this.activeSkills.clear();
    this.background.tasks.clear();
    this.tasks.clear();

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `dispose 期间 ${errors.length} 处失败（已全部尝试）：${errors.map(errText).join("；")}`);
    }
  }

  /**
   * loop 看到的授权 stage：policy 只裁决，ask 的登记/超时/中止/回答全在本 Agent 的 ledger。
   * `responder:"none"` 的策略若返回 ask，这里把它折成 policy deny——诚实缺席，不生成 ask、不等人。
   */
  private permissionStage(): PermissionStage {
    const policy = this.permissionPolicy;
    return {
      authorize: async (input) => {
        // 先验形再看 kind：策略返回 null/"bogus" 时，这里要给出「非法裁决」而不是 TypeError
        const verdict = normalizeVerdict(await policy.authorize(input));
        if (verdict.kind === "ask" && policy.responder === "none") {
          return { kind: "deny", reason: `${verdict.reason} (the policy asks for approval, but no responder is configured: ask counts as deny)` };
        }
        // 「宿主会回答」但此刻没有任何订阅者——不开 ask（开了就是永久 pending），当场拒。
        // 放在 stage 里而不只在 run 入口：Dream 等不经 runWithLifecycle 的路径也走这条 stage。
        if (verdict.kind === "ask" && policy.responder === "host" && policy.askTimeoutMs === null && !this.hooks.hasSubscribers()) {
          return { kind: "deny", reason: `${verdict.reason}（声明了 responder:"host" 但没有 subscribeLifecycle 订阅者：无人回答，拒绝）` };
        }
        return verdict;
      },
      ask: (input, signal) => this.permissions.openAsk(input, { timeoutMs: policy.askTimeoutMs, signal }),
    };
  }

  /**
   * hook 拿到的现场。**只有现场，没有命令面**（§7.1，2026-08-25 决策记录）：
   * 上一版这里给了 steer/followUp/abort 和「直调 InternalTool」——后者绕开循环流水线
   * （preToolUse 拦截、事件、结果入账），是一条不受拦截的后门，与 `HookEffect[]` 一并删除。
   */
  private hookContext(): HookContext {
    return {
      origin: "model",
      depth: 0,
      hookId: "",
      signal: this.signal,
    };
  }

  /* ───────────── 私有：事件 → 状态的唯一写路径 ───────────── */

  private async emit(event: AgentEventInput): Promise<void> {
    await this.processEvents(event);
  }

  /**
   * 三步顺序**不可换**：
   *   ① 归约状态 ② 增量交给 SessionService ③ 逐个 await listener
   * 监听器看到的必须是已经生效的状态——反过来就会读到旧值。
   */
  private async processEvents(input: AgentEventInput): Promise<void> {
    const event = { ...input, seq: this.seq++, at: Date.now() } as AgentEvent;

    switch (input.type) {
      case "agent_start":
        this._state.status = "generating";
        // 运行状态落盘（2026-09-03）：只在 idle ↔ working 这条边上写，generating / acting / compacting
        // 是 working 的子态——别人只关心「现在问它，它能马上答吗」。
        this.publishPhase("working");
        break;
      case "turn_start":
        this._state.iteration = input.iteration;
        break;
      case "message_start":
        this._state.status = "generating";
        break;
      case "message_update":
        this._state.streamingMessage = { ...input.message, at: Date.now() };
        break;
      case "message_end":
        this._state.streamingMessage = undefined;
        this._state.messages = [...this._state.messages, input.message];
        break;
      case "tool_execution_start": {
        this._state.status = "acting";
        const next = new Set(this._state.pendingToolCalls);
        next.add(input.toolCallId);
        this._state.pendingToolCalls = next;
        break;
      }
      case "tool_execution_end": {
        const next = new Set(this._state.pendingToolCalls);
        next.delete(input.toolCallId);
        this._state.pendingToolCalls = next;
        if (next.size === 0) this._state.status = "generating";
        break;
      }
      case "compaction_start":
        this._state.status = "compacting";
        break;
      case "compaction_end":
        this._state.status = "generating";
        if (input.stages.length > 0) this._state.compaction = input.compaction;
        this._state.contextTokens = input.contextTokens;
        break;
      case "retry_scheduled":
        this._state.retryCount = input.attempt;
        break;
      case "usage": {
        // 这一轮送模的上下文有多大，provider 说了算（输入 + 它自己的输出 = 下一轮至少这么大）
        const tokens = input.usage.inputTokens + input.usage.outputTokens;
        this._state.contextTokens = tokens;
        // 校准比：真值 / 同一份视图（system + 到这条 assistant 为止的投影；usage 事件紧跟它的 message_end）的字符估。
        // 记下来给手动压缩与下一个 run 的首轮用——那两处没有 usage 基准
        const raw = this.lastSystemEstimate + estimateTokens(buildWorkingMessages(this._state.messages, this._state.compaction));
        if (raw > 0) this.lastCalibration = clampCalibration(tokens / raw);
        this._state.usage = {
          inputTokens: this._state.usage.inputTokens + input.usage.inputTokens,
          outputTokens: this._state.usage.outputTokens + input.usage.outputTokens,
          // 只要有一边报过缓存就带着累计值；两边都没报过则字段保持缺席（没报≠0）
          ...(this._state.usage.cachedInputTokens !== undefined || input.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: (this._state.usage.cachedInputTokens ?? 0) + (input.usage.cachedInputTokens ?? 0) }
            : {}),
        };
        break;
      }
      case "agent_end":
        this._state.streamingMessage = undefined;
        this._state.lastError = input.outcome.kind === "error" ? input.outcome.error : null;
        // 终态锁存：状态已应用、listener / 持久化还没跑——它们之后抛错，normalizer 复用这份，不发第二个 agent_end
        if (this.currentRunId !== null && !this.terminalByRun.has(this.currentRunId)) {
          this.terminalByRun.set(this.currentRunId, { outcome: input.outcome, messages: this._state.messages.slice(this.runMessagesBefore) });
        }
        break;
      default:
        break;
    }

    try {
      await this.persist(input);
    } finally {
      // §15 被动 tap：state 与 required persistence 已落才释放，且**严格按 seq 顺序**（见 releaseToTap）。
      // persist 抛错（run 随之失败）也要放行这一条——否则后面所有 seq 都卡死在缓冲里。
      this.releaseToTap(event);
    }

    const signal = this.activeRun?.abortController.signal ?? new AbortController().signal;
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }

  /**
   * canonical sink 的按 seq 释放缓冲。seq 在 processEvents 入口分配、persist 是 await 的：早一条 message_end 还在慢持久化时，
   * 外部 steer() fire-and-forget 的 queue_update 拿到更大的 seq，若直接交给 sink 就先到了（实测 [9,queue_update]
   * 早于 [8,message_end]）。所以每条先进缓冲，只放行 seq 连续的前缀。
   */
  private releaseToTap(event: AgentEvent): void {
    if (this.observationRuntime() === undefined) return;
    this.tapPending.set(event.seq, event);
    for (;;) {
      const next = this.tapPending.get(this.tapNextSeq);
      if (next === undefined) return;
      this.tapPending.delete(this.tapNextSeq);
      this.tapNextSeq += 1;
      this.deliverToTap(next);
    }
  }

  /**
   * 同步交给 canonical sink，**不 await**。sink 自身 never-throw（fact-sink.ts），这里再兜一层：
   * 异常原文不进诊断（§15.11 采集边界）——只留分类 + 稳定 hash；观测层任何异常都不进 Agent 控制流。
   */
  private deliverToTap(event: AgentEvent): void {
    const sink = this.observationSink;
    if (sink === undefined) return;
    try {
      sink.offer(event);
    } catch (e) {
      this.reportDiagnostic({ code: "observation_tap_failed", message: `observation sink 抛错（seq ${event.seq}，${event.type}）：${redactedLabel(e)}` });
    }
  }

  /* ───────────── §15 canonical writer 接线（Host-internal） ───────────── */

  /** 首次调用解析 `attachObservationHost` 挂上的 runtime，并接上诊断与 AgentEvent sink；没挂就永远 undefined。 */
  private observationRuntime(): ObservationRuntime | undefined {
    if (this.observationResolved) return this.observation;
    const wiring = observationHostOf(this);
    if (wiring === undefined) return undefined; // 还没挂（构造期）或根本不会挂（低层 `new Agent()`）：不记忆，下次再看
    this.observationResolved = true;
    this.observation = wiring.runtime;
    const rt = wiring.runtime;
    rt.attachDiagnostics((d) => this.reportDiagnostic(d));
    rt.bindScope(() => this.observationScope());
    this.observationSink = rt.eventSink();
    // §15.9 的三条 O3a 领域行：sink 挂在各 Capability 自己的 module-local 位置，descriptor 归语义 owner
    if (this.memory !== undefined) this.memory.observe = rt.capabilitySink(memoryFactDescriptor({ pathDigestKey: rt.pathDigestKey }), builtinOwner(MEMORY_ENTRY_ID));
    attachTaskObserver(this.tasks, rt.capabilitySink(taskFactDescriptor, builtinOwner(TASKS_ENTRY_ID)));
    if (this.schedule !== undefined) this.schedule.observe = rt.capabilitySink(scheduleFactDescriptor, builtinOwner(SCHEDULER_ENTRY_ID));
    return this.observation;
  }

  /**
   * AgentEvent 到达时刻的 scope（fact-sink 的 scope 供给）：run 归属只在 permit 期间有效（`activeRun` 落位到 `closeRun()`），
   * turn 归属跟 `_state.iteration`，与 `projectAgentEvent` 里 turn span 自带的 `t<iteration>` 同一格式。**必须返回对象**：
   * 供给返回 undefined 会被 sink 判成「run 归属不可知」而开 gap。
   */
  private observationScope(): Readonly<Record<string, string>> {
    const runId = this.activeRun !== undefined && this.currentRunId !== null ? this.currentRunId : undefined;
    return {
      agentId: this.agentId,
      agentInstanceId: this.agentInstanceId,
      ...(this._state.sessionId === null ? {} : { sessionId: this._state.sessionId }),
      ...(runId === undefined ? {} : { runId }),
      // turn 归属只在 turn 开着时补：agent_end 这类 turn 之外的事实不能被记成「最后一个 turn 里的」
      ...(runId !== undefined && this.intake.activeTurnId !== null && this._state.iteration > 0 ? { turnId: `t${this._state.iteration}` } : {}),
    };
  }

  private observationIdentity(): Readonly<{ agentId: string; agentInstanceId: string; sessionId: string | null }> {
    return { agentId: this.agentId, agentInstanceId: this.agentInstanceId, sessionId: this._state.sessionId };
  }

  /** admission 颁发 permit 前：没挂 canonical writer 一律放行；挂了就要 `run.accepted` 真 COMMIT。 */
  private async observeRunAccepted(input: { runId: string; source: RunSource; modelBinding: RunModelBinding }): Promise<boolean> {
    const rt = this.observationRuntime();
    if (rt === undefined) return true;
    const r = await rt.acceptRun({ runId: input.runId, source: input.source, ...this.observationIdentity(), modelBinding: input.modelBinding });
    return r === "accepted";
  }

  private async observeRunStarted(runId: string): Promise<void> {
    const rt = this.observationRuntime();
    if (rt === undefined) return;
    await rt.startRun(runId, this.observationIdentity());
  }

  /** permit finalizer：业务 outcome 已冻结（executed / callback-error 都是）；finalSnapshot 由本 Agent 此刻的状态投影。 */
  private async observeRunClosed(input: { runId: string; result: AgentAdmissionResult }): Promise<void> {
    const rt = this.observationRuntime();
    if (rt === undefined || input.result.kind === "rejected") return;
    await rt.closeRun({ runId: input.runId, outcome: input.result.result.outcome, finalState: this.observableState(rt, input.runId) }, this.observationIdentity());
  }

  /** `EchoObservableState`（§15.5.1）：只放固定的低基数字段；Capability summary 随 §15.9 埋点进来（O3a 第二刀）。 */
  private observableState(rt: ObservationRuntime, runId: string): EchoObservableState {
    const phase = this.observationPhase();
    const persistence = rt.sequencer.persistenceState.status;
    return {
      runtime: {
        phase,
        status: phase === "ready" && persistence !== "healthy" ? "degraded" : phase,
        observationPersistence: persistence,
        generation: rt.runtimeGeneration,
        activeEntryCount: 0,
      },
      agent: {
        status: this._state.status,
        activeRunId: runId,
        activeTurnId: this._state.iteration > 0 ? `t${this._state.iteration}` : null,
        iteration: this._state.iteration,
        messageCount: this._state.messages.length,
      },
      capabilities: [],
      omittedCapabilitySummaryCount: 0,
    };
  }

  /** Agent 生命周期 phase → §14 RuntimePhase 的固定投影。 */
  private observationPhase(): RuntimePhase {
    switch (this.phase) {
      case "running":
        return "ready";
      case "pausing":
        return "reconfiguring";
      case "stopping":
        return "disposing";
      case "stopped":
        return "disposed";
      case "lost":
        return "failed";
      default:
        return "bootstrapping";
    }
  }

  /**
   * run 关门时 accepted 却没消费的 steer / followUp（只在 abort / error / 超时 / 轮数用尽 / dispose 时非空）：
   * **显式报出、当场清空**——不留给下一个 run 捡走（§14：不偷偷转成下一 run），也不静默丢。
   */
  private reportUnconsumed(left: IntakeLeftovers, when: string): void {
    if (left.steers.length === 0 && left.followUps.length === 0) return;
    this.reportDiagnostic({
      code: "queue_dropped",
      message: `${when}：accepted 但未消费的消息被丢弃——steer ${left.steers.length} 条 / followUp ${left.followUps.length} 条（run 已关门，不会转入下一个 run）`,
    });
    if (left.steers.length > 0) void this.emit({ type: "queue_update", queue: "steering", size: 0 });
    if (left.followUps.length > 0) void this.emit({ type: "queue_update", queue: "followUp", size: 0 });
  }

  /**
   * 增量入账。**「哪些事件进 session」这条语义在这里，不在 Store**——
   * 三种：定稿消息、压缩、以 error 结束的 run。
   *
   * 只交内容，**id / parentId 由 `SessionService` 生成**。身份归 core 的理由见
   * `session/service.ts`——它是恢复期才会炸的那类不变量。
   */
  private async persist(input: AgentEventInput): Promise<void> {
    const id = this._state.sessionId;
    if (id === null) return;

    const parts: SessionEntryInput[] = [];
    if (input.type === "message_end") {
      parts.push({ kind: "message", message: input.message });
    } else if (input.type === "compaction_end") {
      // 没压动的不入账：账本只记事实，一条「什么都没变」的 entry 只会让恢复多验一次同样的状态
      if (input.stages.length > 0) parts.push({ kind: "compaction", at: Date.now(), reason: input.reason, compaction: input.compaction });
    } else if (input.type === "agent_end" && input.outcome.kind === "error") {
      parts.push({ kind: "error", at: Date.now(), error: input.outcome.error });
    }
    if (parts.length === 0) return;

    await this.sessionService?.append(id, parts);
  }
}

function normalizePrompt(input: string | AgentMessage | AgentMessage[], images?: ImageBlock[]): AgentMessage[] {
  if (Array.isArray(input)) return input;
  if (typeof input !== "string") return [input];
  return [userMessage(input, "human", images)];
}

/** 低层 Agent 的默认：全部放行——授权是产品策略，`new Agent()` 不替产品做决定。 */
const ALLOW_ALL_PERMISSION: PermissionPolicy = Object.freeze({
  authorize: () => ({ kind: "allow" as const }),
  askTimeoutMs: null,
  responder: "none",
});

/**
 * 构造期校验（§14.10.3）：能进 ask 又不超时，就必须有人回答或明确说没人——不能等 Tool 暂停了才发现。
 * 有限超时必须是正整数。
 */
function validatePermissionPolicy(policy: PermissionPolicy | undefined): PermissionPolicy {
  if (policy === undefined) return ALLOW_ALL_PERMISSION;
  const t = policy.askTimeoutMs;
  if (t !== null && (!Number.isInteger(t) || t <= 0)) {
    throw new Error(`permission.askTimeoutMs 必须是正整数毫秒或 null，收到 ${String(t)}`);
  }
  // responder 运行时穷举：TS 的字面量联合挡不住 JS 调用方；"bogus" 既不走 host 检查也不走 none 折叠，
  // 最后就是一个永远等不到人的 ask（实测）。
  if (policy.responder !== undefined && policy.responder !== "host" && policy.responder !== "none") {
    throw new Error(`permission.responder 只能是 "host" | "none"，收到 ${JSON.stringify(policy.responder)}`);
  }
  if (t === null && policy.responder === undefined) {
    throw new Error(
      "permission.askTimeoutMs 为 null（ask 等人不超时）时必须显式声明 responder：\"host\"（宿主会 subscribeLifecycle 后回答）或 \"none\"（ask 视为拒绝）",
    );
  }
  if (typeof policy.authorize !== "function") throw new Error("permission.authorize 必须是函数");
  return policy;
}

function textOf(m: AgentMessage): string {
  if (!("content" in m) || !Array.isArray(m.content)) return "";
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * hook 改写了正文：新文本放在**第一个原文本块的位置**，其余文本块删掉（patch 的是 `textOf()` 拼出来的整段），
 * 图片等非文本块**原位、原相对顺序**——块序会原样进 provider，把文本挪到最前会改变图片与指令的对应关系
 * （实测 `[image, text]` 曾被改成 `[text, image]`）。原消息没有文本块（纯图片）时，文本插在最前，
 * 与 `userMessage()` 的 `[text, ...images]` 构造序一致。
 */
function withUserText(m: AgentMessage, text: string): AgentMessage {
  if (!("content" in m) || !Array.isArray(m.content)) return m;
  const blocks = m.content as ContentBlock[];
  const firstText = blocks.findIndex((b) => b.type === "text");
  if (firstText < 0) return { ...m, content: [{ type: "text", text }, ...blocks] } as AgentMessage;
  const content: ContentBlock[] = [];
  blocks.forEach((b, i) => {
    if (i === firstText) content.push({ type: "text", text });
    else if (b.type !== "text") content.push(b);
  });
  return { ...m, content } as AgentMessage;
}

