# 输出在 max_tokens 处截断后续写：续轮前追加一条 harness 消息，说清从断点接着写、截在工具调用里就重发

> 状态:implemented · 提出 2026-11-03（provider 适配与主循环一线的 bug 清单）· 拍板 2026-11-03（用户：「按推荐修」）· 落地 `packages/core/src/loop/run-loop.ts`，判据见文末

**给谁看**：改 reply 的续轮判决或 harness 消息的人。假设已知 [Run Loop 的四层](../../design/run-loop-layers.md) §2.2 与 [上下文与消息流](../../design/context-and-message-flow.md) §2.2（消息来源）。

## 现状（拍板前）

落地消息 `stopReason: max_tokens` → reply 直接开下一 turn（cause `max_tokens`），transcript 里不加任何东西，下一次请求以那条 assistant 半句结尾：

- 模型不知道自己被截断了。OpenAI 兼容端点把末尾的 assistant 当普通上文（不是续写前缀），模型多半当成上一句已经说完，另起一段、重复，或者直接收尾。
- 截在工具调用里时，方言因参数 JSON 不完整把那个调用丢了（只发一条 `tool_call_dropped` 告警），模型也收不到任何结果——它以为调用已经发出去了。

参照（只看做法）：pi 对 `length` 收尾的消息里的工具调用一律不执行，给每个调用回一条错误结果，说参数可能被截断、带完整参数重发。

## 选项

- **A. 续轮前追加一条 harness 来源的 user 消息**：进 transcript（落盘、可审计、续会话后看得到当时为什么续），措辞同时覆盖「接着写」与「截在工具调用里就重发」。
- **B. 每个 attempt 注入、不入账**：续会话后看不到当时为什么续，账本与模型看到的对不上。
- **C. 照 pi 把截断消息里的工具调用全判失败**：本仓方言已经把参数不完整的那个调用丢掉，完整的照常执行没有错；改执行判据超出这一条要解决的事。

## 决定

**A**（2026-11-03 用户拍板「按推荐修」）。

1. 落地消息是 `max_tokens` → 先把 [`MAX_TOKENS_CONTINUATION`](../../../packages/core/src/loop/run-loop.ts#symbol=MAX_TOKENS_CONTINUATION) 作为 `userMessage(…, "harness")` 吸收进 transcript（发 `message_end`），再吸收本 turn 交出的 steer（后到的话说了算），下一 turn 的 cause 仍是 `max_tokens`。
2. 措辞（模型面，英文）：输出在上限处被截断，从断点接着写、不要重复已经写过的；如果截在工具调用里，那个调用因参数不完整已被丢弃，重发它并把参数缩小（比如把一次大写入拆成几次）。截断那轮里完整的工具调用照常执行，提示排在它们的结果之后。
3. **一条措辞覆盖两种情形**，不判断「这次截在不在工具调用里」：loop 拿到的定稿里看不出有调用被丢过（丢弃只留一条告警事件），为此从方言往 loop 加一条通道不值得。

## Non-Goals

- 不改截断消息里工具调用的执行判据（选项 C）。
- 不设连续截断的上限：每次续写都消耗 `maxIterations` 的预算，撞上限照常 `error{max_iterations}`。
- 不按 provider 调措辞。

## 验收

- [截断续写](../../../packages/core/test/loop-layers.test.ts#test=maxtokens-截断续轮前追加一条-harness-来源的-user-消息让模型从断点接着写截在工具调用里就重发此前续写请求以-assistant-半句结尾没有任何指示)：第二次请求末尾两条是 assistant 半句与那条 harness 消息；账本里 user 的 source 依次是 `human`、`harness`；截断那轮带完整工具调用时，消息顺序是 user → assistant → toolResult → user（提示）→ assistant。
- 变异：不追加那条消息，判据变红。
