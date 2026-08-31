// Permission stage 的公共词汇。设计见 docs/design/AGENT-CORE.md §14.10.3 / §14.2.3。
//
// 授权不是普通 preToolUse hook：它是工具流水线里**固定位置的一道 stage**——
//   transform hooks → 对最终参数重新校验 → freeze → authorization（只能决定，不能改参数）→ execute。
// 三条不变量：
//   - authorization 永远看到最终冻结参数；ask 里的 `params`、Inspector 看到的、Tool `execute()` 收到的是**同一份**对象；
//   - 只有真正进入 ask 才生成 `permissionId`；policy 直接 allow/deny 没有 ask，也就没有 ID；
//   - Hook 对 permission 生命周期事件只能观察，回答只能来自可信宿主的 `answerPermission()`。

/** 进入 ask 时向宿主公开的形状：宿主要展示的就是这一份（含冻结后的最终参数）。 */
export type PermissionAsk = Readonly<{
  permissionId: string;
  runId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  params: unknown;
  reason: string;
}>;

/** 可信宿主的回答。只引用 ID——不能携带另一份参数把已批准内容换掉。 */
export type PermissionAnswer = Readonly<{
  permissionId: string;
  decision: "allow" | "deny";
  reason?: string;
}>;

export type PermissionAnswerResult =
  | Readonly<{
      kind: "accepted";
      permissionId: string;
      runId: string;
      toolCallId: string;
      decision: "allow" | "deny";
    }>
  | Readonly<{
      kind: "stale";
      permissionId: string;
      reason: "unknown" | "superseded";
      currentPermissionId?: string;
    }>
  | Readonly<{
      kind: "closed";
      permissionId: string;
      reason: "answered" | "timed-out" | "run-aborted" | "runtime-disposed";
    }>;

/** ask 超时的唯一 owner 是 policy（§14.10.3）：`null` = 等人，不超时。 */
export type PermissionPolicyConfig = Readonly<{
  askTimeoutMs: number | null;
}>;

/** authorization 看到的现场：`params` 已是冻结后的最终参数。 */
export type PermissionAuthorizeInput = Readonly<{
  runId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  params: unknown;
}>;

/** authorization 的裁决。**只能决定，不能改参数**——这里没有 patch 位。 */
export type PermissionVerdict =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "deny"; reason: string }>
  | Readonly<{ kind: "ask"; reason: string }>;

export type PermissionAuthorizer = (input: PermissionAuthorizeInput) => PermissionVerdict | Promise<PermissionVerdict>;

/**
 * Agent 构造期收的策略（`AgentOptions.permission`）。
 *
 * `askTimeoutMs: null` 意味着 ask 要等人——那就必须有人：`responder:"host"` 是宿主的显式声明
 * （并且首个 run 前必须已经 `subscribeLifecycle()`，否则 run 入口 fail-loud，不能等到 Tool 已暂停才发现无人回答）；
 * `responder:"none"` 是诚实缺席：策略仍可返回 ask，但 Agent 把它当作 policy deny 封口，不生成 ask。
 * 两者都没给、又不超时 → 构造期 fail-loud。有限 `askTimeoutMs` 时 responder 可省：宿主答就答，不答到点拒。
 */
export type PermissionPolicy = PermissionPolicyConfig &
  Readonly<{
    authorize: PermissionAuthorizer;
    responder?: "host" | "none";
  }>;

/** 一次 ask 的最终结算——loop 据此发 granted/denied/cancelled 事件并决定执行与否。 */
export type PermissionSettlement =
  | Readonly<{ kind: "allow"; decidedBy: "human" }>
  | Readonly<{ kind: "deny"; decidedBy: "human" | "timeout"; reason: string }>
  | Readonly<{ kind: "cancelled"; reason: "run-aborted" | "runtime-disposed" }>;

export type PermissionAskHandle = Readonly<{
  permissionId: string;
  settled: Promise<PermissionSettlement>;
}>;

/**
 * loop 看到的 stage 接口（`AgentLoopConfig.permission`）。Agent 用自己的 ledger + policy 实现它；
 * `ask()` 同步登记并返回 ID——`permissionRequest` 事件要带着这个 ID 恰好发一次，所以 ID 必须先于等待拿到。
 */
export interface PermissionStage {
  authorize(input: PermissionAuthorizeInput): PermissionVerdict | Promise<PermissionVerdict>;
  ask(input: PermissionAuthorizeInput & Readonly<{ reason: string }>, signal: AbortSignal): PermissionAskHandle;
}
