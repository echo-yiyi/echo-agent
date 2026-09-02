// Host-internal 的观测接线（§15，O3a）：canonical writer **不进公共 `AgentOptions`**。
//
// 与 `state/host-wiring.ts` 同一个理由、同一个做法：`AgentOptions` 是根入口与 `/engine` 的公开类型，
// 往里放 `ObservationIngest` 等于允许任何调用方伪造 canonical identity（§15.4.1 末尾）。这里的东西只由
// 同一个包内的 composition root（`createAgent`）在构造之后挂上；Extension 与外部调用方拿不到、也看不见。
// Agent 按需 `observationHostOf(this)` 读——没挂就是 `/engine` 那条路：只有 `AgentOptions.observationTap`，没有 journal。

import type { ObservationRuntime } from "./runtime.ts";

export type ObservationHostWiring = Readonly<{
  runtime: ObservationRuntime;
}>;

const WIRING = new WeakMap<object, ObservationHostWiring>();

/** composition root 在构造之后、`start()` 之前挂上。重复挂 fail-loud：一个 Agent 只有一套 canonical writer。 */
export function attachObservationHost(agent: object, wiring: ObservationHostWiring): void {
  if (WIRING.has(agent)) throw new Error("这个 Agent 已经挂过观测接线了：一个 Agent 只服务一个 canonical writer");
  WIRING.set(agent, wiring);
}

export function observationHostOf(agent: object): ObservationHostWiring | undefined {
  return WIRING.get(agent);
}
