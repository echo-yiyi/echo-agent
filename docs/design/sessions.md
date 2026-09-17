# 会话与 agent 协作

> 读者：接入会话工具、构建常驻容器或处理会话恢复的人<br>
> 范围：身份、状态根、lease、inbox、会话工具及壳的切换边界<br>
> 状态：当前实现说明；等待回信与持久清空等未完成能力见 §9

## 导读

**解决什么。** 让多段会话独立保存、独立运行，并通过持久收件箱交换消息；同一角色可以同时拥有多段 session。

**设计主线。** 一段 session 一个状态根和 lease。容器负责让它运行，core 提供创建、查询、发送和关闭协议；模型工具与壳消费同一会话面。角色定义保存为 session 的身份快照，记忆按产品声明的作用域跨会话共享。

**边界。** session 不是 subagent：前者有持久身份、lease 和 inbox，后者是父容器中的隔离子循环。core 不决定怎样创建进程，也不负责共享代码工作区的冲突合并。

主要取舍见 [状态根](../decisions/implemented/2026-09-03-session-is-the-state-root.md)、[角色定义](../decisions/implemented/2026-09-07-role-agent.md)、[身份](../decisions/implemented/2026-09-07-agent-is-an-identity.md) 与 [可让位 lease](../decisions/implemented/2026-09-07-preemptible-lease.md)。

## 1. 术语（只定义一次，全文同一个词）

> 规范词表在仓库根 [CONTEXT.md](../../CONTEXT.md)；本表只列本文用到的，定义以那里为准。

| 词 | 指什么 | 对应操作系统的词 |
|---|---|---|
| **agent（定义）** | **一个身份**：identity 段、工具子集、模型缺省，加上它的名字（见 [agent 是身份](../decisions/implemented/2026-09-07-agent-is-an-identity.md)）。产品内的角色（reviewer、前端）是它，findjob 里的一个 HR 也是它；现写的 inline 定义同样是。**产品本身不是 agent**，它是容器级的事。挂载时变成一条 extension（§4） | 程序 |
| **session** | 某个 agent 的**一次运行实例**：盘上一个目录，运行时一个 `Agent` 类实例。**一个 agent 可以有多段 session**（跟同一个 HR 的两条并行对话 = 那一个 agent 的两段），所以 10 个 HR 是 10 个 agent、不是 10 段 session | 进程 |
| **容器** | 一个 OS 进程，装一个或多个 session。终端里的 echo-coding 装一个；findjob 这类常驻程序装几十个 | 机器 |
| **产品** | 容器跑的那个：echo-agent、echo-coding、findjob。一段 session 记着自己是哪个产品开的（`product`），角色在它之下 | 发行版 |
| **main** | 容器起的 session（人起的、宿主程序起的）。`session_create` 建出来的都不是 main | init 起的进程 |
| **作用域** | 产品声明的记忆共享范围，见 §2 | 不等于 session 状态根的层级 |

一份 agent 身份可以对应多段 session；它们分别拥有运行状态。

`Agent` 类不改名，`SessionInfo.agent` 字段不改名：**类是一段 session 的运行时**（不是 agent），字段是这一段属于哪个 agent。

## 2. 作用域

| 作用域 | 目录 | 放什么 | 共享面 |
|---|---|---|---|
| **session** | `~/.echo/sessions/<id>/` | meta、transcript、inbox、tasks、schedule、lease、status、observability | 只有这段 session 自己写 |
| **project** | `~/.echo/projects/<hash>/`，`hash = fnv1a64hex(workspace)` 前 12 位 | project 级 memory（**缺省**声明，见下）；以后可加项目级 agent 定义 / skill | 同一 workspace 的所有 session |
| **user** | `~/.echo/` | credentials、settings、extensions、skills、agent 定义（`agents/<角色名>/`，角色记忆也住这里）、user 级 memory | 全部 session |

默认产品把项目记忆放在 home 下按 workspace 分组，不自动写进项目仓库。其他产品可声明不同位置；这是产品选择，不是 core 对 git 的约束。workspace 指令文件则由 prompt 路径读取。

记忆作用域由产品声明，默认 user / project / role；无角色名时不建立 role 层。作用域回答共享范围，记忆模块回答内容类型。解析发生在 session 恢复后，运行中不重新绑定。详细路径、预算与共享层并发保护只在 [Memory](memory.md) 维护；Dream 状态跟随记忆层，不存成 session 私有记忆。

