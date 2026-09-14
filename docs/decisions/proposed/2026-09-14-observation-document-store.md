# 观测的默认存储改成状态根里的文档，过期规则归产品

> 状态:proposed · 提出 2026-09-14 · 方向拍板 2026-09-14（口头：「默认实现不应该用 sqlite，默认用文档 + 文档过期策略」「清理应该是使用方或产品方定义的，我们只建机制」；旧库「不迁移，我们现在用户并不多」）· 下面的目录结构、提交点、读法与「待拍板」四条是提案，确认后实现 · 推翻 [观测的公开线](2026-09-07-observation-public-face.md) 第 3 条里「SQLite 作为缺省不翻（2026-09-01 拍板）」

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

### 开库

读 `heads/` 与 `runs/`；对每个 runtime，把文件名大于它 head 的批文件按序回放，补齐派生文件（上次进程在 rename 之后、派生文件之前停下的那一段）。新进程的 runtimeId 是新的，写入只进自己的 `batches/<runtimeId>/`；旧 runtime 的批文件只读。key 不存在就生成并写一次。

### 读面

读面签名不变（`echo.observations` / `openObservationReader({ stateRoot })`），实现换成列目录 + 读文件：

| 方法 | 做法 |
|---|---|
| `getRun(runId)` | 读 `runs/<runId>.json`；按文件名找出覆盖 `[firstSeq, lastSeq]` 的批文件（覆盖 seq `s` 的是第一个 `nextPrefix ≥ s` 的文件），取其中这个 run 的记录物化 |
| `listRuns` / `lastRun` | 列 `runs/`、读全部概要，按 `(acceptedAt, runId)` 倒序分页，游标格式不变。成本随 run 数线性——控制它的正是过期规则 |
| `recentActivity` | 从各 runtime 最新的批文件往回扫 `runId` 为空的记录，按 `observedAt` 倒序 |
| `runtimeHeads` / `counts` | 列 `heads/`、`runs/`；记录数由批文件累加 |
| 订阅回放 `readRecordsAfter` | 该 runtime 的批文件按文件名顺序读 |

**跨进程读**（面板读正在跑的会话）：只读 rename 完成的文件，看不到半截；`runs/` 最多落后正在写派生文件的那一批，读到的是稍旧但自洽的状态。`SessionObservationReaders` 按 `observability/` 目录是否存在发现会话。

### 过期：规则归产品，机制归 core

```ts
import type { ObservationCapturePolicy, RunObservationHeader } from "@echo-agent/core";

type CreateAgentObservationOption = {
  observation?: {
    capture?: ObservationCapturePolicy;
    /** 返回要删掉的 runId。不给 = 永不删。core 不内置任何规则。 */
    expiry?: (runs: readonly RunObservationHeader[], now: number) => readonly string[];
  };
};
```

core 按返回值执行：

1. 删 `runs/<runId>.json`，这个 run 的 `getRun()` 立刻是 `unknown`。**当前进程里还开着的 run**（Sequencer 正在跟踪的）拒删并报诊断；已封口的、以及以前进程留下的没封口的，删不删由规则定——观测不判断进程死活。父 run 删了，子循环 run 不连带：它们各有自己的 `runs/` 文件，规则要删就一并返回。
2. 回收批文件：一个批文件里出现过的 run 全都删了（`runs/` 里都不在），且其中 run 之外的记录也已过期（见待拍板 3）→ 删掉。
3. 订阅回放跨过被删的批文件，交付 `retention-gap`（类型已有）。

### 撤掉

- `observability/sqlite-store.ts`、`worker-store.ts`、`sqlite-worker.ts`、`worker-protocol.ts` 与各自的测试，`bun:sqlite` 在 `packages/*/src` 里零引用；`create-agent.ts` 的 `:memory:` 分支（注入内存 `store` 时观测跟着在内存）；空会话清理里「观测在不在内存」这个参数。
- 公共面（API 快照要重录）：`observationDatabasePath`、`SqliteEchoObservationReader`（`openObservationReader` 返回类型改为 `EchoObservationReader` 的新实现）、`ObservationDatabaseMissingError`（「这个状态根没有观测目录」改由 reader 如实返回空，或保留同名错误改指目录——实现时按 `observe` 命令的提示需要定）。`ObservationStoreOpenError` / `ObservationCorruptionError` 保留。
- 设计文档 §5 的 worker 线程一节与两条 Bun 约束随之删除；`docs/architecture.md`、`README.md` / `README.zh.md` 里的 `observations.sqlite` 改写。

## Non-Goals

- **不迁移旧库**，也不留读旧库的代码。
- **不内置任何过期规则**：没有缺省 TTL、没有缺省条数上限。
- **不做 fsync 与崩溃恢复**：rename 原子保证不留半截文件，掉电丢最后几批与今天同属欠账（设计文档 §8）。
- **不开「语义层 store」注入**（换成 Postgres 之类）：本条只换缺省实现、开字节面，见待拍板 4。
- **不做按正文字段的部分清理**：删的粒度是 run。

## 待拍板

1. **过期什么时候执行。** 推荐：core 在两个固定时点调用规则函数——开库之后一次、每个 run 的 `run.closed` 提交之后一次；另给 `echo.observations.expire()` 供需要自己挑时机的使用方。备选：只给 `expire()`，时机全归使用方。
2. **删掉 `pruned` 这个读面状态。** 推荐删：粒度是 run 之后「留概要、删正文」没有落点。牵动公开类型 `RunLookupResult` 的 `pruned` 分支与 `RunIndexEntryV1.bodyState` / `prunedAt`，同一次改动里改掉读面与面板对它的处理。
3. **run 之外的记录（extension 装卸、收件、相位变更…）怎么过期。** 推荐：规则函数的返回值多一个 `activityBefore?: number`，早于它的 run 之外记录可回收；不给 = 永不删。备选：跟随批文件——批文件里的 run 全删了就连带删，不单独给规则。
4. **可注入的是哪一层。** 推荐：先只开字节面——`observation.store?: StorageDir`，缺省是状态根的 `FileDir`，覆盖「放内存 / 放别处」。「换成另一种数据库」要的是语义层（`CanonicalObservationStore`）注入，而公开线第 2 条又定了 store 接口留在内部，两条在同一份记录里互相顶着；等真有这样的消费者再拍。

## 验收

- `packages/*/src` 里没有 `bun:sqlite`；`observability/` 下没有 `sqlite-*` / `worker-*` 文件。
- 现有 `createEcho → send → getRun` 端到端测试在 `FileDir` 与 `InMemoryDir` 两种状态根下都绿，记录逐项比对不变。
- 提交点：在批文件 rename 之前让写失败——读面看不到这一批、read-after-error 判 absent；rename 之后、派生文件之前停下——重新开库后 `runs/` 补齐、`getRun` 完整。
- 过期：规则返回某个已封口的 runId → `getRun` 为 `unknown`、只含它的批文件被删、与别的 run 共用的批文件留着、订阅回放跨过时收到 `retention-gap`；返回当前正在跑的 runId → 拒删并有诊断；不给规则 → 跑多次 run 后一个文件不删。
- `observe` 命令与面板在新格式上读得出；只有 `observations.sqlite` 的会话给出「旧格式观测，已不再读取」。
- Node 下 `createEcho` 起一次、`send` 一次、`getRun` 读得回（若 Node 下另有挡路的，登记出来，不在本条修）。
