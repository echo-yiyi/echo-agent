// 循环的入参形状。

import type { AgentEventInput, AgentOutcome } from "../events.ts";
import type { HookContext, HookRuntime } from "../hooks/runtime.ts";
import type { AgentMessage, AssistantMessage, ConvertToLlm, ToolResultMessage } from "../messages.ts";
import type { Model, StreamFn, ThinkingLevel } from "../provider/types.ts";
import type { RetryPolicy } from "../provider/dialect.ts";
import type { AgentTool } from "../tools/types.ts";
import type { ToolResolution } from "../tools/harness.ts";
import type { PermissionStage } from "../permission/types.ts";
import type { CompactionStage, CompactionState } from "../compaction/types.ts";

/**
 * 循环拿到的**对话快照**：进来那一刻的 messages，循环内部只往里 push。
 *
 * **工具不在这里**——它是装备不是对话，每轮经 `AgentLoopConfig.getTools()` 重取。
 * 这样跑的中途注册的工具下一轮就能被模型看见，不必等下次 run。
 *
 * `compaction` 是作用在 `messages` 上的视图状态（`compaction/types.ts`）：messages 永远全量原文，
 * 送模前经 `buildWorkingMessages()` 投影。只有压缩流水线会改它。
 */
export type AgentContext = {
  systemPrompt: string | null;
  messages: AgentMessage[];
  compaction: CompactionState;
};

export type Emit = (event: AgentEventInput) => Promise<void>;

export type LoopIntake = {
  /** turn 开门：在 turn_start 之前调，之后的 steer() 才 accepted。 */
  openTurn(turnId: string): void;
  /** 轮末原子：drain 本 turn accepted 的 steer 并关 turn intake。 */
  closeTurn(): Promise<AgentMessage[]>;
  /** 内层收尾后：drain followUp，run intake 不关。 */
  drainFollowUps(): Promise<AgentMessage[]>;
  /** 真要停了：队列空 → 关 run intake 返回 null；否则返回**非空**已准入列表（门仍开），调用方消费后再来关。 */
  tryCloseRun(): Promise<AgentMessage[] | null>;
  /**
   * run 终止（任何原因）：强制关门。**必须在 agent_end 之前调**——agent_end 的订阅者再 followUp() 得到的是
   * rejected，不是「accepted 随后被丢掉」的假 accepted。accepted 未消费的由 Agent 显式报出。门已关时 no-op。
   */
  closeRun(): void;
};

/**
 * 循环侧的压缩配置：触发面的一个数 + 阶段从哪取。
 * `getStages` **每次流水线跑之前重取**——阶段是 `AgentCompaction` registry 的条目，装卸在轮边界生效（热插拔）。
 */
export type LoopCompactionConfig = {
  reserveTokens?: number;
  getStages: () => readonly CompactionStage[];
  /** 本 run 拿到第一次 usage 之前用的校准比（真 token / 字符估）：Agent 从上一次 usage 记下来的；不给 = 1。 */
  calibration?: number;
};

