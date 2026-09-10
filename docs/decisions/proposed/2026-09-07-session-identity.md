# session 的身份三件：`product`（哪个产品开的）、`agent`（角色）、`main`；`agentId` / `agentName` 退场

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 来源 2026-09-07 领域模型 review · 补 [角色定义](../implemented/2026-09-07-role-agent.md)、[main 与状态](2026-09-03-main-and-status.md)

## 现状(拍板前)

`SessionInfo.agent` 存的是产品名字符串(`packages/core/src/create-echo.ts` 里 `agent: opts.agentName ?? opts.agentId ?? "default"`),`--continue` 靠它挑「本产品在本目录的最近一段」。`agentId`(缺省 `default`)只剩一个用途:lease holder 的显示标识 `agent:${agentId}`;`agentName` 缺省等于 `agentId`。「agent」这个词于是同时指运行实例、产品名、holder 标识、角色定义、壳协议五件事。

[角色定义](../implemented/2026-09-07-role-agent.md) 落地后 `SessionInfo.agent` 变成 `AgentRef`(角色),产品名就没了位置——而它必须有:同一目录里 echo-agent 与 echo-coding 各开过会话,`--continue` 只该挑自己产品的(2026-09-07 用户:「coding agent 是我们的产品,开的 session 里面的前端 coding、代码 review 都是角色」)。

## 不拍板的代价

要么把产品名塞回 `agent` 字段和角色打架,要么 `--continue` 丢掉产品这一维,两个产品在同一目录互相续到对方的对话。

## 选项

- **A. `SessionInfo` 加 `product` 字段,`agent` 只放角色;`agentId` / `agentName` 退场。**
- **B. `agent` 字段存 `${product}/${role}` 拼串。** 一个字段两个事实,筛选要拆字符串。
- **C. 产品名不进 meta,靠状态根分目录。** 与「状态根 = session 目录」冲突。

## 决定

**A**(2026-09-07 用户拍板):产品名从 `agent` 字段挪进新的 `product` 字段,`agent` 只放角色;`agentId` / `agentName` 退场,lease holder 标识改成 `${product}:${sessionId}`。

**`SessionInfo` 的形状与 `--continue` 的筛选条件在 [会话与 agent 集群](../../design/sessions.md) §3**,本条不复述。

选 A 而不是 B / C 的理由:产品与角色是**两个事实**——「谁开的这一段」与「这一段扮演谁」,B 把它们拼成一个字符串,筛选时要拆字符串,而拆串是漂移的常见来源;C 想靠目录分产品,与「状态根 = session 目录」直接冲突,一段 session 的目录已经由它自己的 id 定了。

附带一条不改代码但要守的:词表里「agent」从此只剩两个意思——运行中的 session(`Agent` 类,内部化后仓外看不到)与 agent 定义(角色);产品、lease holder、壳协议各用自己的词,不再共用「agent」。

## 验收

新建段的 `meta.json` 有 `product`;同一目录先后用 echo-agent 与 echo-coding 各开一段,各自 `--continue` 挑到自己的那段;API 快照与 `CreateAgentOptions` 里没有 `agentId` / `agentName`;`.lock` 文件的 holder 字段形如 `echo-coding:<sessionId>`;`packages/core/src/session/types.ts` 的 `SessionInfo` 与 sessions.md §3 的类型块逐字一致。
