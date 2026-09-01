> **未审草稿,不是正式文档。** 由 Claude 在门禁机制建立之前写的,没有经过任何门,也没有人确认过。
> 写正式 `docs/architecture.md` 时可以拿它当素材,但每一条断言都要重新对着代码验。

# 架构

读这份之前不需要读任何别的东西。它讲清四件事:**代码分成哪两个高度、一个 Agent 是怎么装起来的、一轮任务怎么跑完、状态落在哪**。

细节契约在各子系统文档;本文只给全景与入口,每条断言都能落到 `file:line`。

## 一、两个高度

一个包、**一条入口** `@echo-agent/core`,两个使用高度:

| 高度 | 用法 | 调用方自己给什么 |
|---|---|---|
| 高 | `createEcho()` | 只给 provider——端口、内建能力与扩展装配都已备好 |
| 低 | `new Agent()` | 端口与工具全要自己给,它不装任何默认件 |

低层那条的代价是清楚的:什么默认件都不装,`StorageDir`、锁、工具全归调用方。

## 二、装配:一个 Agent 是怎么起来的

只有一个装配现场:

```
createEcho(opts)                      packages/core/src/create-echo.ts
  ├─ createAgent(opts)                packages/core/src/create-agent.ts
  │    ├─ resolveStateDir()           状态根三级解析(见 §四)
  │    ├─ new FileDir(stateDir)       存储端口
  │    ├─ fileStateLock(...)          单写锁
  │    └─ new Agent({...})            具体 Agent
  └─ 发现 <cwd>/extensions/ 并 mount  与内建能力走【同一套机制】
```

三条决定了这一层的性格:

**① 内建与外部扩展走同一条路。** Task / Skill / Memory / Schedule 不是特权代码,它们和你写的扩展用同一张表、同一条 mount 路径(`extension/builtin.ts`)。装了什么在 `echo.extensions` 里看得见。

**② `agent.tools` 也会被转成一条 inline Extension**(`echo:inline-tools`),不由 `Agent` 构造函数直接注册。理由是所有权:直接注册的工具模型能调用,却不经 ExtensionHost、不出现在 `echo.extensions`、没有 owner——与「一份注册机制、一本所有权账本」冲突。低层 `new Agent({ tools })` 不受此限,那一层本来就是自己给端口。

**③ 一个坏扩展就整体不起。** 任何一个 import 失败 / 默认导出形状不对 / mount 失败 → `createEcho()` 抛,并把已造好的 Agent 停掉(否则锁和 store 泄漏)。不收集诊断继续跑:「装了一半的 agent」是本仓禁止的静默降级——用户以为工具在,模型却看不见它。

### 所有权账本

装配有一个窗口:**值已经造出来、Agent 还没构造成功**。这段时间谁负责关掉已建好的资源?答案是一本账(`assembly/ledger.ts`),两种模式:

| 模式 | 用于 | dispose owner |
|---|---|---|
| `adopt` | agent 域的值(Session / Memory / Schedule / Task / Inbox) | provider 先持 `offered` 租约,Agent 构造成功后**原子接管** |
| `borrow` | 进程域的值(root `StorageDir`、`ProviderCatalog`) | provider 始终是 owner,Agent 只拿不带 `close` 的视图 |

装配现场自己是个状态机,`adoptInto()` **只认完整的 `sealed`**:

```
open ──seal()──▶ sealed ──adoptInto()──▶ adopted
 ├──factory 抛错──▶ failed
 └──abort()──────▶ aborting ──▶ aborted
```

`abort()` 在第一个 await **之前**就同步进入 `aborting`,否则「abort 收到一半时 adoptInto」会交出一本残缺账本。

**`adopt` slot 的 factory 必须零外部副作用**:不读写磁盘、不取锁、不起 timer、不连网络、不注册 global listener、不消费 Inbox。durable restore 归 `Agent.start()`,自主活动与 timer 归 `Agent.activate()`。这条由 `assembly/probe.ts` 的探针在一致性测试里证明。

## 三、跑一轮:外层与内层

循环分两层(`loop/run-loop.ts`、`loop/run-turn.ts`):

- **内层** = agent 还在工作:它要调工具、输出被截断、或有人插话;
- **外层** = agent 已经停下,但被交了新的活:followUp,或 stop 被拦。

两个入口只差准备工作,循环体共用 `runLoop`——**它是纯方法**:吃快照 + 装备 + 通道,吐事件,不认识 `Agent` 类、不认识磁盘。评测直接打这里:给假 `streamFn`、给固定 messages,**同样输入必然同样事件序列**。

