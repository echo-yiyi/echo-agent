# 记忆提取的三种结局：正常结束、部分完成、失败后放弃

> 状态:implemented · 提出 2026-11-16（使用者提出要根治：提取要区分正常结束、部分完成、失败后放弃）· 拍板 2026-11-16（用户：「按你的建议做」——三件：会话记录加结局字段、部分完成先只记不重试、先只做提取）· 落地 `packages/core/src/session/types.ts` / `service.ts`、`packages/core/src/memory/extract.ts` / `observe.ts`、`packages/core/src/agent.ts`、`packages/base/src/observe/lexicon.ts` / `page.html`，判据见验收 · 承接 [没跑完时看写成了没有](2026-11-12-memory-extraction-unfinished.md)：游标怎么推一条不改，只把结局分清、记下来

**给谁看**：改记忆提取、会话 entry 或观测面板的人。假设已知 [记忆](../../design/memory.md) 里提取游标那一段。

## 现状（拍板前）

一次提取的结局只有三档（`ExtractPass`：`reviewed` / `unfinished` / `not_run`），游标推进时往会话里写 `{ kind: "memory_reviewed", through }`。**正常跑完、写了一部分就停、连续失败后放弃，写的是同一条记录**；区分只在一条临时诊断里（`memory_extract_failed` / `memory_extract_gave_up`），诊断不进会话也不进观测。

- 部分完成时游标照推，没写到的那部分静默丢掉，事后看不出来。
- 放弃的那段在盘上与正常看过的一样。
- 答不出「这段对话的记忆提取完整了没有」，也没有数据去调提取的轮数上限。

## 决定

1. **结局分三种并落盘。** [`ExtractOutcome`](../../../packages/core/src/session/types.ts#symbol=ExtractOutcome)：`completed`（模型自己收尾，写没写都算）、`partial`（中途停了——轮数用完、模型出错、被 hook 拦下——但已写成至少一条）、`abandoned`（一条没写成就停，连续 `DEFAULT_EXTRACT_UNFINISHED_LIMIT` 次后放弃）。`memory_reviewed` 多三项：`outcome`、`written`（这段写成了几条）、`reason`（部分完成与放弃才有：循环的错误码，被 hook 拦下是 `hook_blocked`）。
2. **旧记录读成「不知道」。** 没有 `outcome` 的 `memory_reviewed` 是 2026-11-16 之前写的，照常恢复游标，不冒充正常结束（那时三种结局写的是同一条记录）。三项有就得认得出，乱写判红。
3. **观测每次跑了的提取都记一条** `memory.extract.finished`：`outcome` 是正常结束、部分完成、失败（游标不动、下次重看）或失败后放弃，带写成了几条、原因码，`runId` 链到那次提取子循环。面板里念成「提取结局」。
4. **游标的走法不变**：部分完成照推（2026-11-12 照参照物定的「写成过就算看过」），失败不推，连续失败放弃后照推。

## Non-Goals

- 部分完成不重试。第二次能在「此刻存着的」里看到第一次写进去的东西、接着补完——但这改的是 11-12 的规矩，先看记下来的数据（部分完成多常见、多半停在哪）再定。
- 整理（Dream）撞上限的「做了一部分」不在这次。
- 不回填旧会话里的记录。

## 验收

去掉对应改动，前两条是红的：

- [三种结局分得清](../../../packages/core/test/memory-extract.test.ts#test=三种结局分得清2026-11-16会话里的游标记录带上正常结束-部分完成-失败后放弃写了几条停下的原因码观测每次跑了的提取都记一条含失败待重试)：同一段会话里依次正常结束（写 1 条）、部分完成（写 1 条后撞轮数上限）、失败、再失败放弃；会话里三条记录、观测里四条结局逐一对上。
- [旧记录与验形](../../../packages/core/test/session-service.test.ts#test=memoryreviewed-的结局三项2026-11-16旧记录没有也照常恢复结局不知道有就得认得出outcome-乱写written-不是非负整数都判红)
- 面板术语表登记了新记录名（`observe-serve.test.ts` 的术语表覆盖那条）。
