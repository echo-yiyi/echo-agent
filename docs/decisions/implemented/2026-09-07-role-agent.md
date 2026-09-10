# session 的 agent 定义是产品内的一个角色，走 extension 挂载，可选择性替代 identity / 工具子集 / 模型

> 状态:implemented · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 来源 [会话与 agent 集群](../../design/sessions.md) §4 · 修正 [agent 是 extension](2026-09-03-agent-is-an-extension.md)(产品打包成 bundle 那一半撤回) · 挪入 implemented 2026-09-09（对照代码核过验收）

## 现状(拍板前)

[agent 是 extension](2026-09-03-agent-is-an-extension.md) 把「agent 定义」理解成产品级:echo-agent / echo-coding 各写成一个 bundle,ABI 加 `extensions` 字段让 extension 打包别的,`Product.preset` 退场。用户 2026-09-07 指出这是误解:**产品是容器级的事**,一个 echo-coding 容器开出来的段全是 coding 方向;session 挂的 agent 定义是**产品内的一个角色**——reviewer、前端、缺省——对应 Claude Code 的 subagent 定义(`.claude/agents/*.md`)。

今天 `SessionInfo.agent` 是产品名字符串,只给 `--continue` 筛选;`session_create` 没有 `agent` 参数(sessions.md §7);`AgentPrompt.section()` 同名 fail-loud、受控 replace 明确「等有真实消费者再开」(`packages/core/src/extension/registries.ts`);工具工作集只有 deferred 一种过滤(`tools/harness.ts` 的 `activeTools` / `visibleTools`),没有「只露这几件」的口。

## 不拍板的代价

按产品 bundle 做下去,`Product` 要改形状、ABI 要加字段、`--resume` 要按名跨容器找定义,而这三件都不是用户要的;真正要的「一段 session 是 reviewer」反而没有落点。

## 选项

- **A. 角色定义 = 产品内的数据文件,mount 时变成一条 `echo:inline-agent` extension。** 产品与 ABI 不动。
- **B. 角色定义 = 一条 extension bundle。** 写角色要写代码。
- **C. 另立 `AgentTemplate` 类型。** 与 extension 并行的第二套注册机制。

## 决定

**A**(2026-09-07 用户拍板:「我们的这个 agent 就是走的 extension,这样做就对了。然后这个 agent 可以选择性的去替代」)。

**形态在 [会话与 agent 集群](../../design/sessions.md) §4**——文件长什么样、三个来源与撞名优先级、能替代哪三样、挂载怎么走、要开的两个 registry 口、`restrict` 与延迟工具怎么叠,都在那里,本条不复述。实现照 §4 做。

选 A 而不是 B / C 的理由:角色是**数据不是代码**(写一个 reviewer 不该要写 TypeScript),而「把数据在 mount 时变成一条 extension」是仓里已有的先例(`agent.tools` → `echo:inline-tools`),所以不必为它另立一套注册机制——C 的代价正是第二套机制会与 extension 并行、迟早分叉。B 保住了机制唯一,但把写角色的门槛抬到写代码,与「产品内的一个角色」这个定位不符。

**从 [agent 是 extension](2026-09-03-agent-is-an-extension.md) 撤回的**:ABI 不加 `extensions` 字段;echo-agent / echo-coding 不写成 bundle;`Product` 与 `preset` 不动。**留下的**:inline → `echo:inline-agent`、不越权、快照权威只能收紧。

**待拍板**(本次未议):`subagent` 工具(`packages/core/src/subagent/tool.ts`,今天由模型逐次给 `system` / `tools`)要不要也接受角色名,让「派一个 reviewer 子 agent」和「开一段 reviewer session」用同一份定义。

## 验收

`<workspace>/.echo/agents/reviewer.md` 存在时,`session_create({ agent: "reviewer", … })` 建出的段 meta 里存着整份定义,其 provider 请求的 system prompt 以该文件正文为 identity、其余段与产品相同,工具菜单恰好是 `tools` 列出的那几件;`tools` 列了池外的名字则判红、盘上不建目录;卸载 `echo:inline-agent` 后产品的 identity 段与工具工作集复原;`AgentPrompt.section()` 不带 `replace` 时同名仍 fail-loud;`Product` 类型与 `ExtensionDefinition` 类型不变。
