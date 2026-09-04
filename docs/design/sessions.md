# 会话（Session）与 agent 集群

> 状态：proposed。2026-09-03 口头拍板、未实现；决策记录留在 `docs/decisions/proposed/` 直到实现后移入 `implemented/`（花名册注释里 proposed 的定义是「提出到实现之间」）<br>
> 读者：要实现会话面、给产品接会话工具、把 echo 嵌进常驻程序（多段会话同时工作）的人<br>
> 假设已读：[Lifecycle 与 Run Loop](lifecycle-and-run-loop.md) 的实例生命周期与 admission；[Context 与 Message Flow](context-and-message-flow.md) 的 transcript / working context 术语；[Compaction](compaction.md) 的「策略是 extension、状态在 core」这条分法——本文对会话用同一条<br>
> 决策记录（五条，本文只指向，不复述论证）：[状态根 = session 目录](../decisions/proposed/2026-09-03-session-is-the-state-root.md) · [记忆三级作用域](../decisions/proposed/2026-09-03-memory-three-scopes.md) · [agent 是 extension](../decisions/proposed/2026-09-03-agent-is-an-extension.md) · [会话对等、通道是 inbox](../decisions/proposed/2026-09-03-sessions-are-peers.md) · [main 与状态](../decisions/proposed/2026-09-03-main-and-status.md)

## 导读

**解决什么。** 今天一个 `Agent` 实例绑死一段会话、一把锁锁整个状态根（`~/.echo/agents/default/.lock`），于是：同一台机器上两个 echo-coding 同时起不来（第二个拿不到锁直接 fail-loud）；会话之间没有任何通道；`Agent` 上的 `newSession` / `loadSession` 走的是旧 `SessionManager`，生产装配只注入 `SessionService`，一调就抛；`/clear` 只清内存、不落盘，`--resume` 会把清掉的对话整个带回来。用户要的形态是一个 **agent 集群**：agent 能自己开会话，会话之间能互发消息，既能在终端里各起各的进程，也能嵌进一个常驻程序里同时跟几十个对象聊。

**最终形态。** 一段 session 就是一个独立的 agent，和操作系统里的进程是同一个抽象：有 id、有它跑的程序（agent 定义，是一个 extension）、有 cwd（workspace）、有内存（transcript）、有邮箱（inbox）、能被列出、能被关掉。**状态根就是 session 目录**，今天按状态根一份的东西（lease、inbox、tasks、schedule、dream、observability）自动变成按 session 一份，代码不动。跨 session 共享的只有 memory 与 skills，提到 project / user 两层。会话之间的通道是 inbox 落盘：发消息 = 往对方目录写一条 record，同进程与跨进程一条路。**core 不管进程**：谁把一段 session 跑起来（终端里人起的、常驻程序在进程内起的、产品自己 spawn 的）是容器的事。会话的用法（四个工具、等回信、命名、筛选、agent 打包、起进程）全是 extension；会话的盘与协议（布局、lease、inbox、状态、不越权）在 core。

**Non-Goals（已决，不做）。**

- 父子会话、子 agent 树、阻塞式委派工具。只有对等会话；「发了就等回信」是通道上的 `wait`，不是父子。
- core 起进程、管进程、重启崩溃的进程。产品要就自己出一个 extension。
- 跨进程把别的 session 的事件流拉到本进程的壳上（IPC）。壳只 attach 自己容器里的 session。
- 分支会话（pi 的 `/tree` `/fork`）。entry 的 `parentId` 保持树形状，不提供分支命令。
- 会话调度器。一个容器里同时跑几段模型调用只给一个并发上限，不做优先级。
- 记忆从 session 级往 project / user 级的自动提升。`remember` 带 `scope`，dream 不跨级。
- memory 目录的多写者保护（多段 session 同时往 project 级记）。归 memory 线，本文只定作用域。
- 会话的回收（GC / TTL）。`closed` 的段留在盘上；不会跑的段靠 §7 的挂载条件与 runner 失败判红不产生，而不是事后清。

**待拍板。** 无。五项决策已拍（2026-09-03，口头），见决策记录；实现时发现设计有问题按「停下来、一句话讲清、等拍板」处理。

**验收判据（机器可判）。** 见 §10。核心四条：同一台机器两段 session 各自的进程同时 `start()` 都成功；A 进程 `session_send` 之后 B 进程不重启就在下一轮看到那条 environment 消息；非 main 的 session 工具表里没有 `session_create`；inline 定义点名了创建者池外的工具，`create` 判红、盘上不建目录。