export type TransformContext = (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

export type ShouldStopAfterTurnContext = { iteration: number; message: AssistantMessage };
export type PrepareNextTurnContext = { iteration: number; message: AssistantMessage; messages: AgentMessage[] };
export type AgentLoopTurnUpdate = {
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string | null;
};

export interface AgentLoopConfig {
  model: Model;
  /** 本次 run 的稳定身份：permission ask、事件关联都引用它。由 Agent 在 run 入口分配，循环只透传。 */
  runId: string;
  /** 仅作追踪标识透传；**循环不碰会话**。 */
  sessionId?: string | null;
  thinkingLevel?: ThinkingLevel;
  maxRetryDelayMs?: number;

  /* ── 上下文两道工序：先 transform（AgentMessage 层），再 convert（投影到线上形状） ── */
  /** 契约：**绝不 throw/reject**——抛出会打断循环且不产出正常事件序列；失败返回安全兜底值。 */
  convertToLlm: ConvertToLlm;
  /** 契约同上；失败原样返回入参。memory / skills 挂件的接入点。 */
  transformContext?: TransformContext;

  /** 每次模型调用动态取 key。契约：绝不抛；没有返回 undefined。 */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

  /**
   * 本轮摆给模型的工具。**每轮调一次**（工具是装备，不进对话快照）。
   * 缺省实现返回 harness 的工作集；渐进式披露落地时只改那边，这里的契约不变。
   */
  getTools: () => readonly AgentTool[];
  /**
   * 本轮开始时池里**全部**名字（含被禁用的）。与 `getTools()` 同一拍取，一起冻成本轮工作集：
   * 执行只认 `getTools()` 给出的对象；不在里面的名字，**只有本轮开始时已知的**才去问 `resolveTool`
   * 要一个准确原因（禁用 / 已卸载）。本轮开始后才注册的名字即使模型点中也不执行——它是下一轮的
   * （§14.7.5 第 1 条：实时池不能成为第二条解析路）。
   */
  knownToolNames: () => readonly string[];
  /**
   * 给「本轮已知、但不在本轮工作集里」的名字一个准确原因——模型点了一个刚断线的 MCP 工具，
   * 它该看到「服务已断开」而不是含糊的「未知工具」（后者会让模型以为自己记错了名字、再试一次）。
   * **循环只读它的原因，绝不执行它返回的对象**。
   */
  resolveTool: (name: string) => ToolResolution;

  /* ── 轮末三个决策钩（turn_end 之后、下一次模型调用之前），契约均为绝不抛 ── */
  shouldStopAfterTurn?: (ctx: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  prepareNextTurn?: (
    ctx: PrepareNextTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  /**
   * 每轮注入:run 中途会变、但**不属于对话事实**的内容(激活的 skill 正文)。
   * 每轮重算,拼在 working 副本**末尾**——前缀(真实对话)字节不动,不破缓存;不进 transcript。
   * 与 getTools 同构:工具每轮重取,注入每轮重算。契约:绝不抛;没有返回 []。
   */
  /** 每轮注入。`visibleTools` 是本轮冻结的、模型菜单上的工具名——注入里的工具门控只许读它，不读活池。 */
  getTurnInjections?: (visibleTools: ReadonlySet<string>) => Promise<AgentMessage[]> | AgentMessage[];
  /**
   * §14 RunIntakeGate 的循环侧：turn / run 的开关门与 drain。Agent 实现；drain 出来的消息已过 userPromptSubmit 准入。
   * 不给 = 这条 run 不吃 steer / followUp（Dream）。
   */
  intake?: LoopIntake;

  /** 缺省 "sequential"（可重放优先）；"parallel" 留着以后启用。 */
  toolExecution?: "sequential" | "parallel";

  /**
   * 工具前后的拦截统一走 hooks 的 preToolUse / postToolUse 挂点，**不是两个字段**。
   * 循环在每轮开头 `snapshot()` 一次、整轮只用那份工作集（§14.7.5 第 2 条）；
   * 轮与轮之间（stop / preCompact）才看活对象。
   */
  hooks: HookRuntime;
  hookContext: HookContext;

  /**
   * 授权 stage（§14.10.3）：在 transform hooks 与重新校验之后、execute 之前的固定位置；
   * 只能决定，不能改参数。它看到的 `params` 已经冻结，与 execute 收到的是同一份。
   */
  permission: PermissionStage;

  /* ── 闸与策略（重试与压缩收进 core 后带来的） ── */
  maxIterations: number;
  timeoutMs?: number;
  retryPolicy: RetryPolicy;
  compaction: LoopCompactionConfig;

  /** 透传给工具的 `ToolExecutionContext.workspace`。 */
  workspace: string;
}

export type TurnResult = {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  stopReason: AssistantMessage["stopReason"];
};

export type LoopResult = {
  outcome: AgentOutcome;
  /** 本次任务新增的全部消息（都已逐条经 message_end 事件入账）。 */
  messages: AgentMessage[];
};

export type LoopDeps = {
  context: AgentContext;
  config: AgentLoopConfig;
  emit: Emit;
  signal: AbortSignal;
  streamFn: StreamFn;
};
