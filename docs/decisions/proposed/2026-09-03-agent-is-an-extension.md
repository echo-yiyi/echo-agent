# agent 定义是一个 extension(可打包别的),session 按名或 inline 引用;inline 不越权

> 状态:proposed · 提出 2026-09-03 · 拍板 2026-09-03(口头,实现后移入 implemented) · **修正 2026-09-07**:产品打包成 bundle 那一半撤回,agent 定义是产品内的角色,见 [角色定义](2026-09-07-role-agent.md) · 来源 [会话与 agent 集群](../../design/sessions.md) §4

## 现状(拍板前)

echo-coding 是 `Product.preset` 返回的一组 `ExtensionEntry`(`packages/coding/src/agent.ts` 的 `codingPreset`),不是一个 extension,按名引用不了;`SessionInfo.agent` 是产品名字符串,只用来给 `--continue` 筛选。一段 session「是谁、会什么」没有可持久化、可重挂的表示。

## 不拍板的代价

agent 要自己开一段「特殊的」session(比如 reviewer),没有任何东西能表达「这段挂什么」;另立一个模版类型就是第二套注册机制,和 extension 并行、迟早分叉。

## 选项

- **A. agent 定义 = extension,ABI 加 `extensions` 字段让 extension 能打包别的。** echo-agent / echo-coding 各写成一个 bundle;inline 定义(identity、extensions、tools、model)在 mount 时变成 `echo:inline-agent`,走 `echo:inline-tools` 的先例;定义整份存进 meta,`--resume` 重挂。
- **B. core 收一张 `name → ExtensionEntry[]` 表。** `Product` 往表里登记,不改 ABI;inline 同 A。
- **C. 另立 `AgentTemplate` 类型。** 名字、extension 列表、模型、权限,与 extension 并行。

## 决定

**A**(2026-09-03 用户拍板:「agent 也是一个 extension」;「开 session 不一定拿模版实例,也可能按自己的想法去创建」)。附带一条不变量,在 core 的 `sessions.create` 里验、不靠工具自觉:inline 的 `tools` ⊆ 创建者当前工具集,`extensions` ⊆ 创建者已挂的,权限策略继承不放宽;违反判红、盘上不建目录。检查只在创建那一刻做,通过的定义是**创建期快照、持久化后权威、只能收紧**:`--resume` 时工具集取「快照 ∩ 容器此刻能提供的」,不回头看创建者(它可能已经 closed),任何路径都不能比快照更宽。

## 修正(2026-09-07)

上面的 A 把「agent 定义」当成了产品级(echo-agent / echo-coding 各写成一个 bundle)。用户 2026-09-07 指出这是误解:产品是容器级的事,session 挂的 agent 定义是**产品内的一个角色**(reviewer、前端、缺省),对应 Claude Code 的 subagent 定义。于是 **撤回**:ABI 加 `extensions` 字段、echo-agent / echo-coding 写成 bundle、`Product.preset` 退场这三句。**留下**:inline 定义 mount 时变成 `echo:inline-agent`、不越权、快照权威只能收紧。角色的形状、来源、能替代什么,见 [角色定义](2026-09-07-role-agent.md);本条的验收以那条为准。

## 验收(2026-09-07 前的原文,已由角色定义那条取代)

`extensions` 字段打包的 extension 按拓扑先装、逆序卸,任一失败整代回滚(沿用 `ExtensionHost` 的全有或全无);`--resume` 一段 inline 定义的 session,工具表与 identity 段和创建时逐字相同;inline 点名创建者池外的工具,`create` 判红、`~/.echo/sessions/` 下不多目录。
