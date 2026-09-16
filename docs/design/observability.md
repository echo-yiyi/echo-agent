# 可观测性：运行记录与诊断

> 状态：已实现并在用（本文写的是**现状**，不是目标形态）；公开面尚未拍板，见「待拍板」<br>
> 读者：要读观测记录排查问题、给观测加事实、或把观测接到别处的人<br>
> 假设已读：[Run Loop 的四层](run-loop-layers.md)（run / reply / turn / attempt 的定义，本文直接用）、[会话就是状态根](sessions.md)（观测库住在哪一层）<br>
> 决策记录（本文只指向，论证在记录里）：[观测的公开线](../decisions/proposed/2026-09-07-observation-public-face.md)（B 已拍、未实现）、[观测的默认存储改成状态根里的文档，过期规则归产品](../decisions/implemented/2026-09-14-observation-document-store.md)（部分被下一条推翻）、[观测不进主流程](../decisions/implemented/2026-09-14-observation-off-main-loop.md)

## 导读

**解决什么。** 回答一次运行在哪耗时、何处失败、采用了什么装备，以及在允许采集正文时实际交换了什么内容。session 账本服务于恢复，观测账本服务于诊断，两者职责不同。

**最终形态。** 每次 run 把自己写进会话状态根下的一组观测文档（§5）。**观测是插桩，不是事件协议**（§7）：循环、压缩、Agent 自身、extension 装载、各能力模块在自己的执行节点上各插一个**探针**，节点走到就当场记一条事实，与给壳的事件（`AgentEvent` / `LifecycleEvent`）并列、互不依赖。一条记录是一个 **envelope**（§2）：谁发的、什么时候、挂在哪个 run / turn 下、body 是什么。记录分两条 lane（§3）——run 的三条边界走 boundary lane（有序、可等），其余走 bounded lane（同步、永不抛、满了就留缺口而不是丢消息不吭声）。记多少由 **capture policy** 三档决定（§4）。读面有三个入口（§6）：`observe` 子命令、`echo.observations`、离线的 `openObservationReader()`。**一条贯穿全篇的硬规矩：观测的任何功能都不出现在主机制、主循环里**（2026-09-14，[记录](../decisions/implemented/2026-09-14-observation-off-main-loop.md)）——探针在节点上只取一次字段交给进程里的**观测线程**，编码、摘要、seq、落盘都在那边；admission、装配、`start` / `stop`、lease、run 生命周期都不为观测等待、不为观测计算、不因观测多一种失败（§5）。留多久由产品自己定：两个产品都声明「只留最近 30 天」，由启动逻辑不等地跑一遍，agent 里没有过期代码（§5）。

**Non-Goals（已决，不做）。**

- **观测不订阅、不转发事件协议，也不为观测往事件协议里加成员**（2026-09-11 拍板）。事件协议是功能模块：agent 状态要给前端实时展示，形状由「前端要展示什么」决定；观测是插进执行过程的节点，留下整体运行状态供事后分析评估，覆盖面由「复盘与评估要什么」决定。两者耦合的后果实测过：循环的观测曾经转手 `AgentEvent`，于是 reply / attempt 事件没投影时落成看不出含义的 `agent.custom_event`，Dream 与子 agent 因为不想广播给前端而传了空 `emit`，内部在账本里一条都没有。
- **观测不判断进程死活**（2026-09-06 拍板）。观测只记别人做过的决定；没封口的 run 只说「未收尾」，不由观测推断它是崩了还是还在跑。所以 `RunObservationStatus` 里没有「被接管封口」那一档（2026-09-15 删掉没有写者的 `interrupted`）——将来若有管进程的那一层做了接管决定，由它把决定当事实交给观测记，那时再加。会话死活另有其人，见[会话存活探针](../decisions/implemented/2026-09-09-session-alive-pid-probe.md)。
- **不脱敏。** `content` 档把模型文本、思考、工具参数与结果**明文**写进盘上的观测文档。`redact.ts` 只处理第三方异常对象（stack 只留 digest），不是内容脱敏层。谁开这一档，谁承担盘上有明文这件事。
- **不做 crash recovery**（列在「欠账」§8，不是本文要设计的东西）。
- **不在 agent 的任何流程里清理，core 也不内置清理规则。** 留多久、留多少归产品：产品不给规则就一条不删；core 不在启动、run 封口、lease 的任何一步上跑它（§5）。装配层只管**什么时候跑产品给的规则**，那一步不在 agent 的流程里、也不让谁等它。旧格式的 `observations.sqlite` 不迁移、不读（[记录](../decisions/implemented/2026-09-14-observation-document-store.md)）。
- **语义层的 canonical store 不是用户可换的端口**，只开字节面：`observation.store?: StorageDir` 决定文档放在哪（内存 / 别处），格式与提交语义仍是 core 的（§5）。in-memory 的 `CanonicalObservationStore` 只供参考一致性测试。「换成另一种数据库」的注入等真有使用方再拍（[记录](../decisions/implemented/2026-09-14-observation-document-store.md)决定 4）。
- 面板长什么样归 UI，本文只说它读什么。

