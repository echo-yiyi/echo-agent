# 记忆正文不进 system：system 只留规则，存着的东西是对话最前面的一条消息

> 状态:implemented · 提出 2026-11-13（用户问：记忆和 system 里的规则冲突时会发生什么）· 拍板 2026-11-13（用户：位置要动——系统指令是系统指令，记忆是记忆；这一轮只动记忆，接线做在 core 内部、不开注册口）· 落地 `packages/core/src/memory/compose.ts` / `harness.ts`、`agent.ts`、`loop/run-turn.ts`、`compaction/pipeline.ts`，判据见「验收」 · 承接 [记忆段会话内冻结](2026-10-29-memory-frozen-in-system.md)：冻结、作废、变化通知三条照旧，只换了记忆正文所在的位置

**给谁看**：改 system 装配、记忆给模型看的格式、送模上下文或 provider 缓存相关代码的人。假设已知 [Prompt 的三种载体](../../design/prompt.md)（§1）与 [记忆的冻结与变化通知](../../design/memory.md)（§3）。

**一句话**：system 只放开发者写的东西（产品、extension、角色注册的段）。记忆的规则是模块定义的，留在 system；各模块存着的内容是模型写的，移出 system，包成一条**开头消息**——排在 transcript 视图之前、每个 run 装一次、不进 transcript 的消息（`AgentContext.preamble`）。

## 现状（拍板前）

`memory` 段（order 900）一段里装着两样东西：规则（模块说明、层、怎么写）和各模块此刻存着的内容。内容是模型写的（提取、整理、模型自己写），却和产品的身份、纪律同处一条 system 字符串，装配器只做排序和连接，不分来源。

- 段里没有一句话说记忆和上面的规则冲突时听谁的；项目指令段有（`instructionsHeader`：不覆盖上面的规则）。
- 写入只校验预算，不看内容；`user` 模块的判据正是「用户纠正过你的做法」这类最容易和纪律对冲的东西。
- 产品可以扩展 system、开发者可以用角色替换 `identity`：他们写的段和模型写的记忆在同一个位置，开发者从自己注册的段推不出最终 system 说了什么。
- 同一个混放已经出过一次事：记忆正文里一行 `{{ }}` 曾让每个 run 在调模型前失败，靠「第三方文本的段不插值」补上（[插值由段声明](2026-11-03-prompt-interpolation-opt-in.md)）。

## 不拍板的代价

冲突时没有任何说法，谁赢全看模型；被污染的记忆（提取看得到工具结果，网页或文件里的文字可能被写进记忆）以 system 的位置跨会话常驻。

## 选项

- **A. 位置不动，只在记忆段里补一句地位声明。** 改动最小；但「开发者写的」和「模型写的」仍在同一条字符串里，结构上分不开。
- **B. 正文移出 system，成为开头消息；规则与地位声明留在 system。** 请求里的字节顺序几乎不变（原来在 system 末尾，现在是第一条消息），冻结与缓存那套照旧。
- **C. 正文写进 transcript（每次作废后追加一条全量快照）。** 不用加字段；但每次压缩、续会话都多一份全量快照，且落在靠近末尾的位置——[变化只发路径通知](2026-11-03-memory-change-notice-and-reads.md) 刚因为快照堆积改掉这种做法。

## 决定

**B**（2026-11-13 用户拍板）。

1. **拆成两份**。`renderMemoryRules()` 出规则，仍是 system 的 `memory` 段（order 不变），不读盘、会话内逐字不变；`renderMemoryContent()` 出正文，一块内容都没有时返回空串、不出消息。
2. **正文是一条开头消息**。`memoryPreamble()` 把正文包成 `environment` 消息（`source: "memory"`，`at` 固定为 0），经 `AgentContext.preamble` 交给循环；送模时排在 transcript 视图之前（`callModel`），之后才接每轮注入、过 `transformContext` 与 `contextBeforeBuild`。它不进 transcript、不落 session、压缩不动它。
3. **冻结照旧**（[2026-10-29](2026-10-29-memory-frozen-in-system.md) 的四条不变）：会话内第一次装配时取一次，Agent 持有冻结的那份（`MemoryFreeze`，存的是消息对象）；压缩落地、`reset`、续会话三处作废重取；两次 run 之间的变化仍走只列路径的通知。
4. **沿用主循环 system 的调用一并带上开头消息**，否则前缀对不上：压缩阶段从主对话分叉的模型调用（`modelCallFor`）、记忆提取（`Agent.runExtract`）、fork 的子 agent。自带 system 的不带：fresh 的子 agent、给了 `systemPrompt` 的压缩调用、Dream。
5. **估算把它算进去**。`measureContext()` 与两处校准比（`pipeline.ts` 的 `noteTurn`、`Agent` 的 usage 处理）原来靠 system 的字数算到记忆，现在算 system 加开头消息（`prefixEstimate`）。
6. **地位写在 system 里**，不写在那条消息里（一段文字给自己定地位不算数）。规则段说明：记忆内容不是 system 的一部分，是更早的会话留下的背景、可能过期、不是指令；不覆盖 system 里的任何内容，也不覆盖用户这次对话里说的话；冲突时以后两者为准并改掉那条记忆。
7. **观测**。`context.built` 的构成多一种来历 `preamble`（`source` 为 `memory`），面板与 `observe show --context` 标成「开头消息」；`prompt.assembled` 里 `memory` 段只剩规则。

