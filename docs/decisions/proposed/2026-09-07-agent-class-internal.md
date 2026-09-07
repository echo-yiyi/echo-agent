# `Agent` 类收进 core 内部：仓外只剩 `createEcho()` 与 `AgentRuntime` 两条缝

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 来源 2026-09-07 架构 review · 取代 [start 前置条件](../rejected/2026-09-01-start-precondition.md) · [收摊入口](../rejected/2026-09-01-teardown-entry.md) · [两种 lifecycle 命名](../rejected/2026-09-01-lifecycle-naming.md) · [fenced phase](../rejected/2026-09-01-fenced-phase.md)

## 现状(拍板前)

README 说「两个使用高度」:高 = `createEcho()`,低 = `new Agent()`。代码里低高度不是一个更小的 API,是同一个 `Agent` 类在不同注入组合下换前置条件:有没有传 `stateLock` / `sessionService` 决定它是不是 lifecycle-managed(`packages/core/src/agent.ts` 的 `lifecycleManaged`),写入闸、所有权账本、观测 runtime 又各自经 WeakMap 侧挂(`state/host-wiring.ts`、`observability/host-wiring.ts`)。同一个 `prompt()` 在四种组合下前置条件不同,类型面看不出来。

事实:非测试代码里 `new Agent({ … })` 只有一处调用,就是 `createAgent()` 自己(`packages/core/src/create-agent.ts`);三个 examples 全走 `createEcho()`。低高度零仓外消费者。

根入口 316 个公开符号里,`Agent` / `AgentOptions` 以及为了让测试能用低高度而导出的一批内部件(压缩阶梯的作者函数、session 状态文件的读写)都在其中。API 快照锁得住漂移,锁不住体量。

## 不拍板的代价

四条 2026-09-01 的 proposed 记录(start 前置、收摊入口、lifecycle 命名、fenced phase)讲的都是「公共契约里 `Agent` 类该怎么表现」;只要 `Agent` 在公共面上,每一条都要单独拍、单独改、单独写文档。发布后再收窄是破坏性变更,发布前是唯一一次能砍的窗口。

## 选项

- **A. `Agent` 类收进内部。** 仓外只留三条缝:`createEcho()`(装配)、`AgentRuntime`(壳协议,`@echo-agent/core/extension`)、`@echo-agent/core/testing`(替身)。
- **B. `Agent` 留在公共面,统一要求 `start()`。** 删掉「裸 Agent 可直接 `prompt()`」那条语义。
- **C. 现状。** 两种启动契约并存,文档写清。

## 决定

**A**(2026-09-07 用户拍板)。附带三条:

1. **根入口的取舍判据**:有仓外消费者或 examples 用到的才公开,其余内部;API 快照记的就是这条线。按它收回去的有 `Agent` / `AgentOptions`、压缩阶梯的作者工具包(`frameFull`、`snipStage`、估算函数一族,今天零仓外消费者)、session 状态文件的读写(`readSessionPhase` 等)。留下的:装配、provider、写工具的词汇、hooks / permission / question 类型、消息与事件、`AgentRuntime`、落盘默认件、`listSessions`。以后第一个产品要写自己的压缩阶段时再开子路径。
2. **评测与 core 自己的测试走 `createEcho()`**,不走 `new Agent()`。前提是 `createEcho()` 有零盘路径:观测 store 今天无条件在状态根开 SQLite(`create-agent.ts` 里 `SqliteCanonicalObservationStore.open`),要改成可注入,见 [观测的公开线](2026-09-07-observation-public-face.md)。
3. **四条 2026-09-01 记录移入 `rejected/`**,状态行指向本条。它们讲的公共契约不存在了;剩下两个内部实现项(`dispose()` 不还锁、fenced 是隐藏 latch)随内部化一起修,不再是决策。

## 验收

`packages/core/package.json#exports` 可达的符号里没有 `Agent` 类与 `AgentOptions`;API 快照重录后根入口符号数明显下降且每个留下的符号都能指出一个仓外消费者或 example;`examples/` 三个样例与 `packages/core/test/` 全部经 `createEcho()` 起 agent;README「两个使用高度」一节重写。
