// 压缩流水线的观测探针：一次压缩的起止，在流水线的执行节点上记。
//
// 与 `loop/observe.ts` 同一条规矩：**观测是插桩，不是事件协议**——这里不转发 `compaction_start / compaction_end`
// 这两个给壳的事件，流水线在同一个节点上与 emit 并列调探针。
//
// 纯 Web-standard（不碰 `node:`）。

import type { CompactionReason, CompactionState } from "./types.ts";
import type { CapabilityFactDescriptor, CapabilityFactSink, ObservationFactProjection } from "../observability/fact-sink.ts";
import type { ObservationCapturePolicy } from "../observability/types.ts";

export const COMPACTION_INSTRUMENTATION = { name: "echo.compaction", version: "1" } as const;

export const SPAN_CONTEXT_COMPACT = "context.compact";

export type CompactionFactBody =
  | { kind: "compaction_started"; reason: CompactionReason }
  | { kind: "compaction_ended"; reason: CompactionReason; compaction: CompactionState; stages: readonly string[]; contextTokens: number }
  /**
   * 带 `stage`：那个阶段抛错（流水线跳过它继续）；不带：整条跑完没有任何一段改动上下文。
   * 此前给壳的 `compactionFailed` 没人收（TUI 的 default 分支丢掉），观测也不记——压缩失败完全不可见。
   */
  | { kind: "compaction_failed"; reason: CompactionReason; stage?: string; message: string };

/**
 * 带发生时刻与所在循环身份的事实：`runId` 是跑这次压缩的循环的 run，`turnId` 只在 turn 里撞窗应急时才有
 * （轮首的自动压缩发生在两轮之间）。与循环事实同一条规矩：身份自带，不从外面那个 Agent 补。
 */
export type CompactionFact = CompactionFactBody & Readonly<{ at: number; runId: string; turnId?: string }>;

export type CompactionProbe = CapabilityFactSink<CompactionFact>;

/** 节点上调它：补发生时刻与身份，交给探针。没给探针就什么都不做。 */
export function probeCompaction(sink: CompactionProbe | undefined, where: Readonly<{ runId: string; turnId?: string }>, fact: CompactionFactBody): void {
  sink?.offer({ ...fact, at: Date.now(), runId: where.runId, ...(where.turnId !== undefined ? { turnId: where.turnId } : {}) } as CompactionFact);
}

function scopeOf(fact: CompactionFact): Readonly<Record<string, string>> {
  return { runId: fact.runId, ...(fact.turnId !== undefined ? { turnId: fact.turnId } : {}) };
}

export function projectCompactionFact(fact: CompactionFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
  if (policy === "off") return null;
  const base = { occurredAt: fact.at } as const;
  const content = policy === "content";
  switch (fact.kind) {
    case "compaction_started":
      return { ...base, kind: "span_start", name: SPAN_CONTEXT_COMPACT, scope: scopeOf(fact), attributes: { reason: fact.reason }, body: { reason: fact.reason } };
    case "compaction_ended": {
      // metadata 档：只有形状（段数、清到哪、哪些阶段动了、压完多大）；content 档才带各段摘要正文
      const body: Record<string, unknown> = {
        reason: fact.reason,
        stages: [...fact.stages],
        spans: fact.compaction.spans.map((s) => (content ? { from: s.from, to: s.to, summary: s.summary } : { from: s.from, to: s.to, summaryChars: s.summary?.length ?? 0 })),
        clearedBefore: fact.compaction.clearedBefore,
        contextTokens: fact.contextTokens,
      };
      return { ...base, kind: "span_end", name: SPAN_CONTEXT_COMPACT, scope: scopeOf(fact), attributes: { reason: fact.reason, changed: fact.stages.length > 0 }, body };
    }
    case "compaction_failed": {
      // 阶段名是标识，metadata 档就记；错误消息来自第三方阶段，可能带上下文正文，只在 content 档记
      const attrs: Record<string, string> = { reason: fact.reason };
      if (fact.stage !== undefined) attrs.stage = fact.stage;
      const body: Record<string, unknown> = { ...attrs };
      if (content) body.message = fact.message;
      return { ...base, kind: "event", name: "context.compact.failed", scope: scopeOf(fact), attributes: attrs, body };
    }
  }
}

export const compactionFactDescriptor: CapabilityFactDescriptor<CompactionFact> = {
  instrumentation: COMPACTION_INSTRUMENTATION,
  project: projectCompactionFact,
};
