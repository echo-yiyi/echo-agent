// CapabilityFactSink（§15.9）：没有统一 AgentEvent 的内建 Capability（Memory / Task / Schedule …）在自己的
// 唯一 decision / commit / settle 点调 `sink.offer(fact)`。
//
//   · 每个 Capability 自己拥有窄 fact union 与 descriptor（descriptor 与语义 owner 共址，不住中央 switch）；
//   · sink 是 module-local、同步、**永不抛**；Capability 不 import Sequencer，也不知道 tap 长什么样；
//   · 完整 Runtime 注入的 adapter 转成 `ObservationIngest.offer()`；没注入时是 no-op。
//
// 它不是 public AgentEvent、不是 Extension ABI、不是第二套状态机。

import type { Diagnostic } from "../errors.ts";
import type { BoundedObservationDraft } from "./draft.ts";
import { redactedLabel } from "./redact.ts";
import { assertIdentifier, freezeInstrumentation, freezeOwner, materializeScope, type ScopeMaterialization } from "./identity.ts";
import type { ObservationIngest, ProjectionFailureOutcome } from "./sequencer.ts";
import type { ObservationCapturePolicy, ObservationOwner, ObservationRecordKind } from "./types.ts";

/** descriptor 投影出的 scope：envelope scope 的子集（`runtimeId` 由 Sequencer 盖，不由 producer 给）。 */
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
 * descriptor 的产出：**body 尚未 normalize**——原 body 交给 Sequencer 做唯一一次 `normalizeObservationValue()`
 * （失败 → hole + gap）。identity 字段（name / scope / subject）同样由 Sequencer 再物化一次。
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

/** 可注入的 reporter 抛错会直接击穿 `offer()` 的 no-throw 契约（review 实测），构造时就包掉。 */
function safeReporter(report: ((d: Diagnostic) => void) | undefined): (d: Diagnostic) => void {
  if (report === undefined) return () => {};
  let disabled = false;
  return (d) => {
    if (disabled) return;
    try {
      // **只挡同步 throw 是不够的**（2026-08-27 review P0）：`(d) => void` 同样放行 `async` reporter，
      // 它 reject 时是进程级 unhandled rejection——观测故障又一次击穿主流程。
      const r: unknown = report(d);
      if (typeof r === "object" && r !== null && typeof (r as { then?: unknown }).then === "function") {
        // **吞掉 rejection 还不够，得停用它**（同轮 review P1）：只吞不停的话，每条诊断仍会调一次违规
        // reporter——实测 10,000 条诊断 = 10,000 次调用 + 10,000 个 pending Promise，诊断通道自己成了
        // 资源放大器。与 tap 同一处置：接口要求同步，返回 thenable 即停用。
        disabled = true;
        Promise.resolve(r as PromiseLike<unknown>).then(
          () => {},
          () => {},
        );
      }
    } catch {
      // 诊断通道自己坏了，没有第二条诊断通道可报——只能吞
    }
  };
}

/**
 * **供给自己抛错 ≠ 没有 scope**：前者说明这条事实的 run 归属不可知，必须走失败路径；
 * 后者（没配 scope 供给）才是合法的空 scope。两者原来被同一个 `?? {}` 抹平了（review P1）。
 */
function suppliedScope(supply: FactSinkOptions["scope"]): ScopeMaterialization {
  if (supply === undefined) return materializeScope(undefined); // 没配供给 = 合法空 scope
  let raw: unknown;
  try {
    raw = supply();
  } catch (e) {
    return { ok: false, violation: `scope 供给抛错 ${redactedLabel(e)}` };
  }
  // **供给返回 null/undefined 也是失败**：上一版把它转交给 `materializeScope(undefined)`，
  // 于是又落回「没配供给」那条合法路径——实测 records=["fine"]、gaps=0、diags=[]，
  // 和上面那句注释直接打架（review P1）。要表达「这条事实确实没有 scope」，供给必须显式返回 `{}`。
  if (raw === undefined || raw === null) {
    return { ok: false, violation: `scope 供给返回 ${raw === null ? "null" : "undefined"}（没有 scope 请显式返回 {}）` };
  }
  return materializeScope(raw);
}

const NOOP: CapabilityFactSink<unknown> = Object.freeze({ offer(): void {} });

export function noopFactSink<T>(): CapabilityFactSink<T> {
  return NOOP as CapabilityFactSink<T>;
}

export type FactSinkOptions = Readonly<{
  report?: (d: Diagnostic) => void;
  /** 调用时刻补的 scope（agentId / sessionId / runId …）；descriptor 自带的 scope 字段优先。 */
  scope?: () => ObservationFactScope;
}>;

