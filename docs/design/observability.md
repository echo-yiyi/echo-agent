# 观测：一次 run 留下的账本

> 状态：已实现并在用（本文写的是**现状**，不是目标形态）；公开面尚未拍板，见「待拍板」<br>
> 读者：要读观测记录排查问题、给观测加事实、或把观测接到别处的人<br>
> 假设已读：[Run Loop 的四层](run-loop-layers.md)（run / reply / turn / attempt 的定义，本文直接用）、[会话就是状态根](sessions.md)（观测库住在哪一层）<br>
> 决策记录（本文只指向，论证在记录里）：[观测的公开线](../decisions/proposed/2026-09-07-observation-public-face.md)（**proposed**，A/B/C 未拍）

## 导读

**解决什么。** agent 跑完一次，除了终端上滚过去的字，什么都不剩。会话目录里的 `entries/` 是**功能用的回放队列**（模型要求原样带回上一轮的 reasoning，所以它必须留），不是给人读的历史：它没有时间、没有耗时、没有嵌套、没有失败原因，也不记「这次 run 装配了哪些 extension、绑了哪个模型」。想回答「这次为什么慢」「哪一步失败了」「模型到底想了什么」，没有第二个地方可查。观测层就是那个地方：**它是这个仓里唯一为「读」而存在的记录**。

**最终形态。** 每次 run 把自己写进会话状态根下的一个 SQLite 账本。**观测是插桩，不是事件协议**（§7）：循环、压缩、Agent 自身、extension 装载、各能力模块在自己的执行节点上各插一个**探针**，节点走到就当场记一条事实，与给壳的事件（`AgentEvent` / `LifecycleEvent`）并列、互不依赖。一条记录是一个 **envelope**（§2）：谁发的、什么时候、挂在哪个 run / turn 下、body 是什么。记录分两条 lane（§3）——run 的三条边界走 boundary lane（有序、可等），其余走 bounded lane（同步、永不抛、满了就留缺口而不是丢消息不吭声）。记多少由 **capture policy** 三档决定（§4）。读面有三个入口（§6）：`observe` 子命令、`echo.observations`、离线的 `openObservationReader()`。**一条贯穿全篇的纪律：观测拦不住 agent**——写不动就降级并如实报出来，绝不让 run 等、绝不拒 run、绝不把异常抛进 Agent 控制流（§5）。

**Non-Goals（已决，不做）。**

- **观测不订阅、不转发事件协议，也不为观测往事件协议里加成员**（2026-09-11 拍板）。事件协议是功能模块：agent 状态要给前端实时展示，形状由「前端要展示什么」决定；观测是插进执行过程的节点，留下整体运行状态供事后分析评估，覆盖面由「复盘与评估要什么」决定。两者耦合的后果实测过：循环的观测曾经转手 `AgentEvent`，于是 reply / attempt 事件没投影时落成看不出含义的 `agent.custom_event`，Dream 与子 agent 因为不想广播给前端而传了空 `emit`，内部在账本里一条都没有。
- **观测不判断进程死活**（2026-09-06 拍板）。观测只记别人做过的决定；没封口的 run 只说「未收尾」，不由观测推断它是崩了还是还在跑。`RunObservationStatus` 里的 `interrupted` 今天没有任何写者——将来若有管进程的那一层做了接管决定，由它把决定当事实交给观测记。会话死活另有其人，见[会话存活探针](../decisions/implemented/2026-09-09-session-alive-pid-probe.md)。
- **不脱敏。** `content` 档把模型文本、思考、工具参数与结果**明文**写进盘上的库。`redact.ts` 只处理第三方异常对象（stack 只留 digest），不是内容脱敏层。谁开这一档，谁承担盘上有明文这件事。
- **不做 retention / reopen / crash recovery**（列在「欠账」§8，不是本文要设计的东西）。
- **canonical store 不是用户可换的端口。** in-memory 实现只供参考一致性测试，`createEcho()` 装不进去；能不能换是[公开线那条记录](../decisions/proposed/2026-09-07-observation-public-face.md)要拍的事。
- 面板长什么样归 UI，本文只说它读什么。

**待拍板。** 一条，且卡着：[观测的公开线](../decisions/proposed/2026-09-07-observation-public-face.md) 的 A/B/C——650 行的类型面整份公开并冻结（A）、按「extension 作者要什么」划读面 / 写面（B）、还是公开但标 experimental（C）。不拍的代价写在那条记录里：线不画清，API 快照只能整份锁。**本文是那条记录说的「形态的家」**：接口形状在这里，取舍留在记录里。

