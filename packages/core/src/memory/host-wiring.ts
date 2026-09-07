// Host-internal 的接线：记忆 project 层的**一次性重指口**不进公共 `AgentOptions`。
//
// 与 `state/host-wiring.ts` 同一个理由：`AgentOptions` 是根入口的公开类型，往里加字段就是公共面
// 变化——「公共类型里可配置、文档却说只有 composition root 能用」是个站不住的中间态。project 层
// 的三个根是 `createAgent` 的 `prepareCapabilities` 接上的，重指口也只由**同一个包内的
// composition root** 在构造之后挂上；Extension 与外部调用方拿不到、也看不见。
//
// 低层 `new Agent({ memory })` 自己装记忆的宿主没挂这一份 = `start()` 里那一步是空操作：
// 它的记忆字节面是自己给的，core 不知道哪一层是 project、也无权替它换。

export type MemoryHostWiring = Readonly<{
  /**
   * `Agent.start()` 从盘上拿到权威 workspace 之后调**一次**，把记忆的 project 层重指到它的目录。
   *
   * 「只生效一次」由实现保证（`memory/scope.ts` 的 `projectScopeBinding`），不是靠调用方只调一次：
   * 运行中的 `setWorkspace()` 故意不重指（2026-09-07 用户拍板），这条纪律不该建立在调用点自觉上。
   *
   * 目录里那份 `workspace.json` 与新 workspace 对不上时 **reject**（48 位哈希撞了），`start()` 判红。
   */
  pinProjectWorkspace?: (workspace: string) => Promise<void>;
}>;

const WIRING = new WeakMap<object, MemoryHostWiring>();

/** composition root 在构造之后、`start()` 之前挂上。重复挂 fail-loud：一个 Agent 只有一套记忆字节面。 */
export function attachMemoryHost(agent: object, wiring: MemoryHostWiring): void {
  if (WIRING.has(agent)) throw new Error("这个 Agent 已经挂过记忆 host 接线了：一个 Agent 只服务一套记忆字节面");
  WIRING.set(agent, wiring);
}

export function memoryHostOf(agent: object): MemoryHostWiring | undefined {
  return WIRING.get(agent);
}
