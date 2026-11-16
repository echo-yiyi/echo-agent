# skill 目录不进 system：规则留在 system，目录是 messages 载体的段

> 状态:implemented · 提出 2026-11-16（[prompt 段的载体](2026-11-16-prompt-section-carrier.md) 落地后，skill 目录是 system 里剩下的一段第三方文本；用户问别家的做法，回答是也在消息里）· 拍板 2026-11-16（用户：拆——规则留 system、列表走 messages，和记忆同一个做法）· 落地 `packages/core/src/skill/compose.ts`、`agent.ts`，判据见「验收」 · 推翻 [prompt 段的载体](2026-11-16-prompt-section-carrier.md) Non-Goals 的第一条（skill 目录不动）

**给谁看**：改 skill 给模型看的格式、prompt 装配或 provider 缓存相关代码的人。假设已知 [prompt 段的两种载体](../../design/prompt.md)（§1）。

**一句话**：skill 给模型看的东西拆成两段。`skills`（system）只有我们写的规则；`skills-catalog`（`carrier: "messages"`）是每个 skill 一行的名字与描述，是对话前面的一条消息。

## 现状（拍板前）

`skills` 段（order 500，system）一段里装着两样东西：我们写的规则（skill 是什么、匹配了就先 `skill_activate`），和池里每个 skill 的描述。描述来自各个 SKILL.md，是 skill 作者写的任意文本——单行化、截断过，但仍和产品的身份、纪律在同一条 system 字符串里。池里增删一个 skill，system 从这一段起失去缓存。

## 决定

与 [记忆正文不进 system](2026-11-13-memory-content-out-of-system.md) 同一个拆法。

1. **两个渲染函数**。[`renderSkillRules()`](../../../packages/core/src/skill/compose.ts#symbol=renderSkillRules) 出规则：skill 是什么、目录在对话前面的一条消息里、匹配了就先激活、描述是 skill 作者写的——拿它判断合不合用，不当指令。不含任何 skill 的名字或描述。[`renderSkillCatalog()`](../../../packages/core/src/skill/compose.ts#symbol=renderSkillCatalog) 出目录：一句说明加每个 skill 一行，预算与单行化照旧。
2. **两段，同出同没**。`echo:skills` 注册 `skills`（system）与 `skills-catalog`（messages），order 都是 500。池里没有可列的 skill、或 `skill_activate` 不在工具面，两段都渲染为空。
3. **顺序**。messages 载体的段现在三条：项目指令（400）、skill 目录（500）、记忆正文（900）。
4. **什么时候变**。池里增删 skill 只换目录那条消息，system 逐字不变（除非池从空变成不空或反过来——那时规则段跟着出现或消失）。激活 / 停用两段都不动，激活的正文仍是每轮注入。

## Non-Goals

- 不改目录的预算（单条描述 1024、总量 8000）、不改激活正文的注入方式。
- 不改「目录读的是工具池、角色收紧不联动」这条已知限制（[Prompt](../../design/prompt.md) §9）。

## 没有验证的

- 缓存命中率没有在真实 provider 上重测；「池变了 system 不变」是按请求布局推的。
- 模型看到目录在消息里之后，激活 skill 的倾向有没有变，没有评测。

## 验收

- 规则里没有 skill 的名字与描述、池里增删它逐字不变；目录里没有规则：[规则与目录分开](../../../packages/core/test/prompt.test.ts#test=规则与目录分开规则里没有任何-skill-的名字或描述池里增删-skill-它逐字不变目录里没有怎么用的规则)
- 池空两段都不出：[池空](../../../packages/core/test/prompt.test.ts#test=池空-两段都不出门控有没有-skillactivate-工具在段的闭包里)
- 规则在 system、目录是对话最前面的一条消息，激活后两样都不变：[Agent 接线](../../../packages/core/test/prompt.test.ts#test=内建段经-echo-装进-prompt环境段带-workspacemodelskill-的规则在-system目录是对话最前面的一条消息激活后下一轮注入可见system-逐字节不变)
