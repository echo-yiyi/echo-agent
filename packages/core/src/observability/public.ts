// `@echo-agent/core/observability` —— 观测的**公共类型与只读工具**（§15：公共类型、查询面类型与 renderer 从这条子路径导出）。
//
// 这里只有 JSON-safe 的类型、上限常量、快照构造器与**纯函数** renderer。**Sequencer / store / draft / fact-sink 不在这里**：
// 它们是 Host-internal seam，露出来等于允许外部伪造 canonical identity（§15.4.1 末尾）。
// 会碰盘的入口（`openObservationReader`）在根入口——根入口本来就是 node-only。
//
// 纯（不碰 `node:` / `bun:`）：engine 面的消费者也能 import。

export * from "./types.ts";
export type { EngineObservationFact, EngineObservationScope, EngineObservationTap } from "./engine-tap.ts";
export { sealAgentAssemblyObservation, snapshotRunModelBinding } from "./assembly.ts";
export type { BuiltinSlotContribution } from "./assembly.ts";
export { buildRunObservationViewModel, renderRunObservation, RENDERER_VERSION } from "./render.ts";
export { materializeRunObservation, decodeObservationEnvelope, pairSpans, NOT_CAPTURED } from "./materialize.ts";
export { ObservationCorruptionError, ObservationStoreUnavailableError } from "./store.ts";
export { RUN_ASSEMBLY_RECORD, RUN_BOUNDARY_NAMES } from "./draft.ts";
export type { RunAssemblyBodyV1, RunBoundaryName, RunAcceptedBodyV1, RunStartedBodyV1, RunObservationHeaderSeed } from "./draft.ts";