export type IngestFactSinkContext = Readonly<{
  runtimeId: string;
  runtimeGeneration: string;
  capturePolicy: ObservationCapturePolicy;
  owner: ObservationOwner;
}> &
  FactSinkOptions;

/**
 * descriptor → `ObservationIngest.offer()`（bounded lane）。body 原样交给 Sequencer normalize。
 * instrumentation / owner / runtime 身份在构造期**冻结副本**并校长度：只校验不复制的话，adapter 构造完
 * 把 `instrumentation.name` 改成 9,000 字节，之后每条事实都成 gap（review 实测）。
 */
export function factSinkToIngest<T>(descriptor: CapabilityFactDescriptor<T>, ingest: ObservationIngest, ctx: IngestFactSinkContext): CapabilityFactSink<T> {
  // 同上：构造期冻结副本，之后不再读 descriptor / ctx
  const instrumentation = freezeInstrumentation(descriptor.instrumentation, "descriptor.instrumentation");
  const runtimeId = ctx.runtimeId;
  const runtimeGeneration = ctx.runtimeGeneration;
  assertIdentifier(runtimeId, "runtimeId");
  assertIdentifier(runtimeGeneration, "runtimeGeneration");
  const owner = freezeOwner(ctx.owner, "owner");
  const capturePolicy = ctx.capturePolicy;
  const project = descriptor.project;
  const report = safeReporter(ctx.report);
  /**
   * canonical 路径的失败出口：**先占失败身份 + 挂 safe gap，再报诊断**。
   * 顺序要紧——诊断报完才预留的话，报诊断途中任何抛错都会让这个洞彻底消失。
   */
  // writer terminal 之后每条失败都报一次的话，100 次失败 = 100 条诊断（review 实测 101 条），
  // 诊断通道自己成了新的无界增长面。terminal 是**持续状态**不是逐条事件，只报第一次。
  let terminalReported = false;
  const openGap = (runId: string | undefined, why: string): void => {
    let outcome: ProjectionFailureOutcome = "writer-unavailable";
    try {
      outcome = ingest.reserveProjectionFailureGap({ runId });
    } catch (inner) {
      // Sequencer 内部 bug：没有第二条 canonical 通道可用，只能升一条诊断
      report({ code: "observation_sequencer_internal", message: `${instrumentation.name}：gap 预留失败 ${redactedLabel(inner)}` });
    }
    if (outcome !== "gap-reserved") {
      // writer 已 terminal：canonical 那条路不存在了，诊断如实说明「这条只剩 live 证据」，
      // 不能让读者以为账本上仍有洞可查（review P1）。只报第一次。
      if (terminalReported) return;
      terminalReported = true;
      report({
        code: "observation_fact_dropped",
        message: `${instrumentation.name}：${why}（writer 已 terminal，此后的失败只有 live 证据、无 canonical gap；只报第一次）`,
      });
      return;
    }
    report({ code: "observation_fact_dropped", message: `${instrumentation.name}：${why}` });
  };
  return {
    offer(fact: T): void {
      // scope 供给**在 project 之前**读一次并**物化成稳定快照**：project 抛错时那条 gap 也得挂在
      // 正确的 runId 上，否则 run 级的记录数对账仍然看不见这个洞（review P1 第一轮）。
      // 物化失败**不当作「没有 scope」**——run 归属不可知的事实不能冒充 runtime-scoped 正常记录
      // （review P1 第二轮实测：gaps=0、diags=[]，原 run 仍显示 complete）。
      const s = suppliedScope(ctx.scope);
      let gapRunId = s.ok ? s.scope.runId : s.runId;
      if (!s.ok) {
        openGap(gapRunId, `scope 物化失败：${s.violation}`);
        return;
      }
      const callScope = s.scope;
      try {
        const p = project(fact, capturePolicy);
        if (p === null) return;
        const kind = p.kind;
        const occurredAt = p.occurredAt;
        const sourceSeq = p.sourceSeq;
        const scope = { ...callScope, ...p.scope, runtimeId };
        if (typeof scope.runId === "string") gapRunId = scope.runId;
        const draft: BoundedObservationDraft<unknown> = {
          lane: "bounded",
          occurredAt,
          ...(sourceSeq === undefined ? {} : { sourceSeq }),
          kind,
          name: p.name,
          scope,
          correlation: {},
          generation: { runtime: runtimeGeneration },
          owner,
          instrumentation,
          attributes: p.attributes,
          body: p.body,
          ...(p.subject === undefined ? {} : { subject: p.subject }),
        };
        // draft 里的 identity 由 Sequencer 再物化一次（它才是 canonical 的 owner）；这里不重复校验。
        ingest.offer(draft);
      } catch (e) {
        openGap(gapRunId, redactedLabel(e));
      }
    },
  };
}
