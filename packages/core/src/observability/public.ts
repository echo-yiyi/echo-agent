// `@echo-agent/core/observability` —— 观测的**公共类型与只读工具**（§15：公共类型、查询与 renderer 从这条子路径导出）。
//
// 这里只有 JSON-safe 的类型、上限常量、快照构造器。**Sequencer / store / draft / fact-sink 不在这里**：
// 它们是 Host-internal seam，露出来等于允许外部伪造 canonical identity（§15.4.1 末尾）。
// 查询面（`EchoObservations`）与 renderer 随 O3a 进来。
//
// 纯（不碰 `node:`）：engine 面的消费者也能 import。

export * from "./types.ts";
export type { EngineObservationFact, EngineObservationScope, EngineObservationTap } from "./engine-tap.ts";
export { sealAgentAssemblyObservation, snapshotRunModelBinding } from "./assembly.ts";
export type { BuiltinSlotContribution } from "./assembly.ts";
