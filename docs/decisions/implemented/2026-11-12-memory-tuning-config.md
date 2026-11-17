# 记忆的可调取值：提取的节奏与轮数上限、整理的门由产品配

> 状态:implemented · 提出 2026-11-12（用户：「我们可以把一些做成配置不？比提取最多5轮这种。」）· 拍板 2026-11-12（用户：「可以，按这个做」）· 落地 `packages/core/src/memory/tuning.ts` / `extract.ts` / `harness.ts`、`create-agent.ts`、`agent.ts`、`index.ts`，判据 `packages/core/test/memory-tuning.test.ts`、`memory-extract.test.ts`、`create-echo.test.ts` · 放开 [降频](2026-10-30-memory-extraction-gate.md) 与 [从主对话分叉](2026-11-03-memory-extraction-fork.md) Non-Goals 里「不做成产品配置」的门槛与轮数 · 后续 2026-11-17：缺省整理门去掉文件数、两边各能换指令（`prompt`），见 [提取 / 整理指令交给产品](2026-11-17-memory-prompts-and-gates.md)

**给谁看**：做产品、要按自己的模型与对话风格调记忆后台活的人。假设已知 [记忆设计](../../design/memory.md) §2（开关归用户、形状归产品）与 §5、§6。

## 现状（拍板前）

提取的轮数上限（5）、攒满几轮（3）、攒够多少词（8）是 `agent.ts` 直接读的常量；整理的门在记忆层内部有类型 `DreamGates`（`MemoryHarnessOptions.dream`），但 `createAgent` 没往下传。产品能配的记忆形状只有 `memory.builtin` 与 `memory.scopes`。

一套数不适合所有产品：轮数上限看模型（弱模型要多几轮，也直接关系成本），节奏看对话风格（陪伴类话短轮多，编程类一轮干很久）。

## 决定

（2026-11-12 用户拍板。）

1. **挂在已有的 `CreateAgentOptions.memory` 下**，与 `builtin` / `scopes` 并列，产品照旧经 `Product.preset` 给——不另开路：
   - `extract?: MemoryExtractOptions`：`maxTurns`（≥ 1）、`everyTurns`（≥ 1）、`minUserWords`（≥ 0，0 = 不设词数门槛）。
   - `dream?: DreamGates`：`minWritesSinceLast` / `minTurnsSinceLast` / `minFiles` / `minIntervalMs`（都 ≥ 0，0 = 这一道不设门槛）。
2. **不给的项用缺省**：提取用 `DEFAULT_EXTRACT_SETTINGS`；整理是给了的项覆盖 `DEFAULT_DREAM_GATES` 里的同名项，其余照缺省。
3. **配错在装配时抛**（[`resolveExtractOptions()`](../../../packages/core/src/memory/tuning.ts#symbol=resolveExtractOptions)、[`resolveDreamOptions()`](../../../packages/core/src/memory/tuning.ts#symbol=resolveDreamOptions)（2026-11-17 由 `resolveDreamGates` 改名，多收一项 `prompt`））：不是整数、低于下限、写错键名都算，消息说出是哪一项、可配的有哪些。不回落到缺省——回落的话产品以为自己的配置生效了。关着记忆（`withoutMemory`）也照样校验。
4. **只给产品配**：不进 `settings.json`、不做命令行参数。用户这边仍只有开关（`withoutMemory`）。评测直接调 `createEcho()` 装配，自然能传。
5. **取值装在记忆包上**：`createAgentMemories({ extract, dream })` → `AgentMemories.extract` / `.gates`，`Agent` 排提取、起提取子循环时读它——不经全局。
6. **公开导出类型** `MemoryExtractOptions`、`DreamGates`（`@echo-agent/core`），API 快照多这两个符号。

## Non-Goals

- 连续没写成的放弃次数（`DEFAULT_EXTRACT_UNFINISHED_LIMIT`）、退出前补跑的等待上限（`DEFAULT_EXTRACT_DRAIN_MS`）、锁的超时：机制内部的取值，不开放。
- 不做运行中改配置：装配时定下，整段会话不变。
- 不给用户层（`settings.json` / CLI）开口子。

## 验收

- 校验与补齐：[缺省与覆盖](../../../packages/core/test/memory-tuning.test.ts#test=不配-全用缺省配了的项覆盖其余照缺省)、[配错就抛](../../../packages/core/test/memory-tuning.test.ts#test=配错就抛轮数上限与攒满几轮至少-1不收小数负数字符串)、[写错键名](../../../packages/core/test/memory-tuning.test.ts#test=写错键名也是配错报出可配的那几项不悄悄忽略)
- Agent 读记忆包上的设置：[everyTurns / minUserWords](../../../packages/core/test/memory-extract.test.ts#test=配了-everyturns-1minuserwords-0一句ok就起提取缺省要攒满三轮八个词)、[maxTurns](../../../packages/core/test/memory-extract.test.ts#test=配了-maxturns-2提取子循环第二次模型调用之后就到上限缺省-5)
- 经 `createEcho()` 接到 Agent：[提取](../../../packages/core/test/create-echo.test.ts#test=memoryextract-经-createecho-接到-agent配了-everyturns-1一轮之后就提取缺省要攒满三轮第一轮不跑)、[整理](../../../packages/core/test/create-echo.test.ts#test=memorydream-经-createecho-接到-agent写入数与文件数两道给-0回到-idle-就整理缺省要写满-5-次10-个文件)、[配错当场报错](../../../packages/core/test/create-echo.test.ts#test=memoryextract-memorydream-配错createecho-当场报错不回落到缺省)

后两组在改动之前的代码上是红的（配置被忽略、配错不报）。
