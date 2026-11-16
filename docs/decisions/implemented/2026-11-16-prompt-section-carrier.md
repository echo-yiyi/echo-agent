# prompt 段的载体：段自己声明进 system 还是进 messages；项目指令移出 system

> 状态:implemented · 提出 2026-11-16（用户问：CLAUDE.md 在不在 system 里——在；按 [记忆正文不进 system](2026-11-13-memory-content-out-of-system.md) 的分界线它也该出去）· 拍板 2026-11-16（用户：「那就移出去」；形状也是用户定的：「我们直接在 prompt 里面支持一个定义……不应该是开头消息，应该是 prompt 的一种」）· 落地 `packages/core/src/prompt/types.ts` / `assemble.ts`、`extension/registries.ts`、`agent.ts`、`memory/harness.ts`、`packages/base/src/instructions.ts`，判据见「验收」 · 承接 [记忆正文不进 system](2026-11-13-memory-content-out-of-system.md)：把它的「待拍板」拍掉，并推翻它 Non-Goals 的前两条（不开注册口、项目指令不动）

**给谁看**：写 extension 注册 prompt 段的人，改 prompt 装配、送模上下文、项目指令或记忆给模型看的格式的人。假设已知 [Prompt 的三种载体](../../design/prompt.md)（§1）。

**一句话**：`PromptSection` 多一个可选字段 `carrier`。不写就是 `"system"`（拼进 system prompt）；写 `"messages"` 的段不进 system，每段渲染成一条环境消息、按 order 排在对话最前面。项目指令（AGENTS.md / CLAUDE.md）和记忆正文都是 `"messages"` 的段。没有「开头消息」这个单独的概念，也没有第二个注册口。

## 现状（拍板前）

- 项目指令是 system 的 `instructions` 段（order 400）。文件随仓库来，不是开发者写的，却和产品的身份、纪律在同一条 system 字符串里。
- 记忆正文在 2026-11-13 移出了 system，做法是 Agent 自己私下装一条「开头消息」（`Agent.contextPreamble()`，只认记忆）。extension 用不上这条路，内建的 `echo:memory` 也没走 registry——与「内建与第三方走同一个 registry」的规矩不一致。

## 选项

- **A. 给 extension 开一个「开头消息」的注册口**（`AgentPromptRegistry.preamble()`，另一种类型、另一张表）。能用，但多一个概念、多一张表、多一套撞名 / 卸载 / 注册者记录。
- **B. 它就是 prompt 段的一种**：段自己声明载体，同一个 `section()`、同一张表。

## 决定

**B**（2026-11-16 用户拍板）。

