# 失败 attempt 的 assistant 消息留在 transcript,投影时丢

> 状态:implemented · 提出 2026-09-05 · 拍板 2026-09-05 · 合入 2026-09-06(24e919c) · **范围修订拍板 2026-09-07**(口头,从 `error` 扩到 `error | aborted`,见「2026-09-07 修订」) · 来源 [Run Loop 的四层](../../design/run-loop-layers.md) §6

## 现状

`runTurn` 把定稿无条件 push 进 transcript,失败的也一样(`stopReason: "error"`)。`packages/core/src/message-shape.ts` 与 provider 投影里没有过滤它的逻辑——重跑时这条失败消息会作为一条 assistant 消息送回模型,当成它说过的话。

## 不拍板的代价

要么账本里有一条模型没说过的话被当上文用(现状),要么为了不送回去把它从账本删掉、事件配对跟着破。两头都不能不选。

## 选项

- **A. 留在 transcript,投影丢。** `convertToLlm` 丢掉 `stopReason === "error"` 的 assistant 消息。与压缩「transcript 全量原文、送模前投影」同一口径;账本里留着「那次 provider 挂了」这个事实,与「过程事实要入账」一致;失败 attempt 照常 `message_start … message_end`,配对不破。多一道过滤。
- **B. 不进 transcript,只在 `attempt_end` 里。** 会话恢复时看不到那次失败;`message_start` 没有配对的 `message_end`,「每条定稿消息必有成对 start / end」的不变量要改。

## 决定

**A。**

## 验收

失败 attempt 之后的 provider 请求不含那条失败消息(测试从 spy 的请求体里断言);transcript 里那条消息仍在,`stopReason === "error"`;`packages/core/test/invariants.test.ts` 的 start / end 成对判据在有重试的 run 上仍成立。

## 2026-09-07 修订:范围从 `error` 扩到 `error | aborted`

**改了什么。** `packages/core/src/messages.ts` 的 `projectOne` 原本只对 `stopReason === "error"` 返回 `null`,现在 `"aborted"` 也返回 `null`。判据不变、口径不变,只是这条决策管的消息种类从一种变成两种。

**为什么是同一类。** `"aborted"` 的 assistant 消息是流中途被中断时由 `packages/core/src/event-stream.ts` 的 `finalizeError` 用已流出的 partial 拼出来的**半截回复**。它与失败 attempt 的定稿在账本里是同一种东西:那次调用确实发生过(所以留在 transcript 当事实、`message_start` / `message_end` 照常配对),但**不是模型说完的话**,拿它当上文送回去,模型看到的是一句被截断的自述。原记录里「留在 transcript 当事实,投影时丢」这条理由对两者一字不改地成立。

**与落单 `tool_use` 补齐的先后关系。** `defaultConvertToLlm` 的顺序是先 `projectOne` 投影、再 `healOrphanToolUses` 补齐([落单的 `tool_use`](2026-09-07-orphan-tool-use.md),选项 B)。被丢的消息压根不进补齐那一步,它带的 `tool_use` 也就不登记 pending、不会被补上 error 结果——**这个先后是承重的**:反过来就等于给一句没说完的话补齐工具结果,再把这一整套当上文送回去。修订前正是这个状态(补齐上线时把它登记为「相邻的、本条不管的」),本条修订把它关掉。

**验收。** `packages/core/test/orphan-tool-use.test.ts`:一条 `stopReason: "aborted"` 的 assistant 消息在 `defaultConvertToLlm` 的输出里整条不见;它带 `tool_use` 时,输出里既没有那个 `tool_use`、也没有为它补出来的 `tool_result`。
