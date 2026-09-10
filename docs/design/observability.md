# 观测：一次 run 留下的账本

> 状态：已实现并在用（本文写的是**现状**，不是目标形态）；公开面尚未拍板，见「待拍板」<br>
> 读者：要读观测记录排查问题、给观测加事实、或把观测接到别处的人<br>
> 假设已读：[Run Loop 的四层](run-loop-layers.md)（run / reply / turn / attempt 的定义，本文直接用）、[会话就是状态根](sessions.md)（观测库住在哪一层）<br>
> 决策记录（本文只指向，论证在记录里）：[观测的公开线](../decisions/proposed/2026-09-07-observation-public-face.md)（**proposed**，A/B/C 未拍）

## 导读

**解决什么。** agent 跑完一次，除了终端上滚过去的字，什么都不剩。会话目录里的 `entries/` 是**功能用的回放队列**（模型要求原样带回上一轮的 reasoning，所以它必须留），不是给人读的历史：它没有时间、没有耗时、没有嵌套、没有失败原因，也不记「这次 run 装配了哪些 extension、绑了哪个模型」。想回答「这次为什么慢」「哪一步失败了」「模型到底想了什么」，没有第二个地方可查。观测层就是那个地方：**它是这个仓里唯一为「读」而存在的记录**。

**最终形态。** 每次 run 把自己写进会话状态根下的一个 SQLite 账本。一条记录是一个 **envelope**（§2）：谁发的、什么时候、挂在哪个 run / turn 下、body 是什么。记录分两条 lane（§3）——run 的三条边界走 boundary lane（有序、可等），其余走 bounded lane（同步、永不抛、满了就留缺口而不是丢消息不吭声）。记多少由 **capture policy** 三档决定（§4）。读面有三个入口（§6）：`observe` 子命令、`echo.observations`、离线的 `openObservationReader()`。**一条贯穿全篇的纪律：观测拦不住 agent**——写不动就降级并如实报出来，绝不让 run 等、绝不拒 run、绝不把异常抛进 Agent 控制流（§5）。

**Non-Goals（已决，不做）。**

- **观测不判断进程死活**（2026-09-06 拍板）。观测只记别人做过的决定；没封口的 run 只说「未收尾」，不由观测推断它是崩了还是还在跑。`RunObservationStatus` 里的 `interrupted` 今天没有任何写者——将来若有管进程的那一层做了接管决定，由它把决定当事实交给观测记。会话死活另有其人，见[会话存活探针](../decisions/implemented/2026-09-09-session-alive-pid-probe.md)。
- **不脱敏。** `content` 档把模型文本、思考、工具参数与结果**明文**写进盘上的库。`redact.ts` 只处理第三方异常对象（stack 只留 digest），不是内容脱敏层。谁开这一档，谁承担盘上有明文这件事。
- **不做 retention / reopen / crash recovery**（列在「欠账」§8，不是本文要设计的东西）。
- **canonical store 不是用户可换的端口。** in-memory 实现只供参考一致性测试，`createEcho()` 装不进去；能不能换是[公开线那条记录](../decisions/proposed/2026-09-07-observation-public-face.md)要拍的事。
- 面板长什么样归 UI，本文只说它读什么。

**待拍板。** 一条，且卡着：[观测的公开线](../decisions/proposed/2026-09-07-observation-public-face.md) 的 A/B/C——650 行的类型面整份公开并冻结（A）、按「extension 作者要什么」划读面 / 写面（B）、还是公开但标 experimental（C）。不拍的代价写在那条记录里：线不画清，API 快照只能整份锁。**本文是那条记录说的「形态的家」**：接口形状在这里，取舍留在记录里。

**验收判据（机器可判）。** 现有门，全部已绿，改这一层时它们必须仍绿：

- `bun test packages/core/test/observability-sequencer.test.ts` —— lane 语义、seq 预留与 hole/gap 配对、prefix barrier、CAS。
- `bun test packages/core/test/observability-sqlite-store.test.ts` —— 同事务全见或全不见、幂等重提、corruption 判定。
- `bun test packages/core/test/observability-projection.test.ts` —— AgentEvent 逐 type 的固定投影、三档的字段差异、投影抛错留 hole + gap、投影自身在同步预算内。
- `bun test packages/core/test/observability-capture.test.ts` `observability-capabilities.test.ts` —— 三档的采集差异、五个 capability 的事实。
- `bun test packages/core/test/observability-render.test.ts` —— renderer 是纯函数（golden 锁层级与相对顺序，不锁 wall clock）。
- `bun test packages/base/test/observe-serve.test.ts` —— 面板的路由、页面自检门（内联脚本能编译、配色规则）。

## 1. 术语

> 规范词表在仓库根 [CONTEXT.md](../../CONTEXT.md)；本表只列本文用到的，定义以那里为准。

