# 「agent 对一条输入的完整回应」这一层叫 `reply`

> 状态:proposed · 提出 2026-09-05 · 拍板 2026-09-05(口头,实现后移入 implemented) · 来源 [Run Loop 的四层](../../design/run-loop-layers.md) 导读

## 现状

run loop 里有名字的只有 run 和 turn。「agent 对一条输入(prompt / followUp / stop hook 注入)的完整回应」——从吸收输入到 settle,中间不管转了几个 turn——没有名字、没有 ID、没有事件;内层退出的 settle 与外层吸收 followUp 都不发事件,一个 run 里的任务边界对外不可见。

## 不拍板的代价

这一层是 Claude Agent SDK 的 `result`、OpenAI Agents SDK 的 `run`——两家的自然单位。没有它,观测无法按「一次回应」聚合,UI 不知道一段回答什么时候算完,`maxIterations` 也没有正确的作用域可挂。

## 选项

- **A. `reply`。** src 里只在 `packages/core/src/task/tools.ts`、`packages/core/src/session/tools.ts` 出现,是工具描述里的动词,不是概念名。中文「一次回答」直译。
- **B. `exchange`。** 零撞名;但中文语境说不顺,且它含用户输入那一半,而这一层是 agent 的回应。
- **C. `answer`。** 撞 `permission/ledger.ts`、`agent.ts` 里「回答一次 ask」的 answer。
- **D. `task`。** 撞任务清单(`packages/core/src/task/`)。

## 决定

**A。** `reply` 成为 run 之下、turn 之上的一层:`replyId = ${runId}/${k}`,事件 `reply_start{source}` / `reply_end{outcome, final, turns}`,函数 `runReply`。术语表须点明两处反向撞名:Anthropic Messages API 的 turn 指一条消息;OpenAI Agents SDK 的 run 就是本设计的 reply。

## 验收

`events.ts` 有 `reply_start` / `reply_end` 变体;每个 run 的事件流里 `agent_start … agent_end` 之间至少一对 reply,turn 事件带 `replyId`;`docs/design/run-loop-layers.md` §1 与 §1.1 的术语表按上述写。
