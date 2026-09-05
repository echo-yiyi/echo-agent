// 后台活动：**agent 起的、在轮与轮之间继续活着、必须被收掉的东西**。
//
// 为什么它在 core（而不是产品层）——只有 agent 站在那个位置守这条不变量：
//   **agent 起的东西，不能比 agent 活得久。**
// 忘了接线就是孤儿进程。而 abort 信号、run 边界、dispose 这三个生命周期节点只有 core 知道。
//
// 但**执行体不在 core**：core 不 import 任何 `node:` 内置（它是纯 JS，浏览器/Worker/边缘
// 运行时都能跑）。产品把「怎么起一个进程 / 怎么调远程作业 / 怎么跑一个子 agent」填进 `run`。
//
// 分界一句话：**队列在 core，跑什么在产品。**
//
// 反向边界（不写清以后必混）：`inbox` 是**外部驱动 agent**（事情发生了 → 告诉它）；
// 这里是**agent 驱动外部**（agent 起了东西 → 得盯着、得收）。方向相反，不共用概念。

import type { AgentMessage } from "../messages.ts";
import type { ResourceChange } from "../events.ts";
import type { Diagnostic } from "../errors.ts";
import type { OutputBuffer } from "./buffer.ts";

export type BackgroundStatus = "running" | "completed" | "failed" | "killed";

/**
 * 一个「agent 起的、还活着的东西」。**它是什么，core 不关心**。
 *
 * **这就是实体本身**——取消口、输出缓冲、run 的 promise 都在它身上，
 * 不再有一个 `BackgroundEntry` 包装（2026-08-05 用户拍定：只要数据实体，不要包装类型）。
 */
export type BackgroundTask = {
  readonly id: string;
  /** "process" | "remote" | "subagent" | 上层自定义。**开放字符串**。 */
  readonly kind: string;
  readonly label: string;
  readonly startedAt: number;
  /** 终态吸收：只有 running 能转移。 */
  status: BackgroundStatus;
  /** 进入终态的时刻；running 时为 null。淘汰按它排序。 */
  endedAt: number | null;
  /** 结束原因（失败时的错误信息）。running 时为 null。 */
  error: string | null;
  /** 取消口。 */
  readonly controller: AbortController;
  /** 有界输出缓冲（绝对码点游标 + 驱逐标记）。 */
  readonly buffer: OutputBuffer;
  /** run 的 promise：收摊时要等它真的停下来。 */
  settled?: Promise<void>;
};

/** agent 的后台任务表。 */
export type BackgroundMap = Map<string, BackgroundTask>;

/**
 * 起后台任务要的一整包。
 *
 * **为什么它是个上下文而 tools/skills/tasks 是裸 Map**：后台任务结束要投进 inbox、
 * 失败要上报——它**需要 agent 侧的回调**，而那三个不需要。形态跟着需要走，不强行一致。
 */
export type AgentBackground = BackgroundDeps & {
  tasks: BackgroundMap;
  limits?: BackgroundLimits;
};

export type BackgroundRunContext = {
  /** 被取消时触发。**收到必须能停**——停不下来的任务会拖住 dispose。 */
  readonly signal: AbortSignal;
  /** 写输出。core 替它做增量缓冲与驱逐，产品不必自己管游标。 */
  write(chunk: string): void;
};

export type BackgroundSpec = {
  readonly kind: string;
  readonly label: string;
  /** 真正干活的那段——**产品提供**。正常返回 = completed；抛出 = failed。 */
  run(ctx: BackgroundRunContext): Promise<void>;
  /**
   * 结束时要投给 agent 的消息。返回 `null` = 这个任务结束了不必打扰 agent。
   * 不提供就用 core 的通用文案。
   *
   * 消息进 **inbox**，不打断正在跑的任务；agent 回到 idle 后按自己的策略消费。
   */
  onEnd?(task: BackgroundTask): AgentMessage | null;
};

export type BackgroundLimits = {
  /** 同时 running 的上限。**闸只有在 core 掌握「起」这个动作时才是真闸**。 */
  maxConcurrent: number;
  /**
   * **总登记数上限（含终态）**。没有这一条，跑一天下来 map 里全是尸体——真泄漏，不是洁癖。
   * 超了先淘汰最老的终态任务；一个可淘汰的都没有（全在 running）→ 拒。
   */
  maxTasks: number;
  /** 每个任务保留的输出上限（字符）。超出从头驱逐，读的时候带 dropped 标记。 */
  maxOutputChars: number;
};

export const DEFAULT_BACKGROUND_LIMITS: BackgroundLimits = {
  maxConcurrent: 8,
  maxTasks: 64,
  maxOutputChars: 64_000,
};

/**
 * **满了就拒，不排队**——这是决定，不是「以后再补」。
 *
 * 排队对模型是**不诚实的**：它拿到 id 以为在跑，然后 `background_output` 轮询，
 * 烧轮次等一个还没开始的东西（v1 尸检：31/100 轮烧在轮询上）。
 * 拒绝则一目了然：「已有 8 个在跑，先 kill 掉一些」——模型能立刻做对的事。
 * 产品真要排队，在 harness 外面自己排（它知道自己的优先级规则，core 不知道）。
 */
export type BackgroundStart =
  | { ok: true; task: BackgroundTask }
  | { ok: false; reason: "too_many_running"; running: number; max: number }
  | { ok: false; reason: "too_many_tasks"; tasks: number; max: number };

/** 起后台任务要 agent 给的三件：变更广播、结束投递、诊断上报。 */
export type BackgroundDeps = {
  onChanged?: (change: ResourceChange) => void;
  deliver?: (message: AgentMessage) => void;
  report?: (d: Diagnostic) => void;
};
