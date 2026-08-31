// 任务清单。设计见 docs/design/AGENT-CORE.md §5D。
//
// 它是什么（2026-08-05 用户拍定，四条）：
//   ① 一个任务列表，**指导 agent 的实现方向**
//   ② 可持续规划、可落盘、**跨会话指导**（上下文压缩掉了它还在）
//   ③ 状态说清：哪些没做、哪些在做、**在做的是谁在做**
//   ④ 有工具能改它
//
// **它与「做不做」无关**：task 是意图，不是执行。所以这个文件里**不出现**
// background / subagent 这两个概念——`executor` 只是个不透明字符串，
// core 既不解释它，也**永不自动填它**。
//
// 结构是数据不是机制：缺省实现是 DAG（`links` 里 `kind:"blocks"` 的边），
// 但**不写边就退化成一条链**，同一份数据、同一套工具、代码一行不差。
// 开闭一句话：**形状开放，行为不开放**——status/meta/link kind 随便扩，
// 但我们的方法只对 `"blocks"` 负责。要别的结构语义，上层自己实现 TaskHarness。

/** 开放字符串：内置四个是**我们的方法认识的那些**，其余照存。 */
export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled" | (string & {});

/** 了结口径。**自定义状态一律算「未了结」**——不认识就当没做完，是安全的一侧。 */
export const DONE_STATUSES: ReadonlySet<string> = new Set(["done"]);
/** 断路口径：前置进了这里，下游标 `unreachable`（派生，**不级联改状态**）。 */
export const DEAD_STATUSES: ReadonlySet<string> = new Set(["cancelled"]);

export function isSettled(status: string): boolean {
  return DONE_STATUSES.has(status) || DEAD_STATUSES.has(status);
}

/** 出边。`{to: X, kind: "blocks"}` 读作「**本条卡着 X**」——X 得等它。 */
export type TaskLink = {
  readonly to: string;
  readonly kind: "blocks" | (string & {});
  readonly meta?: Record<string, unknown>;
};

export const BLOCKS: string = "blocks";

export type TaskItem = {
  /** **稳定**，不随更新漂移。边靠它连，所以这是整个模块的根。 */
  readonly id: string;
  readonly title: string;
  /** 长描述。**`list()` 不给、`get()` 才给**——渐进式披露，跟工具/skill 一个口径。 */
  readonly detail?: string;
  readonly status: TaskStatus;
  /** 谁在做。**不透明**：core 不解释、不自动填。 */
  readonly executor?: string;
  /** 线性形态靠它排序。 */
  readonly order: number;
  /** 出边。只存这一个方向，前置反向算（图就几十个点，不缓存 → 没有失效 bug）。 */
  readonly links: readonly TaskLink[];
  readonly meta?: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** 派生三件，**永不落盘**。 */
export type TaskDerived = {
  /** 卡着我、且自己还没了结的前置 id。 */
  readonly blockedBy: readonly string[];
  /** 未了结 且 不是 in_progress 且 blockedBy 为空。 */
  readonly ready: boolean;
  /** 有前置进了 dead 态——这条路断了，但**它自己的状态不动**。 */
  readonly unreachable: boolean;
};

/** get() 的返回：全量 + 派生。 */
export type TaskView = TaskItem & { readonly derived: TaskDerived };

/** list() 的返回：**不含 detail**。 */
export type TaskBrief = Omit<TaskItem, "detail"> & { readonly derived: TaskDerived };

/** 建一条。`ref` 是**本批内的临时名**，让同一批里的边能互相引用。 */
export type TaskSpec = {
  readonly ref?: string;
  readonly title: string;
  readonly detail?: string;
  readonly status?: TaskStatus;
  readonly executor?: string;
  readonly meta?: Record<string, unknown>;
  /** 本条卡着谁（出边）。可写已存在的 id，也可写同批的 ref。 */
  readonly blocks?: readonly string[];
  /** 谁卡着本条。**书写便利**——落地时写成对方的出边，存储只有一个方向。 */
  readonly blockedBy?: readonly string[];
};

export type TaskPatch = {
  readonly title?: string;
  readonly detail?: string;
  readonly status?: TaskStatus;
  readonly executor?: string | null;
  readonly meta?: Record<string, unknown>;
  readonly addBlocks?: readonly string[];
  readonly removeBlocks?: readonly string[];
  readonly addBlockedBy?: readonly string[];
  readonly removeBlockedBy?: readonly string[];
};

export type TaskFilter = {
  readonly status?: readonly string[];
  readonly executor?: string;
  /** 只要当前没被卡住的。 */
  readonly ready?: boolean;
};

/* 失败一律是**返回值不是抛出**：这些结果直接喂给模型，错误正文就是给它看的原因。 */
export type TaskCreateResult = { ok: true; tasks: readonly TaskItem[] } | { ok: false; error: string };
export type TaskWriteResult = { ok: true; task: TaskItem } | { ok: false; error: string };
export type TaskLinkResult = { ok: true } | { ok: false; error: string };

export type TaskGraph = {
  readonly nodes: readonly TaskBrief[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[];
};

/** 进 `agent.state.tasks` 的投影。counts 按 status 开放计数——自定义状态也算得出来。 */
export type TaskSnapshot = {
  readonly total: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly ready: readonly TaskBrief[];
  readonly active: readonly TaskBrief[];
};

/**
 * 落盘端口——**字节面，没有语义**（D3 / §13.12.2）。
 *
 * 收窄过一次：原先是 `load(): Promise<TaskItem[]>` / `save(items)`，于是 JSON 编解码、
 * 逐条验形、「文件不存在算空清单」这些**语义全在实现方手里**，而 `loadTasks()` 只有三行、
 * 完全信任返回值。第三方实现可以静默丢记录、返回缺字段的 `TaskItem`（TS 类型运行时不存在），
 * core 无从保证——与旧 `SessionManager` 是同一种泄漏。
 *
 * 现在它只搬字节：解码与校验在 `loadTasks()` 里。
 *
 * **原子性归本端口的 conformance，不归 Service**：先写临时文件再 rename 这类手法是
 * 存储介质的事（远程实现用别的手段），Service 不该假设文件系统。要求是
 * 「一次 `write` 要么整份生效、要么完全不生效，不留半份」。
 *
 * 没有 watch、没有 revision、没有冲突合并：跨会话 = 同一个 agent 下次起来读一次，
 * 不是多写者并发。
 *
 * **终局**：与 `StorageDir` 合并、本类型退役。现在不做是因为 `fileTaskStore(path)` 的调用面
 * 还在用（`@echo/coding-agent`），换成传 `dir` 是另一次改动。
 */
export interface TaskStore {
  /** 不存在返回 `null`，**不抛**——「还没有清单」不是错误。其余 IO 错照抛。 */
  read(): Promise<string | null>;
  /** 一次完整快照。 */
  write(text: string): Promise<void>;
}
