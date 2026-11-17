# 记忆提取部分完成也重看：写成过不再算看过

> 状态:implemented · 提出 2026-11-17（使用者报：「只写入部分事实，就推进已审阅」）· 拍板 2026-11-17（用户：「第 2 条做」）· 落地 `packages/core/src/agent.ts`（`enqueueExtract` 的结局处理）、`packages/core/src/memory/extract.ts`（`ExtractPass` 说明、`ExtractRange.retry`、提取指令），判据见验收 · 推翻 [没跑完时看写成了没有](2026-11-12-memory-extraction-unfinished.md) 的「写成过就算看过」与 [提取的三种结局](2026-11-16-memory-extract-outcomes.md) 的 Non-Goal「部分完成不重试」

**给谁看**：改记忆提取的游标、结局或提取指令的人。假设已知 [记忆](../../design/memory.md) §5 的游标。

## 现状（拍板前）

一次提取写成至少一条后中途停了（轮数用完、模型出错、被 hook 拦下），算「部分完成」，游标照推到这段末尾（2026-11-12 照参照物定的「写成过就算看过」）。没写到的那部分再没人看——使用者报的正是这个：只写进一部分事实，这段就被记成审阅过了。

## 决定

1. **部分完成不推游标**：与「一条没写成就停了」同算没看完，游标不动，下一次连同新的对话一起重看这段。
2. **重看时提示词说清上次停在半路**（[`ExtractRange.retry`](../../../packages/core/src/memory/extract.ts#symbol=ExtractRange)）：上次写成的几条已经在「Stored now」里，接着补，不重写。
3. **放弃的上限不变、两种没看完共用**：连续 [`DEFAULT_EXTRACT_UNFINISHED_LIMIT`](../../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_UNFINISHED_LIMIT) 次没看完就放弃这段、游标照推，报 `memory_extract_gave_up`。会话里那条 `memory_reviewed` 记：这一串写成过是 `partial`，一条没写成是 `abandoned`；`written` 是这一段前后几次一共写成几条（补完时的 `completed` 也一样）。
4. **观测按每一次记**（`memory.extract.finished`）：这一次部分完成记 `partial`、没写成记 `failed`，到上限放弃的那一次记 `abandoned`（带这一次写成的条数）。

## Non-Goals

- 不调缺省轮数（5）：产品经 `createEcho({ memory: { extract: { maxTurns } } })` 自己配（2026-11-12 起就有，用户 2026-11-17：「允许用户自己配置轮次」）。
- 不加「重看时去重」的机制：靠「Stored now」与提示词。重复本身另议（使用者报的第 4 条）。
- 连续次数仍只在内存，重启归零。

## 验收

去掉对应改动，这几条是红的：

- [部分完成不推游标、补完记总数](../../../packages/core/test/memory-extract.test.ts#test=部分完成不推游标2026-11-17写了一部分就停的那段下次接着看指令从那段第一句看起说清上次停在半路补完才推游标记下这段一共写成几条)
- [撞上限但写成过一条：下一次连同那段重看](../../../packages/core/test/memory-extract.test.ts#test=撞上轮数上限但写成过一条游标不动下一次连同那段一起重看指令说清上次停在半路2026-11-17-改此前写成过就算看过游标照推没写到的那部分再没人看)
- [三种结局与放弃时记哪种](../../../packages/core/test/memory-extract.test.ts#test=三种结局分得清2026-11-162026-11-17-部分完成改成不推游标会话里的游标记录带上正常结束-部分完成-失败后放弃写了几条停下的原因码观测每次跑了的提取都记一条含没看完待重看)
- [重看时的那句提示](../../../packages/core/test/memory.test.ts#test=提取-prompt第一次复盘从对话开头看起不说上次复盘到对话中途之后才说)
