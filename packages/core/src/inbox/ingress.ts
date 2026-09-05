// Durable ingress 的公共协议：**V0 只有这一种 `deliverDurable()` 返回类型**。
//
// 「投成功了吗」的答复走这里：`accepted` 只在 Inbox record 已持久化后返回；相同 pending dedupeKey 返回原
// `recordId` 与 `deduplicated:true`。运行期拒绝与 Store I/O 失败都 fulfill 结构化 result，**不用 Promise rejection
// 表达**；只有不应可达的 Host invariant bug 才 throw。

import type { AgentMessage } from "../messages.ts";

export type DurableDeliveryRequest = Readonly<{
  message: AgentMessage;
  /**
   * **pending durable fact 防重**用，不是永久 message identity。有稳定事实身份时用作用域化业务 key
   * （schedule incarnation、task ID、webhook event ID）；没有自然身份时，调用方必须为**每次** delivery 生成唯一
   * UUID——那等价于主动关闭跨调用去重。空字符串直接 `rejected(invalid-request)`；固定常量或跨事实复用同一 key
   * 属于 producer conformance failure，Host 无法从单个非空字符串证明它，责任由 adapter 测试与第三方契约承担。
   */
  dedupeKey: string;
}>;

export type DurableDeliveryResult =
  | Readonly<{
      kind: "accepted";
      recordId: string;
      dedupeKey: string;
      deduplicated: boolean;
    }>
  | Readonly<{
      kind: "rejected";
      reason:
        | "runtime-not-ready"
        | "lease-gap"
        | "stopping"
        | "lease-lost"
        | "runtime-failed"
        | "runtime-disposed"
        | "invalid-request"
        | "store-error";
      errorDigest?: string;
    }>;

export interface DurableIngressPort {
  deliverDurable(request: DurableDeliveryRequest): Promise<DurableDeliveryResult>;
}

/**
 * Host-internal：结构化 rejected → Promise rejection 的**唯一**转接口，给签名不能改的领域端口用
 * （`ScheduleDeps.deliver` 就是：accepted / deduplicated 映射成 resolve，任何 rejected 映射成本错误，
 * 于是现有 tick/catch-up 的 catch 路径保留 entry / due occurrence 并报告原因）。
 * **不进 public exports**：adapter 不重写 schedule 状态机，也不把 rejected 当已投递。
 */
export class DurableDeliveryDeferred extends Error {
  readonly code = "durable_delivery_deferred";
  constructor(readonly delivery: Extract<DurableDeliveryResult, { kind: "rejected" }>) {
    super(`durable 投递未被接受（${delivery.reason}）——事实保留，稍后重试`);
    this.name = "DurableDeliveryDeferred";
  }
}
