// `@echo-agent/core/observability` —— 观测的**公共类型与只读工具**（公共类型、查询面类型与 renderer 从这条子路径导出）。
//
// 这里只有 JSON-safe 的类型、上限常量、快照构造器与**纯函数** renderer。**Sequencer / store / fact-sink 不在这里**：
// 它们是 Host-internal seam，露出来等于允许外部伪造 canonical identity。draft 的 7 个符号**目前还从这里导出**
//（下面最后两行）——[观测的公开线](../../../../docs/decisions/proposed/2026-09-07-observation-public-face.md) 第 2 条拍了要收回这条子路径、
// 尚未实现；在那之前别把「不导出」写成现状（review 2026-09-07）。
// 会碰盘的入口（`openObservationReader`）在根入口——根入口本来就是 node-only。
//
// 纯（不碰 `node:` / `bun:`）：浏览器 / Worker 里的渲染消费者也能 import。

export * from "./types.ts";
export { sealAgentAssemblyObservation, snapshotRunModelBinding } from "./assembly.ts";
export type { BuiltinSlotContribution } from "./assembly.ts";
export { buildRunObservationViewModel, renderRunObservation, RENDERER_VERSION } from "./render.ts";
export { materializeRunObservation, decodeObservationEnvelope, pairSpans, NOT_CAPTURED } from "./materialize.ts";
export { ObservationCorruptionError, ObservationStoreUnavailableError } from "./store.ts";
export { RUN_ASSEMBLY_RECORD, RUN_BOUNDARY_NAMES } from "./draft.ts";
export type { RunAssemblyBodyV1, RunBoundaryName, RunAcceptedBodyV1, RunStartedBodyV1, RunObservationHeaderSeed } from "./draft.ts";
