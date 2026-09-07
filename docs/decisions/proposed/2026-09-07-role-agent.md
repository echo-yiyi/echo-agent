# session 的 agent 定义是产品内的一个角色，走 extension 挂载，可选择性替代 identity / 工具子集 / 模型

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 来源 [会话与 agent 集群](../../design/sessions.md) §4 · 修正 [agent 是 extension](2026-09-03-agent-is-an-extension.md)(产品打包成 bundle 那一半撤回)

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

**形状**,照 skill 的样子,一个 markdown 文件、frontmatter 带字段,正文就是 identity:

```md
---
name: reviewer
description: 只读审查,不改代码
tools: [read_file, grep, glob, bash]     # 必须 ⊆ 产品的工具池
model: kimi-k3                            # 可省,缺省用产品的
---
你是代码审查员。……
```

**来源三处,按优先级合并**:产品自带(echo-coding 可以自带 reviewer)、user 层 `~/.echo/agents/`、项目层 `<workspace>/.echo/agents/`(放仓库里、随 git 走——角色是人写给 agent 的,与项目指令文件同一条规矩)。

**能替代什么,各自可选,没给的项产品原样生效**:identity 段**替换**产品的 identity(纪律段、工具习惯段照旧);`tools` 是产品工具池的子集,只能少不能多;`model` 可选。权限策略不让角色改,继承产品的。任何其他 prompt 段不可替换——纪律段和工具习惯段是产品对自己工具的承诺,角色换掉它们等于换了产品;真有需要再按 registry 那条规矩开。

**mount** 走已有先例(`echo:inline-tools`):定义在 mount 时变成一条 `echo:inline-agent`,`apply()` 里三行——有 identity 就 `section(identity, { replace: true })`,有 tools 就 `restrict(tools)`,有 model 就走 `setModel`。为此在现有 registry 上开两个最小的口,都带 disposer、卸载复原:

```ts
import type { PromptSection } from "@echo-agent/core";
type Disposer = () => void;

interface AgentPromptRegistry {
  /** replace:同名存在才成功,disposer 把原来那段放回去;不给 replace 照旧同名 fail-loud。 */
  section(section: PromptSection, opts?: { replace: true }): Disposer;
}
interface AgentToolsRegistry {
  /** 工作集 = 池 ∩ names,只能收紧;disposer 解除。池不动,别的 extension 照常注册。 */
  restrict(names: ReadonlySet<string>): Disposer;
}
```

角色就是 registry 注释里等的那个「真实消费者」。

**`session_create` 的 `agent` 参数回来**:`agent: "reviewer" | { identity, tools?, model? }`,按名从上面三处找,找不到判红。不越权与快照权威两条沿用 2026-09-03 的记录:`tools` ⊆ 创建者当前工具集在 core 的 `sessions.create` 里验;通过的定义整份存进 meta,`--resume` 用「快照 ∩ 容器此刻的工具」,不需要按名找任何东西,名字只是来历。

**从 2026-09-03 记录撤回的**:ABI 不加 `extensions` 字段;echo-agent / echo-coding 不写成 bundle;`Product` 与 `preset` 不动。**留下的**:inline → `echo:inline-agent`、不越权、快照权威只能收紧。

**待拍板**(本次未议):`subagent` 工具(`packages/core/src/subagent/tool.ts`,今天由模型逐次给 `system` / `tools`)要不要也接受角色名,让「派一个 reviewer 子 agent」和「开一段 reviewer session」用同一份定义。

## 验收

`<workspace>/.echo/agents/reviewer.md` 存在时,`session_create({ agent: "reviewer", … })` 建出的段 meta 里存着整份定义,其 provider 请求的 system prompt 以该文件正文为 identity、其余段与产品相同,工具菜单恰好是 `tools` 列出的那几件;`tools` 列了池外的名字则判红、盘上不建目录;卸载 `echo:inline-agent` 后产品的 identity 段与工具工作集复原;`AgentPrompt.section()` 不带 `replace` 时同名仍 fail-loud;`Product` 类型与 `ExtensionDefinition` 类型不变。
