// Task 的领域观测（§15.9 Task 行）：两种真相分开——
//   · `task.state.committed`：`commit()` 完成 Map swap 之后（内存态已变）；
//   · `task.store.saved / failed`：只在真实 `saveTasks()` settle 之后（O3a 只有 dispose / 显式写链那几处会调它）。
// renderer 不得把 state commit 显示为 durable；多次 state commit 可以对应一次 store save（O2b dirty coalescer）。
//
// harness.ts 是一袋函数、没有 ctx 对象：sink 按 `TaskMap` 实例登记在 WeakMap 里（与 host-wiring 同一个做法），
// 公开签名一个不改。

import type { CapabilityFactDescriptor, CapabilityFactSink, ObservationFactProjection } from "../observability/fact-sink.ts";
import { sha256Hex } from "../observability/hash.ts";
import type { ObservationCapturePolicy } from "../observability/types.ts";
import type { TaskItem } from "./types.ts";

export type TaskStateOperation = "create" | "update" | "remove" | "link" | "unlink";

export type TaskFact =
  | Readonly<{
      kind: "state";
      operation: TaskStateOperation;
      /** 受影响的任务 id（create 是整批；link / unlink 是 [from, to]）。 */
      ids: readonly string[];
      before?: string;
      after?: string;
      /** commit 之后清单里的任务总数。 */
      total: number;
      occurredAt: number;
    }>
  | Readonly<{
      kind: "store";
      outcome: "saved" | "failed";
      count: number;
      bytes?: number;
      message?: string;
      occurredAt: number;
    }>;

export const TASK_INSTRUMENTATION = { name: "echo.task", version: "1" } as const;

const MAX_IDS = 32;

export const taskFactDescriptor: CapabilityFactDescriptor<TaskFact> = {
  instrumentation: TASK_INSTRUMENTATION,
  project(fact: TaskFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
    if (policy === "off") return null;
    if (fact.kind === "state") {
      const attributes: Record<string, string | number | boolean> = { operation: fact.operation, count: fact.ids.length, total: fact.total };
      if (fact.before !== undefined) attributes.before = fact.before;
      if (fact.after !== undefined) attributes.after = fact.after;
      return {
        occurredAt: fact.occurredAt,
        kind: "event",
        name: "task.state.committed",
        scope: {},
        attributes,
        body: {
          operation: fact.operation,
          ids: fact.ids.slice(0, MAX_IDS),
          idsTruncated: fact.ids.length > MAX_IDS,
          ...(fact.before === undefined ? {} : { before: fact.before }),
          ...(fact.after === undefined ? {} : { after: fact.after }),
          total: fact.total,
        },
      };
    }
    return {
      occurredAt: fact.occurredAt,
      kind: "event",
      name: `task.store.${fact.outcome}`,
      scope: {},
      attributes: { outcome: fact.outcome, count: fact.count },
      body: {
        count: fact.count,
        ...(fact.bytes === undefined ? {} : { bytes: fact.bytes }),
        ...(fact.message === undefined ? {} : policy === "content" ? { message: fact.message } : { reasonDigest: sha256Hex(fact.message) }),
      },
    };
  },
};

const OBSERVERS = new WeakMap<Map<string, TaskItem>, CapabilityFactSink<TaskFact>>();

/** composition root / Agent 把 sink 挂到这个清单上；没挂 = no-op。重复挂 fail-loud：一份清单只有一个 owner。 */
export function attachTaskObserver(tasks: Map<string, TaskItem>, sink: CapabilityFactSink<TaskFact>): void {
  if (OBSERVERS.has(tasks)) throw new Error("这份任务清单已经挂过观测 sink 了");
  OBSERVERS.set(tasks, sink);
}

export function taskObserverOf(tasks: Map<string, TaskItem>): CapabilityFactSink<TaskFact> | undefined {
  return OBSERVERS.get(tasks);
}
