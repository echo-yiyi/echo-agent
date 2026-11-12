# 记忆提取没跑完：写成过就算看过，连续没写成就放弃那段

> 状态:implemented · 提出 2026-11-11（用户点出：游标只在提取跑完后推进，耗尽 5 轮怎么办）· 拍板 2026-11-12（用户：「可以按照他的来做」——照参照物的处理）· 落地 `packages/core/src/memory/extract.ts` / `agent.ts`，判据 `packages/core/test/memory-extract.test.ts` · 修改 [从主对话分叉](2026-11-03-memory-extraction-fork.md) 与 [降频](2026-10-30-memory-extraction-gate.md) 里「游标只在正常跑完时推进；出错、轮数用完都不动」那一条

**给谁看**：改记忆提取的游标、失败处理或轮数上限的人。假设已知 [从主对话分叉](2026-11-03-memory-extraction-fork.md)（攒满三轮、游标落盘）与 [记忆设计](../../design/memory.md) §5。

## 现状（拍板前）

提取的子循环只要不是 `completed`，游标就不动、下次重看（`Agent.runExtract` 返回布尔）。两处会把它放大：

- **卡住的那段本身已攒够三轮。** 「攒满三轮才跑」挡不住它，下一条 reply 就再跑一次，看的是「旧的那段 + 新的一轮」——范围一次比一次大，越大越容易再撞 5 轮上限，自己越卡越死；要等压缩把旧段压成摘要才自然收住。provider 持续出错时同样每条 reply 重跑一次。
- **轮数上限在轮首判。** 第 5 轮只要还调了工具（哪怕是一次成功的写入），就拿不到第 6 轮去收尾，结局是 `max_iterations`——写进去的那几条是真的，这段却当没看过。

整理撞上限早在 2026-11-03 就按「做了一部分」记了（`markDreamPartial`），提取没跟上，两边口径不一致。

参照（只看机制，不作设计依据；本机 Claude Code 2.1.322 的日志字符串）：提取「提前停了」= API 出错、撞轮数上限或被中止且**一条都还没写成**，或者抛错——游标不动、下次重看；写成过的不算提前停。**连续**提前停若干次（计数名 `unfinished_in_a_row`，次数从外面看不到）就推过游标、那几轮不再看。

## 决定

照参照物的处理（2026-11-12 用户拍板）。一次提取的结局是 [`ExtractPass`](../../../packages/core/src/memory/extract.ts#symbol=ExtractPass)，游标推不推由它定：

1. **`reviewed`：这段算看过，游标推进。** 跑完了；或者没跑完（provider 出错、轮数用完）但已写成至少一条——那几条已经落盘，与整理按「做了一部分」记同一个口径。`memory_extract_failed` 照报，消息里说明已写入几条、这段算看过了。
2. **`unfinished`：一条没写成就停了，游标不动、下次重看。** 连续 [`DEFAULT_EXTRACT_UNFINISHED_LIMIT`](../../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_UNFINISHED_LIMIT)（2，即重试一次）次都这样，就放弃这段、游标照推，报诊断 `memory_extract_gave_up`。参照物的次数看不到，2 是本仓取的。
3. **`not_run`：没起来或被中止（stop / 丢锁），游标不动，也不算一次没跑完。** 丢锁之后一个字都不许再写，`memory_reviewed` 也不落。
4. **连续次数只在内存。** 推一次游标就归零，`reset` 与续会话也归零。重启后最坏是那段再重试这么多次。

## Non-Goals

- 不改轮数上限（仍是 5，2026-09-14 拍板）。
- 不做「撞上限前留一轮收尾」：写成过就算看过之后，第 5 轮写完拿不到第 6 轮收尾已不影响游标。
- 连续次数不落盘、不进观测账本——诊断入账（`agent.diagnostic`）是观测白盒化的遗留项，另议。
- 通道兜住的抛错（`runExtract` 约定不抛）不计入连续次数。

## 验收

- 写成过就算看过：[撞上限但写成过一条](../../../packages/core/test/memory-extract.test.ts#test=撞上轮数上限但写成过一条这段算看过游标照推下一次从新的一批看起不把那段重看一遍此前游标不动之后每条-reply-都重看)
- 没写成重看一次、连续两次放弃：[连续两次放弃](../../../packages/core/test/memory-extract.test.ts#test=一条没写成就撞上限下一次重看那段连续两次都这样就放弃那段报-memoryextractgaveup再下一次从之后的内容看起)
- 一次出错照旧重看：[失败重看](../../../packages/core/test/memory-extract.test.ts#test=提取没跑完模型出错游标不动下一轮就把那段连同新的一轮重看一遍攒着的已经够三轮)

前两条在改动之前的代码上跑都是红的（第一条又从第一句看起；第二条提取跑了 4 次、没有放弃）。
