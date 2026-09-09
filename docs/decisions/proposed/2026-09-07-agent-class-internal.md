# `Agent` 类收进 core 内部：仓外只剩 `createEcho()` 与 `AgentRuntime` 两条缝

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · **判据 2026-09-07 改**(见「决定」第 1 条,原来那条以「零仓外消费者」为据,受众定成第三方之后失效) · 来源 2026-09-07 架构 review · 判据的上位记录:[受众与版本](2026-09-07-audience-and-versioning.md) · 取代 [start 前置条件](../rejected/2026-09-01-start-precondition.md) · [收摊入口](../rejected/2026-09-01-teardown-entry.md) · [两种 lifecycle 命名](../rejected/2026-09-01-lifecycle-naming.md) · [fenced phase](../rejected/2026-09-01-fenced-phase.md)

> **形态的家就是本条**:公共面这件事没有设计文档([架构总览](../../architecture.md) §6 只列门,不列该公开什么)。有了之后把清单搬过去,本条只留取舍。

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

1. **根入口的取舍判据**(2026-09-07 改,见 [受众与版本](2026-09-07-audience-and-versioning.md)):**第三方建产品 / 写扩展 / 换壳需要不需要**——需要就公开,否则内部;API 快照记的就是这条线。

   原来写的是「有仓外消费者或 examples 用到的才公开」,依据是「`new Agent()` 零仓外消费者」。受众定成第三方之后那条失效了:两者差在**时态**,旧判据问「现在有没有人用」,新判据问「将来那个人要不要」。**结论没变**(`Agent` 类照旧内部化),但理由换了——见下面第 4 条;按新判据的两处翻案也在那里。

   按新判据收回去的:`Agent` / `AgentOptions`(理由见第 4 条)、session 状态文件的读写(`readSessionPhase` 等——那是容器内部的事,第三方经 `Echo.sessions` 拿 core 合成好的行)。**留下的**:装配、provider、写工具的词汇、hooks / permission / question 类型、消息与事件、`AgentRuntime`、落盘默认件、`listSessions`,**以及压缩阶梯的作者函数**(`frameFull` / `snipStage` / 估算一族——第三方要写自己的压缩策略就得用;旧判据把它们判成「零消费者→收内部」,是错的)。它们留在根入口还是下沉到 `./compaction` 子路径,是实现时的一步,不改「留」这个结论。
2. **评测与 core 自己的测试走 `createEcho()`**,不走 `new Agent()`。它要的零盘路径**已经有了**:给了自定义 `store` 又没点名 `stateDir` 时观测库开 `:memory:`(71150f0),配上 `InMemoryDir` 与 `InMemoryStateLock` 就是一次不碰盘的完整装配。想换掉观测 store 本身是另一件事,见 [观测的公开线](2026-09-07-observation-public-face.md)。
3. **四条 2026-09-01 记录移入 `rejected/`**,状态行指向本条。它们讲的公共契约不存在了;剩下两个内部实现项(`dispose()` 不还锁、fenced 是隐藏 latch)随内部化一起修,不再是决策。
4. **`Echo.start()` 先开出来**(2026-09-08 用户拍板,review 批 5 发现):内部化之前第三方就得有一条不经 `agent` 的启动入口,否则 README 的 quickstart 只能教 `echo.agent.start()`。`Echo` 加 `start()`,就是 `agent.start()` 的转发;README / examples / cli 改走它,`echo.agent` 字段随内部化退场。
5. **`RuntimeSource` 随内部化改名**(2026-09-09 用户拍板,review 批 6 #113 登记):它是 `agentRuntimeOf()` 收的那份 `Pick<AgentRuntime, …>`——「做 runtime 用的源材料」,不是「runtime 的来源」,名字会被读成后者。它现在是公共符号(`extension/public.ts` 导出),单独改名要重录 API 快照一次;`Agent` 内部化落地时这条边界本来就要重画(收进来的就是它),届时一起改、只重录一次。

## 验收

`packages/core/package.json#exports` 可达的符号里没有 `Agent` 类与 `AgentOptions`;API 快照重录后根入口符号数明显下降且每个留下的符号都能指出一个仓外消费者或 example;`examples/` 三个样例与 `packages/core/test/` 全部经 `createEcho()` 起 agent;README「两个使用高度」一节重写。
