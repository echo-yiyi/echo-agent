// Run admission 的公共类型面（docs/design/AGENT-CORE.md §14.2.4「Unified Run Admission」）。
//
// 一条 run 要跑，先取得 permit：用户 prompt、Agent 内建的 Inbox 消费、Dream 整理，最终都经同一个 admission。
// 这里只有 host port 的形状：`AgentAdmissionPort`、request / ticket / result / execute scope，以及每次 admission
// 冻结的 model seam（`RunModelBinding`）。RunPermit、并发裁决、失败规范化都是 Host 私有——不从这里出。

import type { LoopResult } from "../loop/types.ts";
import type { AgentError } from "../errors.ts";
import type { RetryPolicy } from "../provider/dialect.ts";
import type { StreamFn, ThinkingLevel } from "../provider/types.ts";

export type RunSource =
  | Readonly<{ kind: "user" | "inbox" | "dream" }>
  | Readonly<{ kind: "extension"; entryId: string; sourceId: string }>;

/** JSON-like：plain object / array / string / boolean / null / finite number。别的（函数、symbol、bigint、class 实例、循环）一律拒。 */
export type ModelSnapshotValue =
  | null
  | boolean
  | number
  | string
  | readonly ModelSnapshotValue[]
  | { readonly [key: string]: ModelSnapshotValue };

/** `Model` 的 JSON-like 冻结快照：递归 clone + freeze，catalog 里的原对象之后怎么变都影响不到已接受的 run。 */
export type RunModelSnapshot = Readonly<{
  provider: string;
  id: string;
  api: string;
  name?: string;
  capabilities?: Readonly<{
    reasoning?: boolean;
    vision?: boolean;
    contextWindow?: number;
    maxOutputTokens?: number;
  }>;
  cost?: Readonly<{
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  }>;
  params?: Readonly<Record<string, ModelSnapshotValue>>;
  thinkingLevelMap?: Readonly<Partial<Record<ThinkingLevel, string | null>>>;
}>;

/**
 * 每次 admission 的完整 model seam：provider 身份、model 快照、stream function、凭据解析、有效 thinkingLevel、重试策略
 * 一起固定到同一 catalog revision。`streamFunction` / `getApiKey` / `retryPolicy.backoffMs` 是 opaque reference，
 * 不进 clone；其余数据部分由 Host 新建并 freeze，不别名 caller 的可变对象。
 */
export type RunModelBinding = Readonly<{
  bindingId: string;
  source: RunSource;
  purpose: "foreground" | "maintenance";
  catalogRevision: string;
  provider: Readonly<{
    id: string;
    entryId: string;
    generation: string;
  }>;
  model: RunModelSnapshot;
  streamFunction: StreamFn;
  getApiKey?: (providerId: string) => Promise<string | undefined> | string | undefined;
  /** admission 时算出的有效值（缺省已归一为 "off"），不是「执行时再读 Agent 当前值」。 */
  thinkingLevel: ThinkingLevel;
  retryPolicy: Readonly<RetryPolicy>;
  maxRetryDelayMs?: number;
}>;

/** Agent 内建来源的 run 请求：Inbox 一批（带 reservation）或 Dream 整理。用户 run 走 Host 私有入口，不经这里。 */
export type AgentInternalRunRequest =
  | Readonly<{
      source: Readonly<{ kind: "inbox" }>;
      priority: "foreground";
      purpose: "foreground";
      /** concrete Agent 的 reservation ledger 发的单次 ID；port 只经 `assertReserved` 闭包核对，不复制 record。 */
      reservationId: string;
      /** 非空、有序、去重；必须与 reservation 完全相等。 */
      reservedRecordIds: readonly string[];
    }>
  | Readonly<{
      source: Readonly<{ kind: "dream" }>;
      priority: "maintenance";
      purpose: "maintenance";
    }>;

export type AgentAdmissionResult<TResult extends LoopResult = LoopResult> =
  | Readonly<{ kind: "executed"; runId: string; result: TResult }>
  /** execute 同步 throw / 异步 reject：Admission 捕获并规范化成配对的终结事件与 LoopResult，ticket 仍 fulfill。 */
  | Readonly<{ kind: "callback-error"; runId: string; result: LoopResult; error: AgentError }>
  | Readonly<{
      kind: "rejected";
      reason: "paused" | "stopping" | "lease-lost" | "superseded";
    }>;

/** `enqueue()` 同步返回：只取得 request ownership，不等 permit、不等 run 完成。`settled` 恰好 fulfill 一次，绝不 reject。 */
export type AgentAdmissionTicket<TResult extends LoopResult = LoopResult> = Readonly<{
  requestId: string;
  settled: Promise<AgentAdmissionResult<TResult>>;
}>;

export type AgentAdmissionExecuteScope = Readonly<{
  runId: string;
  /** 前台抢占 Dream、shutdown、丢锁都从这里发；execute 必须尊重。 */
  signal: AbortSignal;
  modelBinding: RunModelBinding;
}>;

export interface AgentAdmissionPort {
  /**
   * 同步取得 request ownership 并返回 ticket。`execute` **至多调用一次**（未获 permit 的 rejected ticket 零次）；
   * 调用者要结算就 `await ticket.settled`，拿不到、也关不了 permit。
   * request 自身不合法（reservation 不存在 / record 集合错序 / ID 为空）是受保护接线的编程不变量破坏：创建 ticket 前同步抛。
   */
  enqueue<TResult extends LoopResult>(
    request: AgentInternalRunRequest,
    execute: (scope: AgentAdmissionExecuteScope) => Promise<TResult>,
  ): AgentAdmissionTicket<TResult>;
}
