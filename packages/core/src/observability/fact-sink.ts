// CapabilityFactSink（§15.9）：没有统一 AgentEvent 的内建 Capability（Memory / Task / Schedule …）在自己的
// 唯一 decision / commit / settle 点调 `sink.offer(fact)`。
//
//   · 每个 Capability 自己拥有窄 fact union 与 descriptor（descriptor 与语义 owner 共址，不住中央 switch）；
//   · sink 是 module-local、同步、**永不抛**；Capability 不 import Sequencer，也不知道 tap 长什么样；
//   · 完整 Runtime 注入的 adapter 转成 `ObservationIngest.offer()`；standalone `/engine` 的 adapter 转给构造期
//     host-owned `EngineObservationTap`；两个都没提供时才是 no-op。
//
// 它不是 public AgentEvent、不是 Extension ABI、不是第二套状态机。

import type { Diagnostic } from "../errors.ts";
import type { BoundedObservationDraft } from "./draft.ts";
import type { EngineObservationFact, EngineObservationTap, ObservationFactProjection } from "./engine-tap.ts";
import { encodeCanonical, projectionEncodingLimits } from "./normalize.ts";
import { redactedLabel } from "./redact.ts";
import { assertIdentifier, freezeInstrumentation, freezeOwner, materializeRecordFrame, materializeScope, type ScopeMaterialization } from "./identity.ts";
import type { ObservationIngest, ProjectionFailureOutcome } from "./sequencer.ts";
import type { ObservationCapturePolicy, ObservationOwner } from "./types.ts";

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

/** 与 Sequencer / Agent 同一份判据：只认 `then` 是函数，不做 instanceof。 */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}

const NOOP: CapabilityFactSink<unknown> = Object.freeze({ offer(): void {} });

export function noopFactSink<T>(): CapabilityFactSink<T> {
  return NOOP as CapabilityFactSink<T>;
}

export type FactSinkOptions = Readonly<{
  report?: (d: Diagnostic) => void;
  /** 调用时刻补的 scope（agentId / sessionId / runId …）；descriptor 自带的 scope 字段优先。 */
  scope?: () => EngineObservationFact["scope"];
}>;

/**
 * `/engine`：descriptor → **整条 fact** 按 `projectionEncodingLimits()`（同步预算减去 envelope 框架保留）
 * 编码 → `EngineObservationTap.offer()`。与 canonical 路径共用同一 admission boundary，评测面与 Runtime 面
 * 不分叉（review P1）；超限或 normalize 失败只丢这一条 + 诊断。
 *
 * descriptor 的 `instrumentation` 在**这里**就校长度并 fail-loud：它只进 canonical envelope、不进 ephemeral
 * fact，若不设上限，一个超长 name 能让 Runtime 成 gap 而这边照收——两条路都建不起来才谈得上「不分叉」。
 */
