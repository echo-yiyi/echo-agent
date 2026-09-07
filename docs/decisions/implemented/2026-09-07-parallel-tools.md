# 并行工具：工具自己声明可并行，连续的一批同跑，结果按 tool_use 顺序入账

> 状态:implemented · 提出 2026-09-07 · 拍板 2026-09-07(口头) · 合入 2026-09-07 · 来源 [移除还是实现 `toolExecution: "parallel"`](2026-09-01-tool-execution-parallel.md)(拍板「实现」,语义在本条)

## 现状(拍板前)

turn 里的工具执行是逐个 `await`(`packages/core/src/loop/run-turn.ts` 的工具批循环);中途 abort 的规矩是「已跑完的保留,剩下的不跑」。每个工具自己的流水线:preToolUse hook → 授权(authorize / ask)→ 执行 → postToolUse hook → toolResult 入账;事件 `tool_execution_start / end` 带 `toolCallId`。权限账本已能同时挂多个问(`permission/ledger.ts` 的 `open` 是 Map,`pendingPermissions` 是数组),只是今天没人会同时问两个。工具已有一个逐工具的标记先例:`deferred?: boolean`(`tools/types.ts`)。

## 不拍板的代价

只拍「实现」不拍语义,取消、排序、并发询问、hook 顺序四件会在实现时各自就地决定,事后再改就是行为变更。

## 选项

- **谁能并行**:A. 同一条 assistant 消息里的全部 tool call;B. 工具自己声明可并行,连续的可并行调用一批同跑,碰到不可并行的就断批。
- **结果顺序**:按完成顺序 / 按 tool_use 出现顺序。
- **一批里两个都要问权限**:A. 同一时刻只挂一个问,其余批内排队;B. 允许同时挂多个。
- **`toolExecution` 选项**:删 / 留。

## 决定

2026-09-07 用户拍板:**实现,并且并不并行由工具自己声明**(`concurrent?: boolean`,缺省 false),`toolExecution` 这个选项删掉。

**批怎么切、abort 怎么收、询问怎么排队、事件与入账顺序,在 [Run Loop 的四层](../../design/run-loop-layers.md) §2.3 的「工具批」**,本条不复述。

为什么是声明制而不是调用方开关:能不能与别人同时跑,是**工具自己的性质**——它读盘还是写盘、出不出网、动不动同一份状态,只有工具作者知道;把它做成 `toolExecution` 这样的全局开关,等于让调用方替所有工具作一个它不掌握的判断,而判断错的代价是副作用并发发生。缺省 false 同理:标错的方向要选损失小的那边——漏标只是慢,误标是并发副作用。

询问之所以批内串行:账本本来就装得下多个 pending ask,但**壳一次只答得了一个**,同时挂两个问,人看到的是一个问题被另一个盖住。所以并行的是执行,不是询问。

## 验收

一条行为测试:两个 `concurrent: true` 的阻塞探针工具,事件序列里第二个的 `tool_execution_start` 出现在第一个的 `tool_execution_end` 之前;三个工具 `[并行, 串行, 并行]` 的批切成三段;两个都要 ask 的工具,`pendingPermissions` 任一时刻长度 ≤ 1;完成顺序倒过来时 transcript 里 toolResult 仍按 tool_use 顺序;批中 abort 后每个 tool_use 都有对应的 toolResult。`toolExecution` 从公共类型消失。
