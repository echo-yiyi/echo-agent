// `/engine` 的只读观测口（§15.6，OR14）：构造期 host-owned `EngineObservationTap`。
//
// **它是 consumer seam，不是 writer**：调用方只提供 consumer，拿不到 Sequencer / canonical identity / 查询 /
// renderer。fact 没有 `recordId / runtimeId / canonical seq`，是明确的 ephemeral 投影——评测与 `/engine`
// 纯 loop fixture 用它看到与完整 Runtime **同一 descriptor、同一 body** 的事实（§15.14 O3a 门 9），
// 但不声称 persistence、gap、RunIndex、历史查询或 renderer 完整性。
//
// 纯 Web-standard：这个文件可从 `/engine` 到达，engine 纯度门盯着它。

import type { ObservationCapturePolicy, ObservationRecordKind, ObservationValue } from "./types.ts";

export type EngineObservationScope = Readonly<{
  agentId?: string;
  agentInstanceId?: string;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  activityId?: string;
  toolCallId?: string;
}>;

export type EngineObservationFact<T extends ObservationValue = ObservationValue> = Readonly<{
  schemaVersion: 1;
  kind: ObservationRecordKind;
  /** 与 canonical descriptor 同名。 */
  name: string;
  occurredAt: number;
  sourceSeq?: number;
  scope: EngineObservationScope;
  /** 与 canonical envelope 同名同义。**必须在这条面上**：只进 Runtime 一侧的字段会让两边的
   *  admission boundary 错开（review 实测 9,000 字节 subject：engine 收下、Runtime 成 gap）。 */
  subject?: Readonly<{ kind: string; id: string }>;
  attributes: Readonly<Record<string, string | number | boolean>>;
  body: T;
}>;

export interface EngineObservationTap {
  readonly capturePolicy: ObservationCapturePolicy;
  /** Agent 在固定 descriptor / capture / normalize 后调用；同步、不得返回 Promise，异常由 Agent catch + diagnostic 隔离。 */
  offer(fact: EngineObservationFact): void;
}

/**
 * descriptor 的产出：**body 尚未 normalize**。两条 adapter 各自收尾——送 `EngineObservationTap` 的在 adapter 里
 * normalize（失败 → 丢 + 诊断）；送 `ObservationIngest` 的把原 body 交给 Sequencer（失败 → hole + gap）。
 * 这样 normalize 仍只有 `normalizeObservationValue()` 一处，只是被调的位置不同。
 */
export type ObservationFactProjection = Readonly<{
  kind: ObservationRecordKind;
  name: string;
  occurredAt: number;
  sourceSeq?: number;
  scope: EngineObservationScope;
  attributes: Readonly<Record<string, string | number | boolean>>;
  body: unknown;
  subject?: Readonly<{ kind: string; id: string }>;
}>;
