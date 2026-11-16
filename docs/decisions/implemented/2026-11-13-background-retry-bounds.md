# 后台重试有上界：失败或做不动时不再每一拍白跑一遍

> 状态:implemented · 提出 2026-11-12（用户：「其他地方看一下，我们还有没有需要解决的地方」——按记忆提取那类问题排查后台机制，三个子任务分头查、关键结论逐条对过代码）· 拍板 2026-11-13（用户：「优化」——按排查报告一、二两部分的九条作为一批修，第三部分只补文档）· 落地 `packages/core/src/compaction/pipeline.ts` / `builtin.ts` / `types.ts` / `observe.ts`、`agent.ts`、`loop/types.ts`、`schedule/harness.ts`、`inbox/store.ts`、`memory/compose.ts` / `dream.ts`、`packages/base/src/observe/page.html` / `lexicon.ts`，判据见验收 · 相关 [记忆提取没跑完](2026-11-12-memory-extraction-unfinished.md)、[删掉整理的水位门](2026-11-12-dream-watermark-removed.md)

**给谁看**：改压缩触发、inbox 消费与 ack、定时任务落盘、收摊顺序的人。假设已知 [压缩](../../design/compaction.md) §4、[会话](../../design/sessions.md) §5、[记忆](../../design/memory.md) §5。

## 现状（拍板前）

2026-11-12 修记忆提取时找到的那类问题——只在成功时推进、失败后每次重来、输入越攒越大；或者触发条件在做完之后仍然成立——在后台其余几处也有。前五条会白花模型调用，后四条是诊断刷屏或误导：

1. **inbox ack 写不进（pre-commit）**：只记一条诊断就排下一轮，下一轮又领到同一批（`Agent.consumeInbox`）。实测 200 毫秒内 143 次模型调用，transcript 同一条消息越堆越多。同一函数里 transcript 写不进那一支早就停了自动消费，这一支没停。
2. **一次性提醒落盘失败**：有意留在表里「下次 tick 再投一次并重试落盘」，`lastFiredAt` 没记上、一直判到期；提醒被消费之后去重键没了，下一拍又投一条——落盘持续失败期间每拍多跑一轮模型。
3. **压缩压完仍在线上**：触发只看占用到没到线，不记得上次压完的结果；不可压的部分本身过线（用户贴了超大日志后跑长工具循环、小窗口模型挂大量 MCP schema）时每轮都压一次：两次模型调用、摘要每次把整段重摘、缓存每轮断一次。完全没东西可压时每轮一条错误通知。阶段只要改了状态就算成功，让上下文变大的也采用。
4. **压缩调用失败不熔断**：每轮重来；collapse 折到第 k 段失败时前面 k−1 段连同花掉的调用一起丢，下一轮从同一处重做。实测连续 9 轮、每轮 3 次调用、一次都没压成。
5. **退出前补提取被整理挡住**：`quiesce()` 只关自动整理、不中止在跑的那次；提取与整理排成一条，补跑排在整理后面，整理多半超过 15 秒上限，到点两个一起被中止，最后那段对话没人看。
6. **inbox 封账后闹钟每秒白投一次**：封账不停定时任务，每拍被拒、每拍一条 `schedule_fire_failed`，直到重启。
7. **一条坏的 inbox 记录每拍报一次**：refresh 读不出来只报诊断、不记下，轮询每秒重读重报。
8. **常驻模块超预算的拒绝文案**：「用 str_replace/delete 删条目」——常驻模块的 `delete` 删的是整份 `agent.md`。删掉水位门之后压紧全靠写的一方，这句的分量变大了。
9. **inbox run 的 transcript 写不进时提前返回**：run 里登记的收尾活（`afterRun`，模型触发的热部署）要等下一个人开的 run 才做。

## 决定

（2026-11-13 用户拍板，九条作为一批。）