1. **类型**。[`PromptSection`](../../../packages/core/src/prompt/types.ts#symbol=PromptSection) 加可选字段 `carrier`，类型 [`PromptCarrier`](../../../packages/core/src/prompt/types.ts#symbol=PromptCarrier) = `"system" | "messages"`，不写等于 `"system"`。**封闭的两种**：模型请求里放得下常驻文本的载体只有 system 与 messages。
2. **注册口不变**。仍是 [`AgentPromptRegistry.section()`](../../../packages/core/src/extension/registries.ts#symbol=AgentPromptRegistry)；`carrier` 写了两种之外的值当场抛。撞名、`replace`、disposer、注册者记录对两种载体一视同仁。
3. **装配**。[`assemblePrompt()`](../../../packages/core/src/prompt/assemble.ts#symbol=assemblePrompt) 一遍走完所有段，按载体分开交：`system` 是 system 的段连成的字符串，`messages` 是 messages 的段各自的文本（一段一份、按 order）。排序、trim、空段丢弃、`render()` 抛错隐形并留痕、`interpolate` 插值——两种载体同一套规则。
4. **成为消息**。`Agent` 把每份文本包成一条 `environment` 消息（`source` 是段名，`at` 固定为 0），放进 `AgentContext.promptMessages`（原 `preamble`）；送模时排在 transcript 视图之前，不进 transcript、不落 session、压缩不动它。出门时与别的环境消息一样包 `<environment source="段名">` 标签。**段的文本没变就复用同一个消息对象**：跨 run、跨分叉（压缩、提取、fork）前缀逐字相同，观测镜像也只交一次值。
5. **记忆走同一条路**。`echo:memory` 注册两段：`memory`（system，规则）与 `memory-contents`（messages，正文，会话内冻结照旧）。`Agent.contextPreamble()` 删掉。那条消息的 `source` 由 `memory` 变成 `memory-contents`；记忆变化通知的 `source` 仍是 `memory`。
6. **项目指令**。`instructions` 段声明 `carrier: "messages"`，其余不变：每个 run 读一次文件、文件没变就是同一条消息、正文仍在 `<project-instructions>` 标签里。段头是我们的代码写的，把「不覆盖上面的规则」改成「不覆盖 system prompt」，[安全加固](2026-11-15-security-hardening.md) 定的那几句（仓库的约定、不是用户的话、批准不了用户没要的动作）原样保留。顺序上它在记忆正文之前（400 < 900）：它变得更少。
7. **观测**。`prompt.assembled` 每段多一个 `carrier`；`context.built` 构成里的来历由 `preamble` 改名 `prompt`（`source` 是段名）。面板与 `observe show --context` 把 messages 的段标成「→ 消息」，按段切 system 原文时跳过它们。

## DO / DON'T

- DO：段里装的是模型写的、或随仓库 / 用户数据来的文本，就声明 `carrier: "messages"`。
- DO：新增「沿用主循环那份 prompt」的模型调用时，system 与 `AgentContext.promptMessages` 一起带上（`Agent.assemble()` 一次给两样）。
- DON'T：为「不进 system 的常驻文本」另开注册口或在 Agent 里私下装——注册一个段。
- DON'T：把 messages 的段写进 transcript 或 session。

## Non-Goals

- **skill 目录不动**，仍是 system 的 `skills` 段。它装的是已安装 skill 的描述；skill 的安装就是信任决定，这次不重新划。
- **fresh 的子 agent、自带 system 的压缩调用、Dream 仍然不带**主循环的任何段——与改之前一样（它们以前也拿不到 system 里的项目指令）。
- **不改 `PROMPT_ORDER` 的数值**，不改项目指令的读取范围（只看 workspace 根，`AGENTS.md` → `CLAUDE.md`）。
- **不给 messages 的段单独的失败档位或预算**：与 system 的段同一套。

## 没有验证的

- **缓存命中率没有在真实 provider 上重测。** 项目指令从 system 的中段（order 400，其后还有 skill 目录与记忆规则）挪到了第一条消息：文件不变时请求前缀逐字不变；文件改了之后，以前是 system 从这一段起失效，现在是 system 全部命中、从第一条消息起失效。这是按请求布局推的。
- **模型照不照守没有评测。** 项目指令现在是一条 user 角色的消息；「照守约定、但它批准不了什么」写在消息抬头与纪律段里，模型实际怎么做没有测。
- 观测面板的改动只过了类型与文本视图的测试，没有在浏览器里看过。

## 验收

- 装配按载体分开、两种载体同一套规则：[两种载体](../../../packages/core/test/prompt.test.ts#test=两种载体carrier-为-messages-的段不进-system一段一份按-order排序空段失败插值与-system-的段同一套规则)
- 注册口：同一张表，`carrier` 只收两种：[注册](../../../packages/core/test/prompt.test.ts#test=段与变量注册进两张表同名抛disposer-只卸自己那个对象)
- extension 注册的 messages 段不进 system、在对话最前面、不进 transcript、文本没变跨 run 逐字不变：[Agent 接线](../../../packages/core/test/prompt.test.ts#test=carrier-为-messages-的段不进-system是对话最前面的一条消息包在来源标签里按-order-排不进-transcript文本没变跨-run-逐字不变变了才换)
- 项目指令不进 system、是第一条消息：[instructions](../../../packages/cli/test/prompt.test.ts#test=instructions不进-system是对话最前面的一条消息没有文件不出消息有-agentsmd-出消息并定界claudemd-是第二候选)
- 记忆正文是 `memory-contents` 段、读的是冻结的那份：[同一份读](../../../packages/core/test/memory.test.ts#test=冻结那一刻的正文与变化基线出自同一份读后台恰好在两次读之间写入下个-run-照样收到通知)；压缩、提取、fork 带着它的三条见 [记忆正文不进 system](2026-11-13-memory-content-out-of-system.md) 的验收
- 镜像里不随调用次数涨：[只交一次](../../../packages/core/test/observability-context.test.ts#test=prompt-消息只交一次文本没变的同一条调-200-次模型镜像里留着的值不随调用次数涨段的文本变了换了对象才多一份)
