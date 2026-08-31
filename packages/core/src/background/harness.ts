// 后台活动的操作方法。设计见 docs/design/AGENT-CORE.md §5B。
//
// **这个文件里全是方法,没有 interface、没有类、没有状态**（2026-08-05 用户拍定）:
// 任务表是 agent 的——`agent.background` 就是 `Map<string, BackgroundTask>`,
// 装的是**任务本体**（取消口、缓冲、promise 都在它身上）。
//
// 它为什么在 core:只有 agent 站在那个位置守这条不变量——**agent 起的东西,不能比 agent 活得久**。
// 但**执行体不在 core**:产品把「怎么起一个进程 / 怎么调远程作业」填进 `spec.run`,
// 所以这里没有一行 `node:` 内置。一句话:**队列在 core,跑什么在产品。**

import { errText } from "../errors.ts";
import { environmentMessage } from "../messages.ts";
import { OutputBuffer } from "./buffer.ts";
import {
  DEFAULT_BACKGROUND_LIMITS,
  type AgentBackground,
  type BackgroundDeps,
  type BackgroundLimits,
  type BackgroundMap,
  type BackgroundSpec,
  type BackgroundStart,
  type BackgroundStatus,
  type BackgroundTask,
} from "./types.ts";

export const BACKGROUND_KIND = "background";
/** 结束通知里带多少尾巴。**只看一眼,不动游标**。 */
const END_NOTICE_TAIL_CHARS = 2000;
/** kill 后等它真停下来的宽限期。产品的 `run` 未必理会 signal,不设宽限会挂死 dispose。 */
export const DEFAULT_KILL_GRACE_MS = 5000;

export type KillOptions = { graceMs?: number; report?: BackgroundDeps["report"] };

/**
 * 起一个后台活动。core 管 id、并发闸、取消、缓冲、状态机、结束通知。
 *
 * **满了就拒,不排队**:排队对模型是不诚实的——它拿到 id 以为在跑,然后轮询烧轮次
 * 等一个还没开始的东西。拒绝则一目了然,模型能立刻做对的事。
 */
export function startBackground(ctx: AgentBackground, spec: BackgroundSpec): BackgroundStart {
  const { tasks } = ctx;
  const limits = ctx.limits ?? DEFAULT_BACKGROUND_LIMITS;
  const running = [...tasks.values()].filter((t) => t.status === "running").length;
  if (running >= limits.maxConcurrent) {
    return { ok: false, reason: "too_many_running", running, max: limits.maxConcurrent };
  }
  if (!makeRoom(tasks, limits)) {
    return { ok: false, reason: "too_many_tasks", tasks: tasks.size, max: limits.maxTasks };
  }

  const task: BackgroundTask = {
    id: `bg-${nextSeq(tasks)}`,
    kind: spec.kind,
    label: spec.label,
    startedAt: Date.now(),
    status: "running",
    endedAt: null,
    error: null,
    controller: new AbortController(),
    buffer: new OutputBuffer(limits.maxOutputChars),
  };
  tasks.set(task.id, task);
  ctx.onChanged?.({ kind: BACKGROUND_KIND, action: "added", name: task.id, source: spec.kind });

  // 生产挂后台：start 同步返回，run 自己跑。
  task.settled = (async () => {
    try {
      await spec.run({ signal: task.controller.signal, write: (chunk) => task.buffer.write(chunk) });
      transition(task, task.controller.signal.aborted ? "killed" : "completed");
    } catch (e) {
      // 被 kill 之后 run 抛错是正常的（它响应了 abort）——终态吸收保证不会被记成 failed。
      transition(task, task.controller.signal.aborted ? "killed" : "failed", errText(e));
    } finally {
      announce(task, spec, ctx);
    }
  })();

  return { ok: true, task };
}

export function getBackground(tasks: BackgroundMap, id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

export function listBackground(tasks: BackgroundMap): readonly BackgroundTask[] {
  return [...tasks.values()];
}

/**
 * 取消并等它停下来;`graceMs` 到了还没停就放弃等待、标 killed 并报诊断
 * （`run` 是产品提供的,它未必理会 signal——不设宽限期会挂死 dispose）。
 */
export async function killBackground(tasks: BackgroundMap, id: string, opts: KillOptions = {}): Promise<boolean> {
  const task = tasks.get(id);
  if (task === undefined || task.status !== "running") return false;
  task.controller.abort();
  const grace = opts.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const timedOut = await Promise.race([
    task.settled?.then(() => false) ?? Promise.resolve(false),
    new Promise<boolean>((r) => setTimeout(() => r(true), grace)),
  ]);
  if (timedOut) {
    transition(task, "killed", `kill 后 ${grace}ms 仍未停止（run 可能没理会 abort signal）`);
    opts.report?.({ code: "background_kill_timeout", message: `后台任务 ${id} 未在宽限期内停止` });
  }
  return true;
}

/** 收摊:全部取消并等干净。**agent 起的东西不能比 agent 活得久**。 */
export async function killAllBackground(tasks: BackgroundMap, opts: KillOptions = {}): Promise<void> {
  await Promise.all([...tasks.keys()].map((id) => killBackground(tasks, id, opts)));
}

/* ─────────────── 私有 ─────────────── */

function nextSeq(tasks: BackgroundMap): number {
  let max = 0;
  for (const id of tasks.keys()) {
    const n = Number(id.slice(3)); // "bg-"
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** 终态吸收：只有 running 能转移。 */
function transition(task: BackgroundTask, status: BackgroundStatus, error?: string): void {
  if (task.status !== "running") return;
  task.status = status;
  task.endedAt = Date.now();
  if (error !== undefined) task.error = error;
}

/** 结束通知:投进 inbox。**不打断正在跑的任务**——inbox 的语义就是「回 idle 再说」。 */
function announce(task: BackgroundTask, spec: BackgroundSpec, ctx: AgentBackground): void {
  ctx.onChanged?.({ kind: BACKGROUND_KIND, action: "removed", name: task.id, source: task.kind });
  if (spec.onEnd !== undefined) {
    const msg = spec.onEnd(task);
    if (msg !== null) ctx.deliver?.(msg);
    return;
  }
  // 只看一眼末尾，**不动游标**——读一眼不该消耗掉别人的增量
  const tail = task.buffer.tail(END_NOTICE_TAIL_CHARS);
  const text =
    `[后台任务 ${task.label}（${task.id}）已结束：${task.status}]` +
    (task.error !== null ? `\n错误：${task.error}` : "") +
    (tail === "" ? "" : `\n最后输出：\n${tail}`);
  ctx.deliver?.(environmentMessage(text, BACKGROUND_KIND, task.id));
}

/**
 * 腾位：超总量时按结束时间**从老到新淘汰终态任务**。腾得出返回 true。
 *
 * `maxTasks` 修的是真泄漏——没有它，跑一天下来表里全是尸体。
 * 一个可淘汰的都没有（全在 running）→ 拒。
 */
function makeRoom(tasks: BackgroundMap, limits: BackgroundLimits): boolean {
  while (tasks.size >= limits.maxTasks) {
    const dead = [...tasks.values()]
      .filter((t) => t.status !== "running")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const oldest = dead[0];
    if (oldest === undefined) return false;
    tasks.delete(oldest.id);
  }
  return true;
}
