# 记忆变化只发路径通知；stale_read 冲突：拒绝带回现行内容、提取继承前台的已读账、后台写记忆排成一条

> 状态:implemented · 提出 2026-11-03（用户转述的反馈：「stale_read 冲突」「旧的记忆快照累计」；同批的「持续活跃的旧工具结果怎么回收」「大工具参数累计」暂不做）· 参照本机 Claude Code 2.1.317 的机制与 Anthropic 文档（只看机制、不抄措辞）· 拍板 2026-11-03（用户：「1，2 暂时先不做吧，我们先把 3 和 4 做掉」）· 落地 `packages/core/src/memory/harness.ts` / `tool.ts` / `agent.ts`，判据 `packages/core/test/memory.test.ts`、`packages/core/test/memory-extract.test.ts`、`packages/core/test/create-echo.test.ts` · 修改 [记忆段会话内冻结](2026-10-29-memory-frozen-in-system.md) 的第 3 条（追加的内容）与 [覆写前核对读到的版本](2026-09-11-memory-read-version-check.md) 的拒绝行为

**给谁看**：改记忆注入、记忆工具的读写核对或后台记忆任务的人。假设已知 [记忆设计](../../design/memory.md) §3、§5、§7。

**一句话**：两次 run 之间记忆变了，只追加一条「哪些文件变了」的通知，不再贴整段记忆；写入被 `not_read` / `stale_read` 拒时，拒绝里带上现行内容并算作看过；分叉出来的提取继承前台的已读账、预记它在指令里全文看过的常驻文件；本进程里提取与整理一次只跑一个。

## 现状（拍板前）

- **快照累计**：记忆一变，下一个 run 之前追加一条环境消息，正文是整段记忆（常驻全文 + 各层索引，缺省预算下每层最多约 2.9 万字符）。旧的从不清；提取每攒满三轮就可能写一次，长会话里堆着几十份几乎一样的全量快照。
- **stale_read 冲突**：
  - 三本账各自为政（前台一本、每次提取一本、每次整理一本），提取那本空账起步——上文里有前台 view 的结果、指令里有常驻全文，模型以为看过，一覆写就是 `not_read`，5 轮白花一轮；
  - 提取在后台改了文件，前台再整份覆写就是 `stale_read`，要先 view 一轮再重做；
  - 提取与整理是两条独立通道，同一次空闲里能并发改同一层，互相 `stale_read`（整理被要求跳过改不动的文件，那一份就没整理成）；
  - 文案只说「another session wrote to it」，写的往往是本 session 自己的后台复盘。

参照（不作设计依据）：Claude Code 会话中途记忆或 CLAUDE.md 变了不重注入全文——提取写完只追加一条列出变化路径的提醒，完整内容在压缩、`/clear`、重启后重新加载；它 fork 出的子循环（含记忆提取）克隆父的已读状态，上下文里全文展示过的文件也记成已读。

## 决定

1. **变化通知只列路径**（`memoryUpdateMessage`）：冻结记忆段的那一刻，连同每个记忆文件的内容一起记下（`MemorySystemFreeze.files`，常驻模块是那个文件，indexed 模块是目录下每个文件，`INDEX.md` 与点开头的簿记文件除外）。每个前台 run 开头与这份基线比，有变化就追加一条环境消息（`source` 仍是 `memory`），分「changed / added / removed」列路径（每类最多 20 条），说明 system 里那份是旧的、要看就 view；发完基线换成此刻的。完整内容在作废（压缩、`reset`、续会话）后随重新冻结的 system 回来，基线一起重记。
2. **拒绝带回现行内容并算作看过**（`checkRead`）：`not_read` 与 `stale_read`（变了）的拒绝里附上文件此刻的全文，并把这一版记进这把工具的账——模型照着重做就放行，不必再单独 view 一轮。超过 8000 字符的（只可能是人手放进来的）不附、不记。看完之后被删的照旧拒、并从账上抹掉。
3. **提取继承前台的已读账**：前台那把记忆工具的账由 Agent 持有（`foregroundReads`，`CreateMemoryToolOptions.reads` 传入）；提取从主对话分叉时克隆一份，再预记指令「此刻存着什么」里全文展示过的常驻文件（`shownResidentContents`；只在缺省组装下、且没被截尾时预记）。两本账仍各记各的：提取写过的不替前台作保。前台的账在 `reset` / 续会话时清空。
4. **后台写记忆排成一条**（`oneBackgroundWriter`）：提取与整理仍各走各的通道、都不挡前台，但同一时刻只有一个在改记忆；等的期间被中止就不跑。
5. **文案**：拒绝说「another writer changed it (a background memory review in this session, or another session)」。

## Non-Goals

- 不清理历史里已有的旧全量快照（0.5.0 及以前写进会话的那些）：随下一次压缩消失。
- 不把通知做成按块的内容差异：参照物也只列路径，模型要看自己 view。
- 不让后台写完去作废前台账上的那一条：前台再写时拿到的是 `stale_read` + 现行内容（第 2 条），效果相同、少一个跨对象的回写。
- 整理不预记、不克隆账：它不在主对话上下文里，本来就先 view 全部。
- 「持续活跃的旧工具结果回收」「大工具参数累计」：用户决定暂不做。

## 验收

- 通知只列路径、不带内容：[会话内冻结](../../../packages/core/test/memory.test.ts#test=会话内冻结run-内写记忆本-run-system-不变下个-run-system-仍逐字不变变化以一条只列路径的通知追加在输入之前)、[分得清改增删](../../../packages/core/test/memory.test.ts#test=通知分得清改了新增删掉indexed-模块的文件增删也报索引本身不报)、[只送一次](../../../packages/core/test/memory.test.ts#test=一次变化只送一次之后记忆不变就不再追加再变一次再送一条)
- 作废后完整内容回到 system、不补通知：[压缩后](../../../packages/core/test/memory.test.ts#test=压缩落地后-system-重取一次记忆完整的现行内容回到-system基线跟着重记不再补通知)、[续会话](../../../packages/core/test/create-echo.test.ts#test=续上一段会话system-按此刻的记忆重取完整内容回到-system上个进程那条变化通知原样留在历史里续上不再补)
- 拒绝带回内容并算看过：[没看过的已有文件](../../../packages/core/test/memory.test.ts#test=没看过的已有文件整份覆写-按行插-删都先被拒一次拒绝里带着现行内容并记成看过照着重做就放行不必再-view新建文件不用先看)、[超长不带](../../../packages/core/test/memory.test.ts#test=拒绝只交得起短文件超过上限的不带正文也不记成看过模型得自己-view-全文)
- 提取的账：[克隆前台](../../../packages/core/test/memory-extract.test.ts#test=前台-view-过的文件分叉出来的提取直接覆写就放行账从前台克隆过来此前空账起步一覆写就是-notread5-轮白花一轮)、[预记常驻全文](../../../packages/core/test/memory-extract.test.ts#test=提取指令里全文展示过的常驻文件提取直接覆写就放行账上预记了那一版)
- 排成一条：[提取与整理](../../../packages/core/test/memory-extract.test.ts#test=提取与整理排成一条提取还在跑时整理不起模型调用提取跑完它才开始同一层并发写会互相-staleread)

五种变异（提取不克隆前台的账 / 不预记常驻文件 / 整理不排队 / 拒绝不带内容不记看过 / 通知发完不换基线）各让对应判据变红。
