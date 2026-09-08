// 错误分类学：一套形状，三个挂点。
//
// 三个挂点各服务一种消费：
//   agent_end.outcome → 决策（接下来怎么办）
//   AssistantMessage.error → 渲染（这条消息怎么显示）
//   AgentState.lastError → 查询（最近一次怎么死的）
// 三处同一形状，所以分支逻辑在哪写都是同一个 switch。
//
// **不设独立的 error 事件**：错误沿数据流返回——它是终结事件的一个侧面，不是一种事件。
// 孤立的错误广播会逼前端自己做「这错属于哪条消息/哪个工具卡」的关联。

/** 错误的稳定键：页面聚合、重试判据、审计都认它，措辞可变、code 不可变。 */
export type ErrorCode =
  // —— provider 侧 ——
  | "context_overflow" // 上下文超出模型窗口
  | "rate_limit" // 限流
  | "auth" // 凭据缺失/失效
  | "timeout" // 超时
  | "network" // 连接失败
  | "protocol" // 后端违约（缺终结事件、响应不可解析）
  | "server" // 后端 5xx
  // —— 工具侧 ——
  | "tool_not_found"
  | "tool_bad_params"
  | "tool_crashed"
  // —— 自身 ——
  | "aborted"
  | "max_iterations" // 一条 reply 的 turn 上限
  | "max_replies" // 一个 run 的 reply 上限（达上限且仍有待办）
  | "internal";

/* ══════════════════ 中断的理由 ══════════════════ */

/**
 * `AbortSignal.reason` 里装的中断理由。**必须是 `AbortError` 形状的 `DOMException`**：provider 靠 `name === "AbortError"`
 * 识别「请求被中止」（`provider/openai.ts`），裸字符串会让 fetch 的 rejection 被当成别的错误、run 以 error 而非 aborted 收场。
 * 理由是自由字符串：宿主传什么透传什么；core 自己发起的用 `ABORT_REASON` 里的常量。
 */
export class AbortReason extends DOMException {
  constructor(readonly reason: string) {
    super(reason, "AbortError");
  }
}

/** 从 signal 取回中断理由；没给理由的裸 `abort()`（或不是本仓装进去的）返回 undefined。 */
export function abortReasonOf(signal: AbortSignal): string | undefined {
  return signal.reason instanceof AbortReason ? signal.reason.reason : undefined;
}

/**
 * core 自己发起的中断在 outcome 里用的理由常量（docs/decisions/implemented/2026-09-01-abort-reason.md）。
 * 不做枚举——枚举会把宿主的中断理由挤成 other。
 */
export const ABORT_REASON = Object.freeze({
  /** 状态锁丢了：这段不再属于本进程。 */
  leaseLost: "lease-lost",
  /** Agent 收摊（stop / dispose）。 */
  dispose: "dispose",
} as const);

export type AgentError = {
  source: "provider" | "tool" | "internal";
  code: ErrorCode;
  /** 「再试一次可能就好了」——重试闸只认这一位，不猜异常类型。 */
  retryable: boolean;
  message: string;
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "rate_limit",
  "timeout",
  "network",
  "server",
]);

export function agentError(
  source: AgentError["source"],
  code: ErrorCode,
  message: string,
  retryable = RETRYABLE.has(code),
): AgentError {
  return { source, code, retryable, message };
}

/** 认不出来的异常一律 internal + 不可重试——猜「大概能重试」会把 bug 重复放大 N 遍。 */
export function classifyUnknown(e: unknown): AgentError {
  return agentError("internal", "internal", errText(e), false);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 一条诊断（加载失败、连不上、写盘失败）。**不上报就是静默失败**。 */
export type Diagnostic = {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};
