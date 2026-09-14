// CapabilityFactSink：执行节点上的探针。内建能力（Memory / Task / Schedule …）、循环、压缩、Agent 自身在自己的
// 唯一 decision / commit / settle 点调 `sink.offer(fact)`。
//
//   · 每个 Capability 自己拥有窄 fact union 与 descriptor（descriptor 与语义 owner 共址，不住中央 switch）；
//   · sink 同步、**永不抛**、没有 Promise；Capability 不 import 观测线程，也不知道它长什么样；
//   · **探针在主线程上只做三件事**：读一次 scope 供给、按 policy 投影（descriptor 的有界取字段，不算摘要）、交给观测线程。
//     normalize、摘要、seq、落盘全在观测线程（thread-host.ts）；主循环不为观测等任何东西
//     （决策：docs/decisions/implemented/2026-09-14-observation-off-main-loop.md）。
//
// 它不是 public AgentEvent、不是 Extension ABI、不是第二套状态机。

import type { ObservationCapturePolicy, ObservationRecordKind } from "./types.ts";

/** descriptor 投影出的 scope：envelope scope 的子集（`runtimeId` 由观测线程盖，不由 producer 给）。 */
export type ObservationFactScope = Readonly<{
  agentId?: string;
  agentInstanceId?: string;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  activityId?: string;
  toolCallId?: string;
}>;

/**
 * descriptor 的产出：**body 尚未 normalize**——原 body 交给观测线程里的 Sequencer 做唯一一次 normalize
 * （失败 → hole + gap）。identity 字段（name / scope / subject）同样由它再物化一次。
 */
export type ObservationFactProjection = Readonly<{
  kind: ObservationRecordKind;
  name: string;
  occurredAt: number;
  sourceSeq?: number;
  scope: ObservationFactScope;
  attributes: Readonly<Record<string, string | number | boolean>>;
  body: unknown;
  subject?: Readonly<{ kind: string; id: string }>;
  /**
   * 要在观测线程里算的摘要：`body[字段] = SHA-256(text)` 的十六进制；`keyed: true` 用这个状态根的路径摘要 key 做 HMAC-SHA256。
   * 摘要是观测自己的活，不在节点上算；原文只在进程内过一次线程，不进记录。有它时 `body` 必须是普通对象。
   */
  digests?: Readonly<Record<string, Readonly<{ text: string; keyed?: true }>>>;
}>;

export interface CapabilityFactSink<T> {
  /** 同步、永不抛、没有 Promise。 */
  offer(fact: T): void;
}

export type CapabilityFactDescriptor<T> = Readonly<{
  instrumentation: Readonly<{ name: string; version: string }>;
  /** 按 capture policy 把领域事实投成固定 name/kind/attributes/body；返回 null = 该 policy 下不生成记录。 */
  project(fact: T, policy: ObservationCapturePolicy): ObservationFactProjection | null;
}>;

const NOOP: CapabilityFactSink<unknown> = Object.freeze({ offer(): void {} });

export function noopFactSink<T>(): CapabilityFactSink<T> {
  return NOOP as CapabilityFactSink<T>;
}

/** 探针把东西交给观测线程的那一步（thread.ts 的 runtime 连接实现它）。两个方法都同步、永不抛。 */
export type FactHandoff = Readonly<{
  /** 交出一条投影。过不了线程（比如 body 里有函数）时自己转成 `failed`。 */
  fact(at: number, scope: unknown, projection: ObservationFactProjection): void;
  /** 探针在这一侧就失败了：观测线程补 hole + gap 与诊断。`error` 是抛出物的原文，只在观测线程里做成脱敏标签。 */
  failed(at: number, runId: string | undefined, why: string, error?: string): void;
}>;

export type ThreadFactSinkContext = Readonly<{
  capturePolicy: ObservationCapturePolicy;
  /** 事实到达的时刻（记录的 observedAt）。 */
  now: () => number;
  /** 调用时刻补的 scope（agentId / sessionId / runId …）；descriptor 自带的 scope 字段优先。不给 = 合法的空 scope。 */
  scope?: () => ObservationFactScope;
  handoff: FactHandoff;
}>;

/** 抛出物的原文，只读 name / message，永不抛。脱敏在观测线程里做。 */
export function thrownText(e: unknown): string {
  try {
    if (e instanceof Error) return `${String(e.name)}: ${String(e.message)}`;
  } catch {
    // Proxy 的 getPrototypeOf / getter 能让判断本身抛
  }
  return typeof e === "string" ? e : "non-error thrown";
}

/** 从 scope 供给的返回值里 total 地取 runId：失败路径给 gap 挂归属用。 */
function runIdOf(raw: unknown): string | undefined {
  try {
    const id = (raw as { runId?: unknown } | undefined)?.runId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * descriptor → 观测线程。scope 供给**在 project 之前**读一次：project 抛错时那条 gap 也得挂在正确的 runId 上。
 * **供给自己抛错 ≠ 没有 scope**：前者这条事实的 run 归属不可知，必须走失败路径；供给返回 null / undefined 同样是失败——
 * 要表达「确实没有 scope」，供给必须显式返回 `{}`。
 */
export function factSinkToThread<T>(descriptor: CapabilityFactDescriptor<T>, ctx: ThreadFactSinkContext): CapabilityFactSink<T> {
  const project = descriptor.project;
  const { capturePolicy, now, scope: supply, handoff } = ctx;
  return {
    offer(fact: T): void {
      const at = now();
      let raw: unknown;
      if (supply !== undefined) {
        try {
          raw = supply();
        } catch (e) {
          handoff.failed(at, undefined, "scope 供给抛错 ", thrownText(e));
          return;
        }
        if (raw === undefined || raw === null) {
          handoff.failed(at, undefined, `scope 供给返回 ${raw === null ? "null" : "undefined"}（没有 scope 请显式返回 {}）`);
          return;
        }
      }
      let p: ObservationFactProjection | null;
      try {
        p = project(fact, capturePolicy);
      } catch (e) {
        handoff.failed(at, runIdOf(raw), "", thrownText(e));
        return;
      }
      if (p === null) return;
      handoff.fact(at, raw, p);
    },
  };
}
