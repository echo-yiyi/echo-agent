# 提取范围带起止下标；「Stored now」常驻照给、只省没变过的索引

> 状态:implemented · 提出 2026-11-17（产品方报告：没有完整的提取范围；每次提取都读整个记忆库，成本随库变大）· 拍板 2026-11-17（用户：「可以，按你的顺序做」；真模型数据出来后改选混合写法，用户：「按你推荐的①来」）· 落地 `packages/core/src/memory/extract.ts`（`ExtractRange`、`ExtractPromptInput`、`defaultExtractPrompt`）、`packages/core/src/memory/harness.ts`（`MemoryFreeze.shown`、`memoryStoredSince`）、`packages/core/src/memory/observe.ts`、`packages/core/src/session/`（`memory_reviewed.from`）、`packages/core/src/agent.ts`（`enqueueExtract`、`runExtract`），判据见验收

**给谁看**：改记忆提取的人，自己写提取指令、读提取观测或会话记录的产品。

## 现状（拍板前）

1. 一次提取看的那一段，交给指令的只有条数与第一句用户原话（[`ExtractRange`](../../../packages/core/src/memory/extract.ts#symbol=ExtractRange)），观测与会话记录只记终点（`memory_reviewed.through`）。事后说不清某次提取看的是哪几条。
2. 每次提取的指令都带整个记忆库（`Stored now`：每个常驻模块全文、每个 indexed 模块的索引），哪怕上文开头那条记忆正文里已经有一模一样的一份。库越大越贵。

## 决定

1. **范围带起止下标**：`ExtractRange.from` / `to` 是这一段在会话记录里的消息下标，左闭右开，与 `memory_reviewed.through` 同一套（`reset` 之后接着数）。交给指令、记进观测的 `memory.extract.finished`（`from` / `to`），`memory_reviewed` 多记起点 `from`（可缺，旧记录没有；有就得是不超过 `through` 的非负整数）。
2. **`Stored now` 常驻模块照给全文，indexed 模块只给记忆正文冻结之后变过的**（[`memoryStoredSince`](../../../packages/core/src/memory/harness.ts#symbol=memoryStoredSince)）。没变过的索引在上文开头那条记忆正文里，不重发。一个 indexed 模块任何一个文件改了、新增了、删掉了都算变过，变了就给整份索引。
3. **对照的是冻结那一刻的版本**：`MemoryFreeze` 多记一份 `shown`（正文冻结时的文件版本），不是变化通知的基线 `files`——通知每发一次基线就换成最新的，而上文那条正文一直是冻结那一版。正文作废时三项一起清。`runExtract` 先装配、再写指令：正文刚作废的话，装配这一下才重新冻结，比对要对着这次装进去的那一版。
4. **上文里没有那条正文就给全部**：没挂记忆段（`promptSections` 里没有 `memory`）或没冻结过，`stored` 照旧是 [`memoryManifest()`](../../../packages/core/src/memory/harness.ts#symbol=memoryManifest)。产品自己写指令时看 `ExtractPromptInput.indexesChangedOnly` 分辨两种。
5. **缺省指令跟着说清两处**：常驻模块在 `Stored now` 里是此刻的全文；indexed 模块的索引在上文开头那条正文里是当时的样子，变过的在 `Stored now` 里；查重两处一起看。

## 为什么常驻照给（数据）

真模型（DeepSeek `deepseek-flash`），同一场景：挂记忆段，常驻 `user` 1356/1400 字符，8 个 indexed 笔记，六轮对话后提取一次。

| 写法 | 次数 | 指令长度（字符） | 平均模型调用 | 撞上限被拒 | 常驻 `user` 被重写得更短 |
|---|---|---|---|---|---|
| 全量（拍板前） | 8 | 6553 | 3.38 | 0 | 0 |
| 常驻也只给变化 | 8 | 4860 | 3.62 | 3 次 | 2 次（888、1135） |
| 常驻照给、只省没变过的索引（本决定） | 6 | 6299 | 3.83 | 0 | 0 |

常驻也只给变化的话，模块快满时加一条要整份重写，全文却在很远的对话开头，模型照着重写漏了内容——就是 [整理兜底](2026-11-17-dream-resident-floor.md) 刚处理过的那类丢事实。常驻模块有上限，照给全文的成本有界；索引随文件数增长、没有上限，「每次读整个记忆库」的成本在它身上。这个场景里索引小，只省 4%；库越大省得越多。混合那组有一次写了 7 条后撞轮数上限（部分完成），常驻没短，属正常波动。

## Non-Goals

- 不按条目省常驻模块的内容（见上）。
- indexed 模块不按文件省：变了就给整份索引，索引本身就是一行一个文件。
- 范围的起止下标不进缺省指令的正文：模型按条数与第一句用户原话找那一段，下标给观测、会话记录与产品自己的指令用。

## 验收

- [Stored now 常驻照给、只省没变过的索引](../../../packages/core/test/memory-extract.test.ts#test=提取的stored-now常驻模块照给全文indexed-模块只给记忆正文冻结之后变过的索引2026-11-17没变的索引在上文开头那条正文里不重发)：没变过时常驻全文在、indexed 索引不在；冻结之后新增一个 indexed 文件，那个模块的整份索引回到指令里，上文开头仍是冻结那一版。拍板前的全量写法在「没变的索引不重发」上是红的，「常驻也只给变化」在「常驻照给」上是红的。
- [没挂记忆段给全部](../../../packages/core/test/memory-extract.test.ts#test=提取指令自带此刻存着的记忆indexed-模块给索引常驻模块给全文并说明-indexmd-由系统维护不用一个个-view-去摸)：这条既有测试不挂记忆段，照旧拿到全部。
- [范围带起止下标](../../../packages/core/test/memory-extract.test.ts#test=提取范围带起止下标2026-11-17指令的输入观测里的-memoryextractfinished-与会话里的-memoryreviewed-都记这一段在会话记录里的-from-to)：两次提取的输入、观测与 `memory_reviewed` 都是 `[0, 6)`、`[6, 12)`。
- [memory_reviewed 的起点验形](../../../packages/core/test/session-service.test.ts#test=memoryreviewed-的起点2026-11-17旧记录没有照常恢复有就得是不超过-through-的非负整数)：缺省照常恢复，超过 `through` 或为负判红。
