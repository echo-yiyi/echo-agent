# 观测不进主流程：编码与落盘挪进观测线程，过期是产品自己调的函数

> 状态:implemented · 提出并拍板 2026-09-14（口头：「观测的所有功能不允许在主机制，主循环中出现！！！所有都不行！」「我要求的过期机制和 run 没有任何关系，属于后置机制」；下面决定里的四条「没问题！要改」）· 合入 2026-09-14 · 补充 2026-09-14（审计之后拍板：观测出问题不往外报；存储卡死时进程不无限等，见「补充」）· 推翻 [观测的默认存储改成状态根里的文档](2026-09-14-observation-document-store.md) 的「开库与持锁之后」一节、「过期」一节的执行时机与细节决定 1、`afterLeaseAcquired` 接线

**给谁看**：改观测（探针、Sequencer、文档存储、读面）的人，和要清理观测的产品作者。假设已读 [观测：一次 run 留下的账本](../../design/observability.md) §2–§6 与上面那条被部分推翻的记录。

**解决什么**：上一版观测仍长在主流程上——admission 要等 `run.closed` 落盘（最多 500ms）才放下一个 run，每个 run 封口后在主线程上跑一轮过期，`createEcho()` 要等打开观测存储，`stop()` 要等过期跑完、ring 写完，探针在节点上同步做 normalize 与 SHA-256。改完之后：主流程上的观测只剩「在节点上取一次字段、交出去」；编码、摘要、落盘在进程里一条观测线程上；过期是产品自己调的 `expireObservations()`，agent 里没有过期代码。

## 硬规矩

**观测的任何功能都不出现在主机制、主循环里**：admission、`createEcho()` 装配、`start()`、`stop()`、lease、run 生命周期都不为观测等待、不为观测做计算、不因观测多一种失败。

- DO：探针在节点上只读 scope 供给、跑 descriptor 的有界投影、交给观测线程（一次结构化拷贝），同步返回。
- DO：run 边界（accepted / started / closed）交出去就返回；状态快照只收 Agent 同步可读的原始值。
- DON'T：在 agent 的任何流程节点上 `await` 观测、在节点上算摘要或编码、把观测挂到 lease 的任何一步、在 run 生命周期里跑维护（过期、补齐）。
- DON'T：让 `send()` / `stop()` 的返回值或时机依赖观测写没写完。

## 现状（改之前）

| # | 位置 | 主流程在等什么、算什么 |
|---|---|---|
| 1 | `admission/standalone.ts` 封口处 `await observe.closed` | 每个 run 等 `run.closed` 落盘才结算、才放下一个 run，最多 500ms |
| 2 | `ObservationRuntime.closeRun` | 每个 run 封口后触发一轮过期，与提交共用一条写队列 |
| 3 | 探针 `offer()` | 同步分配 seq、normalize、SHA-256，run 开头 / 结尾同步拍状态快照并算能力摘要 |
| 4 | `createAgent` 装配 | `await` 打开观测存储（读或建 `key.json`），打不开 `createEcho` 失败 |
| 5 | lease 生命周期端口 | `stop()` 等过期整轮跑完、再等 ring 写完；启动后挂补齐与过期 |
| 6 | 文档存储 | 读写回调、过期时解析批文件都在 agent 同一条线程上 |
| 7 | `send()` 返回值 | `observationPersistence` / `observationIntegrity` 逼着第 1 条去等 |

## 决定

1. **`send()` 结果去掉 `observationPersistence` / `observationIntegrity`**，只留 `runId`、`outcome` 与观测引用。写没写成事后读：`getRun()` 的 header 自带 `persistence` / `integrity`，`snapshot()` 带 persistence health。管道形态每轮只打 `[run] <runId>`。
2. **过期是独立函数**：`expireObservations({ stateRoot | store, rule, now? })`。agent 里一行过期代码都没有；什么时候、在哪儿调归产品（定时器、另起进程、空闲时）。`observation.expiry` 与 `echo.observations.expire()` 删掉。
3. **观测挪进 Worker 线程**：进程里一条，所有 runtime 共用，主线程只交出原始数据。
4. **`stop()` 不等观测**；进程等观测线程写完才退出。给要在 `stop()` 之后删 / 搬目录的调用方一个 `echo.observations.flush()`（读方法自己也先等它）。