**待拍板。** 一条，本文只指过去、不复述：[观测的公开线](../decisions/proposed/2026-09-07-observation-public-face.md)——B 已于 2026-09-07 拍板（读面与 extension 发口公开、写面内部），**未实现**；本文按实现前的现状写。**本文是那条记录说的「形态的家」**：接口形状在这里，取舍留在记录里。

**验收判据（机器可判）。** 现有门，全部已绿，改这一层时它们必须仍绿：

- `bun test packages/core/test/observability-sequencer.test.ts` —— lane 语义、seq 预留与 hole/gap 配对、prefix barrier、CAS、run 边界 body 的封闭校验（含子循环来源与 `startedBy`）。
- `bun test packages/core/test/observability-document-store.test.ts` —— 文档存储：与 in-memory 参考实现同一套提交裁决、提交点在 rename 前后停下时读面、派生文件落后时下一次提交补上且 head 不越过、过期只凭盘上事实删（已封口的 run、head 之前的批）、回放跨过被删的批时交付 `retention-gap`。
- `bun test packages/core/test/observability-projection.test.ts` —— 循环 / 压缩 / Agent 自身事实的逐 kind 固定投影、三档的字段差异、投影抛错留 hole + gap、投影自身在同步预算内（探针两半直连，只省掉线程那一跳）。
- `bun test packages/core/test/observability-runtime.test.ts` —— 真实 `createEcho → send → 观测线程 → 观测文档 → reader` 链路：脚本化 run 的整段记录**逐项**比对执行顺序、run 开头与结尾两份同形的状态快照、run 之外的相位迁移、前台 / 后台子 agent 各是自己的 run 并链回派出它的工具调用；**观测存储完全卡住时 `createEcho` / `send` / `stop` 都不等**、进程等观测线程写完才退且 exit 监听照常运行、存储卡死时最多再等 `STALL_MS`、观测丢数据不发任何通知、起线程抛错装配照常、产品在活着的 agent 旁边调 `expireObservations()`。
- `bun test test/distribution-gate.test.ts` —— Node 从 dist 起观测线程：`stop()` 不等，下一个进程读得到最后一个 run。
- `bun test packages/core/test/observability-decisions.test.ts` —— 决定点：工具被拦的原因、等人审批的 span、每轮工作集、装备变更。
- `bun test packages/core/test/extension-observe.test.ts` —— extension 一代装上 / prepare 被拒 / apply 失败 / 卸下 / 卸载被拒。
- `bun test packages/core/test/observability-capture.test.ts` `observability-capabilities.test.ts` —— 三档的采集差异、各能力模块的事实。
- `bun test packages/core/test/observability-render.test.ts` —— renderer 是纯函数（golden 锁层级与相对顺序，不锁 wall clock）。
- `bun test packages/base/test/observe-serve.test.ts` —— 面板的路由、页面自检门（内联脚本能编译、配色规则）、术语表覆盖。
- `bun test packages/base/test/observe-expire.test.ts packages/cli/test/cli.test.ts` —— 产品的过期规则（只删超期且已封口的、坏的那一段不连累别段）与启动时那一跑（产品给了规则才清，不给一条不删）。

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
| **观测线程** | 进程里的一条 Worker 线程，所有 runtime 共用：Sequencer、摘要、写文件都在它上面（§5） | 每个 agent 一条；子进程 |

