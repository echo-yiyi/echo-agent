# agent 是身份，session 是它的一次运行实例：一个 agent 可以有多个 session

> 状态：implemented · 提出 2026-09-07 · 拍板 2026-09-07（口头，文档改完即移入 implemented）· 修正 [session 的身份三件](../proposed/2026-09-07-session-identity.md) 词表那一段与 [会话与 agent 集群](../../design/sessions.md) §1 的等号 · 挪入 implemented 2026-09-09（对照代码核过验收）

## 现状（拍板前）

文档把 agent 与 session 说成同一个东西的两个视角：

- `CONTEXT.md` 的 **session** 词条：「session 与运行中的 agent 是同一个实体的两个视角。」
- [会话与 agent 集群](../../design/sessions.md) §1 术语表：「**session = 运行中的 agent**，两个词指同一个实体，从盘上看叫 session，从运行时看叫 agent」，同表尾「`Agent` 类……类是运行中的 session」。
- 同文导读「最终形态」：「一段 session 就是一个独立的 agent」。

这三处把关系压成了 **1 : 1**，于是 findjob 那类场景只能这么数：10 个 HR = 10 段 session。用户 2026-09-07 指出这与他要的形态有出入：**「我可以 1 个 hr，有两个 session，session 的身份才是 agent 的概念」**。

同一表格里的 OS 类比（agent 定义 = 程序，session = 进程）本来就是 1 : N，与那三句自相矛盾——一份程序当然可以有多个进程。

## 不拍板的代价

「一个 agent 一个 session」会顺着往下长出错的东西：清单按 session 数当 agent 数、`session_list` 被当成「有哪些 agent」、多开一段对话被理解成多了一个人格。等这些写进产品面再改，代价就不是三句话了。

## 选项

- **A. agent = 身份，session = 它的一次运行实例（1 : N）。** `SessionInfo.agent` 指向的那个东西才是 agent；session 自己不是 agent。
- **B. 维持 1 : 1，多段对话叫别的名字。** 得为「同一个 HR 的第二段对话」再造一个词，而它在盘上、协议上与 session 毫无区别。
- **C. 不定义，两种说法并存。** 术语有两个真源，agent 实现时按哪句猜都合理。

## 决定

**A**（2026-09-07 用户拍板）。具体：

- **agent** 是身份：一份 agent 定义（identity 段、工具子集、模型缺省）加上它的名字。10 个 HR = 10 个 agent。
- **session** 是某个 agent 的**一次运行实例**：盘上一个目录，运行时一个 `Agent` 类实例。同一个 agent 可以同时有多段 session（跟同一个 HR 的两条并行对话）。
- **`Agent` 类是 session 的运行时，不是 agent**。类名不改（改名的代价远大于收益），但文档不得再说「类是运行中的 agent」。
- OS 类比不变，且从此自洽：agent 定义 = 程序，session = 进程，容器 = 机器。**程序 : 进程 = 1 : N**。
- 代码形状**一行不改**：`SessionInfo.agent: AgentRef` 记的正是「这一段属于哪个 agent」，`product` 记「哪个产品开的」，两维都已就位。这次修的是文档把两个概念说成了一个。

## 待拍板（本次未议）

**agent 这个身份有没有跨 session 的持久状态？** 即：同一个 HR 的两段 session 要不要共享一份「我跟这个候选人聊到哪了」。

- 不要 → agent 就是「定义 + 名字」，两段 session 各记各的，作用域仍是 session / project / user 三层，`AgentRef.name` 保持「只是来历，权威是 `definition` 快照」。
- 要 → 得在三层之外多一层 **agent 作用域**（形状上会长回一个 `<ECHO_HOME>/agents/<name>/`，含义与 2026-09-01 那版状态根无关），并且 `AgentRef.name` 从「来历」变成**外键**，那条注释要反过来。

这条不定，`--resume` 与 `session_create` 的行为一个字都不用改；定了之后才动记忆那条线。

## 验收

`CONTEXT.md` 与 [会话与 agent 集群](../../design/sessions.md) 里搜不到「session = 运行中的 agent」「同一个实体的两个视角」「一段 session 就是一个独立的 agent」这三种说法；术语表的 session 一行明说 1 : N；上面那条「待拍板」出现在 sessions.md 的待拍板段里，不是散落在正文。

**实现注（2026-09-10）。** 上面那条「待拍板」已由 [记忆的作用域由产品声明](2026-09-07-memory-scopes-by-product.md) 定为「要」：缺省作用域里有 role 层，锚在 `<ECHO_HOME>/agents/<名字>/memory/`，`AgentRef.name` 于是成了个人记忆的外键。

运行中造**新的具名身份**不用重启、不用先落定义文件：`sessions.create({ agent: { name, definition } })`，模型面的 `session_create` 在 inline 定义里带 `name` 即可。名字必须过 `isValidAgentName`（字母或数字开头，其后只有字母、数字、`.`、`_`、`-`，最长 64——它会成为目录名，放宽了 `a/b` 与 `a_b` 会落进同一个目录），且不能与已注册的具名定义撞名（同名两份定义会共用一份记忆却各说各的）。同名再开一段就是同一个身份，共享个人记忆；越权检查（`tools` 只能收紧）照旧。没注册过的**名字字符串**仍然判红——那是「点名一个已有定义」，不是「造一个」。
