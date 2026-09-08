# 受众 = 第三方可装的 agent 内核；公共面判据按「第三方需要不需要」划；0.x，ABI 版本独立成线

> 状态:proposed · 提出 2026-09-07 · 拍板 2026-09-07(口头,实现后移入 implemented) · 来源 2026-09-07 设计对话 · **它是根决策**:[`Agent` 类内部化](2026-09-07-agent-class-internal.md) 与 [观测的公开线](2026-09-07-observation-public-face.md) 的判据都从它来

## 现状(拍板前)

仓库在高速改公共面(2026-09-07 一天动了四块),而「改到什么程度算够、谁会因此受伤」没有写下来过。两份材料互相矛盾:

- `README.md` 第一段写「An agent runtime and two products built on it … Use the assembled runtime, **build directly on the engine**, or run the same agent…」,并在「Two products」一节写 `echo-coding` 交 preset 给 `echo-agent` 的启动逻辑「**which is also how a third-party product builds on this runtime**」——是**对第三方的承诺**。
- 而 [`Agent` 类内部化](2026-09-07-agent-class-internal.md) 给自己的判据是「**有仓外消费者或 examples 用到的才公开**」,依据是「`new Agent()` 在非测试代码里零仓外消费者」——那是**没有第三方**时才成立的推理。

两条并存的后果:每次砍公共面都要临时判一次「这个算不算有人用」,而答案取决于没写下来的受众假设。

## 不拍板的代价

判据不定,公共面就在两种口径之间漂:按「当前有没有消费者」砍,会砍掉第三方将来要用的东西(压缩阶梯的作者函数就是一例);按「将来可能有人用」留,则什么都不能砍。两种漂移都要等到第一个 tag 之后才显形,而那时改就是破坏性变更。

## 选项

- **A. 开源一个第三方可装的 agent 内核。** 公共 API 与 extension ABI 本身是产品的一部分,有稳定性承诺;文档要能让外人照着写扩展;观测要给扩展作者留发口。
- **B. 引擎自用**,服务本仓的产品与用户自己的常驻程序;开源只是把代码放出去看,不承诺 API。
- **C. 回到旧口径**:唯一产品是评测系统,agent 是它的引擎(`~/Code/echo_agent` 时期的本体,见那边的设计文档)。

## 决定

**A**(2026-09-07 用户拍板)。四条:

1. **受众是第三方**:别人装 `@echo-agent/core`、写 extension、或基于 `echo-agent` 的启动逻辑建自己的产品。README 现有的那句承诺算数。
2. **公共面的判据换成「第三方建产品 / 写扩展 / 换壳需要不需要」**,取代 [`Agent` 类内部化](2026-09-07-agent-class-internal.md) 原来那句「有仓外消费者或 examples 用到的才公开」。两条判据的差别是**时态**:后者问「现在有没有人用」,前者问「将来那个人要不要」。已知的两处翻案:压缩阶梯的作者函数(`frameFull` / `snipStage` / 估算一族)**留**——第三方要写自己的压缩策略就得用它们;session 状态文件的读写(`readSessionPhase` 等)**收**——那是容器内部的事,第三方经 `Echo.sessions` 拿合成好的行。
3. **正门是 extension ABI,不是裸 `Agent` 类**。`Agent` 仍按那条记录内部化:它有 75 个成员、47 个公开字段,其中相当一部分是 host-internal 接线(写入闸、所有权账本、观测 runtime 都经 WeakMap 侧挂在它身上)的宿主,把它放公共面等于承诺这些。第三方真正要的深度——注册工具 / 出 prompt 段 / 注册压缩阶段 / 拿后台队列 / 换壳——ABI 全都给,而且带 `hostAbiVersion`、Fiber/Effect 所有权与整代回滚。**README 那句「build directly on the engine」随之改写**成三条正门:经 `createEcho()` 装配、写 extension、用 `AgentRuntime` 换壳。
4. **版本:0.x;`hostAbiVersion` 独立成线;第一个 tag 由用户点头**。0.x 是社区默认理解的「次版本可破坏」。ABI 版本管的是「这个扩展能不能装上这个宿主」(mount 时校验),包版本管的是符号表增删,两件事分开计数。tag 的时机不设机械条件——`CLAUDE.md` 的「Pre-release」那节说得清楚:第一个 tag 之后就没有「发现根因不对就连根改」这个自由,什么时候放弃它由用户说。

## 登记(本条不解,将来要各自成条)

- **ABI 对第三方够不够**:今天没有热重载(同一路径的模块进程内只求值一次),extension 面的 `sessions` / `inbox.watch` 还没做(sessions.md §9 第 3 步的尾巴),观测的发口还没建([观测的公开线](2026-09-07-observation-public-face.md) 第 1 条)。「一个第三方能不能真建出东西来」要有人拿这三样试过才知道。
- **扩展作者的文档**:今天只有 `examples/extension` 一个样例,没有写扩展的指南。A 之下文档是产品的一部分,这条缺口要补。
- **「基于 echo-agent 的启动逻辑建产品」这条路今天只在 Bun 下成立**(2026-09-08 review 批 3b 登记):`packages/cli/package.json` 的 `exports` 只有 `bun` 一支,`bin` 是 `.ts`、不构建不发 `dist`——Node 消费不了,普通 tsconfig(不写 `customConditions: ["bun"]`)也拿不到类型。这是 `packages/cli/test/package-isolation.test.ts` 那道门明确定下的「不写空头支票」,不是漏;要让第三方在 Bun 之外用它,得先补 build / 产物门,那是另一件事。README 那句承诺要在写扩展指南时把这个限制写上。

## 验收

`README.md` 与 `README.zh.md` 里没有「build directly on the engine」这类指向裸 `Agent` 的承诺,三条正门写明;[`Agent` 类内部化](2026-09-07-agent-class-internal.md) 的判据段引用本条、不再以「零仓外消费者」为据;按新判据,压缩阶梯的作者函数仍在公共面(或在 `./compaction` 子路径上),`readSessionPhase` 一族不在;`packages/core/package.json` 的版本号是 `0.x`。