**验收判据（机器可判）。** 现有门，全部已绿，改这一层时它们必须仍绿：

- `bun test packages/core/test/observability-sequencer.test.ts` —— lane 语义、seq 预留与 hole/gap 配对、prefix barrier、CAS。
- `bun test packages/core/test/observability-sqlite-store.test.ts` —— 同事务全见或全不见、幂等重提、corruption 判定。
- `bun test packages/core/test/observability-projection.test.ts` —— 循环 / 压缩 / Agent 自身事实的逐 kind 固定投影、三档的字段差异、投影抛错留 hole + gap、投影自身在同步预算内。
- `bun test packages/core/test/observability-runtime.test.ts` —— 真实 `createEcho → send → SQLite → reader` 链路：脚本化 run 的整段记录**逐项**比对执行顺序、run 开头与结尾两份同形的状态快照、run 之外的相位迁移。
- `bun test packages/core/test/observability-decisions.test.ts` —— 决定点：工具被拦的原因、等人审批的 span、每轮工作集、装备变更。
- `bun test packages/core/test/extension-observe.test.ts` —— extension 一代装上 / prepare 被拒 / apply 失败 / 卸下 / 卸载被拒。
- `bun test packages/core/test/observability-capture.test.ts` `observability-capabilities.test.ts` —— 三档的采集差异、各能力模块的事实。
- `bun test packages/core/test/observability-render.test.ts` —— renderer 是纯函数（golden 锁层级与相对顺序，不锁 wall clock）。
- `bun test packages/base/test/observe-serve.test.ts` —— 面板的路由、页面自检门（内联脚本能编译、配色规则）、术语表覆盖。

## 1. 术语

> 规范词表在仓库根 [CONTEXT.md](../../CONTEXT.md)；本表只列本文用到的，定义以那里为准。

| 词 | 定义 | 不表示什么 |
|---|---|---|
| **记录**（record） | 账本里的一行，形状是 envelope（§2） | 一条日志行；一个 AgentEvent |
| **事实**（fact） | 已经发生、由某个 owner 做出或观察到的事 | 推断出来的结论 |
| **探针**（probe） | 执行节点上的一次同步 `sink.offer(fact)`：节点走到就记，与该节点给壳发的事件并列 | 事件协议的订阅者；旁路跟着观察的后台进程 |
| **lane** | 记录进账本的两条通道：`boundary` 与 `bounded`（§3） | 优先级；队列 |
| **缺口**（gap） | 一段 seq 明确地没有记录，且这件事本身被记下来 | 数据丢了但没人知道 |
| **档**（capture policy） | `off` / `metadata` / `content` 三选一，决定记多少（§4） | 日志级别（它不筛「重要性」，只筛「正文进不进」） |
| **runtime** | 一个进程里的一份 canonical writer，`runtimeId` 是它的身份 | 一个 agent；一段会话 |

## 2. 一条记录长什么样

