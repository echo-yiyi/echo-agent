# `maxIterations` 按 reply 计,run 级另加 `maxReplies`

> 状态:implemented · 提出 2026-09-05 · 拍板 2026-09-05(条件「run 级必须保留一个总闸」已纳入本记录) · 合入 2026-09-06(24e919c) · 来源 [Run Loop 的四层](../../design/run-loop-layers.md) §1

## 现状

`maxIterations` 按 run 计:一个 run 里三条 reply(prompt + 两个 followUp)共用一份预算,第三条可能一开始就撞闸。`timeoutMs` 是可选的,不设就没有墙钟。stop hook 注入次数由 `MAX_STOP_CONTINUATIONS` 常量封顶 3 次;followUp 数没有上限。

## 不拍板的代价

按 run 计:预算与「一次回应」脱钩,与两家 SDK(`maxTurns` / `max_turns` 都是每次 query / run,即每条 reply)不一致。按 reply 计而不补总闸:followUp 与 stop hook 注入都能开新 reply、各领一份满预算,`timeoutMs` 又可选——一个 run 真的没有上限。墙钟兜不住「跑得快但停不下来」。

## 选项

- **A. 按 run 计(现状)。**
- **B. 按 reply 计,靠 `timeoutMs` 兜。** 不成立:`timeoutMs` 可选。
- **C. 按 reply 计,run 级加 `maxReplies`。** 与 `maxIterations` 同形:`AgentOptions.maxReplies?` → `AgentLoopConfig.maxReplies: number`,Agent 给缺省。reply 结束后:reply 数 < `maxReplies` 才 drain followUp / 问 stop hook;达上限后只做 `tryCloseRun`——队列空 → `completed`,非空 → `closeRun`、`error{max_replies}`,drain 出来没吸收的消息经 `queue_dropped` 报出。它与 `MAX_STOP_CONTINUATIONS` 是同一类闸(计数,不是墙钟)。
- **D. 按 reply 计,`timeoutMs` 给缺省值。** 墙钟不是这类问题的闸。

## 决定

**C。** `maxReplies` 缺省 10(`DEFAULT_MAX_REPLIES`,保险丝量级:stop hook 最多贡献 3 条,其余留给一次 run 里的 host followUp);它是常量还是配置项,与 [stop hook 三次](../proposed/2026-09-01-stop-continuation-limit.md) 同拍——两者必须同形。

## 验收

`AgentLoopConfig` 有 `maxReplies`;reply 数达上限且仍有待办 → `agent_end{error, code: "max_replies"}` 且未吸收的消息经 `queue_dropped` 报出;达上限但无待办 → `completed`;每条 reply 的 turn 数 ≤ `maxIterations`,超出 → `error{max_iterations}`,不影响同一 run 里的下一条 reply;`shouldStopAfterTurn` / `prepareNextTurn` 收到的 `iteration` 在每条 reply 内从 1 起。
