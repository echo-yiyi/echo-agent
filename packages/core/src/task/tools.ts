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

const STATUS_DESC = "pending (not started) / in_progress (being worked on) / done (finished) / cancelled (dropped)";

function createTool(tasks: TaskMap): ModelTool<{ tasks: TaskSpec[] }> {
  return {
    kind: "model",
    name: "TaskCreate",
    label: "建任务",
    description:
      "Write the work ahead down as a task list. Create it before starting a multi-step task: the list survives context compaction and sessions, " +
      "and it is how you later tell what is done and what remains. " +
      "Several tasks can be created in one call; give a task a temporary name with ref so blocks / blockedBy in the same batch can reference it. " +
      "Do not create a list for a single small step.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "Tasks to create (one or more, in a single call)",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "One line saying what has to be done" },
              detail: { type: "string", description: "Optional: expanded notes (hidden in TaskList, shown by TaskGet)" },
              ref: { type: "string", description: "Optional: temporary name within this batch, for blocks/blockedBy of sibling tasks" },
              status: { type: "string", description: `Optional, default pending. ${STATUS_DESC}` },
              blocks: {
                type: "array",
                items: { type: "string" },
                description: "Tasks this one blocks (they wait for it). Existing task ids or refs from this batch",
              },
              blockedBy: {
                type: "array",
                items: { type: "string" },
                description: "Tasks that block this one (it waits for them). Existing task ids or refs from this batch",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["tasks"],
    },
    async execute({ tasks: specs }) {
      if (!Array.isArray(specs) || specs.length === 0) return toolError("tasks must not be empty");
      const r = createTasks(tasks, specs);
      if (!r.ok) return toolError(r.error);
      const lines = r.tasks.map((t) => `#${t.id} ${t.title}`);
      return toolOk(`Created ${r.tasks.length} task(s):\n${lines.join("\n")}\n\n${renderList(listTasks(tasks))}`);
    },
  };
}

function listTool(tasks: TaskMap): ModelTool<{ status?: string[]; ready?: boolean }> {
  return {
    kind: "model",
    name: "TaskList",
    label: "看任务清单",
    description:
      "List all tasks with their status. Blocked tasks show what they wait for; tasks that can start now are marked [ready]. " +
      "Expanded notes are not included (use TaskGet for one task's details).",
    parameters: {
      type: "object",
      properties: {
        status: { type: "array", items: { type: "string" }, description: `Optional: only these statuses. ${STATUS_DESC}` },
        ready: { type: "boolean", description: "Optional: only tasks that are not blocked and can start now" },
      },
    },
    async execute({ status, ready }) {
      const items = listTasks(tasks, {
        ...(Array.isArray(status) ? { status } : {}),
        ...(ready === true ? { ready: true } : {}),
      });
      if (items.length === 0) return toolOk("The task list is empty.");
      return toolOk(renderList(items));
    },
  };
}

function getTool(tasks: TaskMap): ModelTool<{ id: string }> {
  return {
    kind: "model",
    name: "TaskGet",
    deferred: true, // 冷门：不上菜单，模型 tool_search 取过再用（2026-09-02，缺省那一批）
    label: "看任务详情",
    description: "Show one task in full: expanded notes, status, what it waits for, what it blocks.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Task id (the part after # in TaskList)" } },
      required: ["id"],
    },
    async execute({ id }) {
      const t = getTask(tasks, id);
      if (t === undefined) return toolError(`Unknown task '${id}'`);
      const blocks = t.links.filter((l) => l.kind === "blocks").map((l) => `#${l.to}`);
      const lines = [
        `#${t.id} ${t.title}`,
        `Status: ${t.status}${t.executor !== undefined ? ` (executor: ${t.executor})` : ""}`,
        t.derived.blockedBy.length > 0 ? `Waiting for: ${t.derived.blockedBy.map((b) => `#${b}`).join(", ")}` : "Waiting for: none",
        blocks.length > 0 ? `Blocks: ${blocks.join(", ")}` : "Blocks: none",
        t.derived.unreachable ? "Warning: a prerequisite was cancelled; the premise of this task may have changed" : "",
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
      "Change one task: mark it in_progress before starting, done when finished, cancelled when dropped. " +
      "Also edits the title or notes, adds or removes dependencies, or deletes the task. " +
      "Marking in_progress while prerequisites are unfinished is rejected, and the reply says what it waits for.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        status: { type: "string", description: STATUS_DESC },
        title: { type: "string" },
        detail: { type: "string" },
        executor: { type: "string", description: "Optional: who is working on it" },
        addBlockedBy: { type: "array", items: { type: "string" }, description: "Add: wait for these tasks to finish" },
        addBlocks: { type: "array", items: { type: "string" }, description: "Add: these tasks wait for this one" },
        removeBlockedBy: { type: "array", items: { type: "string" }, description: "Stop waiting for these tasks" },
        removeBlocks: { type: "array", items: { type: "string" } },
        delete: { type: "boolean", description: "Delete this task (dependencies pointing at it are removed too)" },
      },
      required: ["id"],
    },
    async execute(params) {
      const { id, delete: del, ...rest } = params;
      if (del === true) {
        return removeTask(tasks, id) ? toolOk(`Deleted task #${id}\n\n${renderList(listTasks(tasks))}`) : toolError(`Unknown task '${id}'`);
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

  const parts: string[] = ["# Task list"];
  if (active.shown.length > 0) {
    parts.push(`In progress:\n${renderList(active.shown)}${active.rest > 0 ? `\n…and ${active.rest} more` : ""}`);
  }
  if (ready.shown.length > 0) {
    parts.push(`Ready:\n${renderList(ready.shown)}${ready.rest > 0 ? `\n…and ${ready.rest} more` : ""}`);
  }
  parts.push(`(${snapshot.total} total; TaskList for the full list, TaskGet for details)`);
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
  if (items.length === 0) return "(the task list is empty)";
  return items
    .map((t) => {
      const marks: string[] = [];
      if (t.derived.blockedBy.length > 0) marks.push(`waiting for ${t.derived.blockedBy.map((b) => `#${b}`).join(", ")}`);
      else if (t.derived.ready) marks.push("ready");
      if (t.derived.unreachable) marks.push("prerequisite cancelled");
      if (t.executor !== undefined) marks.push(`by ${t.executor}`);
      const suffix = marks.length > 0 ? ` [${marks.join("; ")}]` : "";
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
