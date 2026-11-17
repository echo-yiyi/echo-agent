# 记忆的提取 / 整理指令交给产品，整理不看文件数，快写满时提醒

> 状态:implemented · 提出 2026-11-17（使用者报：「重复记忆，常驻内容拥挤，整理成本高」；用户纠正：使用者用的是自己定义的模块，要从机制上查）· 拍板 2026-11-17（用户：「三件都做，按你的建议来」，以及「我们得提供记忆提取和记忆整理的 prompt，可以由用户自己定义，我们应该把这部分扩展交给用户」）· 落地 `packages/core/src/memory/extract.ts` / `dream.ts` / `tuning.ts` / `harness.ts` / `compose.ts` / `types.ts`、`packages/core/src/agent.ts`、`packages/core/src/create-agent.ts`，判据见验收 · 推翻 2026-09-10「提取 / 整理指令不需要替换口子，判据跟着模块走」与 [记忆的可调取值](2026-11-12-memory-tuning-config.md) 里的缺省 `minFiles: 10`

**给谁看**：用 `createEcho()` 装记忆、自己定义记忆模块的产品，以及改提取、整理、写入校验的人。假设已知 [记忆](../../design/memory.md) 的模块、层与 Dream。

## 现状（拍板前）

- **整理的缺省门里有「文件数 ≥ 10」**，而文件数只数 indexed 模块目录下的文件，常驻模块的单文件记 0（`dreamGate`）。一层里参与整理的全是常驻模块时这道门永远过不了，整理一次都不跑；2026-11-12 又删了按占用触发的门，写满之后只能靠提取在有限的轮数里就地压紧。
- **写满才拒、之前一句不提**：模块一直顶在上限，之后每次提取都得先看一遍、压一遍再写，轮数常耗在这上面。
- **提取与整理的指令写死在内核**（`defaultExtractPrompt` / `defaultDreamPrompt`）：产品的模块与缺省指令配不上时没法改。
- 参照物（Claude Code）：去重同样只靠提示词；索引快到上限时提醒合并、超了仍写入并要求重写；公开资料里的整理触发是「隔一段时间 + 有活动」，不看文件数；不开放提取 / 整理指令的定制（调研见本次会话，第三方逆向资料只作参考）。

## 决定

1. **整理的缺省门去掉文件数**：[`DEFAULT_DREAM_GATES`](../../../packages/core/src/memory/dream.ts#symbol=DEFAULT_DREAM_GATES) 只剩「写过 5 次」与「距上次 24 小时」。产品要文件数门照旧可以经 `memory.dream.minFiles` 配回来。
2. **快写满时提醒**：缺省写入校验（[`defaultCheckWrite`](../../../packages/core/src/memory/compose.ts#symbol=defaultCheckWrite)）在写完占到预算 [`MEMORY_NEAR_FULL_RATIO`](../../../packages/core/src/memory/compose.ts#symbol=MEMORY_NEAR_FULL_RATIO)（九成）以上时放行并带一句提醒（[`WriteVerdict`](../../../packages/core/src/memory/types.ts#symbol=WriteVerdict) 的 `note`），接在成功回执后面：先合并重叠的、删不再成立的。常驻模块按全文、indexed 按该层索引的渲染长度。写满照旧拒——常驻全文每次都送模型，超了就是上下文膨胀。
3. **提取 / 整理指令交给产品**：`createEcho({ memory: { extract: { prompt }, dream: { prompt } } })`。
   - 提取：[`MemoryExtractOptions.prompt`](../../../packages/core/src/memory/extract.ts#symbol=MemoryExtractOptions)，输入 [`ExtractPromptInput`](../../../packages/core/src/memory/extract.ts#symbol=ExtractPromptInput)（`memories`、`scopes`、`range`——含上次没看完的 `retry`——与此刻存着什么 `stored`）。抛错或给空串按这一次没跑成算（`failed`，原因码 `prompt_failed`），报诊断 `memory_extract_prompt_failed`。
   - 整理：[`MemoryDreamOptions.prompt`](../../../packages/core/src/memory/dream.ts#symbol=MemoryDreamOptions)，输入 [`DreamPromptInput`](../../../packages/core/src/memory/dream.ts#symbol=DreamPromptInput)（`memories`、`scopes`、这次整理的 `scope`）。指令在上锁前写好：抛错或给空串这一次不跑、不留锁。
   - 缺省写法 `defaultExtractPrompt` / `defaultDreamPrompt` 一并从根入口导出：在缺省上加几句就 `(i) => defaultExtractPrompt(i) + "…"`。
   - **只换文字，机制仍归内核**：提取只放行记忆工具、轮数上限、游标怎么推；整理只给这一层那把工具、够不到 `dream: false` 的模块。
   - 配置校验（[`resolveExtractOptions()`](../../../packages/core/src/memory/tuning.ts#symbol=resolveExtractOptions)、[`resolveDreamOptions()`](../../../packages/core/src/memory/tuning.ts#symbol=resolveDreamOptions)）：`prompt` 给了就得是函数，其余项照旧只收整数。

## Non-Goals

- 不做机械去重（相似度、语义比对）：参照物也没有；去重靠指令与整理，产品现在能自己写指令。
- 不做跨层整理：整理仍按层各做各的。
- 缺省指令的措辞这次不改：要按参照物的结构重写一版（只学不抄），另做、另验。
- `settings.json` 不接这几项：形状归产品，经 `createEcho()` 配。

## 验收

去掉对应改动，这几条是红的：

- [缺省门不看文件数](../../../packages/core/test/memory.test.ts#test=缺省门下一层里全是常驻模块也会整理2026-11-17此前文件数门只数-indexed-目录常驻模块记-0这道门永远过不了)
- [快写满时提醒](../../../packages/core/test/memory.test.ts#test=快写满时提醒2026-11-17写完占到预算九成以上成功回执后面接一句先合并删过时的不到九成不提)
- [提取指令可以换](../../../packages/core/test/memory-extract.test.ts#test=提取指令可以换2026-11-17用产品给的写法拿到要看的那段与此刻存着什么写法抛错按这一次没跑成算报诊断不调模型)、[整理指令可以换](../../../packages/core/test/memory.test.ts#test=整理指令可以换2026-11-17dreamtask-用产品给的写法拿到这一层与模块表写法抛错时不上锁不留一把要等一小时的锁)
- [经 createEcho 接到内核](../../../packages/core/test/create-echo.test.ts#test=createecho-的-memoryextractprompt-memorydreamprompt-接到了内核2026-11-17退出前补提取用产品给的提取指令整理用产品给的整理写法)、[配置校验](../../../packages/core/test/memory-tuning.test.ts#test=提取与整理的指令可以换2026-11-17prompt-给函数就用它不给用缺省写法给了不是函数就抛)