`ObservationEnvelope`（[types.ts](../../packages/core/src/observability/types.ts#symbol=ObservationEnvelope)）是账本的唯一行格式。只放 **JSON-safe 的值**：`ObservationValue` 是标量 / 数组 / 普通对象，运行期对象（Error、Uint8Array、bigint、Map……）在 Sequencer 里被归一或被拒，不靠 `JSON.stringify()` 静默删字段。

分四组看：

| 组 | 字段 | 谁给 |
|---|---|---|
| 身份 | `recordId` `seq` `observedAt` | **只有 Sequencer**。producer 给不了，给了也不认 |
| 是什么 | `kind`（`event` / `span_start` / `span_end` / `snapshot` / `health`）· `name` · `occurredAt` · `sourceSeq`（可选，今天没有生产者，见 §8） | producer |
| 挂在哪 | `scope`（`runtimeId` / `agentId` / `sessionId` / `runId` / `turnId` / `toolCallId` …）· `correlation` · `generation` | producer 给业务部分，`runtimeId` 由 Sequencer 盖 |
| 内容 | `owner` · `instrumentation` · `subject` · `attributes` · `body` | producer |

两条容易踩的规矩：

- **`attributes` 只放低基数的安全值**（string / number / boolean），正文一律进 `body`——`body` 受档管，`attributes` 不受。
- **身份是固定 schema**：白名单之外的键一律拒（[identity.ts](../../packages/core/src/observability/identity.ts#symbol=materializeDynamicIdentity) 头注）。否则多余键会原样落进 envelope，等于在身份区开一块不受档管的自由字段区。同一模块还解释了为什么「校验完必须返回快照、不能回头读 producer 的原对象」——两轮 review 实测过 TOCTOU：Proxy 检查时只露安全字段、编码时再露正文，照样落盘且没有 gap。

## 3. 两条 lane

[Sequencer](../../packages/core/src/observability/sequencer.ts#symbol=ObservationSequencer) 是 `recordId` / `seq` / `observedAt` 与 append 顺序的唯一 owner。producer 只提交 draft，identity、normalize、批、live 扇出全在它那里。两条 lane 两套 API，因为要的东西不一样：

| | `offer()`（bounded） | `appendBoundary()`（boundary） |
|---|---|---|
| 谁走 | 各执行节点的探针（§7） | run 的三条边界 + `run.assembly` |
| 同步性 | **同步、永不抛、没有 Promise** | 可等待 |
| 满了 / 编码失败 | 该 seq 当场成 **hole**，并在任何后续 producer 拿到 seq 之前预留下一个 seq 写一条 gap | 拒绝，调用方按 §5 降级 |
| 顺序保证 | 由**预留 seq**决定，不由落盘决定 | prefix barrier：worker 先把 `< B` 的全部记录 / 缺口排空，在含 B 及其 RunIndex 变更的同一事务提交并 read-back 到 `committedPrefix >= B` 才 resolve |

**为什么 bounded lane 不能抛、也不能等**：它被内建能力在自己的决策点直接调（`sink.offer(fact)`，[fact-sink.ts](../../packages/core/src/observability/fact-sink.ts#symbol=factSinkToIngest)）。那些点在 agent 主线上，一次异常或一次 await 就会把观测变成主线的一部分。

**缺口不是丢数据，是把「这里丢了」记下来。** `committed prefix` 只越过两类位置：已提交的记录，或被后续 gap 精确覆盖的 hole。缺口原因是封闭集合（`ObservationGapReason`）：`buffer_overflow` `encoding_error` `capture_limit` `store_failure` `canonical_flush_timeout` `lease_lost` `retention`——最后一个今天没有写者，见 §8。

**live 扇出严格在 COMMIT / read-back 之后按 seq 进行**：rollback 或结果不确定的候选记录永远不会被订阅者看见。

## 4. 三档

`ObservationCapturePolicy = "off" | "metadata" | "content"`。缺省 `metadata`，由 `createEcho({ observation: { capture } })` 或 CLI 的 `--observe` 选。

| 档 | 记什么 | 典型用途 |
|---|---|---|
| `off` | 不生成任何记录 | 不想要账本 |
| `metadata` | 形状与计数：块数、字符数、工具调用数、token 用量、耗时、错误码 | 缺省。够回答「哪步慢、哪步失败」 |
| `content` | 上面全部，**加**模型文本、思考、工具参数与结果、错误消息，明文落盘 | 要回答「模型到底说了 / 想了什么」 |

三条要知道的代价：

1. **明文落盘，不脱敏**（Non-Goals 已述）。
2. **单条记录有预算**：超过就成 `capture_limit` 缺口。正文在投影时先按字节预算截断并标 `textTruncated` / `thinkingTruncated`，思考与回答**各有份额**——思考封顶在正文预算的一半，回答拿剩下的，两边合计不超总预算。原因写在 [loop/observe.ts](../../packages/core/src/loop/observe.ts#symbol=MAX_PROJECTED_THINKING_BYTES) 的注释里：另开一份等量预算会让 body 翻倍、整条记录穿不过 Sequencer 被丢掉，那是丢更多事实。
3. **`content` 档下流式增量逐条成记录**（`model.generate.delta`、`tool.execute.progress`）。库因此涨得快得多——而今天没有 retention（§8）。

## 5. 观测拦不住 agent

2026-09-03 拍板放弃 fail-closed admission。今天的语义（[runtime.ts](../../packages/core/src/observability/runtime.ts#symbol=ObservationRuntime) 头注）：

- `run.accepted` / `run.assembly` / `run.started` **只同步预留 seq**，提交是 fire-and-forget。落不下去只降级 persistence + 发诊断，**永不拒 run、永不让 run 等**。
- `run.closed` 仍等它 COMMIT——它在 run 的活干完之后，`send()` 靠它如实报 `observationPersistence`。等待**有界**（`boundaryDeadlineMs`，`createAgent` 定为 500ms），到期即降级返回。
- `ObservationRuntime` 每个公开方法都不抛。

于是调用方拿到的是三个可读的信号，而不是一次异常：

| 信号 | 含义 |
|---|---|
| `observationPersistence` | `healthy` / `degraded` / `recovering` / sealed。**当前 runtime 的投影**：terminal 已进 index 才 `stored` |
| `observationIntegrity` | `complete` / `partial`——`partial` 表示这条 run 的记录里有缺口 |
| `RunObservationStatus` | run 的业务终态：`running` / `completed` / `aborted` / `error`（`interrupted` 无写者） |

**corruption 是唯一 fail-loud 的一类**：同 `recordId` 不同 bytes、半批可见、RunIndex digest 漂移——store 立即抛，writer 被 seal，reader 不「修复」。这不是可降级的错误，是账本不再可信。

## 6. 读面

三个入口，读的是同一份账本：

| 入口 | 形状 | 取锁 | 用途 |
|---|---|---|---|
| `observe` 子命令 | `last` / `show <run-id>` / `export` / `health` / `serve` | **不取** | 命令行排查；`serve` 是本地只读面板 |
| `echo.observations` | `EchoObservations`：`getRun` `lastRun` `listRuns` `snapshot` `subscribe` | 已在 runtime 内 | 宿主自己读 / 订阅 |
| `openObservationReader({ stateRoot })` | `EchoObservationReader`：同上去掉 `subscribe`，多一个 `close()` | **不取** | 离线读一个状态根 |

两条性质值得单说：

- **只读入口不启动 agent、不取会话锁**，所以正在跑的会话也能读——读到的是它已 COMMIT 的部分。reader 走独立的 read-only 连接，只看已提交快照。
- **renderer 是纯函数**（[render.ts](../../packages/core/src/observability/render.ts#symbol=renderRunObservation) 头注）：`buildRunObservationViewModel()` 与 `renderRunObservation()` 不读 Agent、不查 store、不看订阅状态，也不改原 envelope。同一批记录必然同一输出，所以能上 golden。时间全部相对 `acceptedAt`，golden 不锁 wall clock。

**跨会话是在装配层做的，不在 core**：core 守「一个 journal、一个 reader」，`packages/base` 的 `SessionObservationReaders` 给每段会话开一个只读 reader 再合并。所以不给 `--session` 时一个面板能看整个集群。

## 7. 谁在发事实

**观测是插桩，不是事件协议。** 每个发口在自己的执行节点上插一个探针：节点走到，就同步 `offer` 一条事实。给壳的事件在同一个节点上照常 `emit`，两条输出**并列、互不依赖**——观测不订阅、不转发事件，事件为前端改形状也不改变观测记下什么。探针放在 `emit` **之前**：它同步、永不抛，`emit` 自己坏了，「到过这个节点」也已记下。

各发口拥有自己的窄 fact union 与 descriptor——**descriptor 与语义 owner 共址，不住中央 switch**：

| 发口 | 模块 | 记什么 |
|---|---|---|
| 循环 | [loop/observe.ts](../../packages/core/src/loop/observe.ts#symbol=loopFactDescriptor) | run / reply / turn / attempt 四层（turn 开头带本轮冻结的工具工作集）、模型生成与流式增量、工具执行与进展、重试、用量、**工具被拦**（`tool.rejected`）、**等人审批**（`permission.wait` span） |
| 压缩 | [compaction/observe.ts](../../packages/core/src/compaction/observe.ts#symbol=compactionFactDescriptor) | 一次压缩的起止、**压缩失败**（某个阶段抛错被跳过，或整条流水线没有一段改动上下文） |
| Agent 自身 | [agent-observe.ts](../../packages/core/src/agent-observe.ts#symbol=agentFactDescriptor) | **生命周期相位**迁移、**装备变更**（模型 / 思考档）、队列长度、资源注册与卸载、**run 开头的整体状态**（`agent.state`） |
| extension | [extension/observe.ts](../../packages/core/src/extension/observe.ts#symbol=extensionFactDescriptor) | 一代装上（每个 extension 提供了什么、依赖的服务实际连到了谁）/ 没装上（prepare 被拒或 apply 抛错并回滚）/ 卸下 / 卸载被拒 |
| 记忆 | `memory/observe.ts` | 回忆、写入、提取 |
| 任务 | `task/observe.ts` | 状态变更、落盘 |
| 闹钟 | `schedule/observe.ts` | 排程、触发、取消 |
| 收件 | `inbox/observe.ts` | accepted / rejected / restored / consumed / acked / released / sealed |

run 的三条边界 + `run.assembly` 由 `ObservationRuntime` 独家发，不走 descriptor。

几类事实值得单说：

- **决定点。** 工具在执行之前被拦下的调用**不发 `tool.execute`**，所以每个拦截分支各记一条 `tool.rejected`：`stage`（lookup / arguments / preToolUse / permission / postToolUse）、`cause`、`decidedBy`。词汇沿用 `LifecycleEvent` 里已有的。只有真正进了 ask 才有 `permission.wait`，结束探针在裁决落下的那一刻记，span 时长就是等人的时间。原因文本可能来自 hook 或人工输入，只在 `content` 档进 body。
- **整体运行状态。** run 开头（`agent.state` 快照）与结尾（`run.closed` 里的 `finalSnapshot`）各一份，**同形、同一个校验器**（[terminal.ts](../../packages/core/src/observability/terminal.ts#symbol=materializeObservableState)）：状态、装备（思考档、工具 / skill 名单）、上下文占用、工作目录、各能力的计数摘要（`echo:tasks` / `echo:scheduler` / `echo:agent` 的收件箱）。模型与绑定不重复记——它们在 `run.assembly`。校验是**白名单重建**：只有逐个校验过的字段进副本，加字段必须同时扩白名单，否则会在封口时被静默剥掉。
- **生命周期相位。** `Agent` 里所有相位写入都经 [`Agent.setPhase`](../../packages/core/src/agent.ts#symbol=Agent.setPhase)，节点就是它；丢锁那一拍也在这里当场记——这是 Agent 自己做的迁移，不是观测推断死活。**`stopping → stopped` 进不了账本**：观测写入端是 stop 流程里被关掉的东西之一（排在 root store 关闭与空会话目录清理之前，这个顺序不能动），`stopped` 在它之后才成立。一次正常收摊的最后一拍相位是 `running → stopping`。
- **extension。** 按**代**记，不按 Fiber 记：装载是全有或全无的事务。发生在任何 run 之外，进「运行时活动」。

**新工具自动进观测**：工具执行的事实只有一个来源（`loop/run-turn.ts` 的探针），所以产品加工具不需要额外埋点。但**面板要念出人话**得在术语表 `packages/base/src/observe/lexicon.ts` 里登记——没登记只会显示原始名字。那份表是手抄的快照，不是推导出来的门（§8）。

## 8. 欠账

按「会不会随时间恶化」排：

1. **没有 retention。** 库只涨不清，`content` 档下涨得更快。**类型与机制已经全部就位却空转**：`ObservationGapReason` 里有 `"retention"`、`types.ts` 有 `retention-gap` 的传输通知、RunIndex 有 `pruned` 标记、`query.ts` 注释写着「O3b 才会真的产生 pruned 行」——今天没有任何东西真的裁剪。这是唯一会随时间恶化的一条。
2. **降级后不自动 reopen**，**没有 crash recovery 的库层部分**（[sqlite-store.ts](../../packages/core/src/observability/sqlite-store.ts#symbol=SqliteCanonicalObservationStore) 头注自己写着「O3a 不做，O3b 做」）。注意这条**不包含**「给崩掉的 run 补终态」——那属于 Non-Goals 的第一条。
3. **TUI 形态不打 runId**，只有管道形态打。从 TUI 跑的会话，终端上看不到该拿哪个 id 去 `observe show`。
4. **超预算的记录只能成缺口**，没有 attachment / blob 旁路。
5. **`bun:sqlite` 是同步调用**，没隔 Worker：磁盘真挂住会占事件循环。
6. **术语表是手抄快照**：core 加了记录名、产品加了工具，`lexicon.ts` 不会自己红。要立成门得让 core 导出记录名清单、让工具注册表可枚举。
7. **子循环没有观测。** Dream、记忆提取、子 agent 共用的 [`Agent.runSubagent`](../../packages/core/src/agent.ts#symbol=Agent.runSubagent) 不挂探针，内部的 turn / 模型 / 工具不进账本。接上之前要先定记录挂在哪：后台子 agent 在父 run 封口之后才跑，scope 供给会把事实记进无关的 run；同一批并发的前台子 agent 挂着同一个父 turn，span 配对键相同会互相配错；Dream 与提取的 runId 不在 RunIndex 里。
8. **记忆的能力摘要没接。** 状态快照的能力摘要跑在同步封口路径上，记忆的状态在盘上要异步读。
9. **`sourceSeq` 没有生产者。** 它原本是转手 `AgentEvent` 时带的事件 seq；观测改成插桩之后没有任何记录再带它。envelope 上这个可选字段留在已发布的公开类型里没删。
10. **同一个能力有两套 Entry id。** `run.assembly` 的槽位写 `echo:task` / `echo:schedule` / `echo:inbox`，而真实装上的 extension 与能力事实的 owner 是 `echo:tasks` / `echo:scheduler` / `echo:agent`——两份记录按 id 对不上。状态快照的能力摘要用的是后者。
