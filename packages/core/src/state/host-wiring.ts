// Host-internal 的接线：状态根写入总闸与 lease lifecycle port **不进公共 `AgentOptions`**。
//
// 为什么用 WeakMap 而不是构造参数：`AgentOptions` 是根入口的公开类型，往里加字段就是公共面变化
// ——「公共类型里可配置、文档却说只有 composition root 能用」是个站不住的中间态（普通用户能注入自己的
// lifecycle port，而 `createAgent` 又会把 gate 静默覆盖）。这里的两件东西只由**同一个包内的 composition root**
// 在构造之后挂上，Extension 与外部调用方都拿不到、也看不见。

import type { StateWriteGate } from "./write-gate.ts";
import type { StateLeaseLifecycle } from "./lease-lifecycle.ts";
import type { AdoptionLedger } from "../assembly/ledger.ts";

export type StateHostWiring = Readonly<{
  gate?: StateWriteGate;
  leaseLifecycle?: StateLeaseLifecycle;
  /**
   * 装配现场转过来的所有权账本：这一个 Agent 是全部 adopt slot 的唯一 dispose owner，
   * `stop()` 排空它。同样不进公共 `AgentOptions`——外部注入一份「保险 disposer」正是要防的那件事。
   */
  adoption?: AdoptionLedger;
}>;

const WIRING = new WeakMap<object, StateHostWiring>();

/** composition root 在构造之后、`start()` 之前挂上。重复挂 fail-loud：一个 Agent 只有一套 host 接线。 */
export function attachStateHost(agent: object, wiring: StateHostWiring): void {
  if (WIRING.has(agent)) throw new Error("这个 Agent 已经挂过 host 接线了：一个 Agent 只服务一套 gate / lifecycle");
  WIRING.set(agent, wiring);
}

export function stateHostOf(agent: object): StateHostWiring | undefined {
  return WIRING.get(agent);
}