### 主线程上还剩什么

| 剩下的 | 为什么留在主线程 |
|---|---|
| descriptor 的 `project` | 事实在这里；投影是有界取字段（`loop/observe.ts` 的扫描上限）。把原始事实整个拷过线程反而更贵（整条消息、整段工具输出） |
| 读 scope 供给 | run / turn 归属只在调用那一刻成立 |
| 一次 `postMessage` | 结构化拷贝投影结果；过不了线程的值（函数、symbol）改发失败消息，观测线程补 hole + gap |
| 构造探针时冻结 instrumentation / owner | 装配期一次，不是每条事实；超长照旧构造期抛 |
| 执行观测线程要的存储操作 | 注入的 `StorageDir` 是主线程上的对象，过不了线程。只是转发异步调用，不等、不算；Node 的文件 IO 本来就在进程共用的线程池里，放进 worker 也不隔离它 |
| `echo.observations.*` 的读 | 调用方主动读，不是 agent 流程 |

### 观测线程（`thread-host.ts`，入口 `observation-worker.ts`）

- **每个 runtime 一份 Sequencer + 文档写入端**，消息按到达顺序一条一条处理——那就是探针被调的顺序，seq 顺序与原来一致。`observedAt` 用主线程交出时盖的时刻（`FakeClock` 测试仍确定）。
- **原来在节点上算的都在这里算**：scope 物化与 normalize（Sequencer）、run 边界与 `run.assembly` 的构造（AgentAssembly 快照、模型绑定摘要）、状态快照的能力摘要与 `runtime.status` / `observationPersistence`、错误原文摘要。descriptor 要摘要时在投影里声明 `digests`（字段名 → 原文，`keyed` 用记忆路径 HMAC key），观测线程算好填进 body——key 只在观测线程里。
- **什么时候开始写**：runtime 第一次有 `run.accepted` 或第一次被读（flush / subscribe）才打开写入端；之前事实只进 ring（有界，满了记缺口）。收摊时从没开始写的 runtime 直接丢——一句话都没说过的会话目录会被整个删掉，不能有迟到的文件把它建回来。删之前主线程先同步关掉这个 runtime 的存储闸。
- **进程退出**：主线程交出工作消息时 `ref` 线程，线程回报「编号到 n 为止处理完、手上没有要写的」且 n 是最后发出的那条时 `unref`。线程从不 `terminate`：Bun 1.3.14 实测 terminate 之后进程的 `process.on("exit")` 不再运行（`unref` 3/3 正常）。

### 过期（`expiry.ts`）

```ts
import type { RunObservationHeader, StorageDir } from "@echo-agent/core";

type ObservationExpiryDecision = Readonly<{ runs?: readonly string[]; activityBefore?: number }>;
type ObservationExpiryRule = (runs: readonly RunObservationHeader[], now: number) => ObservationExpiryDecision;
type ExpireObservationsOptions = Readonly<{ rule: ObservationExpiryRule; now?: number } & ({ stateRoot: string } | { store: StorageDir })>;
```

规则拿到全部 run 的 header（新的在前），返回要删什么。执行只凭**盘上的事实**，不取锁、不问写入端，所以能在活着的 agent 旁边调：

- **只删盘上已封口的 run**（RunIndex 有 `terminalRecordId`）：封口之后写者不再写这个 run 的任何文件。没封口的列进结果的 `openRuns`。
- **批文件只删 `nextCommittedPrefix ≤ head` 的**：派生文件的写入顺序是约定——先 `runs/`、后 `heads/`，head 走到哪，那之前每批的 `runs/` 就都写成了；在 head 之后的批，写者可能正要写它的 `runs/`，不动。其余条件照旧：批里出现过的 run 都已不在 `runs/`，run 之外的记录都早于 `activityBefore`。
- 规则或存储抛错原样抛给调用方：这是产品自己调的函数，不是 agent 的流程。