export function factSinkToEngineTap<T>(descriptor: CapabilityFactDescriptor<T>, tap: EngineObservationTap, opts: FactSinkOptions = {}): CapabilityFactSink<T> {
  // 构造期**冻结副本**，之后再也不读 descriptor / tap 的字段：只校验不复制的话，adapter 构造完
  // 把 `instrumentation.name` 改成 9,000 字节，这边照收而 Runtime 成 gap（review 实测）。
  const instrumentation = freezeInstrumentation(descriptor.instrumentation, "descriptor.instrumentation");
  const capturePolicy = tap.capturePolicy;
  const project = descriptor.project;
  const report = safeReporter(opts.report);
  // tap 返回 thenable（`async offer()`）时停用它，见下。
  let tapDisabled = false;
  return {
    offer(fact: T): void {
      if (tapDisabled) return;
      // 与 canonical 那条路同一把尺：scope 先物化成稳定快照，失败即拒。
      // `/engine` 没有 canonical journal，所以这里只能丢记录 + 诊断——差别是有没有账本，不是纪律松紧。
      const s = suppliedScope(opts.scope);
      if (!s.ok) {
        report({ code: "observation_fact_dropped", message: `${instrumentation.name}：scope 物化失败：${s.violation}` });
        return;
      }
      const callScope = s.scope;
      try {
        const p = project(fact, capturePolicy);
        if (p === null) return;
        // 每个字段**只读一次**存进局部量；之后只用局部量与物化快照，绝不回头碰 p
        // （否则 check 与 encode 之间就有 TOCTOU 窗口：Proxy 第二次读能换成别的内容或类型）。
        // 与 Sequencer 调**同一个** frame 物化：kind / occurredAt / sourceSeq / attributes / identity 一把尺量到底。
        // 只对齐 identity 不够——之前 kind 只有 Sequencer 校验，descriptor 返回 `kind:"bogus"` 时这边收下、
        // Runtime 成 gap（review 实测）。
        const m = materializeRecordFrame({
          kind: p.kind,
          occurredAt: p.occurredAt,
          ...(p.sourceSeq === undefined ? {} : { sourceSeq: p.sourceSeq }),
          name: p.name,
          scope: { ...callScope, ...p.scope },
          attributes: p.attributes,
          ...(p.subject === undefined ? {} : { subject: p.subject }),
        });
        if (!m.ok) {
          report({ code: "observation_fact_dropped", message: `${instrumentation.name}：${m.violation}` });
          return;
        }
        const f = m.frame;
        const id = f.identity;
        const raw: Omit<EngineObservationFact, "body"> & { body: unknown } = {
          schemaVersion: 1,
          kind: f.kind,
          name: id.name,
          occurredAt: f.occurredAt,
          ...(f.sourceSeq === undefined ? {} : { sourceSeq: f.sourceSeq }),
          scope: id.scope ?? {},
          // subject 必须随 fact 一起走，两边的 admission boundary 才对得齐
          ...(id.subject === undefined ? {} : { subject: id.subject }),
          attributes: f.attributes,
          body: p.body,
        };
        const encoded = encodeCanonical(raw, projectionEncodingLimits());
        // `/engine` 也没有 blob CAS seam：BlobRef 在这条路上同样无人可解，别写一个假装可解析的 digest。
        // 与 Sequencer 同一裁决（O3b 落 seam 前 binary 一律拒），两面才谈得上同一 admission boundary。
        if (encoded.blobs.length > 0) {
          report({ code: "observation_fact_dropped", message: `${instrumentation.name}：binary 需要 blob CAS seam（O3b），O2a 不得产出 BlobRef` });
          return;
        }
        // **thenable 必须在 adapter 里接住**（2026-08-27 review P0）：`EngineObservationTap.offer` 声明返回
        // void，但 TypeScript 放行 `async offer()`。丢掉返回值后，外层 `Agent.deliverToTap()` 只看得见
        // 本 sink 返回的 void，它那道 thenable 防护完全失效——exporter 的 async reject 又变回进程级
        // unhandled rejection（实测 unhandled=1、reported=0），正是 O1a/O2a 要消灭的东西。
        // 接口明确要求同步，所以除了接住 rejection，还要**立刻停用这个 tap**：否则 pending Promise 无界累积。
        const r: unknown = tap.offer(encoded.value as unknown as EngineObservationFact);
        if (isThenable(r)) {
          tapDisabled = true;
          // **「报一次」要真的是一次**（2026-08-27 review P1）：上一版「返回了 thenable」与「它 reject 了」
          // 各报一条，native rejecting Promise 就是 2 条；而自定义 thenable 可以把 reject 回调**调 1000 次**，
          // 于是一条 fact 产出 1001 条诊断——诊断通道自己又成了无界增长面。
          // 规矩：one-shot guard + `Promise.resolve()` 同化（同化后只可能 settle 一次，
          // 后续 reject 调用被丢弃，但仍被消费掉、不会变成 unhandled rejection）。
          // **诊断必须当场发**（2026-08-27 review P1）：上一版把它放进 settle 回调里，于是 tap 返回一个
          // **永不 settle** 的 Promise 时 `calls=1, diagnostics=0`——tap 被停用了，故障却完全不可见。
          // 规矩：发现 thenable 就立刻报一条通用诊断（不含成因，那时还不知道），随后**静默消费**
          // eventual rejection（只为不产生 unhandled rejection，不再报第二条）。
          report({ code: "observation_tap_failed", message: `${instrumentation.name}：EngineObservationTap.offer 必须同步，返回了 thenable——已停用该 tap` });
          Promise.resolve(r).then(
            () => {},
            () => {},
          );
        }
      } catch (e) {
        report({ code: "observation_fact_dropped", message: `${instrumentation.name}：${redactedLabel(e)}` });
      }
    },
  };
}

export type IngestFactSinkContext = Readonly<{
  runtimeId: string;
  runtimeGeneration: string;
  capturePolicy: ObservationCapturePolicy;
  owner: ObservationOwner;
}> &
  FactSinkOptions;

/**
 * 完整 Runtime：descriptor → `ObservationIngest.offer()`（bounded lane）。body 原样交给 Sequencer normalize。
 * 与 engine adapter 同样在构造期钉住 instrumentation / owner / runtime 身份（见上）。
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
