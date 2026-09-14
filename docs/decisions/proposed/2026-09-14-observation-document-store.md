# 观测的默认存储改成状态根里的文档，过期规则归产品

> 状态:proposed · 提出 2026-09-14 · 方向拍板 2026-09-14（口头：「默认实现不应该用 sqlite，默认用文档 + 文档过期策略」「清理应该是使用方或产品方定义的，我们只建机制」；旧库「不迁移，我们现在用户并不多」）· 细节拍板 2026-09-14（原「待拍板」四条全部按推荐：「可以，都按照推荐来做」）· 实现后移入 implemented · 推翻 [观测的公开线](2026-09-07-observation-public-face.md) 第 3 条里「SQLite 作为缺省不翻（2026-09-01 拍板）」

**给谁看**：改观测存储、读面（`echo.observations` / `openObservationReader()` / `observe` 面板）的人，和要给观测定清理规则的产品作者。假设已读 [观测：一次 run 留下的账本](../../design/observability.md) 的 §2（envelope）、§3（两条 lane 与 committed prefix）、§6（读面）。

**解决什么**：观测库只涨不清，而清理规则（留多久、留多少）本该由产品定，core 只建机制。现在的默认存储是 SQLite：清理要删行、要 VACUUM，和「使用方不一定用 SQLite」的前提也对不上；它的同步调用还逼出了一整套 worker 线程（`ad516a3`）。改完之后：观测和 session、记忆、任务一样，是状态根里 `StorageDir` 上的一批 JSON 文件；产品给一个过期函数，core 按它删；不给就一条不删。

## 现状（拍板前）