### 撤掉

- 过期与补齐：`DocumentObservationStore.expire` / `repairDerived`、写入端的关闭闸（改成主线程的存储闸）、`ObservationSequencer.isTrackingRun`。
- lease：`state/lease-lifecycle.ts`（唯一的生产使用方就是观测）、`Agent` 里对它的四处调用、`ObservationSequencer.markLeaseLost`。
- 公共面（API 快照重录）：`EchoRunResult.observationPersistence` / `observationIntegrity`、`EchoObservations.expire()`、`createEcho` / `createAgent` 的 `observation.expiry`、根入口的 `ObservationStoreOpenError`（它不再抛给任何公开调用方，只在观测线程里做成诊断）；加 `EchoObservations.flush()`、`expireObservations` 与 `ExpireObservationsOptions` / `ObservationExpiryDecision` / `ObservationExpiryResult` / `ObservationExpiryRule`。
- `createAgent` 的 `OBSERVATION_BOUNDARY_DEADLINE_MS`（没人等边界了，Sequencer 用缺省 5s 只作健康判定）。

### 补充（2026-09-14，审计之后）

- **观测出问题不往外报**：原来观测线程的诊断经主线程交回 Agent 的诊断通道，变成 `kind: "error"` 通知——会跑用户配的 notification hook，TUI 每条往对话里加一行（content 档 200 轮实测来了 201 条）。拍板：观测本身就是日志，它坏了再发通知或打日志没有意义。诊断消息整个撤掉；丢掉的事实照旧留 hole + gap，写入端的状态在 `snapshot().health` 里。
- **存储卡死时不无限等**：原来只要有一个存储调用没回来，观测线程就不报空闲、一直拖住进程。实测只卡观测写、会话存储正常时进程照样退不出——下面 Non-Goals 原来那条「与会话存储卡住同一个处境」的类比不成立：会话存储卡住时 `stop()` 本身卡着，看得见；观测卡住时 `stop()` 已经返回，进程却不退。改成：线程拖着进程期间连续 `STALL_MS`（5 秒）没有进展（没收到线程的消息、也没有存储操作做完），就放开进程，没写完的观测随进程丢。
- **content 档的工具载荷在投影时收进预算**：原来工具结果、参数原样交出去，线程那头超过 64 KB 整条判成缺口——主线程为一份注定丢掉的数据做了一次完整结构化拷贝。现在正文截断、结构化载荷放不进就不带（设计文档 §4）。
- **起线程同步抛错不再让 `createEcho()` 失败**：这个进程的观测不记，装配照常。
- **删掉没有消费者的内部机制**：`appendBoundary()` 不再返回 Promise（主线程和观测线程都没人等它），同步预留、立刻安排提交；随之删掉边界提交的期限（`boundaryDeadlineMs`）与等待者。那个期限原来是写入端 `degraded` 的唯一来源，所以 `degraded` 今天也没有写者（设计文档 §8）。探针失败不再携带原因文本与抛出物原文——它们只给诊断用。**没删**对抗性输入的防御（快照读、canonical 编码的校验）：主线程上 content 档的载荷预算（`estimatePayloadBytes` / `fitPayload`）直接拿 producer 的原始值跑同一个编码器。

## Non-Goals

- **不做崩溃恢复**：进程在批文件写成、派生文件没写成之间退出，那几个 run 列不出来；它们的批也永远在 head 之后，过期不回收。
- **core 不给过期挑时机、不给缺省规则。**
- **不把存储 IO 搬进观测线程**：注入的 `StorageDir` 过不了线程，而默认的 `FileDir` 在 worker 里也和主线程共用 IO 线程池。