## 2. 一条记录长什么样

`ObservationEnvelope`（[types.ts](../../packages/core/src/observability/types.ts#symbol=ObservationEnvelope)）是账本的唯一行格式。只放 **JSON-safe 的值**：`ObservationValue` 是标量 / 数组 / 普通对象，运行期对象（Error、Uint8Array、bigint、Map……）在 Sequencer 里被归一或被拒，不靠 `JSON.stringify()` 静默删字段。

分四组看：

| 组 | 字段 | 谁给 |
|---|---|---|
| 身份 | `recordId` `seq` `observedAt` | **只有 Sequencer**。producer 给不了，给了也不认 |
| 是什么 | `kind`（`event` / `span_start` / `span_end` / `snapshot` / `health`）· `name` · `occurredAt` | producer |
| 挂在哪 | `scope`（`runtimeId` / `agentId` / `sessionId` / `runId` / `turnId` / `toolCallId` …）· `correlation` · `generation` | producer 给业务部分，`runtimeId` 由 Sequencer 盖 |
| 内容 | `owner` · `instrumentation` · `subject` · `attributes` · `body` | producer |

两条容易踩的规矩：

- **`attributes` 只放低基数的安全值**（string / number / boolean），正文一律进 `body`——`body` 受档管，`attributes` 不受。
- **身份是固定 schema**：白名单之外的键一律拒（[identity.ts](../../packages/core/src/observability/identity.ts#symbol=materializeDynamicIdentity) 头注）。否则多余键会原样落进 envelope，等于在身份区开一块不受档管的自由字段区。校验后使用重建的快照，不再次读取 producer 原对象，避免校验与编码读取到不同值。

## 3. 两条 lane

[Sequencer](../../packages/core/src/observability/sequencer.ts#symbol=ObservationSequencer) 是 `recordId` / `seq` / `observedAt` 与 append 顺序的唯一 owner。producer 只提交 draft，identity、normalize、批、live 扇出全在它那里。两条 lane 两套 API，因为要的东西不一样：

| | `offer()`（bounded） | `appendBoundary()`（boundary） |
|---|---|---|
| 谁走 | 各执行节点的探针（§7） | run 的三条边界 + `run.assembly` |
| 同步性 | **同步、永不抛、没有 Promise** | **同步、没有 Promise**：预留完立刻安排提交，不等攒批 |
| 满了 / 编码失败 | 该 seq 当场成 **hole**，并在任何后续 producer 拿到 seq 之前预留下一个 seq 写一条 gap | body 非法 / 编码失败同样是 hole + gap；生命周期不合法（重复发、缺前置）或写入端已 seal 时什么都不留 |
| 顺序保证 | 由**预留 seq**决定，不由落盘决定 | prefix barrier：`< B` 的全部记录 / 缺口按批上限一批批先提交，B 与它的 RunIndex 变更在同一事务，一直推到 `committedPrefix >= B` |

**为什么探针不能抛、也不能等**：它被内建能力在自己的决策点直接调（`sink.offer(fact)`，[fact-sink.ts](../../packages/core/src/observability/fact-sink.ts#symbol=factSinkToThread)）。那些点在 agent 主线上，一次异常或一次 await 就会把观测变成主线的一部分。所以探针在主线程上只读 scope、投影、交出去；Sequencer 的两条 lane 都在观测线程里（[thread-host.ts](../../packages/core/src/observability/thread-host.ts#symbol=ingestFact)）。

**缺口不是丢数据，是把「这里丢了」记下来。** `committed prefix` 只越过两类位置：已提交的记录，或被后续 gap 精确覆盖的 hole。缺口原因是封闭集合（`ObservationGapReason`）：`buffer_overflow`（ring 满）、`encoding_error`（编码不了）、`capture_limit`（可选快照超预算）、`retention`（回放跨过被过期删掉的批）。**每个都有写者**——没有写者的值 2026-09-15 已从公开类型里删掉。

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
2. **单条记录有预算**：超过就成 `capture_limit` 缺口。工具载荷在投影时就收进预算：结果正文与字符串进展截断并标 `resultTruncated` / `partialTruncated`，截不了半个的结构化载荷（参数、结果 metadata、对象进展、`tool_use` 的 input）放不进就不带、标 `paramsOmitted` / `metadataOmitted` / `partialOmitted` / `inputOmitted`——注定超预算的整份不交给观测线程。正文在投影时先按字节预算截断并标 `textTruncated` / `thinkingTruncated`，思考与回答**各有份额**——思考封顶在正文预算的一半，回答拿剩下的，两边合计不超总预算。原因写在 [loop/observe.ts](../../packages/core/src/loop/observe.ts#symbol=MAX_PROJECTED_THINKING_BYTES) 的注释里：另开一份等量预算会让 body 翻倍、整条记录穿不过 Sequencer 被丢掉，那是丢更多事实。
3. **`content` 档下流式增量逐条成记录**（`model.generate.delta`、`tool.execute.progress`）。库因此涨得快得多——清不清、清多少由产品的过期规则定（§5）。

## 5. 观测不在主流程上

2026-09-03 放弃 fail-closed admission；2026-09-14 定成硬规矩：**观测的任何功能都不出现在主机制、主循环里**（[记录](../decisions/implemented/2026-09-14-observation-off-main-loop.md)）。今天的语义（[runtime.ts](../../packages/core/src/observability/runtime.ts#symbol=ObservationRuntime) 头注）：

- 主线程上的 [`ObservationRuntime`](../../packages/core/src/observability/runtime.ts#symbol=ObservationRuntime) 只**交东西出去**：探针的投影、run 三条边界的输入、Agent 此刻的状态原始值。每个方法同步返回、不抛、不等。admission 不等 `run.closed`，`createEcho()` 不碰观测存储，`stop()` 不等写完，观测不挂 lease。
- **观测线程**（[thread-host.ts](../../packages/core/src/observability/thread-host.ts#symbol=ObservationThreadHost)，入口 `observation-worker.ts`）：进程里一条，所有 runtime 共用；每个 runtime 一份 Sequencer + 写入端，消息按到达顺序处理（就是探针被调的顺序）。原来在节点上做的——scope 物化、normalize、run 边界与装配快照的构造、各种摘要（能力状态、模型绑定、错误原文、记忆路径 HMAC）——都在这里。descriptor 要摘要时在投影里声明 `digests`，由观测线程算。
- **主线程上还剩的**：descriptor 的有界投影、读一次 scope 供给、一次 `postMessage`；以及替观测线程执行它要的存储操作（注入的 `StorageDir` 是主线程上的对象，过不了线程；只转发异步调用）。
- **观测出问题不往外报**（2026-09-14 拍板：观测本身就是日志，它坏了再发通知或打日志没有意义）：写不动、编码不了、线程起不来或坏掉，都不进 agent 的诊断 / 通知通道，也不打日志。丢掉的事实照旧留 hole + gap，写入端的状态在 `snapshot().health` 里。**永不拒 run、永不让 run 等**。
- **进程退出**：交出工作消息时线程 `ref`，线程报「处理到最后一条、手上没有要写的」时 `unref`——`stop()` 不等，进程等观测写完才退。**不无限等**：线程拖着进程期间连续 [`STALL_MS`](../../packages/core/src/observability/thread.ts#symbol=STALL_MS)（5 秒）没有任何进展，就放开进程，没写完的观测随进程一起丢。线程从不 `terminate`（Bun 实测 terminate 后进程的 exit 监听不再运行）。要在 `stop()` 之后删 / 搬状态根的调用方先 `await echo.observations.flush()`。

**存在哪：状态根里的文档**（[决策](../decisions/implemented/2026-09-14-observation-document-store.md)）。写入端是 [`DocumentObservationStore`](../../packages/core/src/observability/document-store.ts#symbol=DocumentObservationStore)，经 `StorageDir`（缺省是状态根的存储，`observation.store` 可换）写在 `observability/` 下：

| 路径 | 是什么 |
|---|---|
| `batches/<runtimeId>/<nextPrefix>.json` | 一次提交一个文件：这一批的记录（canonical JSON 原文）与它改动的 RunIndex。**rename 完成就是提交点** |
| `runs/<runId>.json` | 这个 run 的 RunIndex（header + firstSeq / lastSeq）——派生，写失败下次补 |
| `heads/<runtimeId>.json` | 这个 runtime 提交到哪——派生 |
| `key.json` | 记忆路径的 HMAC key，首建写一次、永不改写，读面不读 |

Sequencer 的契约没变：一批几个 run 的记录与 RunIndex 在同一个批文件里，一次 rename 同时可见；批文件已存在且逐字相同是幂等重提，不同是 corruption；head 与 RunIndex 的 CAS 对的是写入端内存里的值（每个进程的 runtimeId 是新的，只写自己的批文件、自己 run 的 `runs/`、自己的 `heads/`，与别的进程不相交，所以不需要 lease）。派生文件的写入顺序是约定：**先 `runs/`、后 `heads/`**——过期靠它判断批文件能不能删。

**什么时候开始写**：runtime 第一次有 `run.accepted` 或第一次被读才打开写入端（读或建 `key.json`）；之前事实只进 ring（有界，满了记缺口）。收摊时从没开始写的 runtime 直接丢：一句话都没说过的会话，状态根会被整个删掉，不能有迟到的文件把目录建回来（删之前主线程先同步关掉这个 runtime 的存储闸）。派生文件没写成时下一次提交补上；进程在两者之间退出，那几个 run 就列不出来——不做崩溃恢复。

**过期：产品自己调，agent 里没有**。[`expireObservations({ stateRoot | store, rule, now? })`](../../packages/core/src/observability/expiry.ts#symbol=expireObservations)：规则拿到全部 run 的 header（新的在前）与此刻，返回 `{ runs?, activityBefore? }`。什么时候、在哪儿调归产品（定时器、另起进程、空闲时）；不调就一条不删。执行只凭**盘上的事实**，不取锁、不问写入端，所以能在活着的 agent 旁边调：

- 只删盘上**已封口**的 run（RunIndex 有终态记录）：封口之后写者不再写这个 run 的任何文件。没封口的列进结果的 `openRuns`。删了之后 `getRun()` 是 `unknown`。
- 批文件只在 `nextCommittedPrefix ≤ head`、里面出现过的 run 都已不在 `runs/`、run 之外的记录都早于 `activityBefore` 时回收。
- 订阅回放跨过被删的批，交付 `retention-gap`（传输通知，不进 journal、不改 integrity）。

**今天两个产品怎么调**（2026-09-15 拍板）：`echo-agent` 与 `echo-coding` 各自在自己的 `Product` 上声明 [`observationExpiry: retainRecentDays(30)`](../../packages/base/src/observe/expire.ts#symbol=retainRecentDays)——两个产品平级，规则各写各的。时机归装配层：[`mainFor()`](../../packages/base/src/cli.ts#symbol=mainFor) 启动时**不等地**跑一遍 [`expireSessionObservations`](../../packages/base/src/observe/expire.ts#symbol=expireSessionObservations)，失败不报——观测的任何功能都不许让启动多等一拍。扫的是**会话根下每一段**，不是当前这一段：缺省每次启动都新建一段，只清自己那一段等于什么都不清。某一段的观测坏了只跳过那一段。

**`send()` 不带观测状态**：它只返回 `runId`、`outcome` 与观测引用。写没写成事后读，调用方拿到的是三个可读的信号，而不是一次异常：

| 信号 | 在哪读 | 含义 |
|---|---|---|
| `persistence` | `snapshot().health.persistence` | 写入端此刻的 `healthy` / `sealed` 两态，封口时带 `terminalSince` 与 `lastErrorDigest`。**不在 run 的 header 上**：run 的记录进没进账本看 `integrity`，run 在不在看 `getRun()` 的两态 |
| `integrity` | `getRun()` 的 header | `complete` / `partial`——`partial` 表示这条 run 的记录里有缺口 |
| `status` | `getRun()` 的 header | run 的业务终态：`running` / `completed` / `aborted` / `error` |

**corruption 是唯一 fail-loud 的一类**：同一个批文件内容不同、committed prefix 或 RunIndex digest 的 CAS 不符、RunIndex 引用了不存在的记录、文档不是它该是的形状——store 立即抛，writer 被 seal，reader 不「修复」。这不是可降级的错误，是账本不再可信。

## 6. 读面

三个入口，读的是同一份账本：

| 入口 | 形状 | 取锁 | 用途 |
|---|---|---|---|
| `observe` 子命令 | `last` / `show <run-id>` / `export` / `health` / `serve` | **不取** | 命令行排查；`serve` 是本地只读面板 |
| `echo.observations` | `EchoObservations`：`getRun` `lastRun` `listRuns` `snapshot` `subscribe` `flush` | 已在 runtime 内 | 宿主自己读 / 订阅；读之前先等观测线程写完此刻之前交出去的 |
| `openObservationReader({ stateRoot })` | `EchoObservationReader`：同上去掉 `subscribe` 与 `flush`，多一个 `close()` | **不取** | 离线读一个状态根 |

读面性质如下：

- **只读入口不启动 agent、不取会话锁**，所以正在跑的会话也能读——读到的是它已提交的部分。reader 只读 rename 完成的文档，看不到半截；`runs/` 最多落后正在写派生文件的那一批。
- **`getRun()` 只有两态**：`found` / `unknown`（从未有过，或已被过期规则删掉）。
- **`lastRun()` 是最近一次顶层 run**：隔离子循环（§7）是某个 run 派出来的，`source` 带 `parentRunId`，不算「上一次」。`listRuns()` 照常列出全部。
- **列举顺序新的在前**（[`RunIndexOrderKey`](../../packages/core/src/observability/document-store.ts#symbol=RunIndexOrderKey)）：`acceptedAt` 倒序；同一毫秒时，同一个 runtime 内按 `firstSeq` 倒序（`run.accepted` 的 seq 就是 admission 顺序），跨 runtime 按 `runtimeId` 定一个固定次序——跨 runtime 的 seq 各数各的，没有可比的先后。三段逐级比较是全序，分页游标带的就是这三个字段，所以翻页不重不漏。
- **renderer 是纯函数**（[render.ts](../../packages/core/src/observability/render.ts#symbol=renderRunObservation) 头注）：`buildRunObservationViewModel()` 与 `renderRunObservation()` 不读 Agent、不查 store、不看订阅状态，也不改原 envelope。同一批记录必然同一输出，所以能上 golden。时间全部相对 `acceptedAt`，golden 不锁 wall clock。

**跨会话是在装配层做的，不在 core**：core 守「一个状态根、一个 reader」，`packages/base` 的 `SessionObservationReaders` 给每段会话开一个只读 reader 再合并。所以不给 `--session` 时一个面板能看整个集群。只有旧格式 `observations.sqlite` 的会话记进读不了的会话，原因写「旧格式观测，已不再读取」。

## 7. 谁在发事实

**观测是插桩，不是事件协议。** 每个发口在自己的执行节点上插一个探针：节点走到，就同步 `offer` 一条事实。给壳的事件在同一个节点上照常 `emit`，两条输出**并列、互不依赖**——观测不订阅、不转发事件，事件为前端改形状也不改变观测记下什么。探针放在 `emit` **之前**：它同步、永不抛，`emit` 自己坏了，「到过这个节点」也已记下。

各发口拥有自己的窄 fact union 与 descriptor——**descriptor 与语义 owner 共址，不住中央 switch**：

| 发口 | 模块 | 记什么 |
|---|---|---|
| 循环 | [loop/observe.ts](../../packages/core/src/loop/observe.ts#symbol=loopFactDescriptor) | run / reply / turn / attempt 四层（turn 开头带本轮冻结的工具工作集）、模型生成与流式增量、工具执行与进展、重试、用量、**工具被拦**（`tool.rejected`）、**等人审批**（`permission.wait` span） |
| 压缩 | [compaction/observe.ts](../../packages/core/src/compaction/observe.ts#symbol=compactionFactDescriptor) | 一次压缩的起止、**压缩失败**（某个阶段抛错被跳过，或整条流水线没有一段改动上下文） |
| Agent 自身 | [agent-observe.ts](../../packages/core/src/agent-observe.ts#symbol=agentFactDescriptor) | **生命周期相位**迁移、**装备变更**（模型 / 思考档）、队列长度、资源注册与卸载。**run 开头的整体状态**（`agent.state`）随 `run.started` 一起交出，由观测线程记 |
| extension | [extension/observe.ts](../../packages/core/src/extension/observe.ts#symbol=extensionFactDescriptor) | 一代装上（每个 extension 提供了什么、依赖的服务实际连到了谁）/ 没装上（prepare 被拒或 apply 抛错并回滚）/ 卸下 / 卸载被拒 |
| 记忆 | `memory/observe.ts` | 回忆、写入、提取 |
| 任务 | `task/observe.ts` | 状态变更、落盘 |
| 闹钟 | `schedule/observe.ts` | 排程、触发、取消 |
| 收件 | `inbox/observe.ts` | accepted / rejected / restored / consumed / acked / released / sealed |

run 的三条边界 + `run.assembly` 由 `ObservationRuntime` 独家发，不走 descriptor。调它的有两处：admission 颁发的 run 由 permit 的 executor / finalizer 调；隔离子循环由派出它的 [`Agent.runSubagent`](../../packages/core/src/agent.ts#symbol=Agent.runSubagent) 调（见下面「子循环」）。

几类事实值得单说：

- **决定点。** 工具在执行之前被拦下的调用**不发 `tool.execute`**，所以每个拦截分支各记一条 `tool.rejected`：`stage`（lookup / arguments / preToolUse / permission / postToolUse）、`cause`、`decidedBy`。词汇沿用 `LifecycleEvent` 里已有的。只有真正进了 ask 才有 `permission.wait`，结束探针在裁决落下的那一刻记，span 时长就是等人的时间。原因文本可能来自 hook 或人工输入，只在 `content` 档进 body。
- **整体运行状态。** run 开头（`agent.state` 快照）与结尾（`run.closed` 里的 `finalSnapshot`）各一份，**同形、同一个校验器**（[terminal.ts](../../packages/core/src/observability/terminal.ts#symbol=materializeObservableState)）：状态、装备（思考档、工具 / skill 名单）、上下文占用、工作目录、各能力的计数摘要（`echo:tasks` / `echo:scheduler` / `echo:agent` 的收件箱）。模型与绑定不重复记——它们在 `run.assembly`。校验是**白名单重建**：只有逐个校验过的字段进副本，加字段必须同时扩白名单，否则会在封口时被静默剥掉。
- **生命周期相位。** `Agent` 里所有相位写入都经 [`Agent.setPhase`](../../packages/core/src/agent.ts#symbol=Agent.setPhase)，节点就是它；丢锁那一拍也在这里当场记——这是 Agent 自己做的迁移，不是观测推断死活。**`stopping → stopped` 进不了账本**：stop 流程里观测被告知收摊（不等），`stopped` 在那之后才成立，观测线程已经不收这个 runtime 的事实。一次正常收摊的最后一拍相位是 `running → stopping`。
- **extension。** 按**代**记，不按 Fiber 记：装载是全有或全无的事务。发生在任何 run 之外，进「运行时活动」。
- **子循环。** 记忆整理（dream）、记忆提取、子 agent 跑的是同一个循环（[`Agent.runSubagent`](../../packages/core/src/agent.ts#symbol=Agent.runSubagent)），**每次调用在账本里是一个 run**，不经 admission：
  - **身份跟着循环走，不从 Agent 身上补。** 循环与压缩的每条事实自带发出它的那个循环实例的 `runId`，turn 里的再带 `turnId`（[`loopProbeFor`](../../packages/core/src/loop/observe.ts#symbol=loopProbeFor)）；Agent 的 scope 供给只给「是哪个 agent、哪段会话」。同一个 Agent 里可能同时跑着几个循环实例——后台子 agent 在父 run 封口之后才跑、前台子 agent 嵌在父的一次工具调用里——Agent 的当前 run / 开着的 turn 只对主循环成立。所以子循环与主循环用同一组探针，没有专门的观测代码。
  - **来源链回派出它的 run。** `source` 是 [`SubloopRunSource`](../../packages/core/src/observability/types.ts#symbol=SubloopRunSource)：dream / extract 带 `parentRunId`；subagent 另带 `parentToolCallId`（派出它的那次工具调用）与 `background`。admission 的 `RunSource` 不动——header 上的类型是两者的并集 `ObservedRunSource`。runId 是 `<kind>-<uuid>`，前台子 agent 不再借父 run 的 runId，turnId 与权限 tombstone 都不再撞。
  - **边界与主循环同一套**，只有一处不同：`run.started` 的 `startedBy` 是 `subloop`。
  - **状态快照照拍**，`state.agent.activeRunId` 记 Agent 此刻开着的 admission run——子循环里是派出它的那个，或者没有。run 开头的 `agent.state` 自带 `runId`，同样不从 Agent 身上补。
  - 面板：子循环的行调暗、「跟随最新」跳过它们；子 agent 的那次工具调用能跳到子 run，子 run 的概览能跳回父 run。

**新工具自动进观测**：工具执行的事实只有一个来源（`loop/run-turn.ts` 的探针），所以产品加工具不需要额外埋点。但**面板要念出人话**得在术语表 `packages/base/src/observe/lexicon.ts` 里登记——没登记只会显示原始名字。该映射需随新记录和工具维护，自动覆盖范围见 §8。

## 8. 当前限制

以下限制影响容量规划、公开 API 与诊断覆盖：

1. **不 fsync，没有崩溃恢复**：rename 保证不留半截文件，但掉电可能丢最后几批；进程在批文件与派生文件之间退出，那几个 run 列不出来、也不会被过期回收；写入端封口之后不自动重开。注意这条**不包含**「给崩掉的 run 补终态」——那属于 Non-Goals。
2. **列 run 读全部概要**：`listRuns` / `lastRun` 每次读 `runs/` 下全部文件再排序，成本随 run 数线性。两个产品的 30 天规则把它压在「最近 30 天的 run 数」上，不是彻底解决——单段会话在 30 天内堆出足够多的 run 仍然会慢。
3. **TUI 形态不打 runId**，只有管道形态打。从 TUI 跑的会话，终端上看不到该拿哪个 id 去 `observe show`。
4. **超预算的记录只能成缺口**，没有 attachment / blob 旁路。
5. **术语表是手抄快照**：core 加了记录名、产品加了工具，`lexicon.ts` 不会自己红。要立成门得让 core 导出记录名清单、让工具注册表可枚举。
6. **记忆的能力摘要没接。** 状态快照在节点上只收同步可读的值，记忆的状态在盘上要异步读。
7. **同一个能力有两套 Entry id。** `run.assembly` 的槽位写 `echo:task` / `echo:schedule` / `echo:inbox`，而真实装上的 extension 与能力事实的 owner 是 `echo:tasks` / `echo:scheduler` / `echo:agent`——两份记录按 id 对不上。状态快照的能力摘要用的是后者。