## 1. 术语（只定义一次，全文同一个词）

| 词 | 指什么 | 对应操作系统的词 |
|---|---|---|
| **agent（定义）** | 一个 extension：打包 identity 段、工具组、模型缺省。echo-agent、echo-coding、一个现写的 inline 定义都是 | 程序 |
| **session** | agent 的一个实例：盘上一个目录，运行时一个 `Agent` 实例。**session = 运行中的 agent**，两个词指同一个实体，从盘上看叫 session，从运行时看叫 agent | 进程 |
| **容器** | 一个 OS 进程，装一个或多个 session。终端里的 echo-coding 装一个；findjob 这类常驻程序装几十个 | 机器 |
| **main** | 容器起的 session（人起的、宿主程序起的）。`session_create` 建出来的都不是 main | init 起的进程 |
| **作用域** | session / project / user 三层目录，见 §2 | 进程私有 / 项目共享 / 用户共享 |

`Agent` 类不改名，`SessionInfo.agent` 字段不改名：类是运行中的 session，字段是它跑的哪个定义。

## 2. 作用域

| 作用域 | 目录 | 放什么 | 共享面 |
|---|---|---|---|
| **session** | `~/.echo/sessions/<id>/` | meta、transcript、inbox、tasks、schedule、dream 状态、**session 级 memory**、lease、status、observability | 只有这段 session 自己写 |
| **project** | `~/.echo/projects/<hash>/`，`hash = fnv1a64hex(workspace)` 前 12 位 | **project 级 memory**；以后可加项目级 agent 定义 / skill | 同一 workspace 的所有 session |
| **user** | `~/.echo/` | credentials、settings、extensions、skills、agent 定义、**user 级 memory** | 全部 session |

project 一层**存 home 下、按 workspace 分**，不放进仓库：agent 自动写的东西不该进 git，也不该要求每个仓库改 `.gitignore`。哈希只有 48 位，撞了就是两个项目的记忆混在一起而没人发现，所以 project 目录里放一份 `workspace.json` 记原路径，打开时对一遍，不匹配判红。项目指令文件（AGENTS.md / CLAUDE.md）仍从 workspace 里读（prompt 决策 7），那是人写给 agent 的，方向相反。

三层里唯一的共享写方是 project / user 级 memory：多段 session 同时 `remember` 到同一层。dream 只整理 session 自己那份，不碰上两层，所以整理不冲突；`remember` 的并发写归 memory 线（Non-Goals）。

