// 主动释放与意外丢锁共用的 host lifecycle port。
//
// **只允许 composition root 构造时注入**：不进 Extension ABI，也不从 AgentHandle 暴露。
// 它只处理 Host 自己拥有的收尾（完整 Runtime 是 canonical Observation writer；standalone 是对应的
// adapter 或 no-op）——**它不拥有 ingress target，也不重复 drain**：那是 concrete Agent 的事。

/** 丢锁的原因。V0 直接给 `Lease.lost` resolve 出来的那个 Error，不另造一套分类。 */
export type LeaseLossReason = Error;

export interface StateLeaseLifecycle {
  /**
   * 正常交还租约之前的最后一站：**cell 仍 installed、根闸仍开**，可以 flush / pause / close 自己的 writer。
   * 返回之后 Agent 才 revoke cell、关根闸、`Lease.release()`——三步之间禁止新的 state-root I/O。
   *
   * `reason` 由 Agent 按实际路径盖章：从 `restored(paused)` 收摊是 `handoff`，直接 shutdown 是 `stop`。
   * **调用方不能伪造 reason 改变 drain / abort 行为**。
   */
  beforeLeaseRelease(input: { reason: "stop" | "handoff" }): Promise<void>;

  /**
   * 意外丢锁之后的封口。**幂等**，每份 Lease 至多调用一次。
   * 这时状态根已经不归本进程——**不得尝试 flush**，只能封住自己的 writer，未持久的诊断留在内存里。
   */
  onLeaseLost(reason: LeaseLossReason): Promise<void>;
}