- 观测库是 `<stateRoot>/observability/observations.sqlite`，写入端 `WorkerObservationStore` 把 `bun:sqlite` 放在 worker 线程（[设计文档 §5](../../design/observability.md)）；注入了自定义 `store` 又没点名 `stateDir` 时开 `:memory:`（`packages/core/src/create-agent.ts`）。
- Sequencer 对 store 的契约（[`ObservationSequencer`](../../../packages/core/src/observability/sequencer.ts#symbol=ObservationSequencer)）：一批 = 连续 seq 窗口里的记录 + 受影响的 RunIndex 新值 + runtime 的 committed prefix，**同一事务全见或全不见**；按 `expectedCommittedPrefix` / `expectedRunIndexDigest` 做 CAS；逐字等价的重提是 `already-committed-same`；ID 撞车、半批可见、digest 漂移是 corruption；写失败后 read-after-error 判 committed / absent / indeterminate。订阅回放早于内存窗口时经 `readRecordsAfter` 分页读。
- 清理相关的类型已在、没有任何写者：`RunIndexEntryV1.bodyState: "retained" | "pruned"` 与 `prunedAt`、`getRun()` 的 `pruned` 分支、缺口原因 `"retention"`、订阅侧 `ObservationReplayGap`（`retention-gap`）。
- 读面的消费者：`packages/base/src/observe/sessions.ts` 的 `SessionObservationReaders`（面板与 `observe` 命令）按「库文件在不在」发现会话，用 `listRuns` / `getRun` / `lastRun` / `runtimeHeads` / `counts` / `recentActivity`。
- 记忆路径的 HMAC key（`path_digest_key`，32 字节，随库首建、永不改写）存在 SQLite 的私有表里，只给 [`memoryFactDescriptor`](../../../packages/core/src/memory/observe.ts#symbol=memoryFactDescriptor) 用。
- `createEcho()` 在 Node 下起不来，挡它的是 `bun:sqlite`（[热部署记录](../implemented/2026-09-14-extension-hot-reload.md)登记过）。

## 不拍板的代价

库继续无限增长；要清理就得在 SQLite 上做删行 + 空间回收，而这套做法换一个存储就作废。worker 线程与它带出来的两条 Bun 行为约束（`expect().rejects` 里消息派发不出来、worker 加载 `node:fs` 后进程 exit 监听不运行）要一直背着。

## 选项

- **A. 保留 SQLite，在 store 上加删行与空间回收，规则由产品给。** 改动小；清理只对 SQLite 成立，旧库建库时没开 `auto_vacuum`，收回空间要改建库参数或对老库做一次 VACUUM。
- **B. 默认存储改成 `StorageDir` 上的文档，过期 = 删文件，规则由产品给。** 与 session / 记忆 / 任务同一个端口：注入 `InMemoryDir` 观测就在内存，Node 下也能跑，不再有同步磁盘调用，worker 线程整个撤掉。代价是 Sequencer 的「一批原子提交」要在文件上重新落实，SQL 查询换成列目录 + 读文件。

## 决定

**B**（方向 2026-09-14 用户拍板）。已有的 `observations.sqlite` **不迁移**：新版本不读它，`observe` 命令与面板遇到只有旧库的会话明确提示「旧格式观测，已不再读取」。

### 目录

全部经状态根的 `StorageDir`（缺省 `FileDir`；注入 `InMemoryDir` 时在内存），前缀 `observability/`：

```
observability/
  key.json                               // 记忆路径 HMAC key（32 字节 base64）：首建写一次、永不改写；读面不读
  batches/<runtimeId>/<nextPrefix>.json  // 一次提交一个文件（nextPrefix 左补零到 12 位）——提交点
  runs/<runId>.json                      // 这个 run 的 RunIndex（概要 + runtimeId + firstSeq / lastSeq）——派生
  heads/<runtimeId>.json                 // { committedPrefix }——派生
```

文件名里的 `runtimeId` / `runId` 按 `StorageDir` 的路径安全规则编码（`rt:`、`run:` 里的冒号不直接落进文件名）。

批文件的形状：

```ts
import type { RunIndexEntryV1 } from "@echo-agent/core/observability";

type ObservationBatchFileV1 = Readonly<{
  schemaVersion: 1;
  runtimeId: string;
  expectedCommittedPrefix: number;
  nextCommittedPrefix: number;
  /** seq 升序；hole（被 gap 覆盖的 seq）没有条目。`envelope` 是 canonical JSON 原文，读回逐字比对。 */
  records: readonly Readonly<{ seq: number; recordId: string; runId?: string; envelope: string }>[];
  /** 这一批改动过的 RunIndex 新值。 */
  runIndex: readonly RunIndexEntryV1[];
}>;
```

### 提交：Sequencer 的契约不变，提交点是批文件的 rename

`commitBatchIfAbsent(input)`：

1. 目标批文件已存在：内容逐字相同 → `already-committed-same`；不同 → corruption。
2. CAS 对的是 store 在内存里的 head 与 RunIndex（开库时建好，之后只有这一个写者——状态根有 lease）：不符 → corruption。
3. 写批文件（`FileDir.write` 本来就是临时文件 + rename）。**rename 完成 = 这一批 committed**：一批里几个 run 的记录与它们的 RunIndex 在同一个文件里，一次 rename 同时可见，「全见或全不见」由此成立。
4. 之后写派生文件：每条变更过的 `runs/<runId>.json`，最后 `heads/<runtimeId>.json`。它们写失败不影响这批已提交（内存里已更新），下次开库按批文件补齐。

read-after-error：批文件存在且逐字相同 → committed；不存在且 head 没动 → absent；其余 → indeterminate。与今天同三种结论，Sequencer 一行不改。

### 开库与持锁之后

装配期（`createAgent`，还没拿 lease）只做两件不和别的写者冲突的事：读或建 `key.json`（在 `StorageDir.lock` 下读、没有才写，建一次后永不改写）；新 runtime 的写入只进自己的 `batches/<runtimeId>/` 与 `heads/<runtimeId>.json`，runtimeId 每个进程唯一——启动前就发生的事实（extension 装载、相位）照常落盘，与 SQLite 时一样不经写入闸。

**拿到 lease 之后**（`Agent.start()` 装上写入闸的那一步，经 lease 生命周期端口新增的 `afterLeaseAcquired` 通知装配层）才碰别的 runtime 留下的东西，而且不阻塞启动：

1. 补齐派生文件：对每个旧 runtime，把文件名大于它 head 的批文件按序回放，补 `runs/` 与 `heads/`（上次进程在 rename 之后、派生文件之前停下的那一段）。
2. 执行一次过期（见下）。

写批文件、补齐、过期三件事在 store 里排同一条队，互不交错。交还 lease（`beforeLeaseRelease`）或丢锁（`onLeaseLost`）之后不再补齐、不再过期。

### 读面

读面签名不变（`echo.observations` / `openObservationReader({ stateRoot })`），实现换成列目录 + 读文件：

| 方法 | 做法 |
|---|---|
| `getRun(runId)` | 读 `runs/<runId>.json`；按文件名找出覆盖 `[firstSeq, lastSeq]` 的批文件（覆盖 seq `s` 的是第一个 `nextPrefix ≥ s` 的文件），取其中这个 run 的记录物化。结果只有 `found` / `unknown` 两态 |
| `listRuns` / `lastRun` | 列 `runs/`、读全部概要，按 `(acceptedAt, runId)` 倒序分页，游标格式不变。成本随 run 数线性——控制它的正是过期规则 |
| `recentActivity` | 从各 runtime 最新的批文件往回扫 `runId` 为空的记录，按 `observedAt` 倒序 |
| `runtimeHeads` / `counts` | 列 `heads/`、`runs/`；记录数由批文件累加 |
| 订阅回放 `readRecordsAfter` | 该 runtime 的批文件按文件名顺序读；相邻两个批文件的 `expectedCommittedPrefix` 与上一个的 `nextCommittedPrefix` 接不上 = 中间的批被过期删了，这一页连同被删的 seq 区间一起返回（内部接口的返回值随之改成「记录 + 被删区间」），Sequencer 据此交付 `retention-gap` |

**跨进程读**（面板读正在跑的会话）：只读 rename 完成的文件，看不到半截；`runs/` 最多落后正在写派生文件的那一批，读到的是稍旧但自洽的状态。`SessionObservationReaders` 按 `observability/` 目录是否存在发现会话。

### 过期：规则归产品，机制归 core

```ts
import type { ObservationCapturePolicy, RunObservationHeader, StorageDir } from "@echo-agent/core";

type ObservationExpiryDecision = Readonly<{
  /** 要删掉的 run。 */
  runs?: readonly string[];
  /** 早于这个时刻（毫秒时间戳，比的是记录的 observedAt）的 run 之外记录可以回收。不给 = run 之外的记录不删。 */
  activityBefore?: number;
}>;

type CreateAgentObservationOption = {
  observation?: {
    capture?: ObservationCapturePolicy;
    /** 观测放在哪。缺省 = 状态根的存储（`opts.store`，没给就是状态根目录的 `FileDir`），前缀 `observability/`。 */
    store?: StorageDir;
    /** 不给 = 永不删。core 不内置任何规则。 */
    expiry?: (runs: readonly RunObservationHeader[], now: number) => ObservationExpiryDecision;
  };
};
```

**什么时候执行**：core 在两个时点调用规则——启动拿到 lease 之后一次、每个 run 的 `run.closed` 提交之后一次；另有 `echo.observations.expire()`，给要自己挑时机的使用方（没持 lease 时是空操作）。几次调用撞在一起时合并成跑完再跑一次。

core 按返回值执行：

1. 删 `runs/<runId>.json`，这个 run 的 `getRun()` 立刻是 `unknown`。**当前进程里还开着的 run**（Sequencer 正在跟踪的）拒删并报诊断；已封口的、以及以前进程留下的没封口的，删不删由规则定——观测不判断进程死活。父 run 删了，子循环 run 不连带：它们各有自己的 `runs/` 文件，规则要删就一并返回。
2. 回收批文件：一个批文件里出现过的 run 全都删了（`runs/` 里都不在），且其中 run 之外的记录都早于 `activityBefore` → 删掉。只含 run 之外记录的批文件同理。
3. 订阅回放跨过被删的批文件，交付 `retention-gap`（类型已有）。

### 撤掉

- `observability/sqlite-store.ts`、`worker-store.ts`、`sqlite-worker.ts`、`worker-protocol.ts` 与各自的测试，`bun:sqlite` 在 `packages/*/src` 里零引用；`create-agent.ts` 的 `:memory:` 分支（注入内存 `store` 时观测跟着在内存）；空会话清理里「观测在不在内存」这个参数。
- 公共面（API 快照要重录）：`observationDatabasePath` → `observationStorePath`（`<stateRoot>/observability`）；`SqliteEchoObservationReader` → `DocumentEchoObservationReader`；`ObservationDatabaseMissingError` → `ObservationStoreMissingError`（这个状态根还没有观测目录）；`RunLookupResult` 去掉 `pruned` 分支，`RunIndexEntryV1` 去掉 `bodyState` / `prunedAt`；`EchoObservations` 加 `expire()`；`createEcho` / `createAgent` 的 `observation` 加 `store` 与 `expiry`。`ObservationStoreOpenError` / `ObservationCorruptionError` 保留。
- 接线：lease 生命周期端口（Host 内部，不进 Extension ABI）加 `afterLeaseAcquired`。
- 旧库提示在装配层做：`SessionObservationReaders` 发现某段会话只有 `observability/observations.sqlite`、没有新格式时，把它记进打不开的会话（`observe` 命令与面板已经会把这一类原因打出来），原因写「旧格式观测（observations.sqlite），已不再读取」。
- 设计文档 §5 的 worker 线程一节与两条 Bun 约束随之删除；`docs/architecture.md`、`README.md` / `README.zh.md` 里的 `observations.sqlite` 改写。

## Non-Goals

- **不迁移旧库**，也不留读旧库的代码。
- **不内置任何过期规则**：没有缺省 TTL、没有缺省条数上限。
- **不做 fsync 与崩溃恢复**：rename 原子保证不留半截文件，掉电丢最后几批与今天同属欠账（设计文档 §8）。
- **不开「语义层 store」注入**（换成 Postgres 之类）：本条只换缺省实现、开字节面，见决定 4。
- **不做按正文字段的部分清理**：删的粒度是 run。

## 细节决定（2026-09-14，原「待拍板」四条全部按推荐）

1. **过期的执行时机**：core 在启动拿到 lease 之后、每个 run 的 `run.closed` 提交之后各调一次规则；另给 `echo.observations.expire()`。没选「只给 `expire()`、时机全归使用方」：那样每个产品都得自己挂时机，忘了库就一直涨。
2. **删掉 `pruned` 读面状态**：粒度是 run 之后「留概要、删正文」没有落点。`RunLookupResult` 的 `pruned` 分支与 `RunIndexEntryV1.bodyState` / `prunedAt` 同一次改动里删，读面与面板对它的处理一起删。
3. **run 之外的记录**（extension 装卸、收件、相位变更…）：规则的返回值带 `activityBefore`，早于它的可回收；不给 = 不删。没选「跟随批文件连带删」：run 之外的记录与 run 的寿命无关。
4. **可注入的层**：只开字节面 `observation.store?: StorageDir`。「换成另一种数据库」要的是语义层（`CanonicalObservationStore`）注入，与公开线第 2 条「store 接口留在内部」互相顶着，等真有这样的使用方再拍。

## 验收

- `packages/*/src` 里没有 `bun:sqlite`；`observability/` 下没有 `sqlite-*` / `worker-*` 文件。
- 现有 `createEcho → send → getRun` 端到端测试在 `FileDir` 与 `InMemoryDir` 两种状态根下都绿，记录逐项比对不变。
- 提交点：在批文件 rename 之前让写失败——读面看不到这一批、read-after-error 判 absent；rename 之后、派生文件之前停下——重新开库后 `runs/` 补齐、`getRun` 完整。
- 过期：规则返回某个已封口的 runId → `getRun` 为 `unknown`、只含它的批文件被删、与别的 run 共用的批文件留着、订阅回放跨过时收到 `retention-gap`；返回当前正在跑的 runId → 拒删并有诊断；不给规则 → 跑多次 run 后一个文件不删。
- `observe` 命令与面板在新格式上读得出；只有 `observations.sqlite` 的会话给出「旧格式观测，已不再读取」。
- Node 下 `createEcho` 起一次、`send` 一次、`getRun` 读得回（若 Node 下另有挡路的，登记出来，不在本条修）。
