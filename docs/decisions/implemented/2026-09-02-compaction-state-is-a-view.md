# 压缩是作用在 transcript 上的视图状态,游标用 transcript 下标

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-02 · 来源 [Compaction](../../design/compaction.md) §1–§3、§8

## 现状(拍板前)

运行中 `checkpoint` 是消息条数(`coveredUpTo`),恢复后是 compaction entry 的 id;盘上的 summary 没有任何恢复路径把它还原成送模上下文。`transformContext` 与 transcript 共享对象,压缩若原地改写会污染账本。

## 不拍板的代价

同一个词在重启前后两种语义,「压缩后立即续」与「恢复后续」送模内容不同,离线评测与审计都对不上账。

## 选项

- **A. 视图状态。** transcript 只增不改;`CompactionState = { spans, clearedBefore }` 描述怎么看它,送模前投影;运行时与盘上同一个形状、同一套下标(transcript 序号)。
- **B. 改写 transcript。** 压缩时把被覆盖的消息从 transcript 删掉、插入摘要消息。
- **C. 新内建 role。** 摘要作为一条 `compaction` 角色的消息进 transcript,投影时据它跳过前面的消息。

## 决定

**A**(2026-09-02 用户拍板)。游标是 transcript 下标而不是 entry id:内存里的消息没有 id,下标在运行时与恢复后天然一致。恢复期用 `assertCompactionFits()` 严格验形,不吸附、不修——写下去时合法的状态永远合法,不合法就是坏档判红。`AgentState.checkpoint` 删除,换成 `compaction`。

## 验收

「压缩后立即续跑 vs 重启恢复后续跑:下一次送模消息逐字节相同」与 session-service 的「compaction 状态不成立 → 坏档判红」两条测试。
