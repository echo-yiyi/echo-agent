# 失败 attempt 的 assistant 消息留在 transcript,投影时丢

> 状态:proposed · 提出 2026-09-05 · 拍板 2026-09-05(口头,实现后移入 implemented) · 来源 [Run Loop 的四层](../../design/run-loop-layers.md) §6

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