## 验收

- [存储卡住时主流程不等](../../../packages/core/test/observability-runtime.test.ts#test=观测存储完全卡住createechostartsendstop-都不等它放行之后该写的照样写进去)：存储读写全部卡住时 `createEcho → start → send × 2 → stop` 900ms 内完成、盘上一个字没写；放行后两个 run 都落盘。
- [进程等观测写完才退](../../../packages/core/test/observability-runtime.test.ts#test=进程在观测线程写完之后才退出stop-不等processonexit-照常运行)：子进程 `send → stop` 后不 flush 直接退出，下一个读者读得到那个 run，exit 监听运行。
- [Node 下同样成立](../../../test/distribution-gate.test.ts#test=node装-tarball-createecho-完整装配-send-echoobservations-读得回stop-不等观测进程写完才退下一个进程离线读得到)：Node 从 dist 起观测线程，最后一个 run 在 `stop()` 之前才封口，下一个 Node 进程离线读得到。
- 过期只凭盘上事实：[没封口不删](../../../packages/core/test/observability-document-store.test.ts#test=盘上还没封口的-run-不删列进-openruns不给-run-也不给-activitybefore-时什么都不动)、[head 之后的批不动](../../../packages/core/test/observability-document-store.test.ts#test=head-之后的批它那一批的-runs-还没写成不回收哪怕里面的记录都够老)、[两种给法](../../../packages/core/test/observability-document-store.test.ts#test=expireobservations规则拿到全部-run-的-header新的在前与-now按它的决定删状态根目录与注入存储两种给法)、[活着的 agent 旁边删](../../../packages/core/test/observability-runtime.test.ts#test=跑完停下再起都一条不删产品在活着的-agent-旁边按规则删删的是盘上已封口的-run)。
- 补充的三条：[观测丢数据不往外报](../../../packages/core/test/observability-runtime.test.ts#test=观测丢数据不往外报content-档的大工具结果截断照记存储写不动也不发任何通知2026-09-14观测本身就是日志)（存储写不动时不发任何通知、content 档大工具结果截断照记不成缺口）、[存储卡死最多再等 STALL_MS](../../../packages/core/test/observability-runtime.test.ts#test=观测存储卡死进程最多再等-stallms-就退出没写完的观测放弃exit-监听照常运行)、[起线程抛错装配照常](../../../packages/core/test/observability-runtime.test.ts#test=起观测线程同步抛错createechosendstop-照常这个进程不记观测)；投影侧 [工具结果截断](../../../packages/core/test/observability-projection.test.ts#test=工具结果正文截到预算内并标-resulttruncated放不进的-metadata-不带标-metadataomitted穿过-sequencer-是记录不是缺口) 与 [结构化载荷放不进就不带](../../../packages/core/test/observability-projection.test.ts#test=工具参数进展tooluse-的-input结构化的放不进就不带标-omitted字符串进展截断)。
- 边界不等：[appendBoundary 不等攒批、立刻提交](../../../packages/core/test/observability-sequencer.test.ts#test=appendboundary-不等攒批b-的-bounded-尾巴与-b-同一事务立刻提交不拨-clock)、[body getter 抛错不同步抛出](../../../packages/core/test/observability-sequencer.test.ts#test=body-getter-抛错appendboundary-不同步抛出也不预留-seq)。
- `git grep -n -E "leaseLifecycle|afterLeaseAcquired|observation\.expiry|observations\.expire\(|observationIntegrity|persistenceOf" -- 'packages/*/src'` 为空（`EchoObservableState.runtime.observationPersistence` 是状态快照里的字段，由观测线程填，不在此列）。
- 反证见合入提交信息。

## 遗留

- `ObservationPersistenceStatus` 的 `lost-lease` 与缺口原因 `lease_lost` 不再有入口，类型还在公开面上；要删另起一条（公开类型变更）。
- `listRuns` / `lastRun` 读全部概要的线性成本照旧（设计文档 §8）。