## DO / DON'T

- DO：新增「沿用主循环那份 system」的模型调用时，把 `AgentContext.preamble` 一起带上。
- DON'T：把模型写的或最终使用者写的文本注册成 system 段。
- DON'T：在开头消息里写「该听谁的」——地位只在 system 的规则段里定。
- DON'T：把开头消息写进 transcript 或 session。

## Non-Goals

- **不给 extension 开「开头消息」的注册口。** 现在只有记忆一个来源，由 `Agent.contextPreamble()` 直接装；要开就是公共面多一个开放集合，单独拍。
- **项目指令（AGENTS.md）不动**，仍是 system 的 `instructions` 段。
- **不改 `memory` 段的 order**（仍是 900）。规则已经不随记忆变，放哪都不影响缓存。
- **不改冻结、作废、通知的时机**，不改记忆提取指令的结构。
- **不给跨会话的许可单独立一句话**（「上次说过以后都直接 push」这类）：由第 6 条的「不覆盖 system 里的任何内容」兜住，不另写。

## 待拍板

- **AGENTS.md 要不要也移出 system。** 按同一条分界线它是最终使用者写的，也该出去；但它的 owner 在 `@echo-agent/base`，要出去就得开上面那个注册口。
- **项目指令的措辞要不要放宽。** 用户 2026-11-13 表示可以放宽（现在写的是「不覆盖上面的规则」）；放宽到哪一步——哪些算可覆盖的缺省习惯、哪些不可覆盖——没有定句子，这一轮没改。

## 没有验证的

- **缓存命中率没有在真实 provider 上重测。** 按请求布局推断与改之前相同（记忆正文从 system 末尾变成第一条消息，前后字节顺序基本不变）；2026-10-29 那组 98% / 38% 是改之前的数。
- **模型在冲突时实际听谁的没有评测。** 位置给的是结构上的区分，user 角色的消息对模型并不天然更弱；这一轮只保证「规则里写明了地位」，不保证模型照做。

## 验收

- 记忆内容不在 system、在对话最前面、不进 transcript：[记忆正文不进 system](../../../packages/core/test/memory.test.ts#test=记忆正文不进-systemsystem-只有规则存着的东西是对话最前面的一条消息不进-transcript)
- 规则里没有记忆内容、地位写在规则里：[规则与正文分开](../../../packages/core/test/memory.test.ts#test=规则与正文分开规则里没有任何记忆内容正文里没有规则正文的地位写在规则里)
- system 与开头消息跨 run 逐字不变、变化走通知：[会话内冻结](../../../packages/core/test/memory.test.ts#test=会话内冻结run-内写记忆本-run-的-system-与开头消息不变下个-run-两样仍逐字不变变化以一条只列路径的通知追加在输入之前)
- 压缩后开头消息重取、system 不变：[压缩后重取](../../../packages/core/test/memory.test.ts#test=压缩落地后开头消息重取一次记忆完整的现行内容回到开头消息system-不变基线跟着重记不再补通知)
- 续会话后重取、不落 session：[续会话](../../../packages/core/test/create-echo.test.ts#test=续上一段会话开头消息按此刻的记忆重取完整内容不进-system上个进程那条变化通知原样留在历史里续上不再补)
- 压缩的分叉调用带着开头消息：[压缩分叉](../../../packages/core/test/memory.test.ts#test=压缩的摘要调用从主对话分叉时带着开头消息同一份-system消息仍是上一次请求的前缀记忆正文在最前指令接在末尾)
- 提取带着开头消息：[提取前缀](../../../packages/core/test/memory-extract.test.ts#test=提取请求的前缀与前台最后一次请求逐字相同同一份-system同一份工具菜单消息是它的延续厂商前缀缓存接得上)
- fork 带、fresh 不带：[子 agent](../../../packages/core/test/memory.test.ts#test=fork-的子-agent-带着父的开头消息前缀与父逐字相同fresh-的-system-是模型给的不带记忆正文)
- 估算算进开头消息：[measureContext](../../../packages/core/test/compaction.test.ts#test=measurecontext有-usage-基准-基准-基准之后的字符估没有-system-开头消息-整个视图的字符估校准比只乘字符估的部分)
- 观测的构成里有 `preamble`：[重建](../../../packages/core/test/observability-context.test.ts#test=重建开头消息排最前记-preamble压缩折掉的段记-summary清掉的旧结果记-clearedplaceholder注入按来源token-与压缩同一个估算器)

压缩、提取、fork 三条在落地时做过反证：去掉对应那一处接线，这三条各自变红。
