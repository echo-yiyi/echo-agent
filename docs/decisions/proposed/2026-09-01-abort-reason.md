# abort reason 是否调用者可依赖的终止信息

> 状态:proposed · 提出 2026-09-01 · 拍板 2026-09-07(口头,选 A) · 来源 [Lifecycle 与 Run Loop](../../design/lifecycle-and-run-loop.md) §9

## 现状

`Agent.abort(reason)` 把 reason 写进 lifecycle notification,但调用底层 `AbortController.abort()` 时没有传 reason;run loop 只返回 `{ kind: "aborted" }`(探针输出 `ABORT_OUTCOME={"kind":"aborted"}`)。而 `AgentOutcome` 的 aborted 分支明明允许 `reason?: string`。

## 不拍板的代价

**半条链路**:接口收了 reason、类型允许 reason,而实际拿不到。调用者写代码时会假设能拿到,运行时发现是空的。

## 选项

- **A. 把 reason 一路保留到 terminal outcome。** 代价:需要贯穿 abort 信号与 run loop 的返回路径。
- **B. 从公开 outcome 类型和 `abort(reason)` 中删掉「可观察原因」的暗示。** 代价:调用方失去区分中断来源的能力。

## 倾向

文档明确:不能维持现在的半条链路。

## 决定

**A,一路保留到 terminal outcome**(2026-09-07 用户拍板:「reason 肯定要保留」)。形状:`reason` 是自由字符串,core 自己的几种中断(lease-lost、dispose、run 超时、用户中断)用常量并在文档里列出,不做枚举——枚举会把宿主的中断理由挤成 other。

## 验收

`LoopResult` 的 aborted 分支带得到调用方传入的 reason,且有测试;或 `abort()` 不再接收 reason、`AgentOutcome` 不再声明它。