## 3. session 在盘上

```
~/.echo/sessions/<id>/
  meta.json          SessionInfo（下面）
  entries/000001.json  transcript 账本，一条一文件
  inbox/<record-id>.json  入站 record；inbox/acks/ 是 ack marker
  tasks.json
  schedules.json
  .lock              lease，每段一把
  status.json        运行态快照（§6）
  observability/
```

meta 与 entries 位于目录根，SessionService 一个实例管一段；[listSessions()](../../packages/core/src/session/service.ts#symbol=listSessions) 扫上级目录得到清单。

身份类型以 [SessionInfo](../../packages/core/src/session/types.ts#symbol=SessionInfo) 与 [AgentRef](../../packages/core/src/agent-def/types.ts#symbol=AgentRef) 为准，不在本文复制类型声明。product 表示哪个产品创建，agent 保存可选 name 与 definition 快照；definition 决定如何运行，name 关联角色记忆。恢复使用保存的定义，不重新读取角色文件。

continue 选择本 workspace、本 product、main 且 active 的最近会话；显式 resume 使用指定身份。名称显示由 [describeAgentRef()](../../packages/core/src/agent-def/types.ts#symbol=describeAgentRef) 派生。

持久化约束是：**每段一个写者**（lease）、**坏档判红不给半截**、**transcript 只增不改**。清单与命名规则如下：

- **活着就找得到，空段收摊时撤掉**。meta 在 `createOrResume` 那一刻就写，所以一段**正开着**的 session 立刻在清单里、也发得进消息；「不留空段」由 `stop()` 兜底：这一段一条 entry 都没写过、inbox 里也没有待消费的记录，就把 `meta.json` 与 `status.json` 撤掉，它便不再进任何清单，`--resume` 它等于「没有这一段」。三道闸：inbox 那道**按盘上判**——撤之前重扫一次 `inbox/`，内存计数看不见别的进程刚投进来的那条；**仍持有 lease** 才撤——丢锁后 meta 已经是接班者的，`SessionService` 封存后一个字都不撤，连目录一起清的那步也只有写入格仍 installed 时才做；`inbox/` 里还有文件也不清目录。重扫与撤 meta 之间仍有一个竞态窗口，登记为已知。

  这样既保证正在运行的空会话可被发现，也避免正常退出后留下没有内容的条目。

- **名字来自第一句人话的首行**（长度限制由装配钩子定义）。core 只出 `SessionService.rename()` 与 `Agent.renameSession()`；命名策略是**装配层挂的一个钩子**（`createEcho` 里的 `echo:session-name`），挂在 `userPromptSubmit` 上——那个挂点直接带 `text` 与 `source`，比 `message_end` 少一层「哪条才是人说的」的判断。

  只在**名字还是会话 id 时**动手，所以产品挂一个 `priority` 更小的钩子先改掉名字就能接管（要让模型起名就这么做）。被别的会话叫醒的那一轮也算 `human`（inbox 消费走同一条前台路），所以 `session_create` 派出去、模型没给名字的那一段会被它收到的第一条指令命名。

  **只改自己那一段**：别人那一段正开着时它的 meta 由它自己的 `SessionService` 拥有，从外面改下一次入账就被覆写回去——所以没有「改别人名字」这个口。

create 创建元数据后段即可被发现，runner 随后负责让它运行。

当前 /clear 调 reset 清理内存投影，并未完成“关闭旧段、创建新段”的持久切换。恢复旧 session 仍可能读到清空前的账本。目标行为及未消费 inbox 的处理边界见 §9。

## 4. agent 定义是产品内的角色

**产品是容器级的事**：一个 echo-coding 容器开出来的段全是 coding 方向。一段 session 挂的 agent 定义是**产品内的一个角色**——reviewer、前端、缺省。角色是数据，不是代码：一个 markdown 文件，frontmatter 带 `name` / `description` / `tools` / `model`，正文就是 identity。产品装配仍通过 [Product](../../packages/base/src/product.ts#symbol=Product) 与 preset。

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

**角色挂载**：CreateEchoOptions 把 `agent.tools` 变成一条内联 extension `echo:inline-tools`。角色（按名加载或程序化传入的定义）同样在 mount 时变成一条 `echo:inline-agent`，apply 替换 identity 并按 tools 收紧工作集；model 由 createEcho 在装配期解析，显式模型选择优先。定义整份存在 meta 里，`--resume` 原样重挂。**它是最后一代**（boot:agent）：replace 要求产品的 identity 段已在，而产品的段来自 `opts.extensions`，所以角色必须排在那一代之后；判据见 [产品段先于角色挂](../../packages/core/test/create-echo.test.ts#test=产品经-extensions-给-identity-段-同时传-agentdefidentity角色替得上产品段必须先于-echoinline-agent-挂)。

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

会话消息写入目标 inbox；持有目标 lease 的实例负责消费与 ack，发送方只追加 record。[InboxStore](../../packages/core/src/inbox/store.ts#symbol=InboxStore) 提供持久 record、ack marker 与 at-least-once 语义。

- record id 由写者生成，包含时间、计数与随机部分，不依赖多个发送方共享一个内存序号。
- refresh 扫描外部追加的 record 并加入 pending；运行中发现坏记录报告诊断，恢复期按恢复规则校验。
- Agent 通过 Clock 端口轮询 inbox，在可消费时调度工作；跨进程投递不依赖内存事件通知。
- 消费确认前中断可能导致重投，接收业务不能把 at-least-once 当成 exactly-once。

**只跟活着的段说话**。一段 session 的**地址是持久的，但它得有宿主才谈得上通信**——所以 `send` 先确认对方活着：没在跑就调容器的 `SessionRunner` 把它叫起来，再投递；叫不起来（容器没给 `run`，或 runner 失败）就 `rejected: unreachable`，**一条消息都不留**。

顺序是**先叫醒再投递**，不能反：反过来会在「容器起不了它」时留下一条躺在没人看的邮箱里的纸条，而工具已经回了「存下了，它下次起来会读」——在没有 runner 的容器里那是句空话。所以 `accepted` 就意味着对方此刻活着，没有中间态。

**唤醒带来的冲突：人优先，后台让位**。叫醒一段之后多了一种撞车——后台把它叫起来了，**人**在另一个终端 `--resume` 同一段就会被挡在门外。锁本来就保证不会两个写者同时在，问题只在**谁输**：人的显式动作输给一次隐式唤醒不能接受。

规矩是：持有者可以自称**可让位**（`acquire({ preemptible })`，写进认领记录，因为请它走的人在另一个进程里）；拿不到锁的一方先问一句（`StateLock.requestHandoff`），只有自称可让位的才让——收到 `Lease.handoffRequested` 就把手上的活 drain 完、`stop()`、release。**只有不可让位的启动方才问**，两个后台互相请没有意义。

三条边界：**锁绝不从谁手里夺走**（让不让是持有者自己决定的，所以「core 不抢占、不猜对面死没死」一个字没变）；请不动就超时返回 `false`，调用方退回原来那句「已被另一个写者持有」；让位走的是 `stop()` 那条正常收摊路，不是丢锁——丢锁是「已经不归我了，一个字都不许再写」，让位是「我还在，做完手上的事再交出去」。

被叫醒的临时宿主该带 `preemptible: true`（`CreateAgentOptions.preemptible`），人开的会话一律留 `false`。

`SessionFace.canWake` 说的就是「这个容器叫不叫得醒」。消费方按它决定**怎么说话**：叫得醒时没在跑的段仍是可以对话的 peer（`session_list` 说「发消息会把它叫起来」）；叫不醒时它们只是盘上的记录（说「从这儿够不着，`/resume` 切过去」）。

**回信（2026-09-16 实现）。** 会话消息的正文前面有一行抬头 `[from session <发件段> · message <这条的 id>]`（回信还带 ` · reply to <被回的 id>`），由 [`sessionHeader()`](../../packages/core/src/session/sessions.ts#symbol=sessionHeader) 生成。要这一行是因为 environment 消息投给模型时 `source` / `ref` 都被剥掉——没有抬头，收件方只看得到一段裸文本，不知道是谁发的，也就回不了信。回信时 `session_send` 带 `reply_to`，它进消息的 `replyTo` 字段（与 `source` / `ref` 一样不出门，只给账本匹配）。

`send` 成功只说明投进了对方的 inbox，不代表对方已经处理或回答。要等回答就带 `wait: true`：工具挂在**自己的** inbox 上，等 `replyTo` 指回这条的那封回信，**命中即消费**——回信作为工具结果交回，不再以 environment 消息进来一次；超时 / 被叫停什么都不消费，之后到的照普通路径进来，恰好一次。实现落点与 at-least-once 的边界见 §7 的 `AgentInbox` 与 §9。

## 6. main 与状态

**main。** 判据是**谁调的 create**：经容器自己的路径建的为 main（cli 启动新建、`/clear` 新建、宿主程序调 `echo.sessions.create`），经 extension 面（`session_create` 工具）建的都不是。一台机器上可以有多个 main（两个终端各起一个 echo-coding），互不隶属。规则只有一条：**只有 main 挂 `session_create`**，所以扇出只有一层，不会自己繁殖。非 main 有 `session_send` / `session_list` / `session_close`，能回话、能找人。宿主 API 不受 main 限制，它是容器不是 session。

**状态两份，都在盘上，跨进程不用 IPC：**

| 哪份 | 在哪 | 值 | 谁写、什么时候 |
|---|---|---|---|
| 持久的 | `meta.json` 的 `status` | `active` / `closed` | `session_close`、`/clear` 写 closed；容器退出**不**写，退出的 session 仍是 active、只是没进程，可 `--continue` |
| 运行的 | `status.json` | `{ phase: "idle" \| "working", updatedAt }` | 持有 lease 的进程在 idle ↔ 非 idle 切换时写 |

`session_list` 的一行 = meta + lease 活没活着 + `status.json`，**在 core 里合成一次**：`alive === false` 时 `phase` 恒为 `null`，`status.json` 的值只在 lease 被持有时才算数。进程崩在 working 时盘上会停在 working，这条规则让它不会被读成「正在忙」；三个消费者（工具、TUI、宿主）都拿合成后的行，不各自组合。模型据此知道对方是马上能回、正在忙、还是没人在（留言）。`closed` 的段缺省不列，`send` 到 closed 的段返回 rejected。

## 7. 宿主 API、extension 面、工具

会话面由模型工具、壳和容器共用。当前公共形状以 [EchoSessions](../../packages/core/src/session/sessions.ts#symbol=EchoSessions)、[SessionRow](../../packages/core/src/session/sessions.ts#symbol=SessionRow) 与 [SessionRunner](../../packages/core/src/session/sessions.ts#symbol=SessionRunner) 为准，不在本文维护另一套接口草图。

`create` 的顺序：建目录、写 meta、把 `message` 投进新段的 inbox、调容器给的 `SessionRunner`、等它 resolve 后返回 `SessionRow`（此时 `alive` 恒为 true）。**runner 那一下的失败有语义，之后才是不监督**：

- runner reject 或超时（缺省 30 秒，容器可在 `sessions.runTimeoutMs` 改）→ `create` 判红，**刚建的段置 `closed`**，不删、留痕。这样不产生「活着但不会跑」的孤儿段，和 §6 的挂载条件是同一条规矩：不会跑的段不产生。投进去的那条 `message` record 留在盘上，closed 的段不列、不收信，它不会被消费。
- runTimeoutMs 限制 runner 的等待；它不构成建目录、投递等全部 I/O 的总耗时上界。

**core 不起进程**：findjob 给的 runner 在进程内挂一个实例上去、等它 `start()` 完成；coding 产品给的 runner 可以开一个终端窗口 `--resume`，然后等那段的 `.lock` 出现，各自出 extension 或宿主代码。容器没给 runner 时，宿主 API 的 `create` 仍可用（宿主自己知道怎么跑它），但 **`session_create` 工具不挂**：模型面的工具不能承诺系统不交付的事，模型调了 `session_create` 却什么都不会发生，比没有这个工具更坏。宿主 API 建的空段由宿主负责 close。

extension 通过 AgentSessionsService 使用同一会话面；未接实际能力时由 NO_SESSION_FACE 返回明确的空结果或拒绝。服务注入规则见 [Extensions](extensions.md)。

**等在自己 inbox 上**是另一个能力端口 [`AgentInbox`](../../packages/core/src/extension/registries.ts#symbol=AgentInbox)（设计里一直叫它 `inbox.watch`，2026-09-16 实现），`session_send` 的 `wait` 是它的第一个用户，第三方要做「发出去等回执」也走它。形状与结局在 [`AgentInboxPort`](../../packages/core/src/inbox/watch.ts#symbol=AgentInboxPort)，实现是 [`Agent.watchInbox`](../../packages/core/src/agent.ts#symbol=Agent.watchInbox)：

- **只能在 run 里等**：命中的那条单独预留出来（[`InboxStore.reserveMatching`](../../packages/core/src/inbox/store.ts#symbol=InboxStore.reserveMatching)，从待投递里摘走，整批消费就拿不到它），ack 挂在本轮 run 的收尾上、而且等 transcript 落定之后——工具结果入账了才算消费。
- **自己刷盘**：常规的 inbox 轮询在有 run 时一拍不扫，而 `wait` 恰恰是在 run 的工具调用里挂着，所以它按同一节拍、同一个时钟自己 `refresh()`。
- **inbox run 的收尾也排空收尾活**：被叫醒的会话跑的全是 inbox 触发的 run，此前只有用户 run 收尾才排空 `afterRun`，这类段里命中之后永远不会 ack（模型触发的热部署同样受影响）。判据见 [inbox run 也排空](../../packages/core/test/inbox-watch.test.ts#test=afterrun-在-inbox-触发的-run-里登记收尾时同样排空不只用户-run-才排)。

**`echo:sessions` 工具组**（内建 extension，就是上面 API 的薄壳）：

| 工具 | 参数 | 挂给谁 |
|---|---|---|
| `session_create` | `name`、`agent`（名字、inline 定义，或带 `name` 的 inline 定义——具名身份，同名的段共享个人记忆）、`workspace?`、`message` | 只 main，且容器给了 `SessionRunner` |
| `session_send` | `to`、`message`、`reply_to?`（回的是哪一条，填它抬头里的 message id）、`wait?`、`timeout_seconds?`（缺省 120，最多 600） | 全部 |
| `session_list` | `workspace?`、`includeClosed?` | 全部 |
| `session_close` | `id` | 全部 |

**开关** = 容器给不给 `CreateEchoOptions.sessions`（已实现）。不给就是今天的单会话形态，prompt 里一件工具都不多；`echo.sessions` 这组 API 与开关无关，恒在。工具的 description 与 `session_*` 的习惯段由这个 extension 自己出（prompt 决策 2：只有拥有工具的 extension 在自己的段里提它）。

它**不在 builtin 表里**，与 `echo:inline-tools` 同代（INLINE）：builtin 表是从一个 `Agent` 派生的，而会话面是**容器**级的——一个容器管着好几段。同理它**不进产品的行为身份快照**（`codingAgentIdentity`）：挂不挂是容器的选择，写进产品身份换个宿主就对不上。

**CLI 这个容器选的是**：开会话面，**并且给 runner**（2026-09-07）。同一台机器上多开几个终端就是多段 session（缺省都跑同一个 agent 定义），让它们看得见彼此、能互相带话；给一段没在跑的会话发消息时，容器 spawn 一个自己的副本、以 `--serve --resume <id>` 无界面地当它的宿主——「只跟活着的段说话」那条要有人兑现才成立。

`--serve` 与人开的会话有三处不同：不装壳、不读 stdin（没人坐在它前面）；**可让位**（你 `--resume` 这一段时它把手上的活做完就让开）；**连着空闲一分钟就退**（它是为了处理一条消息才起来的）。

**为什么起独立进程而不是在自己进程里多跑一段**：一段 session 一个宿主。起在自己进程里的话，关掉这个终端会把别人的会话一起带走；独立进程一直活到自己空闲退出、或被请走为止。runner 的 resolve 条件是**那一段的锁被它持有**，不是「进程起来了」——进程起来但装配失败、或锁被别人占着，都不算跑起来了。

## 8. 与其他模块的边界

- SessionService 拥有本段账本；查询跨段清单由上级目录扫描完成，不让一个实例同时写多个 session。
- lease、tasks、schedule、inbox 与观测库按 session 隔离；记忆与技能使用各自的共享位置。
- 壳通过 sessions 查看会话，通过 onResume 表达切换意图；实际停止旧 Echo、装配新 Echo 归容器。
- 观测每段一个 journal，跨会话面板在 base 层聚合 reader，不改变各段的写入所有权。

## 9. 当前限制

**等待回信。** `wait` 已实现，剩下这几条边界：
- **等的时候这一段什么都不做**：`wait` 挂在一次工具调用里，整轮 run 跟着挂，所以设了上限（600 秒）；能边干边等的场景应该不等、让回信照普通消息进来。
- **at-least-once，不是 exactly-once**：命中后到 ack 之间崩溃，那封回信还在盘上，重启后会再以普通消息进来一次——这时对话里它可能已经作为工具结果出现过。
- **宿主程序发的消息没有抬头**：没有发件段，就没有「回给谁」，模型也无从 `reply_to`。
- 进程内一次性任务仍可用 subagent，它与跨 session 回信是两件事。

**持久清空。** /clear 目前仅 reset 内存；目标是关闭旧段、新建一段并切换。旧 inbox 尚未消费的 record 如何处理仍未确定，不在本文假定为自动转投。

**切换失败。** /resume 由壳选段并退出，容器先停止旧段再启动目标段；目标段拿不到 lease 时尝试回到原段，回退也可能失败。它不是两段锁同时持有的原子交换。

**空段清理竞态。** 停止前检查盘上 inbox 并清理空段元数据之间仍有竞态窗口；lease 不能替代对外部投递的完整协调。

## 10. 验证判据

- **两个进程各一段**：用 resident 集成测试的宿主程序起两个进程、两个 session id、同一个 `ECHO_HOME`，两个 `start()` 都成功，各自的 `.lock` 在各自目录里。
- **跨进程消息**：A 进程 `session_send` 到 B，B 进程不重启，下一轮的 provider 请求里含那条 environment 消息，`source` 为 `session`、`ref` 指向 A。
- **同进程与跨进程同一条**：同一个容器里两段互发，盘上 `inbox/` 里有那条 record，ack marker 在消费后出现。
- **多写者不撞号**：两个进程同时往同一段的 inbox 各投 100 条，盘上恰好 200 个 record 文件，消费后 200 条都进过 transcript。
- **wait 不双送**：A `wait: true` 命中回信后，那条回信不再以 environment 消息出现在 A 的对话里（A 开着自动消费、多等几拍也不出现）；超时后到的回信恰好出现一次。判据见 [端到端](../../packages/core/test/session-wait.test.ts#test=a-wait-发给-bb-看得见抬头带-replyto-回信a-的工具直接拿到回信之后不再以普通消息出现) 与 [超时](../../packages/core/test/inbox-watch.test.ts#test=超时什么都不消费之后到的回信照普通路径进来恰好一次)。
- **崩在 working**：一段的进程在 working 时被杀，`session_list` 里它 `alive = false`、`phase = null`。
- **runner 失败不留孤儿**：runner 抛错或超过 `runTimeoutMs` 不 resolve，`create` 判红，那段在盘上 `status = closed`，`session_list` 缺省不列它；runner 成功时 `create` 返回的行 `alive = true`。
- **project 哈希校验**：把一个 project 目录的 `workspace.json` 改成别的路径，从原 workspace 起的 session 打开时判红。
- **快照只能收紧**：一段 inline 定义的 session，在工具比创建时少的容器里 `--resume`，工具集是交集、不报错；没有任何路径能让它多出快照外的工具。
- **只跟活着的段说话**（2026-09-07 替代原「留言」判据）：send 到没进程的段，容器给了 runner 就先叫醒再投递、返回 `accepted` 且对方此刻活着；叫不醒（没给 runner 或 runner 失败）返回 `rejected: unreachable`，盘上 `inbox/` 里不多任何 record。
- **wait**：A `wait: true` 发给 B，B 回信带 `reply_to`，A 的工具调用在回信落盘后返回回信本身；超时返回「没等到」且什么都不消费；没 ack 就崩溃，重启照样重放（[账本层](../../packages/core/test/inbox-watch.test.ts#test=reservematching-只摘第一条匹配的其余-pending-原样原序没-ack-就崩重启照样重放at-least-once)）。
- **收件方看得见是谁发的**：会话消息投给模型的正文带抬头，写明发件段与这条的 id；回信的抬头点名回的是哪一条（[判据](../../packages/core/test/sessions-face.test.ts#test=send正文带抬头发件段-这条的-id回信另记-replyto-字段结果交回-ref)）。
- **main**：非 main 的 session 工具表里没有 `session_create`；宿主 API 的 `create` 不受限。
- **不越权**：inline 点名创建者当前工具集（§4）之外的工具，`create` 判红、`~/.echo/sessions/` 下不多目录；池里有、但被角色收紧挡掉或已禁用的，同样判红。判据见 [不越权比的是工具集而不是池](../../packages/core/test/create-echo.test.ts#test=不越权比的是创建者此刻的工具集而不是池被角色收紧挡掉的被禁用的判红没取过的延迟工具放行)。
- **`/clear` 落盘（目标判据，未实现）**：`/clear` 后旧段 `status = closed`，新段 id 不同；`--resume` 旧段回来的是清之前的对话，`--continue` 挑到的是新段。
- **活着就找得到**：一段刚 `start()`、一句话没说的 session，在别的进程的 `session_list` 里在，`session_send` 给它是 `accepted`。
- **空会话**：启动即退出，那一段不在清单里（meta 被撤）；但 **inbox 里还有没消费的 record 就不撤**（活着时收到、退出前没处理完的，**含别的进程刚投进来、本进程还没读到内存的**——撤之前重扫盘）——撤了那条消息就成了没人认领的孤儿；**丢锁 / 封存之后一个字都不撤**——那时 meta 与目录已经是接班者的。
- 角色定义与角色记忆可以使用 agents 目录；session 状态根只使用 sessions 目录。

## 11. 判据落在哪一层测试

测试按作用范围分层；标注未实现的目标判据不能计入当前覆盖。

| 层 | 夹具 | 落哪些判据 |
|---|---|---|
| **单元（`InMemoryDir`，零盘）** | `packages/core/test/session-service.test.ts`、`inbox-durable.test.ts`（含 durable ingress 的 conformance suite）、`extension-host.test.ts`、`create-agent.test.ts` | 布局扁平化与 `list()` 扫上级目录；运行时空会话可发现与退出清理；meta 的 `agent` / `main` / `status` 验形；**多写者不撞号**（两个 `InboxStore` 实例对同一个 `StorageDir` 各投 100 条）；`watch` 命中即消费、超时不消费、只摘匹配的那条（`inbox-watch.test.ts`）；会话消息的抬头与 `replyTo`（`sessions-face.test.ts`）；两段同进程走真装配的 `wait` 端到端（`session-wait.test.ts`）；`echo:inline-agent` 装上时 identity 段替换、工作集收紧，卸下时复原；三层作用域解析与 `workspace.json` 校验；角色不越权判红、快照只能收紧 |
| **单进程集成（真盘，脚本化 provider）** | `create-agent.test.ts` 的 `fakeProvider`、`packages/cli/test/cli.test.ts` 的 `scriptedProvider`：脚本让模型按顺序调 `session_create` / `session_send` | 同一个容器里两段互发、先落盘再投、ack marker；runner 失败 / 超时判红并置 closed、成功时 `alive = true`；非 main 的工具表；`alive = false` 则 `phase = null` |
| **跨进程（真 spawn，已实现）** | `packages/core/test/sessions-cross-process.test.ts` + `fixtures/session-peer.ts`：一个真进程起一段 session 然后**待着**，末行吐 JSON 报告 | 别的进程写进它 inbox 的一条，它不重启就看见（反证过：把轮询摘掉这条立刻红）；两段各拿各的锁、同时活着、收摊都还回去。留言之后 `--resume` 第一轮看到那条仍在 `resident-v0.test.ts` 里。注意 `resident-v0` 的 replay 阶段本来就有 ack 裁决窗口的抖动，别把新判据挂在那个窗口上 |
| **壳（真 spawn `bin`）** | `cli.test.ts` 的 `spawnBin` | `--continue` 只挑 main 且 active；持久清空为待补目标；启动即退出不留目录；续了壳有提示 |

测试夹具中的作用域和模型是受控输入，不证明真实产品的全部运行组合。公共类型变更另跑 API snapshot，包消费面变更另跑 distribution gate。
