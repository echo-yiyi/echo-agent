# 删掉整理的水位门：整理只按节流门触发

> 状态:implemented · 提出 2026-11-11（用户点出：agent.md 会触发反复整理；整理的目标是压回硬预算内，没要求降到水位以下，整理完下一次写入可能继续触发）· 拍板 2026-11-12（用户：「可以，删掉水位门」）· 落地 `packages/core/src/memory/dream.ts` / `harness.ts` / `observe.ts`、`packages/base/src/observe/page.html` / `lexicon.ts`，判据 `packages/core/test/dream-schedule.test.ts`、`packages/core/test/observability-memory.test.ts`、`packages/core/test/memory.test.ts` · 取消 [dream 改造](2026-09-07-dream-rework.md) 的「加一道水位门单开」与 [从主对话分叉](2026-11-03-memory-extraction-fork.md) 的第 11 条

**给谁看**：改整理的触发条件或记忆预算的人。假设已知 [记忆设计](../../design/memory.md) §4（写入超预算被拒）与 §6（整理）。

## 现状（拍板前）

整理有两组门：节流（距上次 24 小时、写入 ≥ 5 次、indexed 文件 ≥ 10 个，全满足），或者水位单独成立（这一层某个模块用到预算 80%，且上次整理之后有过新写入）。整理 prompt 只要求「每个模块压回预算内」，即 ≤ 100%。

于是只要某个模块在 80%–100% 之间，整理完它仍在线上，这一层**下一次任何写入**（哪怕写的是别的模块）都会让下次回到 idle 时整层再整理一遍——整理的频率等于写入的频率，24 小时节流不起作用。最容易停在这个区间的是 `agent.md` / `user.md`：常驻、预算小（2200 / 1400）、instructions 要求写得紧凑，写入只在 100% 才被拒，提取会把它一路填到快满。

参照（只看机制，不作设计依据；本机 Claude Code 2.1.322）：整理只有两道门——距上次 ≥ 24 小时、且自上次以来动过的会话 ≥ 5 个（缺省 `{minHours: 24, minSessions: 5}`）；没有按占用触发的门。它的记忆索引超过行数 / 字节上限时不拒写，装载时截断并附一条警告。

## 决定

**删掉水位门**（2026-11-12 用户拍板），整理只按节流门触发。

水位唯一的用处是赶在写入被拒之前先整理，而被拒的代价不大：

- **resident 模块**：全文本来就摆在提取指令里、已记为读过（[从主对话分叉](2026-11-03-memory-extraction-fork.md)），提取一次覆写就能合并压紧。
- **indexed 模块**：索引快到 25 KB 上限时文件早已成百上千，节流几道早就满足，例行整理会接住。

删掉的东西：`DreamGates.budgetRatio` 与缺省值里的 `0.8`、算占用的 `budgetPressure`、`DreamState.writesAtLastPass`（`.dream/state.json` 少一个字段；旧文件里有这个字段时读取忽略，不迁移）、观测 `memory.dream.evaluated` 的判定值 `budget` 及面板文案。整理 prompt「每个模块压回预算内」不改：没有水位之后它正好是对的目标。

## Non-Goals

- 不换节流门的信号（我们数记忆写入、参照物数会话活动——[dream 改造](2026-09-07-dream-rework.md) 已记下这是选错了轴），另议。
- 不让整理读对话记录（参照物会读那几个会话），另议。
- 不改预算与写入时的拒绝。

## 验收

- 占用快满不触发整理：[占用快满不整理](../../../packages/core/test/dream-schedule.test.ts#test=占用快满其余门没满足不整理没有按占用触发的门写满了由写的一方就地腾地方)（改动之前的代码上是红的：缺省门里有水位 0.8，2000 / 2200 一上来就开整）
- 判定值少了 `budget`：[dreamGate 各给一个原因](../../../packages/core/test/observability-memory.test.ts#test=dreamgate进行中-太早-写入不够-轮数不够-文件不够-全满足各给一个原因shoulddream-就是它的-run)
- 缺省门：`memory.test.ts` 的「缺省门」一条（`DEFAULT_DREAM_GATES` 没有 `budgetRatio`）
