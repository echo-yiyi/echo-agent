# 会话（Session）与 agent 集群

> 状态：设计 2026-09-03 口头拍板，2026-09-07 修正 §4（agent 定义是产品内的角色，不是产品打包）。**§9 的第 1、3、4 步已实现并合入 main**（布局 / 通道 / 工具，加会话命名）；第 5 步（壳）实现了看与切两半（`/sessions`、`/resume`），`/clear` 落盘那半还没做；第 2 步（角色定义）未做；记忆三层 2026-09-07 已实现（那一条的决策记录随之移入 `implemented/`）——逐条见 §9。其余决策记录留在 `docs/decisions/proposed/` 直到各自实现完再移入 `implemented/`（花名册注释里 proposed 的定义是「提出到实现之间」）<br>
> 读者：要实现会话面、给产品接会话工具、把 echo 嵌进常驻程序（多段会话同时工作）的人<br>
> 假设已读：[Lifecycle 与 Run Loop](lifecycle-and-run-loop.md) 的实例生命周期与 admission；[Context 与 Message Flow](context-and-message-flow.md) 的 transcript / working context 术语；[Compaction](compaction.md) 的「策略是 extension、状态在 core」这条分法——本文对会话用同一条<br>
> 决策记录（八条，本文只指向，不复述论证。状态见各自文件头，`implemented/` 的已落地）：[状态根 = session 目录](../decisions/implemented/2026-09-03-session-is-the-state-root.md) · [记忆三级作用域](../decisions/implemented/2026-09-03-memory-three-scopes.md) · [会话对等、通道是 inbox](../decisions/proposed/2026-09-03-sessions-are-peers.md) · [main 与状态](../decisions/proposed/2026-09-03-main-and-status.md) · [人优先，后台让位](../decisions/implemented/2026-09-07-preemptible-lease.md) · [agent 定义 = 产品内的角色](../decisions/implemented/2026-09-07-role-agent.md) · [session 的身份三件](../decisions/proposed/2026-09-07-session-identity.md) · [agent 是身份，session 是它的实例](../decisions/implemented/2026-09-07-agent-is-an-identity.md)
>
> 被后来的记录**改掉了一半**、读的时候要连着后一条看：[agent 是 extension](../decisions/implemented/2026-09-03-agent-is-an-extension.md)（产品打包成 bundle 那一半由 [agent 定义 = 产品内的角色](../decisions/implemented/2026-09-07-role-agent.md) 撤回）

## 导读

**解决什么。** 今天一个 `Agent` 实例绑死一段会话、一把锁锁整个状态根（`~/.echo/agents/default/.lock`），于是：同一台机器上两个 echo-coding 同时起不来（第二个拿不到锁直接 fail-loud）；会话之间没有任何通道；`Agent` 上的 `newSession` / `loadSession` 走的是旧 `SessionManager`，生产装配只注入 `SessionService`，一调就抛；`/clear` 只清内存、不落盘，`--resume` 会把清掉的对话整个带回来。用户要的形态是一个 **agent 集群**：agent 能自己开会话，会话之间能互发消息，既能在终端里各起各的进程，也能嵌进一个常驻程序里同时跟几十个对象聊。

**最终形态。** 一段 session 是某个 agent 的一次运行实例，和操作系统里的进程是同一个抽象：有 id、有它跑的程序（agent 定义，是一个 extension）、有 cwd（workspace）、有内存（transcript）、有邮箱（inbox）、能被列出、能被关掉。**一个 agent 可以有多段 session**——10 个 HR 是 10 个 agent，跟其中一个的两条并行对话是那一个 agent 的两段（[agent 是身份](../decisions/implemented/2026-09-07-agent-is-an-identity.md)）。**状态根就是 session 目录**，今天按状态根一份的东西（lease、inbox、tasks、schedule、dream、observability）自动变成按 session 一份，代码不动。跨 session 共享的只有 memory 与 skills，提到 project / user 两层。会话之间的通道是 inbox 落盘：发消息 = 往对方目录写一条 record，同进程与跨进程一条路。**core 不管进程**：谁把一段 session 跑起来（终端里人起的、常驻程序在进程内起的、产品自己 spawn 的）是容器的事。会话的用法（四个工具、等回信、命名、筛选、agent 打包、起进程）全是 extension；会话的盘与协议（布局、lease、inbox、状态、不越权）在 core。

**Non-Goals（已决，不做）。**

- 父子会话、子 agent 树、阻塞式委派工具。只有对等会话；「发了就等回信」是通道上的 `wait`，不是父子。（2026-09-06 补：短命的「派个活出去等结果」由 `subagent` 工具覆盖，那是进程内的子循环，不是 session。）
- **留言**：给一段没有宿主的会话发消息。2026-09-07 拍板按虚拟 actor 走——发消息先把它叫醒，叫不醒就如实拒绝，见 §5。
- core 起进程、管进程、重启崩溃的进程。产品要就自己出一个 extension。
- 跨进程把别的 session 的事件流拉到本进程的壳上（IPC）。壳只 attach 自己容器里的 session。
- 分支会话（pi 的 `/tree` `/fork`）。entry 的 `parentId` 保持树形状，不提供分支命令。
- 会话调度器。一个容器里同时跑几段模型调用只给一个并发上限，不做优先级。
- 记忆从 session 级往 project / user 级的自动提升。选哪一层由模型写路径前缀决定，dream 不跨级。
- memory 目录的多写者保护（多段 session 同时往 project 级记）。归 memory 线，本文只定作用域。
- 会话的回收（GC / TTL）。`closed` 的段留在盘上；不会跑的段靠 §7 的挂载条件与 runner 失败判红不产生，而不是事后清。

**待拍板。** 一条：**agent 这个身份有没有跨 session 的持久状态**——同一个 HR 的两段 session 要不要共享一份「我跟这个候选人聊到哪了」。不要 = agent 就是「定义 + 名字」，作用域仍是 session / project / user 三层；要 = 三层之外多一层 agent 作用域，`AgentRef.name` 也从「来历」变成外键。两条后果与判据见 [agent 是身份](../decisions/implemented/2026-09-07-agent-is-an-identity.md) 的「待拍板」。**这条不定，`--resume` 与 `session_create` 的行为一个字都不用改**；定了才动记忆那条线。

其余的：记忆三层怎么切 2026-09-07 拍了：模块（`agent.md` / `user.md` / 笔记索引）与作用域（session / project / user）分开，哪层放什么、注入什么、怎么选层、什么顺序落地，全在 [记忆三级作用域](../decisions/implemented/2026-09-03-memory-three-scopes.md) 的「切法」一段，2026-09-07 已实现。dream 的计数与锁跟着整理范围下到 session 层，「两段 session 同时整理同一份」于是不再成立。

