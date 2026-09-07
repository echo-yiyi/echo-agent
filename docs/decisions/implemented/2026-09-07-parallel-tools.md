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

2026-09-07 用户拍板,五条:

1. **声明制。** 工具加 `concurrent?: boolean`(缺省 false)。同一条 assistant 消息里**连续的**可并行调用一批同跑;碰到不可并行的就断批,它单独跑,之后再开下一批。Claude Code 同一做法(只读工具标可并发)。
2. **`toolExecution` 选项删掉**,行为由声明决定;API 快照重录。
3. **中途 abort**:已起跑的各自收 signal 结束(工具本来就拿 signal),未起跑的不跑;每个 toolResult 照样入账,被中断的记 error。这是「已跑完的保留,剩下的不跑」在一批里的自然推广。
4. **权限询问批内串行**:同一时刻只挂一个问,其余在批内排队等;不需要问的工具照常并行跑。
5. **hook 与事件**:preToolUse / postToolUse 每个工具各自跑,hook 作者不能假设批内顺序;`tool_execution_start / end` 会交错,消费者按 `toolCallId` 配对;**toolResult 入账顺序按 tool_use 出现顺序**,不按完成顺序。hooks 文档加一句「同一批内可能并发」。

## 验收

一条行为测试:两个 `concurrent: true` 的阻塞探针工具,事件序列里第二个的 `tool_execution_start` 出现在第一个的 `tool_execution_end` 之前;三个工具 `[并行, 串行, 并行]` 的批切成三段;两个都要 ask 的工具,`pendingPermissions` 任一时刻长度 ≤ 1;完成顺序倒过来时 transcript 里 toolResult 仍按 tool_use 顺序;批中 abort 后每个 tool_use 都有对应的 toolResult。`toolExecution` 从公共类型消失。
