# 重试归 loop:attempt 是唯一的重试单位,dialect 不再重试

> 状态:implemented · 提出 2026-09-05 · 拍板 2026-09-05 · 合入 2026-09-06(24e919c) · 来源 [Run Loop 的四层](../../design/run-loop-layers.md) §6

## 现状

重试有两层、共用一个预算:`packages/core/src/provider/dialect.ts` 按 `retry.maxAttempts`(缺省 3)在流内重试;`runLoop` 拿同一个 `retryPolicy` 对象,turn 以 retryable 错误收场后再整轮重跑,最多 `maxAttempts` 次。最坏 3 × (1 + 3) = 12 次请求,没有人设计过这个数。两层都发 `retry_scheduled`,字段 `attempt` 是两套计数;撞窗后的应急重跑则什么都不发。dialect 随 `retry` 事件带出的 partial,`runTurn` 没有用到。

## 不拍板的代价

「重试」没有定义:观测侧分不清一次 529 是 dialect 内部重试还是整轮重跑;用户看到的重试次数与实际请求数对不上;预算实际是乘法。

## 选项

- **A. 重试归 loop。** dialect 只做协议翻译:一次请求、一条流、流断了以 `error` 收场并标 `retryable`;`ProviderEvent.retry` 删除。`runTurn` 按 `retryPolicy` 做重试:同一 turn 的下一个 attempt,中间一个 `retry_scheduled`。撞窗应急重跑也是下一个 attempt。一个 turn 最多 `maxAttempts` 个 attempt,不分原因。
- **B. 重试归 dialect。** loop 不重试。attempt 与 HTTP 请求脱钩,重试在事件流里只剩诊断;撞窗应急仍必须在 loop 做,于是还是两处。
- **C. 维持两层。** 把 12 写进文档。

## 决定

**A。** 代价两条,都接受:

1. **总请求数下降**:同样的 `maxAttempts`,最坏从 12 次变 3 次。
2. **每个 attempt 完整重建上下文**:同一 turn 内重试时,`getTurnInjections`、`transformContext`、`contextBeforeBuild`、`convertToLlm`、`getApiKey` 每个 attempt 各调一次——现状 dialect 重试是同一份请求体重发,不重建。重建在正确性上更好(两次 attempt 之间上下文可能已被应急压缩改过、短命 key 可能已过期),但是行为变化:有副作用的 `transformContext` 会被跑多次。这些回调的契约补一句「同一 turn 内可能被多次调用,有副作用的实现自己去重」。

hook 侧 `modelCallFailed` / `retryScheduled` 现状没有任何发送点;`runTurn` 在 `attempt_end{failed}` 与 `retry_scheduled` 处发,attempt 计数与事件一致。

## 验收

`dialect.ts` 不再读 `maxAttempts`,`ProviderEvent` 没有 `retry` 变体;provider 持续返回 retryable 错误时一个 run 的请求总数 = `maxAttempts`;`retry_scheduled` 只出现在同一 turn 的 `attempt_end{failed}` 之后,其后是下一个 `attempt_start` 或(退避被 abort / deadline 打断时)`turn_end{aborted}`;退避受 run 的 signal 管,打断后在远小于 backoff 的时间内收场;`transformContext` 在有重试的 turn 里被调用的次数 = attempt 数;`modelCallFailed` / `retryScheduled` 有测试证明被发出。

## 补记(2026-09-07):压缩摘要器也重试

dialect 不重试之后,压缩摘要器的模型调用(`packages/core/src/compaction/pipeline.ts` 的 `modelCallFor`)失去了 transport 重试——摘要请求撞一次 429 这次压缩就失败,overflow 应急那条路上等于 run 直接以 `context_overflow` 收场。用户拍板:**加带退避的重试**。形状:同一份 `retryPolicy`、同一个受 signal 管的退避(`packages/core/src/loop/backoff.ts`,与 attempt 共用),retryable 错误重试到 `maxAttempts`;它不是 attempt,只发 hook 侧的 `modelCallFailed` / `retryScheduled`,不发 loop 事件。验收:摘要请求 429 一次后成功,压缩照常完成且 `retryScheduled` 恰好一次;连撞 `maxAttempts` 次后按 error 收场,没有第 N+1 次请求(`packages/core/test/compaction.test.ts`)。
