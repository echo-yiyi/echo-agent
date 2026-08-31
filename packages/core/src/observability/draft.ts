// Host-internal producer 输入（§15.4.1 末尾）。**不从 observability 公共子路径导出**：
// producer 只提交自己领域内的 typed draft，identity（recordId / seq / observedAt）与最终 JSON normalize
// 都归 Sequencer；把 draft 露到公共面等于允许外部伪造 canonical identity。

import type { ObservationEnvelope, RunObservationHeader } from "./types.ts";

export type ObservationDraft<TInput = unknown> = Readonly<
  Omit<ObservationEnvelope, "schemaVersion" | "recordId" | "seq" | "observedAt" | "body"> & { body: TInput }
>;

export type BoundedObservationDraft<TInput = unknown> = ObservationDraft<TInput> & Readonly<{ lane: "bounded" }>;

export type BoundaryObservationDraft<TInput = unknown> = ObservationDraft<TInput> & Readonly<{ lane: "boundary" }>;

/* ══════════════════ run 边界三事实的 body（§15.3.5 / §15.5.2；只有各自的唯一 owner 发） ══════════════════ */

/**
 * `run.accepted` 的 body：RunIndex header 的种子。status / integrity / persistence / startedAt / endedAt
 * 是 index 侧由 Sequencer materialize 的，admission 不能自报（§15.5.1「terminal body 不自指 persistence」）。
 */
export type RunObservationHeaderSeed = Readonly<
  Omit<RunObservationHeader, "schemaVersion" | "status" | "integrity" | "persistence" | "startedAt" | "endedAt">
>;

export type RunAcceptedBodyV1 = Readonly<{ header: RunObservationHeaderSeed }>;

/** `run.started` 没有额外事实：permit executor 真正进入 loop 的那一拍。 */
export type RunStartedBodyV1 = Readonly<{ startedBy: "permit-executor" }>;

/** run 边界三事实的固定名字；其它 producer 不得重发（唯一 emission owner，§15.3.5）。 */
export const RUN_BOUNDARY_NAMES = ["run.accepted", "run.started", "run.closed"] as const;
export type RunBoundaryName = (typeof RUN_BOUNDARY_NAMES)[number];
