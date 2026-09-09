// Host-internal producer 输入。producer 只提交自己领域内的 typed draft，identity（recordId / seq / observedAt）
// 与最终 JSON normalize 都归 Sequencer；把 draft 露到公共面等于允许外部伪造 canonical identity。
// **今天 `public.ts` 仍导出这里的 7 个符号**（`RUN_ASSEMBLY_RECORD` 等）：收回 `./observability` 子路径已拍板未实现
//（`docs/decisions/proposed/2026-09-07-observation-public-face.md` 第 2 条），做之前这句「不导出」不是现状。

import type { AgentAssemblyObservationSnapshot, ObservationEnvelope, RunModelBindingObservationSnapshot, RunObservationHeader } from "./types.ts";

export type ObservationDraft<TInput = unknown> = Readonly<
  Omit<ObservationEnvelope, "schemaVersion" | "recordId" | "seq" | "observedAt" | "body"> & { body: TInput }
>;

export type BoundedObservationDraft<TInput = unknown> = ObservationDraft<TInput> & Readonly<{ lane: "bounded" }>;

export type BoundaryObservationDraft<TInput = unknown> = ObservationDraft<TInput> & Readonly<{ lane: "boundary" }>;

/* ══════════════════ run 边界三事实的 body（只有各自的唯一 owner 发） ══════════════════ */

/**
 * `run.accepted` 的 body：RunIndex header 的种子。status / integrity / persistence / startedAt / endedAt
 * 是 index 侧由 Sequencer materialize 的，admission 不能自报（「terminal body 不自指 persistence」）。
 */
export type RunObservationHeaderSeed = Readonly<
  Omit<RunObservationHeader, "schemaVersion" | "status" | "integrity" | "persistence" | "startedAt" | "endedAt">
>;

/** `run.accepted` 的 body：恰好 `{ header }`，Sequencer 据此建 RunIndex。 */
export type RunAcceptedBodyV1 = Readonly<{ header: RunObservationHeaderSeed }>;

/** `run.started` 没有额外事实：permit executor 真正进入 loop 的那一拍。 */
export type RunStartedBodyV1 = Readonly<{ startedBy: "permit-executor" }>;

/** run 边界三事实的固定名字；其它 producer 不得重发（唯一 emission owner）。 */
export const RUN_BOUNDARY_NAMES = ["run.accepted", "run.started", "run.closed"] as const;
/** `"run.accepted" | "run.started" | "run.closed"`。 */
export type RunBoundaryName = (typeof RUN_BOUNDARY_NAMES)[number];

/**
 * `run.accepted` 之后紧跟的一条 boundary snapshot：本 run 冻结的 sealed AgentAssembly 与 RunModelBinding。
 * 不塞进 `run.accepted` body——那个 body 被 Sequencer 钉死为恰好 `{ header }`（RunIndex 种子）。同一 owner（admission）发。
 */
export const RUN_ASSEMBLY_RECORD = "run.assembly";

/** `run.assembly` 的 body：sealed AgentAssembly 快照 + 本 run 的模型绑定快照。 */
export type RunAssemblyBodyV1 = Readonly<{
  agentAssembly: AgentAssemblyObservationSnapshot;
  modelBinding: RunModelBindingObservationSnapshot;
}>;