`ECHO_HOME` 覆盖 `~/.echo`，与今天的 [`resolveStateDir()`](../../packages/core/src/create-agent.ts#symbol=resolveStateDir) 同一个来源；`agents/<agentId>/` 这一层退场，session 的 meta 里记着自己是哪个 agent。

## 3. session 在盘上

```
~/.echo/sessions/<id>/
  meta.json          SessionInfo（下面）
  entries/000001.json  transcript 账本，一条一文件（今天的形状，不变）
  inbox/000001.json  入站 record；inbox/acks/ 是 ack marker（今天的形状，不变）
  tasks.json
  schedule/
  .dream
  memory/            session 级记忆
  .lock              lease，每段一把
  status.json        运行态快照（§6）
  observability/
```

今天 `SessionService` 把 session 放在状态根下的 `sessions/<id>/`；状态根变成 session 目录之后，meta 与 entries 上提一层到目录根。`list()` 改成扫 `~/.echo/sessions/*/meta.json`，其余逻辑（坏档判红、序号连续、parent 链、compaction 投影）不动。

```ts
type AgentRef =
  | { readonly kind: "extension"; readonly name: string }
  | {
      readonly kind: "inline";
      readonly identity: string;
      readonly extensions?: readonly string[];
      readonly tools?: readonly string[];
      readonly model?: string;
    };

type SessionInfo = {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  readonly agent: AgentRef;
  readonly main: boolean;
  readonly status: "active" | "closed";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
};
```

相对今天的 [`SessionInfo`](../../packages/core/src/session/types.ts#symbol=SessionInfo)：`agent` 从产品名字符串变成 `AgentRef`；加 `main`、`status`。`--continue` 的筛选条件「本产品在本目录的最近一段」改成 `workspace` 相同、`agent` 是同名 extension、`main` 为真、`status` 为 active。

三条不变量沿用：**每段一个写者**（lease）、**坏档判红不给半截**、**transcript 只增不改**。两条新规矩：

- **空会话不落盘。** 新 id 的 `createOrResume` 只建内存游标，meta 在第一次 `append` 时才写。每次启动不再留一个空目录，列表不被空段塞满；`--resume` 一个从没说过话的 id 判红「不存在」。
- **名字来自第一条 user 消息的首行**（截 60 字），由 `echo.agent.hooks` 里的一个钩子在 `message_end` 时调 `rename` 写进 meta；core 只出 `rename`。以后要让模型起名，换钩子即可。

`/clear` 的语义改为：关掉当前一段（`status = closed`）、新建一段、壳 attach 过去。旧段留在盘上可 `--resume`。协议上的 `reset()` 因此没有消费者，删。

## 4. agent 是 extension

一个 agent 定义 = 一个 extension，打包它的 identity 段、纪律段、工具组、模型缺省。今天 echo-coding 是 `Product.preset` 返回的一组 [`ExtensionEntry`](../../packages/core/src/extension/host.ts#symbol=ExtensionEntry)（`packages/coding/src/agent.ts` 的 `codingPreset`），不是一个 extension，所以按名引用不了。

**ABI 加一个字段**：`ExtensionDefinition` 加 `extensions?: readonly ExtensionEntry[]`，一个 extension 可以打包别的。mount 时先按拓扑装它打包的，再装它自己；卸载逆序。这是本设计唯一的 ABI 改动。echo-agent 与 echo-coding 各写成一个 bundle：

```
echo-coding  =  echo:coding（identity + conduct:coding 段）
              + echo:workspace（fs / search 工具与习惯段）
              + echo:shell（bash，自己 inject background 端口）
```

[`Product`](../../packages/cli/src/product.ts#symbol=Product) 只剩 `name` 与 `version` 给可执行文件用，`preset` 退场，装配改成 `extensions: [bundle]`。

**inline 定义**走已有的先例：`CreateEchoOptions` 今天把 `agent.tools` 变成一条内联 extension `echo:inline-tools`。`AgentRef.kind === "inline"` 同样在 mount 时变成一条 `echo:inline-agent`：`identity` 成 identity 段，`extensions` 按名从内建表与已发现的扩展里取，`tools` 从取到的池里过滤，`model` 从模型目录解析。定义整份存在 meta 里，`--resume` 原样重挂。

**不越权**（core 的 `sessions.create` 里验，不靠工具自觉）：inline 的 `tools` 必须是创建者当前工具集的子集，`extensions` 必须是创建者已挂的子集，权限策略继承创建者的、不能放宽。违反判红，盘上不建目录。

**快照权威、只能收紧。** 检查在创建那一刻做一次，通过的定义整份存进 meta，之后它就是这段 session 的权威定义，不再回头看创建者（创建者可能已经 closed）。`--resume` 时工具集取「快照 ∩ 容器此刻能提供的」，只会更小；快照里有、容器没有的工具不挂、不报错。任何路径都不能让它比快照更宽。

## 5. 会话间通道：inbox

会话之间只有一种通信：**往对方的 inbox 写一条 record**。inbox 的语义今天就是「外面发生了一件事 → 入队，不打断正在跑的任务，回 idle 后开一轮」（`packages/core/src/agent.ts` 的 `deliver()` 与 inbox 那段注释），落盘形状是 [`InboxStore`](../../packages/core/src/inbox/store.ts#symbol=InboxStore) 的 record + ack marker、at-least-once。跨 session 发消息不需要新协议，需要四处改动：

1. **inbox 按 session 一份。** 状态根变成 session 目录之后自动成立。
2. **record id 由写者生成。** 今天 record id 是 `InboxStore` 集中分配的六位序号（`store.ts` 的 `nextSeq`，restore 时从盘上校准一次、之后只在内存里递增）。写者从 1 变成 N 之后，两个进程各自校准、各自递增，会发到同一个 `000006.json`；`FileDir.write` 是 tmp + rename，后到的**静默覆盖**先到的，at-least-once 直接变成无声丢失。改成写者自己生成全局唯一、时间可排序的 id（uuidv7 形状，文件名仍字典序 = 时间序），任何写者不读目录就能发号；`SAFE_RECORD_ID` 的判据随之改。只有持有 lease 的进程消费与 ack，别的进程只追加。
3. **消息形态。** environment 消息，`source = "session"`，`ref` 就是这条 record 的 id，正文由发送方给；dedupeKey 也用它。接收方的 transcript 里就是一条普通 environment 消息，壳按普通方式显示。同一轮发两条就是两个 id，不存在「序号是哪个计数器」的问题。
4. **跨进程看得见。** `InboxStore` 今天只在启动时读盘。持有 lease 的进程要对自己的 `inbox/` 目录开一个 watch（fs.watch，退化到轮询），别的进程写进来的 record 在下一次 idle 判断时可见。发现机制可以是端口，语义不动。

同进程里两段 session 互发，实现上可以直接投到对方实例的内存队列，但**先落盘再投**，不允许绕过盘：否则同进程与跨进程两条语义就分叉了。

**`send` 的返回值**带对方活没活着（看对方的 lease）：`{ accepted, alive }`。发给一段没进程的 session，消息只是躺在盘上，发送方要知道这是留言不是对话。

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
  readonly agentName: string;
  readonly main: boolean;
  readonly status: "active" | "closed";
  readonly alive: boolean;
  readonly phase: "idle" | "working" | null;
};

type CreateSessionInput = {
  readonly name: string;
  readonly agent: string | { readonly identity: string; readonly extensions?: readonly string[]; readonly tools?: readonly string[]; readonly model?: string };
  readonly workspace?: string;
  /** 第一条消息，投进新段的 inbox。工具面必填：一段 session 是为了做某件事才开的，没有这条就是一个永远躺着的空目录。 */
  readonly message: string;
};

type SendResult =
  | { readonly kind: "accepted"; readonly alive: boolean; readonly recordId: string }
  | { readonly kind: "rejected"; readonly reason: "not-found" | "closed" | "invalid" };

interface EchoSessions {
  create(input: CreateSessionInput): Promise<SessionRow>;
  list(filter?: { readonly workspace?: string; readonly includeClosed?: boolean }): Promise<readonly SessionRow[]>;
  send(to: string, message: string, opts?: { readonly replyTo?: string }): Promise<SendResult>;
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

**core 为 extension 新开三个口**（extension 拿到的 agent handle 上）：

1. `sessions`：上面这组 `EchoSessions`，就是宿主 API 同一份，只差两点：经这里建的段 `main = false`（§6）；`create` 在这里做不越权检查（§4），检查用的是调用方 session 的当前工具集。
2. `inbox.watch(predicate, opts)`：等到匹配的那条 record，**命中即消费**（§5），给 `wait` 用。
3. `session.main` 与 `session.agent` 可读，工具组据此决定挂什么。

**`echo:sessions` 工具组**（内建 extension，就是上面 API 的薄壳）：

| 工具 | 参数 | 挂给谁 |
|---|---|---|
| `session_create` | `name`、`agent`（名字或 inline 定义）、`workspace?`、`message` | 只 main，且容器给了 `SessionRunner` |
| `session_send` | `to`、`message`、`wait?`、`timeoutMs?`、`replyTo?` | 全部 |
| `session_list` | `workspace?`、`includeClosed?` | 全部 |
| `session_close` | `id` | 全部 |

**开关** = 挂不挂 `echo:sessions`。不挂就是今天的单会话，不需要另加配置项。工具的 description 与 `session_*` 的习惯段由这个 extension 自己出（prompt 决策 2：只有拥有工具的 extension 在自己的段里提它）。

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
| TUI | `/clear` = `reset()` | `/clear` = close + create + attach；`/sessions` = `list` + attach（同容器） |
| memory | 一层，状态根下 | 三层（§2）；`remember` 加 `scope`；dream 只整理 session 层 |
| schedule / tasks / dream / observability | 按状态根一份 | 不改代码，随状态根变成按 session 一份 |

**替代的旧决策**（原文保留在各自的记录里，本文的决策记录标明替代关系）：2026-09-01「状态根用户级 `agents/<agentId>/`」→ 状态根 = session 目录；「记忆用户级、跨项目共享」→ 三级作用域；「会话身份 = workspace + agent」保留，加 `main` 与 `status`。

## 9. 实施顺序（建议，每步独立可验）

1. **布局**：状态根 = session 目录；`SessionService` 扁平化与 `list()`；三层作用域解析；memory / skills 提到共享层；空会话延迟写 meta；删旧 `SessionManager`。lease 每段一把随之成立。
2. **agent 打包**：ABI 加 `extensions`；echo-agent / echo-coding 写成 bundle；`AgentRef` 进 meta；inline → `echo:inline-agent`；不越权检查。
3. **通道**：inbox 目录 watch；`source = "session"`；`Echo.sessions` 与 extension 面的 `sessions` / `inbox.watch`；`status.json`。
4. **工具**：`echo:sessions` 四个工具；main 规则；`wait`；命名钩子。
5. **壳**：`--continue` 新筛选；`/clear`；`/sessions`。

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
- **留言**：send 到没进程的段返回 `alive: false`；之后 `--resume` 那段，第一轮看到这条消息。
- **wait**：A `wait: true` 发给 B，B 回信带 `replyTo`，A 的工具调用在回信落盘后返回；超时返回 `timedOut`。
- **main**：非 main 的 session 工具表里没有 `session_create`；宿主 API 的 `create` 不受限。
- **不越权**：inline 点名创建者池外的工具，`create` 判红、`~/.echo/sessions/` 下不多目录。
- **`/clear` 落盘**：`/clear` 后旧段 `status = closed`，新段 id 不同；`--resume` 旧段回来的是清之前的对话，`--continue` 挑到的是新段。
- **空会话**：启动即退出，`~/.echo/sessions/` 下不多目录。
- **旧决策失效**：`~/.echo/agents/` 不再被创建；`docs` 门与 API 快照重录。

## 11. 判据落在哪一层测试

四层，每层用已有的夹具，只有跨进程那层要加一个 phase。§10 的每条判据都能归到其中一层。

| 层 | 夹具 | 落哪些判据 |
|---|---|---|
| **单元（`InMemoryDir`，零盘）** | `packages/core/test/session-service.test.ts`、`inbox-durable.test.ts`（含 durable ingress 的 conformance suite）、`extension-host.test.ts`、`create-agent.test.ts` | 布局扁平化与 `list()` 扫上级目录；空会话延迟写 meta；meta 的 `agent` / `main` / `status` 验形；**多写者不撞号**（两个 `InboxStore` 实例对同一个 `StorageDir` 各投 100 条）；`watch` 命中即消费、超时不消费；bundle 的拓扑装卸与整代回滚；三层作用域解析与 `workspace.json` 校验；inline 不越权判红、快照只能收紧 |
| **单进程集成（真盘，脚本化 provider）** | `create-agent.test.ts` 的 `fakeProvider`、`packages/cli/test/cli.test.ts` 的 `scriptedProvider`：脚本让模型按顺序调 `session_create` / `session_send` | 同一个容器里两段互发、先落盘再投、ack marker；`wait` 的回信不双送；runner 失败 / 超时判红并置 closed、成功时 `alive = true`；非 main 的工具表；`alive = false` 则 `phase = null` |
| **跨进程（真 spawn）** | `packages/core/test/resident-v0.test.ts` 与 `fixtures/resident-host.ts`：已经会按 phase 起真进程、末行吐 JSON 报告；**加一个 phase**，两个进程各一段、同一个 `ECHO_HOME` | 两个 `start()` 都成功、各自的 `.lock`；A 发 B 不重启看到（目录 watch）；B 在 working 被杀后 A 列表里 `alive = false`；留言之后 `--resume` 第一轮看到。注意这条测试的 replay 阶段本来就有 ack 裁决窗口的抖动，新 phase 不要落在那个窗口里 |
| **壳（真 spawn `bin`）** | `cli.test.ts` 的 `spawnBin` | `--continue` 只挑 main 且 active；`/clear` 后旧段 closed、新段 main、`--resume` 旧段是清之前的对话；启动即退出不留目录；续了壳有提示 |

改公共类型（`SessionInfo`、`Echo`、`CreateEchoOptions`、`ExtensionDefinition`）要重录 API 快照；新文件先 `git add` 再跑分发门。现有测试里与旧语义绑定的要**同一次改**，不留兼容：`inbox-durable.test.ts` 的「恢复之后接着排号」「序号未恢复就 accept 抛」两条随 record id 改写者生成而改写；`create-agent.test.ts` 的 D6 四条随状态根改写；`compaction.test.ts` 用旧 `SessionManager` 的三处改 `InMemoryDir + SessionService`。