1. pre-commit 那一支与 transcript 写不进那一支同一条：整批留在盘上待重启重投，**停止自动消费**。重跑本来就会把同一条消息再处理一遍，等重启按 at-least-once 重投才是对的。
2. 一次性提醒投过就在内存里记上 `lastFiredAt`（[`tickSchedule`](../../../packages/core/src/schedule/harness.ts#symbol=tickSchedule)）：不再到期、列表里不出现；`save` 写盘时不带它、写成之后从表里删；落盘失败的下一拍只重试写盘。重启时盘上那份还在，照常再提醒一次——至少一次的语义不变。不改盘上格式（投过的一次性提醒从不写盘）。
3. **压完仍在线上就冷却**：一次压缩跑完占用仍 ≥ 触发线，记下那一刻（[`CompactionFloor`](../../../packages/core/src/compaction/types.ts#symbol=CompactionFloor)），auto 要等占用涨过 [`compactionRetryAt()`](../../../packages/core/src/compaction/pipeline.ts#symbol=compactionRetryAt) 才再试，其间判为 `cooldown`（`CompactionDecision` 多一个值，面板与术语表同步）。
   - 重试点取**那一刻到窗口之间的一半**，不取固定一截：触发线只比窗口低一个 reserve（≥ 16k），「再涨一成窗口」在 200k 窗口下是 20k，直接越过窗口，自动压缩就再也不会重试。对半收敛，撞窗前最多重试 log2(余量 / 每轮增量) 次。估算已经到了窗口就每涨一成窗口试一次——估算可能偏高，不能就此再也不试。
   - Agent 跨 run 记着（经 `LoopCompactionConfig.floor` / `onFloor` 注入，与校准比同一条路），否则每条新消息的首轮都白压一次。换了窗口、或此刻比那一刻还小（估算被 usage 纠正、上下文变小了）就不作数；压到线下、手动压缩、`/clear`、换一份 transcript 都清掉。子循环不带它。
   - 自动触发的（auto / idle）只采纳让上下文变小的阶段；manual 是用户要的、overflow 要一步到位，照旧采纳。
4. 压缩调用失败的跨轮重试由第 3 条的冷却兜住（失败 = 压完仍在线上）；collapse 某一段失败时，前面已经折好的几段照样交出（第一段就失败才抛）。
5. [`Agent.drainExtract()`](../../../packages/core/src/agent.ts#symbol=Agent.drainExtract) 先中止在跑的整理、等它收尾，再排补跑；中止也算在同一个 15 秒上限里。整理被中止只是推迟（锁过期后重来），没看到的对话却可能再也没人看。
6. 封账（`enterInboxFailure`）时停定时任务；暂停后恢复重新起 managed work 时，封账状态下不起定时任务。
7. refresh 读不出来的记录报一次、记进「本进程不再收」（与已 ack 删不掉、`clear()` 丢弃的同一个集合），重启时按坏档判红。
8. 常驻模块的拒绝文案改成「用 create 整份覆写成压紧后的版本，或用 str_replace 删条目；不要删文件」。
9. transcript 写不进那一支也排空 `afterRun`（先放票据，与正常收尾同一个顺序）；不排自主工作（自动消费已停）。**让位那一支不改**：进程要交出租约，热部署这类收尾活不该再在本进程跑；`wait` 命中没 ack 的那条由接手方重投。

第三部分（不改规则，只补文档）：产品把 `memory.dream.minIntervalMs` 配成 0 时，一层大到一次整理不完就每次回 idle 都接着整理——见 `DreamGates.minIntervalMs` 的注释与 [记忆](../../design/memory.md) §2。

## Non-Goals

- 不给压缩冷却加配置项，不改 reserve 与 goal 的算法。
- collapse 中途失败不另报诊断（交出的是部分成功；没压到线下由第 3 条记下）。
- 不碰被中止的提取怎么算（中止一律不推游标、不计入放弃次数，见 [记忆提取没跑完](2026-11-12-memory-extraction-unfinished.md)）。
- 不碰重叠保护只认内建工具、模块自带工具、具名身份目录跨产品共用这三条遗留（另议）。

## 验收

每条判据在改动之前的代码上跑都是红的（第 8 条是文案断言，旧文案必然不含新句子）：

- 1：[ack 写不进](../../../packages/core/test/inbox-durable.test.ts#test=inbox-run-跑完ack-一直写不进pre-commit这批留在盘上待重投且不再自动消费此前同一批一轮轮重跑模型2026-11-13)（旧代码 200 毫秒 143 次模型调用）
- 2：[一次性提醒落盘失败](../../../packages/core/test/schedule.test.ts#test=一次性任务投递后落盘失败不再投第二次之后每拍只重试落盘写成之后才从表里删)（旧代码投了 3 次；改写了原来断言「再投一次」的那条）
- 3：[压完仍在线上](../../../packages/core/test/compaction.test.ts#test=压完仍在线上没有一段有事可做同一-run-的后几轮下一个-run-都不再压此前每轮都压一次每轮一条错误通知)、[重试点](../../../packages/core/test/compaction.test.ts#test=重试点那一刻到窗口之间的一半估算已经到了窗口就每涨一成窗口试一次估算可能偏高不能再也不试)、[只采纳变小的](../../../packages/core/test/compaction.test.ts#test=自动压缩只采纳让上下文变小的阶段清掉一条很短的工具结果占位比原文还长-不算压过手动照旧采纳)
- 4：[压缩调用一直失败](../../../packages/core/test/compaction.test.ts#test=压缩调用一直失败不每轮重来上下文涨过那一刻到窗口的一半才再试一次)、[collapse 交出折好的段](../../../packages/core/test/compaction.test.ts#test=collapse折到第二段时模型调用失败-已经折好的那段照样交出去此前整段抛掉花掉的调用白费下一轮从同一处重做)
- 5：[stop 时整理正在跑](../../../packages/core/test/memory-extract.test.ts#test=stop-时整理正在跑先中止整理补的那次提取照样跑完此前补跑排在整理后面到点和整理一起被中止最后那段没人看)（旧代码 stop() 一秒内回不来）
- 6：[封账后闹钟也停](../../../packages/core/test/inbox-durable.test.ts#test=inbox-封账indeterminate之后闹钟也停到期的提醒不再每拍白投一次每拍一条-schedulefirefailed2026-11-13)（旧代码三拍三条）
- 7：[坏档报一次](../../../packages/core/test/inbox-durable.test.ts#test=refresh-读到一条坏档报一次就不再收之后每拍不再重读重报此前轮询每秒一条-inboxrefreshskipped2026-11-13)（旧代码三拍三条）
- 8：[resident 超预算拒](../../../packages/core/test/memory.test.ts#test=resident-超预算拒拒因带整理指引)
- 9：[transcript 写不进也排空 afterRun](../../../packages/core/test/inbox-durable.test.ts#test=inbox-run-的-transcript-写不进去run-里登记的收尾活afterrun照样排空此前直接返回要等下一个人开的-run-才做2026-11-13)

为了让「清工具结果」那一步真的省下地方，[校准比](../../../packages/core/test/compaction.test.ts#test=校准比ascii-与中文同一段对话同一份-usage压缩跑过的阶段一致中文不会在第一段就停)那条测试的工具改回一段像样的输出（此前清掉的是一个词，占位比原文长），断言不变。