| 词 | 定义 | 不表示什么 |
|---|---|---|
| **记录**（record） | 账本里的一行，形状是 envelope（§2） | 一条日志行；一个 AgentEvent |
| **事实**（fact） | 已经发生、由某个 owner 做出或观察到的事 | 推断出来的结论 |
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
| 是什么 | `kind`（`event` / `span_start` / `span_end` / `snapshot` / `health`）· `name` · `occurredAt` · `sourceSeq` | producer |
| 挂在哪 | `scope`（`runtimeId` / `agentId` / `sessionId` / `runId` / `turnId` / `toolCallId` …）· `correlation` · `generation` | producer 给业务部分，`runtimeId` 由 Sequencer 盖 |
| 内容 | `owner` · `instrumentation` · `subject` · `attributes` · `body` | producer |

两条容易踩的规矩：

- **`attributes` 只放低基数的安全值**（string / number / boolean），正文一律进 `body`——`body` 受档管，`attributes` 不受。
- **身份是固定 schema**：白名单之外的键一律拒（[identity.ts](../../packages/core/src/observability/identity.ts#symbol=materializeDynamicIdentity) 头注）。否则多余键会原样落进 envelope，等于在身份区开一块不受档管的自由字段区。同一模块还解释了为什么「校验完必须返回快照、不能回头读 producer 的原对象」——两轮 review 实测过 TOCTOU：Proxy 检查时只露安全字段、编码时再露正文，照样落盘且没有 gap。

## 3. 两条 lane

[Sequencer](../../packages/core/src/observability/sequencer.ts#symbol=ObservationSequencer) 是 `recordId` / `seq` / `observedAt` 与 append 顺序的唯一 owner。producer 只提交 draft，identity、normalize、批、live 扇出全在它那里。两条 lane 两套 API，因为要的东西不一样：

| | `offer()`（bounded） | `appendBoundary()`（boundary） |
|---|---|---|
| 谁走 | 循环事件、五个 capability 的事实 | run 的三条边界 + `run.assembly` |
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
2. **单条记录有预算**：超过就成 `capture_limit` 缺口。正文在投影时先按字节预算截断并标 `textTruncated` / `thinkingTruncated`，思考与回答**各有份额**——思考封顶在正文预算的一半，回答拿剩下的，两边合计不超总预算。原因写在 [agent-events.ts](../../packages/core/src/observability/agent-events.ts#symbol=MAX_PROJECTED_THINKING_BYTES) 的注释里：另开一份等量预算会让 body 翻倍、整条记录穿不过 Sequencer 被丢掉，那是丢更多事实。
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

五个发口，各自拥有自己的窄 fact union 与 descriptor——**descriptor 与语义 owner 共址，不住中央 switch**：

| 发口 | 模块 | 记什么 |
|---|---|---|
| 循环 | [agent-events.ts](../../packages/core/src/observability/agent-events.ts#symbol=agentEventDescriptor) | run / reply / turn / attempt 四层、模型生成、工具执行、压缩、重试、用量 |
| 记忆 | `memory/observe.ts` | 回忆、写入、提取 |
| 任务 | `task/observe.ts` | 状态变更、落盘 |
| 闹钟 | `schedule/observe.ts` | 排程、触发、取消 |
| 收件 | `inbox/observe.ts` | accepted / rejected / restored / consumed / acked / released / sealed |

run 的三条边界 + `run.assembly` 由 `ObservationRuntime` 独家发，不走 descriptor。

**新工具自动进观测**：工具执行的事实只有一个来源（`loop/run-turn.ts` 的 `tool.execute`），所以产品加工具不需要额外埋点。但**面板要念出人话动词**得在术语表 `packages/base/src/observe/lexicon.ts` 里登记——没登记只会显示工具名。那份表是手抄的快照，不是推导出来的门（§8）。

## 8. 欠账

按「会不会随时间恶化」排：

1. **没有 retention。** 库只涨不清，`content` 档下涨得更快。**类型与机制已经全部就位却空转**：`ObservationGapReason` 里有 `"retention"`、`types.ts` 有 `retention-gap` 的传输通知、RunIndex 有 `pruned` 标记、`query.ts` 注释写着「O3b 才会真的产生 pruned 行」——今天没有任何东西真的裁剪。这是唯一会随时间恶化的一条。
2. **降级后不自动 reopen**，**没有 crash recovery 的库层部分**（[sqlite-store.ts](../../packages/core/src/observability/sqlite-store.ts#symbol=SqliteCanonicalObservationStore) 头注自己写着「O3a 不做，O3b 做」）。注意这条**不包含**「给崩掉的 run 补终态」——那属于 Non-Goals 的第一条。
3. **TUI 形态不打 runId**，只有管道形态打。从 TUI 跑的会话，终端上看不到该拿哪个 id 去 `observe show`。
4. **超预算的记录只能成缺口**，没有 attachment / blob 旁路。
5. **`bun:sqlite` 是同步调用**，没隔 Worker：磁盘真挂住会占事件循环。
6. **术语表是手抄快照**：core 加了记录名、产品加了工具，`lexicon.ts` 不会自己红。要立成门得让 core 导出记录名清单、让工具注册表可枚举。
