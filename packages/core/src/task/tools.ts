// 任务清单的模型可见面：四个**内核工具**（对 agent 自己的能力面动手，判据见 §5A.4c）。
//
// 名字**逐字沿用生态**（TaskCreate / TaskGet / TaskList / TaskUpdate）：模型见过这四个名字
// 和它们的参数形状，换名字换来的是工具调用准确率下降，零收益。
//
// 边操作**并进 TaskUpdate 的 patch**，不设第五个工具。
//
// ⚠️ description 是**模型逐字读的 prompt 资产**，这里是临时措辞；
// 定稿与治理（版本、指纹）归 prompt 那一轮。

import { environmentMessage, type AgentMessage } from "../messages.ts";
import { toolError, toolOk, type ModelTool } from "../tools/types.ts";
import { createTasks, getTask, listTasks, removeTask, updateTask, type TaskMap } from "./harness.ts";
import type { TaskBrief, TaskSnapshot, TaskSpec, TaskStatus } from "./types.ts";

export function makeTaskTools(tasks: TaskMap): ModelTool[] {
  return [createTool(tasks), listTool(tasks), getTool(tasks), updateTool(tasks)] as ModelTool[];
}

const STATUS_DESC = "pending（没开始）/ in_progress（在做）/ done（做完）/ cancelled（不做了）";

function createTool(tasks: TaskMap): ModelTool<{ tasks: TaskSpec[] }> {
  return {
    kind: "model",
    name: "TaskCreate",
    label: "建任务",
    description:
      "把接下来要做的事写成任务清单。多步任务开工前先建清单——它会跨上下文压缩、跨会话保留下来，" +
      "是你之后判断「做到哪了、还剩什么」的依据。" +
      "一次可以建多条：同一批里用 ref 给任务起个临时名，blocks / blockedBy 就能互相引用。" +
      "只有一件小事时不必建。",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "要建的任务（可多条，一次建完）",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "一行说清要做什么" },
              detail: { type: "string", description: "可选：展开的说明（TaskList 不显示，TaskGet 才给）" },
              ref: { type: "string", description: "可选：本批内的临时名，供同批的 blocks/blockedBy 引用" },
              status: { type: "string", description: `可选，默认 pending。${STATUS_DESC}` },
              blocks: {
                type: "array",
                items: { type: "string" },
                description: "本条卡着谁（这些任务要等它做完）。写已存在的任务 id 或同批的 ref",
              },
              blockedBy: {
                type: "array",
                items: { type: "string" },
                description: "谁卡着本条（要等这些做完才能开工）。写已存在的任务 id 或同批的 ref",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["tasks"],
    },
    async execute({ tasks: specs }) {
      if (!Array.isArray(specs) || specs.length === 0) return toolError("tasks 不能为空");
      const r = createTasks(tasks, specs);
      if (!r.ok) return toolError(r.error);
      const lines = r.tasks.map((t) => `#${t.id} ${t.title}`);
      return toolOk(`已建 ${r.tasks.length} 条任务：\n${lines.join("\n")}\n\n${renderList(listTasks(tasks))}`);
    },
  };
}

function listTool(tasks: TaskMap): ModelTool<{ status?: string[]; ready?: boolean }> {
  return {
    kind: "model",
    name: "TaskList",
    label: "看任务清单",
    description:
      "列出全部任务及其状态。被卡住的会标出在等谁，当前可以开工的会标 [可做]。" +
      "不含展开说明（要看某条的细节用 TaskGet）。",
    parameters: {
      type: "object",
      properties: {
        status: { type: "array", items: { type: "string" }, description: `可选：只看这些状态。${STATUS_DESC}` },
        ready: { type: "boolean", description: "可选：只看当前没被卡住、可以开工的" },
      },
    },
    async execute({ status, ready }) {
      const items = listTasks(tasks, {
        ...(Array.isArray(status) ? { status } : {}),
        ...(ready === true ? { ready: true } : {}),
      });
      if (items.length === 0) return toolOk("清单是空的。");
      return toolOk(renderList(items));
    },
  };
}

function getTool(tasks: TaskMap): ModelTool<{ id: string }> {
  return {
    kind: "model",
    name: "TaskGet",
    label: "看任务详情",
    description: "看一条任务的完整内容：展开说明、状态、在等谁、卡着谁。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id（TaskList 里 # 后面那个）" } },
      required: ["id"],
    },
    async execute({ id }) {
      const t = getTask(tasks, id);
      if (t === undefined) return toolError(`未知任务 '${id}'`);
      const blocks = t.links.filter((l) => l.kind === "blocks").map((l) => `#${l.to}`);
      const lines = [
        `#${t.id} ${t.title}`,
        `状态：${t.status}${t.executor !== undefined ? `（执行者：${t.executor}）` : ""}`,
        t.derived.blockedBy.length > 0 ? `在等：${t.derived.blockedBy.map((b) => `#${b}`).join("、")}` : "在等：无",
        blocks.length > 0 ? `卡着：${blocks.join("、")}` : "卡着：无",
        t.derived.unreachable ? "⚠️ 有前置已取消，这条路的前提可能变了" : "",
        t.detail !== undefined ? `\n${t.detail}` : "",
      ].filter((l) => l !== "");
      return toolOk(lines.join("\n"));
    },
  };
}

type UpdateParams = {
  id: string;
  title?: string;
  detail?: string;
  status?: TaskStatus;
  executor?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  removeBlocks?: string[];
  removeBlockedBy?: string[];
  delete?: boolean;
};