其余五项决策已拍（2026-09-03，口头；§4 那条 2026-09-07 修正），见决策记录。

**验收判据（机器可判）。** 见 §10。核心四条：同一台机器两段 session 各自的进程同时 `start()` 都成功；A 进程 `session_send` 之后 B 进程不重启就在下一轮看到那条 environment 消息；非 main 的 session 工具表里没有 `session_create`；inline 定义点名了创建者当前工具集之外的工具，`create` 判红、盘上不建目录。

## 1. 术语（只定义一次，全文同一个词）

> 规范词表在仓库根 [CONTEXT.md](../../CONTEXT.md)；本表只列本文用到的，定义以那里为准。

| 词 | 指什么 | 对应操作系统的词 |
|---|---|---|
| **agent（定义）** | **一个身份**：identity 段、工具子集、模型缺省，加上它的名字（2026-09-07 两次修正，见 [agent 是身份](../decisions/implemented/2026-09-07-agent-is-an-identity.md)）。产品内的角色（reviewer、前端）是它，findjob 里的一个 HR 也是它；现写的 inline 定义同样是。**产品本身不是 agent**，它是容器级的事。挂载时变成一条 extension（§4） | 程序 |
| **session** | 某个 agent 的**一次运行实例**：盘上一个目录，运行时一个 `Agent` 类实例。**一个 agent 可以有多段 session**（跟同一个 HR 的两条并行对话 = 那一个 agent 的两段），所以 10 个 HR 是 10 个 agent、不是 10 段 session | 进程 |
| **容器** | 一个 OS 进程，装一个或多个 session。终端里的 echo-coding 装一个；findjob 这类常驻程序装几十个 | 机器 |
| **产品** | 容器跑的那个：echo-agent、echo-coding、findjob。一段 session 记着自己是哪个产品开的（`product`），角色在它之下 | 发行版 |
| **main** | 容器起的 session（人起的、宿主程序起的）。`session_create` 建出来的都不是 main | init 起的进程 |
| **作用域** | session / project / user 三层目录，见 §2 | 进程私有 / 项目共享 / 用户共享 |

**类比是 1 : N，别再压成 1 : 1**：一份程序可以有多个进程，一个 agent 可以有多段 session。

`Agent` 类不改名，`SessionInfo.agent` 字段不改名：**类是一段 session 的运行时**（不是 agent），字段是这一段属于哪个 agent。

## 2. 作用域

| 作用域 | 目录 | 放什么 | 共享面 |
|---|---|---|---|
| **session** | `~/.echo/sessions/<id>/` | meta、transcript、inbox、tasks、schedule、lease、status、observability | 只有这段 session 自己写 |
| **project** | `~/.echo/projects/<hash>/`，`hash = fnv1a64hex(workspace)` 前 12 位 | project 级 memory（**缺省**声明，见下）；以后可加项目级 agent 定义 / skill | 同一 workspace 的所有 session |
| **user** | `~/.echo/` | credentials、settings、extensions、skills、agent 定义（`agents/<角色名>/`，角色记忆也住这里）、user 级 memory | 全部 session |

project 一层**存 home 下、按 workspace 分**，不放进仓库：agent 自动写的东西不该进 git，也不该要求每个仓库改 `.gitignore`。哈希只有 48 位，撞了就是两个项目的记忆混在一起而没人发现，所以 project 目录里放一份 `workspace.json` 记原路径，打开时对一遍，不匹配判红。项目指令文件（AGENTS.md / CLAUDE.md）仍从 workspace 里读（prompt 决策 7），那是人写给 agent 的，方向相反。

三层里唯一的共享写方是 project / user 级 memory：多段 session 同时往同一层记。dream 只整理 session 自己那份，不碰上两层，所以整理不冲突；上两层的并发写归 memory 线（Non-Goals）。

**记忆的作用域由产品声明，core 不认识任何具体层名**（2026-09-07 拍板，2026-09-08 实现；替代本节原先那套写死的三层，见 [作用域由产品声明](../decisions/implemented/2026-09-07-memory-scopes-by-product.md)）。不同产品要的分层本来就不一样：coding 要 user / role / project，常驻产品要产品级 / role——它根本没有"这台机器的用户"这个概念。core 只定义"作用域"这个位置：一个有序的、各带一个根的命名集合；名字、前缀、有几层由产品在装配期声明，声明是**纯数据**（锚点闭合、`{{}}` 变量闭合、名字开放）。

**缺省三层**（`DEFAULT_MEMORY_SCOPES`，在装配层而不是 `memory/`）：`user` → `<ECHO_HOME>/memory/`；`project` → `<ECHO_HOME>/projects/{{workspaceHash}}/memory/`（带 `workspace.json` 留痕与撞车校验）；`role` → `<ECHO_HOME>/agents/<角色名>/memory/`——**与角色定义同一棵树**，定义和记忆不分家。`AgentRef.name` 可选，**没有角色名就没有这一层**。

**模块与作用域仍是两个轴**，不是笛卡尔积。模块（原先叫"模块"）是"记的是什么"（`agent.md` / `user.md` / 笔记与它的 `INDEX.md`），作用域是"谁看得见"。模块**不点名 `scopes` = 当前装配的每一层都有**——内建那三个都不点名，core 里因此一个具体层名都不出现；点名了就只在点到的层，点到不存在的层在绑定时 fail-loud。

**选层走路径前缀**（`<层名>/<模块内路径>`），`memory` 工具不加参数；注入的每段带自己的路径，模型改哪份就写哪个路径。system 里那段选层说明**从作用域表生成**：按 `order`（同时是宽度序，小 = 宽）列出每层的 `describe`。

**作用域不在装配期解析**：workspace、角色、产品都是 session 级事实，`--resume` 一段在别的目录、别的角色下建的会话时，权威值要到 `start()` 里 `createOrResume` 返回才知道。所以装配期给的是一个还没绑定的字节面（读写都抛），`start()` 里 session 恢复之后解析一次、绑定一次，之后不变。运行中的 `setWorkspace()` 想跟也跟不了——**结构上没有第二个解析入口**，这条纪律不再建立在调用点自觉上。

