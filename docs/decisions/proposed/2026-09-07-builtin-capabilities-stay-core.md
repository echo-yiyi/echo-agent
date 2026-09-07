# 内建五件的机制留在 core：按压缩那个分法，`echo:*` 只出缺省内容

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 来源 2026-09-07 架构 review

## 现状(拍板前)

memory / tasks / schedule / skills / inbox 五件内建能力,「注册走 extension、机制在 Agent」:`defineToolPack` 只注册工具和 prompt 段(`packages/core/src/extension/builtin.ts`),工具对象在 `Agent` 构造函数里造,恢复顺序在 `start()` 里手排,dream 调度、inbox 轮询、任务落盘尾巴都是 `Agent` 的私有方法。架构 review 把这报成「一个内建能力有两个定义」,并提议把能力整个搬出 `Agent`、为此给 extension ABI 开「恢复完成」「回 idle 起维护 run」两个口(一个叫 `AgentLifecycle` 的能力端口)。

## 不拍板的代价

不拍就有两条路并存:一条把能力当第三方 extension 对待(core 不认识 memory),一条当 core 恒有的能力(core 认识)。ABI 该不该开生命周期口、`agent.ts` 的体量算不算问题、memory 要不要 registry,三件事都取决于这一条。

## 选项

- **A. 按压缩那个分法。** 机制与状态在 core,`echo:*` extension 只出缺省内容,需要让别人扩展的才在 core 开一张 registry(`AgentCompaction` 那样)。`Agent` 不瘦,`agent.ts` 的体量是设计选择。
- **B. 能力整个搬出 `Agent`。** 每件是一条 extension,自带 harness、存储视图、工具、observer;ABI 加生命周期口;core 不认识 memory。
- **C. 只搬没有恢复期依赖的。**

## 决定

**A**(2026-09-07 用户拍板:「memory 其实和压缩一样,是 agent 很核心的能力,core 要认识」)。具体到三层:

| 层 | 压缩(今天) | memory(同样分法) |
|---|---|---|
| 状态与机制,core 拥有 | `CompactionState`、流水线、轮首阈值判断 | `AgentMemories` 容器、dream 调度、轮次门、恢复 dream 状态 |
| 别人往里注册的口 | `AgentCompaction` registry | 分区 registry——**暂不开**,今天零消费者;第一个仓外扩展出现时再开 |
| 缺省内容,一条 `echo:*` extension | `echo:compaction` | `echo:memory`:`memory` 工具、记忆段、缺省分区 |

附带:`AgentLifecycle` 端口的提议**撤回**;架构 review 里「把能力搬出 Agent」那条**撤回**;tasks / schedule / skills / inbox 同此,不逐件另拍。

## 验收

不新增 ABI 成员;`agent.ts` 里五件能力的构造、恢复、调度代码保持原位;`echo.extensions` 仍列出 `echo:memory` / `echo:tasks` / `echo:scheduler` / `echo:skills`,且它们的工具与段仍经 `AgentTools` / `AgentPrompt` 注册。