function updateTool(tasks: TaskMap): ModelTool<UpdateParams> {
  return {
    kind: "model",
    name: "TaskUpdate",
    label: "改任务",
    description:
      "改一条任务：开工前把它标 in_progress，做完标 done，不做了标 cancelled。" +
      "也能改标题/说明、增删依赖关系、删掉这条。" +
      "前置还没完成时标 in_progress 会被拒绝，并告诉你在等谁。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id" },
        status: { type: "string", description: STATUS_DESC },
        title: { type: "string" },
        detail: { type: "string" },
        executor: { type: "string", description: "可选：谁在做这条" },
        addBlockedBy: { type: "array", items: { type: "string" }, description: "加：要等这些任务做完" },
        addBlocks: { type: "array", items: { type: "string" }, description: "加：这些任务要等本条" },
        removeBlockedBy: { type: "array", items: { type: "string" }, description: "去掉对这些的等待" },
        removeBlocks: { type: "array", items: { type: "string" } },
        delete: { type: "boolean", description: "删掉这条任务（指向它的依赖会一并清掉）" },
      },
      required: ["id"],
    },
    async execute(params) {
      const { id, delete: del, ...rest } = params;
      if (del === true) {
        return removeTask(tasks, id) ? toolOk(`已删除任务 #${id}\n\n${renderList(listTasks(tasks))}`) : toolError(`未知任务 '${id}'`);
      }
      const r = updateTask(tasks, id, rest);
      if (!r.ok) return toolError(r.error);
      return toolOk(`#${r.task.id} → ${r.task.status}\n\n${renderList(listTasks(tasks))}`);
    },
  };
}

/** 一份清单渲染成模型能读的紧凑文本。**渲染是纯函数**，与 harness 分开（最该被单独测）。 */
/**
 * 每轮注入给模型的那一段（§5D.7 拍定的形态）。
 *
 * **模型看不见的能力不算能力**——清单一直在盘上、也一直能被工具读，但模型不主动
 * `TaskList` 就等于没有。这一段让它每轮都看得见「现在能做什么、正在做什么」。
 *
 * 三个取舍，都不是这里发明的，是 §5D.7 的原话：
 *   · **渲染什么**：`snapshot()` 的 `ready` + `active`，**不是全量清单**——
 *     已完成和被卡住的每轮重复喂进去只是噪音，要看全量模型自己 `TaskList`。
 *   · **放哪一层**：**turnInjection**，不是 system 段。清单每轮都在变，
 *     放进 system 会**每轮打掉 prompt cache**（skill 目录能进 system 是因为它只在池增删时变）。
 *   · **上限**：`ready` / `active` 各自截断，超出的只报条数——清单可以很长，
 *     而这段是每轮都在的固定开销。
 *
 * 空清单返回空串：**没有任务就一个字都不注入**，别拿「（清单是空的）」占每一轮的位置。
 */
export function renderTaskInjection(snapshot: TaskSnapshot, limit = 10): string {
  const pick = (items: readonly TaskBrief[]): { shown: readonly TaskBrief[]; rest: number } => ({
    shown: items.slice(0, limit),
    rest: Math.max(0, items.length - limit),
  });
  const active = pick(snapshot.active);
  const ready = pick(snapshot.ready);
  if (active.shown.length === 0 && ready.shown.length === 0) return "";

  const parts: string[] = ["# 任务清单"];
  if (active.shown.length > 0) {
    parts.push(`正在做：\n${renderList(active.shown)}${active.rest > 0 ? `\n…另有 ${active.rest} 条` : ""}`);
  }
  if (ready.shown.length > 0) {
    parts.push(`可做：\n${renderList(ready.shown)}${ready.rest > 0 ? `\n…另有 ${ready.rest} 条` : ""}`);
  }
  parts.push(`（共 ${snapshot.total} 条；全量用 TaskList，细节用 TaskGet）`);
  return parts.join("\n\n");
}

/**
 * 上一函数的注入形态：包成一条 `environment` 消息（与 skill 正文注入同形，见
 * `skill/compose.ts` 的 `renderSkillInjections`）。**空清单给空数组**——
 * 一条空 environment 消息也是每轮的固定字节。
 *
 * `at` 传 0 而不是 `Date.now()`：这段每轮重算、拼在消息末尾，时间戳变
 * 等于每轮换字节，白白打掉 messages 那一截缓存。skill 注入同理，同一个理由。
 */
export function taskInjections(snapshot: TaskSnapshot, limit = 10): AgentMessage[] {
  const text = renderTaskInjection(snapshot, limit);
  return text === "" ? [] : [environmentMessage(text, "task", undefined, 0)];
}

export function renderList(items: readonly TaskBrief[]): string {
  if (items.length === 0) return "（清单是空的）";
  return items
    .map((t) => {
      const marks: string[] = [];
      if (t.derived.blockedBy.length > 0) marks.push(`等 ${t.derived.blockedBy.map((b) => `#${b}`).join("、")}`);
      else if (t.derived.ready) marks.push("可做");
      if (t.derived.unreachable) marks.push("前置已取消");
      if (t.executor !== undefined) marks.push(`by ${t.executor}`);
      const suffix = marks.length > 0 ? ` [${marks.join("；")}]` : "";
      return `${STATUS_MARK[t.status] ?? "•"} #${t.id} ${t.title}${suffix}`;
    })
    .join("\n");
}

const STATUS_MARK: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  done: "●",
  cancelled: "✕",
};