实现落点：作用域的声明与路由在 [`memoryScopeDir()`](../../packages/core/src/memory/scope.ts#symbol=memoryScopeDir)，延迟绑定在 [`lateBoundMemoryDir()`](../../packages/core/src/memory/scope.ts#symbol=lateBoundMemoryDir)，`workspace.json` 的校验在 [`assertProjectWorkspace()`](../../packages/core/src/memory/scope.ts#symbol=assertProjectWorkspace)，缺省声明与锚点解析在 `createAgent` 的 `prepareCapabilities` 里。

**共享层的并发写**由记忆自己的文件锁管（进程内串行 + 跨进程乐观校验，见 [记忆的并发](../decisions/implemented/2026-09-07-memory-concurrency.md)），不再是"先接受后写覆盖"。dream 现在**按层各整理各的**，整理哪些模块由模块自己声明。

`ECHO_HOME` 覆盖 `~/.echo`，与今天的 [`resolveStateDir()`](../../packages/core/src/create-agent.ts#symbol=resolveStateDir) 同一个来源；`agents/<agentId>/` 这一层退场，session 的 meta 里记着自己是哪个 agent。

## 3. session 在盘上

```
~/.echo/sessions/<id>/
  meta.json          SessionInfo（下面）
  entries/000001.json  transcript 账本，一条一文件（今天的形状，不变）
  inbox/000001.json  入站 record；inbox/acks/ 是 ack marker（今天的形状，不变）
  tasks.json
  schedule/
  memory/            session 级记忆（`memory/memory/` 是笔记模块，`memory/.dream/` 是整理的计数与锁）
  .lock              lease，每段一把
  status.json        运行态快照（§6）
  observability/
```

**已实现**（2026-09-03）：meta 与 entries 在目录根，`SessionService` 一个实例管一段（同一个 store 上开第二个 id 判红）；清单是自由函数 [`listSessions()`](../../packages/core/src/session/service.ts#symbol=listSessions)，扫的是上一层；坏档判红、序号连续、parent 链、compaction 投影一行没动。`memory/`（session 级记忆，含 dream 的计数与锁）2026-09-07 随记忆三层补上；`status.json` 见 §6。

```ts
type AgentRef =
  | { readonly kind: "named"; readonly name: string }
  | {
      readonly kind: "inline";
      readonly identity: string;
      readonly tools?: readonly string[];
      readonly model?: string;
    };

type SessionInfo = {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  readonly product: string;
  readonly agent: AgentRef;
  readonly main: boolean;
  readonly status: "active" | "closed";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
};
```

相对今天的 [`SessionInfo`](../../packages/core/src/session/types.ts#symbol=SessionInfo)：产品名从 `agent` 字段挪到新的 `product` 字段（容器给，创建时写）；`agent` 变成 `AgentRef`（`named` 引用一个角色文件、`inline` 现写；2026-09-07 起没有 `extensions` 字段，角色不打包 extension）；加 `main`、`status`。`--continue` 的筛选条件「本产品在本目录的最近一段」= `workspace` 相同、`product` 相同、`main` 为真、`status` 为 active。`agentId` / `agentName` 随之退场，见 [session 的身份](../decisions/proposed/2026-09-07-session-identity.md)。

三条不变量沿用：**每段一个写者**（lease）、**坏档判红不给半截**、**transcript 只增不改**。两条新规矩：

- **活着就找得到，空段收摊时撤掉**（2026-09-04 改）。meta 在 `createOrResume` 那一刻就写，所以一段**正开着**的 session 立刻在清单里、也发得进消息；「不留空段」由 `stop()` 兜底：这一段一条 entry 都没写过、inbox 里也没有待消费的记录，就把 `meta.json` 与 `status.json` 撤掉，它便不再进任何清单，`--resume` 它等于「没有这一段」。三道闸（2026-09-07 review 补齐）：inbox 那道**按盘上判**——撤之前重扫一次 `inbox/`，内存计数看不见别的进程刚投进来的那条；**仍持有 lease** 才撤——丢锁后 meta 已经是接班者的，`SessionService` 封存后一个字都不撤，连目录一起清的那步也只有写入格仍 installed 时才做；`inbox/` 里还有文件也不清目录。重扫与撤 meta 之间仍有一个微秒级窗口，登记为已知。

  **原来的做法（把 meta 推迟到第一次 `append`）是错的**，实测：B 正开着、还没说过话时，A 的 `session_list` 里没有它、`session_send` 给它是 `not-found`——「打开第二个终端、从第一个带句话过去」这一步直接断掉。目标（列表不被空段塞满）没变，换了个不会误伤活人的做法。
- **名字来自第一句人话的首行**（截 60 字，已实现 2026-09-07）。core 只出 `SessionService.rename()` 与 `Agent.renameSession()`；命名策略是**装配层挂的一个钩子**（`createEcho` 里的 `echo:session-name`），挂在 `userPromptSubmit` 上——那个挂点直接带 `text` 与 `source`，比 `message_end` 少一层「哪条才是人说的」的判断。

  只在**名字还是会话 id 时**动手，所以产品挂一个 `priority` 更小的钩子先改掉名字就能接管（要让模型起名就这么做）。被别的会话叫醒的那一轮也算 `human`（inbox 消费走同一条前台路），所以 `session_create` 派出去、模型没给名字的那一段会被它收到的第一条指令命名。

  **只改自己那一段**：别人那一段正开着时它的 meta 由它自己的 `SessionService` 拥有，从外面改下一次入账就被覆写回去——所以没有「改别人名字」这个口。

`create()` 出来的段同理立刻可见——它是**替别人建的**，runner 还没接手就已经查无此段是错的。

`/clear` 的语义改为：关掉当前一段（`status = closed`）、新建一段、壳 attach 过去。旧段留在盘上可 `--resume`。协议上的 `reset()` 因此没有消费者，删。**还没做**（反向：P3a `7d4237c` 先把 `reset()` 加进了协议，见 [记录](../decisions/implemented/2026-09-01-runtime-protocol-set-model-thinking-reset.md)；删它随第 5 步一起），代价见 §9 第 5 步。

**待拍板**：关段那一刻旧段 inbox 里还有没消费的 record 怎么办。closed 的段不收信、也不会再被消费，什么都不做等于**静默丢掉别人给你留的话**，而那正是「fail-loud、绝不静默降级」要拦的。提议：**把未消费的 record 转投到新建的那一段**——是同一个人、同一个 workspace 的延续，留言的人要的是「这话有人看」，不是「这话进了哪个目录」。转投走的是 §5 的普通投递路（新 record id、原文照抄、`ref` 指回原来那条），所以 at-least-once 不破。备选是「拒绝 `/clear` 直到 inbox 空」，但那让人按一个清屏键要等别人的消息被处理完，不合适。

## 4. agent 定义是产品内的角色

> 2026-09-07 修正。此前本节写的是「agent 定义 = extension bundle，echo-agent / echo-coding 各打成一个」，那是把产品当成了 agent 定义。决策记录：[角色定义](../decisions/implemented/2026-09-07-role-agent.md)；被修正的那条：[agent 是 extension](../decisions/implemented/2026-09-03-agent-is-an-extension.md)。

**产品是容器级的事**：一个 echo-coding 容器开出来的段全是 coding 方向。一段 session 挂的 agent 定义是**产品内的一个角色**——reviewer、前端、缺省——对应 Claude Code 的 subagent 定义。角色是数据，不是代码：一个 markdown 文件，frontmatter 带 `name` / `description` / `tools` / `model`，正文就是 identity。[`Product`](../../packages/base/src/product.ts#symbol=Product) 与 `preset` 不动，ABI 不加字段。

```md
---
name: reviewer
description: 只读审查，不改代码
tools: [read_file, grep, glob, bash]     # 必须 ⊆ 产品的工具池
model: kimi-k3                            # 可省，缺省用产品的
---
你是代码审查员。……
```

**来源三处，同名时离仓库越近越优先**：项目层 `<workspace>/.echo/agents/` > user 层 `~/.echo/agents/` > 产品自带。与项目指令文件（AGENTS.md / CLAUDE.md）同一个方向——角色是人写给 agent 的，具体仓库里那份最知道自己要什么。项目层放仓库里、随 git 走。

**能替代什么，各自可选，没给的项产品原样生效**：identity 段**替换**产品的 identity（纪律段、工具习惯段照旧）；`tools` 是产品工具池的子集，只能少不能多；`model` 可选。权限策略继承产品的，角色改不了。其他 prompt 段不可替换——它们是产品对自己工具的承诺。

**挂载走已有的先例**：`CreateEchoOptions` 今天把 `agent.tools` 变成一条内联 extension `echo:inline-tools`。角色（按名读到的文件，或 `AgentRef.kind === "inline"` 现写的）同样在 mount 时变成一条 `echo:inline-agent`，`apply()` 里三件事：有 identity 就替换 identity 段，有 `tools` 就收紧工作集，有 `model` 就换模型。定义整份存在 meta 里，`--resume` 原样重挂。**它是最后一代**（`boot:agent`，2026-09-10 修）：replace 要求产品的 identity 段已在，而产品的段来自 `opts.extensions`，所以角色必须排在那一代之后；判据见 [产品段先于角色挂](../../packages/core/test/create-echo.test.ts#test=产品经-extensions-给-identity-段-同时传-agentdefidentity角色替得上产品段必须先于-echoinline-agent-挂)。

为此在现有 registry 上开两个最小的口，都带 disposer、卸载复原。角色就是 `registries.ts` 注释里等的那个「受控 replace 的真实消费者」：

```ts
import type { PromptSection } from "@echo-agent/core";
type Disposer = () => void;

interface AgentPromptRegistry {
  /** replace：同名存在才成功，disposer 把原来那段放回去；不给 replace 照旧同名 fail-loud。 */
  section(section: PromptSection, opts?: { replace: true }): Disposer;
}
interface AgentToolsRegistry {
  /** 工作集 = 池 ∩ names，只能收紧；disposer 解除。池不动，别的 extension 照常注册。 */
  restrict(names: ReadonlySet<string>): Disposer;
}
```

**`restrict` 与延迟工具叠在一起**：先收紧、再按 `deferred` 过滤，两道都作用在工作集上。所以角色白名单外的工具，模型用 `tool_search` 既查不到也取不出——`tool_search` 看的是工作集，不是池。

**不越权**（core 的 `sessions.create` 里验，不靠工具自觉）：角色的 `tools` 必须是创建者当前工具集的子集，权限策略继承创建者的、不能放宽。违反判红，盘上不建目录。「当前工具集」是 [`AgentState.tools`](../../packages/core/src/agent.ts#symbol=AgentState.tools)：池里没被禁用、且过了角色收紧的那些，**不是池**——比池的话，被收紧过的段能派出比自己更宽的段，收紧就成了摆设。延迟工具取没取过都算在内：创建者随时能经 `tool_search` 取来。

**快照权威、只能收紧。** 检查在创建那一刻做一次，通过的定义整份存进 meta，之后它就是这段 session 的权威定义，不再回头看创建者（创建者可能已经 closed）。`--resume` 时工具集取「快照 ∩ 容器此刻能提供的」，只会更小；快照里有、容器没有的工具不挂、不报错。任何路径都不能让它比快照更宽。

## 5. 会话间通道：inbox

会话之间只有一种通信：**往对方的 inbox 写一条 record**。inbox 的语义今天就是「外面发生了一件事 → 入队，不打断正在跑的任务，回 idle 后开一轮」（`packages/core/src/agent.ts` 的 `deliver()` 与 inbox 那段注释），落盘形状是 [`InboxStore`](../../packages/core/src/inbox/store.ts#symbol=InboxStore) 的 record + ack marker、at-least-once。跨 session 发消息不需要新协议，需要四处改动：

1. **inbox 按 session 一份。** 状态根变成 session 目录之后自动成立。
2. **record id 由写者生成**（已实现）。此前 record id 是 `InboxStore` 集中分配的六位序号（`nextSeq`，restore 时从盘上校准一次、之后只在内存里递增）。写者从 1 变成 N 之后，两个进程各自校准、各自递增，会发到同一个 `000006.json`；`FileDir.write` 是 tmp + rename，后到的**静默覆盖**先到的，at-least-once 直接变成无声丢失。现在的形状是 `<12 位十六进制毫秒>-<4 位同毫秒计数><12 位十六进制随机>`：文件名仍字典序 = 时间序，同一个写者严格递增（保序不因换 id 而破），不同写者在同一毫秒靠随机段区分，任何写者不读目录就能发号。发号器在 `InboxStore` 实例上而不是模块级——模块级的话一次「把时钟拨到溢出」的测试会毒死同进程后续所有发号（实测）。只有持有 lease 的进程消费与 ack，别的进程只追加。
3. **消息形态。** environment 消息，`source = "session"`，`ref` 就是这条 record 的 id，正文由发送方给；dedupeKey 也用它。接收方的 transcript 里就是一条普通 environment 消息，壳按普通方式显示。同一轮发两条就是两个 id，不存在「序号是哪个计数器」的问题。
4. **跨进程看得见**（已实现）。`InboxStore` 此前只在 `restore()` 那一刻读盘。现在多一个 `refresh()`：重扫目录、把别人写进来的 record 收进 pending，**只加不减**——不碰 ack marker、不做 cleanup、不改 `ready`，坏档只报诊断跳过（运行途中不该被别人写坏的一条掀翻，重启时仍按老规矩判红）。`Agent` 在 `activate()` 里起一拍每秒的轮询，空闲时才扫，扫到就消费。**用轮询而不是 `fs.watch`**：core 不 import 任何 `node:`，而 `Clock` 是已有端口、`FakeClock` 能零 sleep 驱动判据。宿主想更快就自己在目录上装 watcher 再调 `consumeInbox()`——那是加速，不是另一套语义。

同进程里两段 session 互发，实现上可以直接投到对方实例的内存队列，但**先落盘再投**，不允许绕过盘：否则同进程与跨进程两条语义就分叉了。

**只跟活着的段说话**（2026-09-07 用户拍板，替代原来的「留言」语义）。一段 session 的**地址是持久的，但它得有宿主才谈得上通信**——所以 `send` 先确认对方活着：没在跑就调容器的 `SessionRunner` 把它叫起来，再投递；叫不起来（容器没给 `run`，或 runner 失败）就 `rejected: unreachable`，**一条消息都不留**。

顺序是**先叫醒再投递**，不能反：反过来会在「容器起不了它」时留下一条躺在没人看的邮箱里的纸条，而工具已经回了「存下了，它下次起来会读」——在没有 runner 的容器里那是句空话。所以 `accepted` 就意味着对方此刻活着，没有中间态。

**唤醒带来的冲突：人优先，后台让位**（2026-09-07 拍板）。叫醒一段之后多了一种撞车——后台把它叫起来了，**人**在另一个终端 `--resume` 同一段就会被挡在门外。锁本来就保证不会两个写者同时在，问题只在**谁输**：人的显式动作输给一次隐式唤醒不能接受。

规矩是：持有者可以自称**可让位**（`acquire({ preemptible })`，写进锁文件，因为请它走的人在另一个进程里）；拿不到锁的一方先问一句（`StateLock.requestHandoff`），只有自称可让位的才让——收到 `Lease.handoffRequested` 就把手上的活 drain 完、`stop()`、release。**只有不可让位的启动方才问**，两个后台互相请没有意义。

三条边界：**锁绝不从谁手里夺走**（让不让是持有者自己决定的，所以「core 不抢占、不猜对面死没死」一个字没变）；请不动就超时返回 `false`，调用方退回原来那句「已被另一个写者持有」；让位走的是 `stop()` 那条正常收摊路，不是丢锁——丢锁是「已经不归我了，一个字都不许再写」，让位是「我还在，做完手上的事再交出去」。

被叫醒的临时宿主该带 `preemptible: true`（`CreateAgentOptions.preemptible`），人开的会话一律留 `false`。

`SessionFace.canWake` 说的就是「这个容器叫不叫得醒」。消费方按它决定**怎么说话**：叫得醒时没在跑的段仍是可以对话的 peer（`session_list` 说「发消息会把它叫起来」）；叫不醒时它们只是盘上的记录（说「从这儿够不着，`/resume` 切过去」）。

**`wait`**：`session_send({ to, message, wait: true })` 让这次工具调用挂着，直到自己的 inbox 里出现一条 `replyTo` 指回本条 record id 的回信。这是通道上的一次等待，不是父子关系：等的时候本段仍是一个普通 session，别人照样能给它发消息。core 要给 extension 开一个「盯我的 inbox、等到匹配那条」的口（§7 第 2 条），规则是**命中即消费**：匹配的那条作为工具结果返回，同时 ack 掉，不会再以 environment 消息进来一次；超时返回 `{ timedOut: true }`，什么都不消费，回信之后到了就走普通路径、下一轮以 environment 消息进来。等的过程中进程崩了，那条回信还在盘上，重启后照普通路径投递，at-least-once 不破。

## 6. main 与状态

**main。** 判据是**谁调的 create**：经容器自己的路径建的为 main（cli 启动新建、`/clear` 新建、宿主程序调 `echo.sessions.create`），经 extension 面（`session_create` 工具）建的都不是。一台机器上可以有多个 main（两个终端各起一个 echo-coding），互不隶属。规则只有一条：**只有 main 挂 `session_create`**，所以扇出只有一层，不会自己繁殖。非 main 有 `session_send` / `session_list` / `session_close`，能回话、能找人。宿主 API 不受 main 限制，它是容器不是 session。

**状态两份，都在盘上，跨进程不用 IPC：**

| 哪份 | 在哪 | 值 | 谁写、什么时候 |
|---|---|---|---|
| 持久的 | `meta.json` 的 `status` | `active` / `closed` | `session_close`、`/clear` 写 closed；容器退出**不**写，退出的 session 仍是 active、只是没进程，可 `--continue` |
| 运行的 | `status.json` | `{ phase: "idle" \| "working", updatedAt }` | 持有 lease 的进程在 idle ↔ 非 idle 切换时写 |

`session_list` 的一行 = meta + lease 活没活着 + `status.json`，**在 core 里合成一次**：`alive === false` 时 `phase` 恒为 `null`，`status.json` 的值只在 lease 被持有时才算数。进程崩在 working 时盘上会停在 working，这条规则让它不会被读成「正在忙」；三个消费者（工具、TUI、宿主）都拿合成后的行，不各自组合。模型据此知道对方是马上能回、正在忙、还是没人在（留言）。`closed` 的段缺省不列，`send` 到 closed 的段返回 rejected。

## 7. 宿主 API、extension 面、工具

一组 API，三个消费者共用：模型的工具、TUI 的 `/sessions`、宿主程序（findjob 这类）。

```ts
type SessionRow = {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  /** 哪个产品开的（2026-09-07 从 agent 分出来）。 */
  readonly product: string;
  /** 挂的哪份 agent 定义，人读的名字：具名角色是它的名字，现写的是 "inline"，产品原样的是 "default"。 */
  readonly agent: string;
  readonly main: boolean;
  readonly status: "active" | "closed";
  readonly alive: boolean;
  /** 没活着就是 null——盘上那份是死状态，不许被读成「空闲」。 */
  readonly phase: "idle" | "working" | null;
};

type CreateSessionInput = {
  readonly name?: string;
  /** 名字（从三处来源那张表里找）或现写一份定义（形状见 packages/core/src/agent-def/types.ts 的 AgentDefinition）；不给 = 产品原样，不继承创建者的角色。 */
  readonly agent?: string | { readonly identity: string; readonly tools?: readonly string[]; readonly model?: string };
  readonly workspace?: string;
  /** 第一条消息，投进新段的 inbox。工具面必填：一段 session 是为了做某件事才开的，没有这条就是一个永远躺着的空目录。 */
  readonly message: string;
  /** 经 extension 面（session_create 工具）建的传 false；容器自己建的是 main。 */
  readonly main?: boolean;
};

type SendResult =
  | { readonly kind: "accepted"; readonly alive: true; readonly recordId: string }
  | { readonly kind: "rejected"; readonly reason: "not-found" | "closed" | "invalid" | "unreachable" | "store-error"; readonly detail: string };

interface EchoSessions {
  create(input: CreateSessionInput): Promise<SessionRow>;
  list(filter?: { readonly workspace?: string; readonly agent?: string; readonly product?: string; readonly includeClosed?: boolean }): Promise<readonly SessionRow[]>;
  send(to: string, message: string): Promise<SendResult>;
  close(id: string): Promise<void>;
}

/**
 * 容器交给 core 的「怎么让一段新建的 session 跑起来」。core 在 create 里调它一次，之后不监督。
 * 返回契约：resolve = 那段已经持有自己的 lease（活了）；reject 或超时 = 没跑起来。
 */
type SessionRunner = (session: SessionRow) => Promise<void>;
```

`create` 的顺序：建目录、写 meta、把 `message` 投进新段的 inbox、调容器给的 `SessionRunner`、等它 resolve 后返回 `SessionRow`（此时 `alive` 恒为 true）。**runner 那一下的失败有语义，之后才是不监督**：

- runner reject 或超时（缺省 30 秒，容器可在 `sessions.runTimeoutMs` 改）→ `create` 判红，**刚建的段置 `closed`**，不删、留痕。这样不产生「活着但不会跑」的孤儿段，和 §6 的挂载条件是同一条规矩：不会跑的段不产生。投进去的那条 `message` record 留在盘上，closed 的段不列、不收信，它不会被消费。
- 模型面的一次 `session_create` 调用因此最长等 `runTimeoutMs`，时长有上界。

**core 不起进程**：findjob 给的 runner 在进程内挂一个实例上去、等它 `start()` 完成；coding 产品给的 runner 可以开一个终端窗口 `--resume`，然后等那段的 `.lock` 出现，各自出 extension 或宿主代码。容器没给 runner 时，宿主 API 的 `create` 仍可用（宿主自己知道怎么跑它），但 **`session_create` 工具不挂**：模型面的工具不能承诺系统不交付的事，模型调了 `session_create` 却什么都不会发生，比没有这个工具更坏。宿主 API 建的空段由宿主负责 close。

登记一条不动的观察：`session_create` 的挂载条件（main 且有 runner）和 inline 定义的「快照 ∩ 容器此刻能提供的」都在表达「工具面随容器变」，走的是两条路（挂载条件 / 快照求交）。现在各自都对；将来出现第三种随容器变的东西时再考虑收成一条规则。

**core 为 extension 新开三个口**：

1. `sessions`（**已实现 2026-09-07**）：`AgentSessionsService`，交出去的是容器那一份 `EchoSessions`（`SessionFace` 接口）。壳的 `/sessions`、第三方自己的会话工具都从这里拿——同一份实现，不会长出第二套「会话是什么」。
   **恒有**：裸 `new Agent()` 上给 `NO_SESSION_FACE`（`list()` 返回空、`send()` 说 not-found、`create` / `close` 如实说做不到）。不做成可选依赖是因为 ABI 里没有读 optional 的方法——声明成 optional 只会在缺它时装不上却说成可选。
   还没做的两点：经这里建的段应当 `main = false`（§6）、`create` 应当做不越权检查（§4，等角色定义落地）。
2. `inbox.watch(predicate, opts)`：等到匹配的那条 record，**命中即消费**（§5），给 `wait` 用。
3. `session.main` 与 `session.agent` 可读，工具组据此决定挂什么。

**`echo:sessions` 工具组**（内建 extension，就是上面 API 的薄壳）：

| 工具 | 参数 | 挂给谁 |
|---|---|---|
| `session_create` | `name`、`agent`（名字或 inline 定义）、`workspace?`、`message` | 只 main，且容器给了 `SessionRunner` |
| `session_send` | `to`、`message`、`wait?`、`timeoutMs?`、`replyTo?` | 全部 |
| `session_list` | `workspace?`、`includeClosed?` | 全部 |
| `session_close` | `id` | 全部 |

**开关** = 容器给不给 `CreateEchoOptions.sessions`（已实现）。不给就是今天的单会话形态，prompt 里一件工具都不多；`echo.sessions` 这组 API 与开关无关，恒在。工具的 description 与 `session_*` 的习惯段由这个 extension 自己出（prompt 决策 2：只有拥有工具的 extension 在自己的段里提它）。

它**不在 builtin 表里**，与 `echo:inline-tools` 同代（INLINE）：builtin 表是从一个 `Agent` 派生的，而会话面是**容器**级的——一个容器管着好几段。同理它**不进产品的行为身份快照**（`codingAgentIdentity`）：挂不挂是容器的选择，写进产品身份换个宿主就对不上。

**CLI 这个容器选的是**：开会话面，**并且给 runner**（2026-09-07）。同一台机器上多开几个终端就是多段 session（缺省都跑同一个 agent 定义），让它们看得见彼此、能互相带话；给一段没在跑的会话发消息时，容器 spawn 一个自己的副本、以 `--serve --resume <id>` 无界面地当它的宿主——「只跟活着的段说话」那条要有人兑现才成立。

`--serve` 与人开的会话有三处不同：不装壳、不读 stdin（没人坐在它前面）；**可让位**（你 `--resume` 这一段时它把手上的活做完就让开）；**连着空闲一分钟就退**（它是为了处理一条消息才起来的）。

**为什么起独立进程而不是在自己进程里多跑一段**：一段 session 一个宿主。起在自己进程里的话，关掉这个终端会把别人的会话一起带走；独立进程一直活到自己空闲退出、或被请走为止。runner 的 resolve 条件是**那一段的锁文件出现**，不是「进程起来了」——进程起来但装配失败、或锁被别人占着，都不算跑起来了。

`session_create` 现在**没有 `agent` 参数**：它随 §4 的角色定义一起回来，形状是 `agent: "reviewer" | { identity, tools?, model? }`，按名从三处来源找、找不到判红（2026-09-07 拍板）。在那之前收下这个参数等于收下一个没人兑现的值——新建的那段仍然跑容器挂的那一套。

## 8. 与现有件的对接

| 件 | 今天 | 改成 |
|---|---|---|
| `Agent` 会话面 | `newSession` / `loadSession` 走旧 `SessionManager`，生产路径不可用 | 删 `SessionManager` / `InMemorySessionManager` / `AgentOptions.sessions`；`compaction.test.ts` 的三处改用 `InMemoryDir + SessionService`。`Agent` 一个实例始终一段 session，切换由容器换实例 |
| `AgentOptions.agentName` | 字符串，写进 `SessionInfo.agent` | 改为 `AgentRef` |
| 状态根装配（`createAgent` / `createEcho`） | `~/.echo/agents/<agentId>/` 一把锁装全部端口 | `stateDir = ~/.echo/sessions/<id>/`；memory / skills 的 `StorageDir` 分别从 session / project / user 三层解析后注入；`Echo` 加 `sessions` |
| `SessionService` | 状态根下 `sessions/<id>/` | meta / entries 在目录根；`list()` 扫上级目录；空会话延迟写 meta |
| lease | `fileStateLock(<stateDir>/.lock)` | 不改代码，路径随 stateDir 变成每段一把 |
| `InboxStore` | 启动时读盘；record id 集中发号 | record id 改为写者生成的唯一 id；加目录 watch；record 加 `source = "session"` 这一种来源；`watch` 命中即消费 |
| `CreateEchoOptions` | — | 加 `sessions.run`（`SessionRunner`）与 `sessions.runTimeoutMs`（缺省 30 秒），容器给；没给 `run` 就不挂 `session_create` |
| `AgentRuntime` 协议 | `reset()` | 删 `reset()`；不加会话方法，壳走 `Echo.sessions` |
| cli `--continue` / `--resume` | 装配前另起 `SessionService(FileDir)` 扫状态根 | 同一个函数，扫 `~/.echo/sessions/`；筛选加 `main` 与 `status` |
| observe（含 `serve` 面板） | 一个状态根装多段会话，一份观测库能同时看几段 | **观测库一段一份**（它在 session 目录里）：一个 reader / 一个面板只看得到那一段的 run。`--session` 点名看哪一段，不给就是最近更新的那一段；会话摘要仍从上一层扫，所以面板里出现的任何 sessionId 都反查得到名字与 workspace |
| TUI | `/clear` = `reset()` | `/clear` = close + create + attach；`/sessions` = `list`，`/resume <id>` = 换段（壳只挑段，装配层重装） |
| memory | 一层，状态根下 | **已实现**（2026-09-07）：三层（§2）；选层走路径前缀、工具不加参数；dream 只整理 session 层（它那把 `memory` 工具够不到上两层） |
| schedule / tasks / dream / observability | 按状态根一份 | 不改代码，随状态根变成按 session 一份 |

**替代的旧决策**（原文保留在各自的记录里，本文的决策记录标明替代关系）：2026-09-01「状态根用户级 `agents/<agentId>/`」→ 状态根 = session 目录；「记忆用户级、跨项目共享」→ 三级作用域；「会话身份 = workspace + agent」保留，加 `main` 与 `status`。

## 9. 实施顺序（每步独立可验）

1. **布局（已实现，2026-09-03）**：状态根 = session 目录；`SessionService` 扁平化，清单改自由函数 `listSessions()`（扫上一层）；memory / skills 提到 user 层；空会话延迟写 meta；`SessionInfo` 加 `main` / `status`；删旧 `SessionManager` / `InMemorySessionManager` / `AgentOptions.sessions`；`CreateAgentOptions` 加 `sessionsRoot` 与 `sharedStore`；`observe` 的 `--agent-id` 换成 `--session`。lease 每段一把随之成立。
   **补齐（2026-09-07）**：这一步只把 memory 提到 user 层**一层**；§2 的三层由 memory 线自己那次改动落地——模块表加 `scopes`、路径带作用域前缀、dream 的整理范围与状态一起下到 session 层。
2. **角色定义**（2026-09-07 改，原「agent 打包」作废，见 §4）：角色文件的加载（产品自带 / user 层 / 项目层三处合并）；`AgentPrompt.section(…, { replace: true })` 与 `AgentTools.restrict()` 两个口；`AgentRef` 进 meta；角色 → `echo:inline-agent`；不越权检查；`session_create` 的 `agent` 参数回来。**排在第 5 步之前做**（2026-09-07 拍板：`/clear` 与 `wait` 都会碰 AgentRef 与「这段挂什么」）。
3. **通道（已实现，2026-09-03）**：record id 改**写者自己发号**（`createRecordIdSource`，
   `<12 位十六进制毫秒>-<4 位同毫秒计数><12 位十六进制随机>`；同一写者严格递增，跨写者靠随机区分）；
   `InboxStore.refresh()` 重扫盘上别人写进来的 record；`Agent` 每秒轮询一次自己的 inbox 目录
   （`INBOX_POLL_MS`，走已有的 `Clock` 端口，不用 `fs.watch`——core 不 import `node:`）；
   `EchoSessions`（create / list / send / close）挂在 `Echo.sessions` 上，消息形态是
   `source = "session"` 的 environment 消息、`ref` 由发送方落款；`status.json` 由持锁进程在
   idle ↔ working 边上写，读的时候与 lease 合成一次（`alive` 为假则 `phase` 恒为 `null`）；
   `SessionRunner` 与它的失败 / 超时语义（判红并把那段置 `closed`）也在这一步。
   **还没做**：extension 面的 `sessions` / `inbox.watch`（`wait` 与 `replyTo` 跟着它走）。
4. **工具（大部分已实现，2026-09-03）**：`echo:sessions` 四个工具（`session_create` / `session_list` /
   `session_send` / `session_close`）与它们的习惯段；两条挂载条件在装配层判——**main 且容器给了
   `SessionRunner` 才挂 `session_create`**，是不是 main 读盘上的 meta。会话命名 2026-09-07 补上（见 §3）。
   **还没做**：`wait`——不过它的主要用例（派活出去、等一个答复）2026-09-06 已由 `subagent` 工具覆盖
   （进程内的短命子 agent，前台调用就是阻塞等结果），所以这条的紧要程度已经下来了。
5. **壳**（`--continue` 的新筛选已随第 1 步实现；`/sessions` 与 `/resume` 2026-09-07 已实现）：
   `/sessions` 列出别的会话——id、名字、哪个 agent、在跑没在跑、忙不忙、在哪个目录，一行一段，
   自己那一段不列。用的是 core 合成好的那份行（`alive` 为假时 `phase` 恒为 null），壳不自己组合。
   `/resume <id>` 切过去：认 id、id 前缀、名字的一截，对上多段就摆候选**不猜**；不空（`busy()`，
   「还没就绪」也在里面）就不切，让人自己按 Esc。

   **换实例归装配层，不在壳里**。`/resume` 没有在 `app.ts` 里就地换 `AgentRuntime`——
   lease、inbox、tasks、schedule、观测库全挂在那一个 `Agent` 上，而壳看到的协议里连 `start`/`stop`
   都没有。壳只做一件事：说出要换到哪一段（`TuiAppOptions.onResume`），然后退出这一份界面；
   `runInteractive` 收到 `TuiExit.resume` 后收摊这一段、按新 id 重装一份 `Echo`、把界面开回来。
   **先放开再去拿**：旧的一定先 `stop()`（锁还回去）再装新的，所以同一进程同时占两把锁这条路不存在；
   代价是新的可能拿不到（被别的写者占着且不肯让），这时**退回刚才那一段**，退一次，退不回去照旧 fail-loud。

   **`/clear` 仍没做**——但卡它的那件事已经没了：`/clear` 要的「关掉当前一段、开新的一段、attach 过去」，
   attach 就是 `/resume` 现在这条路（`onResume` → 装配层重装），只差 close + create 那两步。
   在那之前 `/clear` 仍是 `reset()`：只清内存、盘上那段照旧，`--resume` 回来还是清之前的对话——
   这条**已知不一致**记在这里，别当它已经解决。

## 10. 验收判据

- **两个进程各一段**：用 resident 集成测试的宿主程序起两个进程、两个 session id、同一个 `ECHO_HOME`，两个 `start()` 都成功，各自的 `.lock` 在各自目录里。
- **跨进程消息**：A 进程 `session_send` 到 B，B 进程不重启，下一轮的 provider 请求里含那条 environment 消息，`source` 为 `session`、`ref` 指向 A。
- **同进程与跨进程同一条**：同一个容器里两段互发，盘上 `inbox/` 里有那条 record，ack marker 在消费后出现。
- **多写者不撞号**：两个进程同时往同一段的 inbox 各投 100 条，盘上恰好 200 个 record 文件，消费后 200 条都进过 transcript。
- **wait 不双送**：A `wait: true` 命中回信后，那条回信不再以 environment 消息出现在 A 的任何一轮 provider 请求里；超时后到的回信恰好出现一次。
- **崩在 working**：一段的进程在 working 时被杀，`session_list` 里它 `alive = false`、`phase = null`。
- **runner 失败不留孤儿**：runner 抛错或超过 `runTimeoutMs` 不 resolve，`create` 判红，那段在盘上 `status = closed`，`session_list` 缺省不列它；runner 成功时 `create` 返回的行 `alive = true`。
- **project 哈希校验**：把一个 project 目录的 `workspace.json` 改成别的路径，从原 workspace 起的 session 打开时判红。
- **快照只能收紧**：一段 inline 定义的 session，在工具比创建时少的容器里 `--resume`，工具集是交集、不报错；没有任何路径能让它多出快照外的工具。
- **只跟活着的段说话**（2026-09-07 替代原「留言」判据）：send 到没进程的段，容器给了 runner 就先叫醒再投递、返回 `accepted` 且对方此刻活着；叫不醒（没给 runner 或 runner 失败）返回 `rejected: unreachable`，盘上 `inbox/` 里不多任何 record。
- **wait**：A `wait: true` 发给 B，B 回信带 `replyTo`，A 的工具调用在回信落盘后返回；超时返回 `timedOut`。
- **main**：非 main 的 session 工具表里没有 `session_create`；宿主 API 的 `create` 不受限。
- **不越权**：inline 点名创建者当前工具集（§4）之外的工具，`create` 判红、`~/.echo/sessions/` 下不多目录；池里有、但被角色收紧挡掉或已禁用的，同样判红。判据见 [不越权比的是工具集而不是池](../../packages/core/test/create-echo.test.ts#test=不越权比的是创建者此刻的工具集而不是池被角色收紧挡掉的被禁用的判红没取过的延迟工具放行)。
- **`/clear` 落盘**：`/clear` 后旧段 `status = closed`，新段 id 不同；`--resume` 旧段回来的是清之前的对话，`--continue` 挑到的是新段。
- **活着就找得到**：一段刚 `start()`、一句话没说的 session，在别的进程的 `session_list` 里在，`session_send` 给它是 `accepted`。
- **空会话**：启动即退出，那一段不在清单里（meta 被撤）；但 **inbox 里还有没消费的 record 就不撤**（活着时收到、退出前没处理完的，**含别的进程刚投进来、本进程还没读到内存的**——撤之前重扫盘）——撤了那条消息就成了没人认领的孤儿；**丢锁 / 封存之后一个字都不撤**——那时 meta 与目录已经是接班者的。
- **旧决策失效**：`~/.echo/agents/` 不再被创建；`docs` 门与 API 快照重录。

## 11. 判据落在哪一层测试

四层。§10 的每条判据都能归到其中一层；跨进程那层 2026-09-03 新加了一个夹具。

| 层 | 夹具 | 落哪些判据 |
|---|---|---|
| **单元（`InMemoryDir`，零盘）** | `packages/core/test/session-service.test.ts`、`inbox-durable.test.ts`（含 durable ingress 的 conformance suite）、`extension-host.test.ts`、`create-agent.test.ts` | 布局扁平化与 `list()` 扫上级目录；空会话延迟写 meta；meta 的 `agent` / `main` / `status` 验形；**多写者不撞号**（两个 `InboxStore` 实例对同一个 `StorageDir` 各投 100 条）；`watch` 命中即消费、超时不消费；`echo:inline-agent` 装上时 identity 段替换、工作集收紧，卸下时复原；三层作用域解析与 `workspace.json` 校验；角色不越权判红、快照只能收紧 |
| **单进程集成（真盘，脚本化 provider）** | `create-agent.test.ts` 的 `fakeProvider`、`packages/cli/test/cli.test.ts` 的 `scriptedProvider`：脚本让模型按顺序调 `session_create` / `session_send` | 同一个容器里两段互发、先落盘再投、ack marker；`wait` 的回信不双送；runner 失败 / 超时判红并置 closed、成功时 `alive = true`；非 main 的工具表；`alive = false` 则 `phase = null` |
| **跨进程（真 spawn，已实现）** | `packages/core/test/sessions-cross-process.test.ts` + `fixtures/session-peer.ts`：一个真进程起一段 session 然后**待着**，末行吐 JSON 报告 | 别的进程写进它 inbox 的一条，它不重启就看见（反证过：把轮询摘掉这条立刻红）；两段各拿各的锁、同时活着、收摊都还回去。留言之后 `--resume` 第一轮看到那条仍在 `resident-v0.test.ts` 里。注意 `resident-v0` 的 replay 阶段本来就有 ack 裁决窗口的抖动，别把新判据挂在那个窗口上 |
| **壳（真 spawn `bin`）** | `cli.test.ts` 的 `spawnBin` | `--continue` 只挑 main 且 active；`/clear` 后旧段 closed、新段 main、`--resume` 旧段是清之前的对话；启动即退出不留目录；续了壳有提示 |

改公共类型（`SessionInfo`、`Echo`、`CreateEchoOptions`、`ExtensionDefinition`）要重录 API 快照；新文件先 `git add` 再跑分发门。现有测试里与旧语义绑定的要**同一次改**，不留兼容：`inbox-durable.test.ts` 的「恢复之后接着排号」「序号未恢复就 accept 抛」两条随 record id 改写者生成而改写；`create-agent.test.ts` 的 D6 四条随状态根改写；`compaction.test.ts` 用旧 `SessionManager` 的三处改 `InMemoryDir + SessionService`。