一轮内部有两条贯穿规则:

**① 每条进入 transcript 的消息都发 `message_end`**(助手消息之前还有 start/update)。这样 Agent 侧只需要一条 append 路径,`state = apply(state, event)` 对每条消息都成立。

**② 本轮的工具与 hook 在开头定格。** 模型看到的菜单、执行到的对象、拦截它的 handler,整轮是同一份;中途的注册/卸载/替换全部归下一轮(`run-turn.ts` 的 `TurnWorkset`)。

`runTurn` 没有任何提前 return 的分支——所有出圈判断集中在 `runLoop`。

## 四、状态落在哪

```
stateDir(显式给)  >  $ECHO_HOME/agents/<agentId>  >  $PWD/.echo/agents/<agentId>
```

**默认落在项目内而不是 `~/.echo`**:后者会让两个不相干的项目静默共用同一个 agent 的记忆,而用户不会察觉。项目内的代价是「同一项目的两个 checkout 是两个 agent」——那是看得见的代价,可接受(`create-agent.ts:117`)。

`agentId` 与 `sessionId` 一样**是路径段,都要过 `assertSafePathSegment`**:此前只校验 sessionId,于是 `agentId="../../escaped"` 能把状态根挪出 `.echo/agents`(实测)。

### 四条硬约定

| 约定 | 含义 | 谁在守 |
|---|---|---|
| **零运行时依赖** | `dependencies` 恒空 | 有门(`zero-runtime-deps.test.ts`) |
| **fail-loud** | 缺凭据、拿不到锁、盘上坏档——一律抛,不回退到「假装成功」 | 纪律 |
| **single-writer** | 一个状态根同时只允许一个写者。锁被占就拒绝启动,**core 不抢占**、不猜对面死没死;崩溃后人工清锁 | 有门(`state-lock.test.ts`) |
| **`write()` resolve 即持久** | 存储端口上没有 `flush`;`stop()` 等的是未 settle 的写 | 纪律 |

**持久化失败会封存该会话**:一次写失败之后拒绝继续写——继续写只会产出 parent 指向不存在 entry 的坏档。需人工确认盘上状态,再重新 `createOrResume`(`state/write-gate.ts`)。

## 五、观测

观测是**公共 ABI,不是日志**(`observability/`,4,752 行)。三条决定:

**① 只收 JSON-safe 的值。** 运行期对象(Error / Uint8Array / bigint / Map)在 `normalizeObservationValue()` 里归一或**被拒**,不靠 `JSON.stringify()` 静默删字段。

**② 两条 lane 两种 API**(`observability/sequencer.ts`):

| lane | API | 语义 |
|---|---|---|
| bounded | `offer()` | **同步、永不抛、无 Promise**。ring 满或编码失败 → 该 seq 当场成 hole,并在任何后续 producer 取到 seq 之前写一条 gap 记录 |
| boundary | `appendBoundary()` | 可等待。装 prefix barrier,worker 排空 `< B` 的全部 record/gap,同事务提交并 read-back 到 `committedPrefix >= B` 才 resolve |

**committed prefix 只越过两类位置**:已 committed 的 record,或被后续 gap 精确覆盖的 hole。**丢了也要在账上留个洞**——丢失本身是可对账的事实,不是沉默。

**③ 两条消费面同一个准入边界。** `/engine` 的 `EngineObservationTap` 是只读 consumer seam:拿不到 Sequencer、canonical identity、查询或 renderer,fact 没有 `recordId/runtimeId/seq`,是明确的 ephemeral 投影。但**字段集必须与 canonical envelope 一致**——只进 Runtime 一侧的字段会让两边的准入边界错开(实测:9,000 字节的 subject,engine 收下、Runtime 成 gap)。

## 六、公共面怎么锁

`packages/core/test/api-snapshot.test.ts` 锁住导出符号表:**增删任何导出都必须重录快照并人审 diff**。清点脚本 `scripts/api-inventory.ts`,判据源与人读报告是同一份。

导出面:`.` / `./engine` / `./extension` / `./testing` / `./tools` / `./task` / `./task/fs` / `./background` / `./mcp`。

## 相关

- 各子系统详解:`docs/subsystems/`
- 设计规格与章节号(代码里的 `§x.y.z`):`docs/design/`
- 门禁清单与判据:`test/` 与各包 `test/`
