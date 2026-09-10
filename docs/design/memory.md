# 持久记忆（审阅稿）

> 状态：审阅中；按 2026-09-08 当前实现核对，不以决策记录的 implemented 标签代替验收<br>
> 读者：配置产品记忆范围、编写记忆 extension、排查记忆没有写入或没有被召回的人<br>
> 范围：作用域、记忆模块、模型读写、提取、Dream、预算、并发与收摊<br>
> 退出条件：第 8 节的实现缺口分别修复或经新决策改变承诺，复核后改为正式设计；本稿不另行复制为第二份契约

## 1. 记忆解决什么问题

记忆保存另一段会话仍值得知道的内容，不保存当前任务进度，也不是聊天记录的第二份副本。用户偏好、重复出现的行为纠正、试出来的环境事实与决定的理由可以成为候选；是否值得长期保存由模型判断，机器不证明其真实性或持久性。

它与相邻机制的边界是：

| 机制 | 保存或处理什么 | 后续怎样使用 |
| --- | --- | --- |
| session / transcript | 这段会话发生过什么 | 恢复、追溯、继续任务 |
| compaction | 怎样缩小当前会话的送模视图 | 原账本不变，送模时投影摘要与保留段 |
| 持久记忆 | 跨会话仍有用的认知与事实 | 小内容常驻 system，大内容靠索引按需读取 |
| 提取 | 从会话材料选择新的记忆 | 使用记忆工具新建或修改 |
| Dream | 整理已经保存的记忆 | 去重、归位、剪枝、处理冲突 |

会话机制见 [Sessions](sessions.md)，压缩见 [Compaction](compaction.md)，模型输入刷新见 [Prompt](prompt.md)。提取可以产生新条目，Dream 应只整理已有内容；“不发明”“不保存凭据”“不重复记录”都是提示词纪律，不是已建立的语义门。

本轮设计决定分别归属：[作用域](../decisions/implemented/2026-09-07-memory-scopes-by-product.md)、[记忆模块](../decisions/implemented/2026-09-07-memory-modules.md)、[提取](../decisions/implemented/2026-09-07-memory-extraction.md)、[Dream](../decisions/implemented/2026-09-07-dream-rework.md)、[并发](../decisions/implemented/2026-09-07-memory-concurrency.md)。本文描述它们当前兑现到哪里，不重写决策理由。

## 2. 产品怎么装配，数据在哪里

受支持入口是 [`createEcho()`](../../packages/core/src/create-echo.ts#symbol=createEcho)。默认装配记忆；一次性评测或不希望保留跨任务状态时传 `withoutMemory: true`，记忆工具、记忆 section 及这两条后台工作随能力一起缺席。不要围着裸 Agent 复制装配。

**开关归用户，形状归产品。** `withoutMemory` 对应用户的 `--no-memory`，产品碰不到；装哪些模块、分哪几层由产品经 `Product.preset` 返回的 `memory` 决定。`memory.builtin: false` 不装内建的三个模块（agent / user / notes），模块全部来自扩展经 `AgentMemory.module()` 的注册——扩展注册在缺省情况下只是**追加**，要替换就得先关掉内建这组。想保留其中某几个，就把 `@echo-agent/core/extension` 导出的定义再注册一遍。

**作用域回答“谁共享”，记忆模块回答“记什么”。** 路径由两者组合：`<作用域>/<模块路径>`。例如 `project/agent.md` 是这个项目里共同使用的行为记忆，不是某个 agent 实例的私有文件。相同内容出现在不同作用域时，不自动覆盖、去重或跨层提升。

产品通过 [`CreateAgentOptions`](../../packages/core/src/create-agent.ts#symbol=CreateAgentOptions) 的 `memory.scopes` 整份替换默认声明。每项 [`MemoryScopeDef`](../../packages/core/src/memory/scope.ts#symbol=MemoryScopeDef) 指定名字、顺序、可见性说明、锚点、相对前缀及可选留痕。默认真盘位置由 [`DEFAULT_MEMORY_SCOPES`](../../packages/core/src/create-agent.ts#symbol=DEFAULT_MEMORY_SCOPES) 给出：

| 作用域 | 默认根 | 共享范围 |
| --- | --- | --- |
| user | `<ECHO_HOME>/memory/` | 使用这个 home 的会话 |
| project | `<ECHO_HOME>/projects/<workspaceHash>/memory/` | 同一 workspace 的会话 |
| role | `<ECHO_HOME>/agents/<角色名>/memory/` | 同一具名角色的会话，可跨项目 |

没有角色名时没有 role 层，不退回名为 default 的共享层。当前默认没有 session 记忆层。`order` 决定选层说明及模块内部各层的呈现顺序，但不是 ACL，也不能把“项目范围”和“角色范围”变成严格包含关系；选层还必须读 `describe`。

上述路径是默认文件系统装配，不是固定绝对位置。`sharedStore` 控制共享存储；只给自定义 `store` 时，共享面默认跟随它，不能假定仍写真盘 home。workspace / path 锚点另由装配层开对应目录，见 [`prepareCapabilities()`](../../packages/core/src/create-agent.ts#symbol=prepareCapabilities)。远程记忆服务、向量检索和组织共享后端不属于本轮设计。

### 绑定以恢复后的身份为准

作用域先声明，等 session 创建或恢复拿到权威 workspace、角色、产品后再解析。绑定前的字节读写拒绝；绑定后不因 `setWorkspace()` 改变而重新选根。原因是恢复一段会话不能把它的项目记忆误指向启动命令所在目录。

实现归 [`lateBoundMemoryDir()`](../../packages/core/src/memory/scope.ts#symbol=lateBoundMemoryDir) 与 [`bindMemoryScopes()`](../../packages/core/src/memory/harness.ts#symbol=bindMemoryScopes)。模块在绑定前注册时，层名与路径重叠校验延迟到绑定；绑定后注册则立即校验，不能统称“所有错误都在注册当场发现”。

前缀支持的变量以 [`MEMORY_PREFIX_VARIABLES`](../../packages/core/src/memory/scope.ts#symbol=MEMORY_PREFIX_VARIABLES) 为准；角色用 agent 锚点，不另设 role 变量。`stamp: true` 的层会检查已有 `workspace.json`，首次写入时生成留痕；这用于发现已有目录与 workspace 不符，不应说成哈希绝不会碰撞或并发首次创建已原子化。

## 3. 模块、预算与召回

内建模块与第三方都经 [`AgentMemoryRegistry.module()`](../../packages/core/src/extension/registries.ts#symbol=AgentMemoryRegistry.module) 登记。extension 注入 `AgentMemory`，在自己的 effect 中注册并交还 disposer；没有记忆能力时这个 service 缺席。扩展只增加内容声明，不另建落盘流程。模块声明的 `ops` 在 harness 的唯一写路径上生效（`op_not_supported` 拒绝），不在工具 schema 上——一把工具服务所有模块，动词枚举是全局的；落在方法上则无论缺省工具还是复写的 handlers 都挡得住。整理那把工具除了限定在当前层，还碰不到同层声明了 `dream: false` 的模块（读不拦）。

当前内建定义见 [`agentMemory`](../../packages/core/src/memory/types.ts#symbol=agentMemory)、[`userMemory`](../../packages/core/src/memory/types.ts#symbol=userMemory)、[`notesMemory`](../../packages/core/src/memory/types.ts#symbol=notesMemory)：

| 模块 | 路径 | 呈现模式 | 语义 |
| --- | --- | --- | --- |
| agent | `agent.md` | resident：全文进 system | 经常性的做事习惯、应重复或避免的行为 |
| user | `user.md` | resident：全文进 system | 对用户的认知、偏好与沟通方式 |
| memory（笔记） | `memory/` | indexed：索引进 system，正文用工具读取 | 长期事实及以后去哪里找东西 |

模块不填 `scopes` 表示当前所有层都有；填写则限定在那些层。同一模块每层独立存储、独立预算。`residentMemory()` / `indexedMemory()` 是声明构造器，不会自行装入运行中的产品。重复名字、已绑定后的路径重叠会拒绝，避免同一路径落进两个预算域。

预算以 JavaScript 字符串 `length` 计，不是 token 或 UTF-8 字节。resident 校验全文；indexed 同时校验单文件全文和该层完整索引的渲染长度。具体缺省值以构造器和内建定义为准，本文不复制一张会独立漂移的数字表。模块数量和作用域数量可以增长，因此单模块预算不等于最终 system 的总上界。

### 索引是派生物，不是记忆真源

[`indexEntries()`](../../packages/core/src/memory/compose.ts#symbol=indexEntries) 从文件生成路径与描述：优先 frontmatter 的 description，否则取正文首个非空行。索引描述会单行化并截断；正文不因此成为可信指令。

`INDEX.md` 由写方法重建，不能通过默认记忆写方法直接改它，也不索引它自身。组装时优先读已有非空索引；没有索引时才现场扫描。**手工改正文不保证马上更新已有索引**，下一次相关写入重建前可能继续使用旧描述。

[`defaultComposeMemory`](../../packages/core/src/memory/compose.ts#symbol=defaultComposeMemory) 为每个模块的非空层生成带路径的块；模块按注册次序遍历，模块内部按作用域顺序遍历。它不会加载 indexed 正文来代替索引。读入超预算的手工文件会截断并留标记，不能据此承诺文件本身已被修复。

[`memoryPromptSections()`](../../packages/core/src/memory/harness.ts#symbol=memoryPromptSections) 把规则和内容接进 system。每个主 run 装配一次：run 内写记忆不回写这份 system，下一次 run 才重新呈现；模型仍可用 `view` 主动读取更新后的文件。冻结的是生成后的字符串，不是多个记忆文件的事务快照。

## 4. 模型读写与失败语义

默认只有一把 [`memory`](../../packages/core/src/memory/tool.ts#symbol=createMemoryTool) 工具，command 选择操作：

| 操作 | 当前行为 |
| --- | --- |
| view | 空路径看概览；目录看列表；文件返回带行号内容 |
| create | 新建或整文件覆盖，不是 create-if-absent |
| str_replace | old_str 必须非空且恰好命中一次 |
| insert | 指定行之后插入，零表示文件开头；拒绝非法或越界行号 |
| delete | 删除属于已注册模块的文件 |
| rename | 同一作用域、同一模块内移名；目标必须不存在 |

路径先经 [`normalizeMemoryPath()`](../../packages/core/src/memory/tool.ts#symbol=normalizeMemoryPath) 规范化，接受 `/memories/` 前缀，拒绝路径穿越、反斜杠、控制字符、点开头的内部段。`.dream` 状态不通过该工具暴露。这是路径协议的判据，不是模型语义安全保证。

写入骨架归 [`writeMemory()`](../../packages/core/src/memory/harness.ts#symbol=writeMemory)：规范化 → 保护索引 → 路由模块 → 读取并准备新正文 → 预算检查 → 新鲜度检查 → 写入 → 更新计数和索引 → 发 mutation 事实。删除、改名有各自路径，不能假定它们具备完全相同的保护。

工具拒绝或失败用 error result 回给模型；成功正文写入后索引重建失败，正文仍已提交，诊断为 `memory_index_rebuild_failed`，事实的 `indexOutcome` 为 failed。改名先写目标再删源，删源失败报告 partial，可能留下两份文件，不是事务回滚。判据与事实生成见 [`finishMemoryMutation()`](../../packages/core/src/memory/harness.ts#symbol=finishMemoryMutation)。

这套方法是默认工具的共用操作面，不是“所有宿主代码绝无绕行路径”的保证。当前公开 harness 仍暴露字节面；模块 `ops` 与 Dream 模块边界也尚未执行，见第 8 节。

## 5. 记忆怎样产生：前台与提取

前台仍可主动记忆，触发提示和排除项由 [`renderMemorySystem()`](../../packages/core/src/memory/compose.ts#symbol=renderMemorySystem) 提供。提取是另一条后台通道，入口是主事件流的 reply_end，而不是每次模型请求。

当前 [`Agent.enqueueExtract()`](../../packages/core/src/agent.ts#symbol=Agent.enqueueExtract) 检查记忆已绑定、生命周期允许工作且有运行 scope，然后对 reply 结束时的 transcript 做压缩视图投影并渲染文本。**这不是该 reply 最后一次 provider request 的精确快照**：不包含同一条 transform / hook / 临时 injection 管线，且时间点已经在 reply 收尾。

[`defaultExtractPrompt()`](../../packages/core/src/memory/extract.ts#symbol=defaultExtractPrompt) 把这份会话材料连同作用域与模块说明给隔离子循环，要求先查看已有记忆、避免重复、只保留以后有用的事实，允许什么都不写。

[`Agent.runExtract()`](../../packages/core/src/agent.ts#symbol=Agent.runExtract) 当前只给 memory 工具，不继承父的动态注入；上限来自 [`DEFAULT_EXTRACT_MAX_TURNS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_MAX_TURNS)。模型绑定仍来自父 scope，**没有单独实现“便宜模型档”选择**；轮数上限也不等于费用或墙钟时间的硬上界。

提取不通过 admission，不抢前台许可；独立消息数组、不消费前台 steer / followUp，子循环事件不发进主 transcript。但它复用父的循环配置与相关服务，不能笼统宣称与前台完全不共享可变状态。

目前重叠保护是“本 reply 出现成功的 memory 工具结束事件”，并非已提交 mutation 事实。因此只读 view 也会跳过提取，别名工具的写入则未必触发跳过。忙时后续触发的材料还可能丢失，见第 8 节；不能承诺每条 reply 恰好完成一次提取。

## 6. Dream 怎样整理

主 agent 回 idle 后可排 Dream；生命周期激活时为已有记忆打开自动整理。它走与提取分开的 [`MemoryChannel`](../../packages/core/src/memory/channel.ts#symbol=MemoryChannel)，两条通道各自同时至多一个任务在跑，前台不会通过 admission 抢占它们。

[`dreamScopes()`](../../packages/core/src/memory/harness.ts#symbol=dreamScopes) 选出 dream 模块涉及的层，按作用域顺序逐层处理。每层的 [`shouldDream()`](../../packages/core/src/memory/harness.ts#symbol=shouldDream) 判据为：

1. 有未过期 startedAt 标记时不启动。
2. 否则，任一参与整理模块达到配置水位即可启动。
3. 未达水位时，所有已配置的节流条件都满足才启动：间隔、写入数、轮数、indexed 文件数。

缺省阈值以 [`DEFAULT_DREAM_GATES`](../../packages/core/src/memory/dream.ts#symbol=DEFAULT_DREAM_GATES) 为准。水位对 resident 看全文，对 indexed 看索引，不看 indexed 单个正文是否快满。轮次来自前台 turn_end 并向各参与层计数；状态存于各层 `.dream/state.json`。

[`dreamTask()`](../../packages/core/src/memory/harness.ts#symbol=dreamTask) 写 startedAt 并生成限定该层的 memory 工具。当前层边界在工具执行时检查，但 dream:false 模块的排除只影响提示词和选层，并未限制这把工具能写同层哪些模块。

[`defaultDreamPrompt()`](../../packages/core/src/memory/dream.ts#symbol=defaultDreamPrompt) 要求去重、把错放的内容重建到正确模块后从原处删掉、剪枝、保留无法裁决的冲突及控制预算。这些语义步骤不具备事务性，也没有机器判据证明模型真的完成了它们。

[`Agent.runDreamPass()`](../../packages/core/src/agent.ts#symbol=Agent.runDreamPass) 仅在子循环 outcome 为 completed 且未 abort 时调用 [`markDreamed()`](../../packages/core/src/memory/harness.ts#symbol=markDreamed)，记录时间、清除标记及计数。失败不记成功，标记等过期再允许重来；单层错误报诊断后继续其他层。completed 仅说明循环完成，不说明记忆质量变好。

当前 Dream 继承父的动态注入，而提取不继承；Dream 的迭代预算沿用父配置。这与“整理只看已有记忆”的语义需要分开：其工具只有记忆，不代表其输入绝无其他材料。

## 7. 并发、收摊与可观测性

当前只能确认以下边界：

- [`withMemoryFileLock()`](../../packages/core/src/memory/lock.ts#symbol=withMemoryFileLock) 按 harness 对象和路径串行化，不是 OS 文件锁。不同 harness 即使在同一进程、指向同一根，也不共用这条队列。
- [`assertFresh()`](../../packages/core/src/memory/lock.ts#symbol=assertFresh) 在部分读改写操作落盘前重读旧内容；它与后面的 write 不是原子操作，不能推出跨进程无丢更新。create 整体覆盖不做这项比对。
- Dream 的 startedAt 是状态文件里的标记；shouldDream 的检查和 dreamTask 的设置分开，不能推出多个 session 只有一个整理者。
- 索引与计数各有后续写入；正文、索引、Dream 状态不组成一个原子事务。按单文件串行也不能推出多个笔记并发写入时索引总预算仍受保护。

[`Agent.settleDream()`](../../packages/core/src/agent.ts#symbol=Agent.settleDream) 虽沿用旧名字，实际会同时 abort 并等待提取、Dream 两条通道，接入 stop / 丢锁路径。停发新工作与等待在飞工作结束是两件事；不能以“后台不阻塞前台”推导“退出不必等后台”。

正文变更由 [`MemoryFact`](../../packages/core/src/memory/observe.ts#symbol=MemoryFact) 表达 committed / rejected / failed / partial；索引结果单独记录。后台循环当前不作为独立 admission run 出现在 run 列表里。通道捕获抛出的异常，但提取调用点没有检查非抛出的 error outcome，因此“后台失败都有明确提取失败诊断”尚不成立。

## 8. 尚未兑现的契约

以下不是待写功能清单，而是当前实现与已登记承诺的具体差异。复现仅使用内存字节面，不触碰用户记忆，也不证明真实模型的语义质量。

### 模块自带工具未落地

记忆模块决策里的 `tools` 回调（模块自带工具，只拿 harness 方法、拿不到字节面）没有落地：registry 接收的是 `AnyMemory`，模块形状里没有这一格。harness 的写方法也不在公共面上，所以**包外扩展今天没有办法给自己的模块配一件专用写工具**，只能靠缺省的 `memory` 工具。

### 忙时提取重跑旧快照

MemoryChannel 只保留 again 标记，结束后重跑最初的 run 回调；新 schedule 传入的回调被丢弃。而提取的 transcript 被捕获在回调闭包中，结果不是“再看一次最新状态”，而是“再提取一次旧材料”。

```bash
bun -e 'import {MemoryChannel} from "./packages/core/src/memory/channel.ts"; let release; const barrier=new Promise(r=>release=r); const calls=[]; const c=new MemoryChannel("probe"); c.schedule(async()=>{calls.push("old"); await barrier;}); c.schedule(async()=>{calls.push("new");}); release(); await new Promise(r=>setTimeout(r,10)); console.log(calls); await c.settle();'
```

当前输出 old、old。修复判据必须覆盖忙时的新材料最终被消费，不能只断言“又运行了一次”。重叠保护还应以真实提交写入区分 view 与 mutation，输入快照与模型选择则须对照提取决策分别收口。

### 新鲜度检查不能代替跨进程互斥

以下在两个 harness 的最终 write 前设置 barrier，让两边都先通过新鲜度检查，模拟共享根的两个写者：

```bash
bun -e 'import {createAgentMemories,bindMemoryScopes,memoryStrReplace} from "./packages/core/src/memory/harness.ts"; import {residentMemory} from "./packages/core/src/memory/types.ts"; import {memoryScopeTable} from "./packages/core/src/memory/scope.ts"; import {InMemoryDir} from "./packages/core/src/memory/in-memory-dir.ts"; const raw=new InMemoryDir(); await raw.write("note.md","A B"); let n=0,release; const barrier=new Promise(r=>release=r); const dir={read:p=>raw.read(p),list:p=>raw.list(p),remove:p=>raw.remove(p),write:async(p,v)=>{if(p==="note.md"){if(++n===2)release();await barrier;}await raw.write(p,v);}}; const make=()=>{const h=createAgentMemories({memories:[residentMemory("note")]});bindMemoryScopes(h,memoryScopeTable([{def:{name:"team",order:1,describe:"shared",anchor:{kind:"home"},prefix:""},dir}]));return h;}; const r=await Promise.all([memoryStrReplace(make(),"team/note.md","A","AA"),memoryStrReplace(make(),"team/note.md","B","BB")]);console.log({errors:r.map(x=>x.isError),final:await raw.read("note.md")});'
```

当前两次都报成功，最终却是 A BB，第一份修改丢失。这足以否定“已实现跨进程读改写锁”的承诺；真正的跨进程、崩溃恢复及双 Dream 排他仍需独立验证，不能拿本探针冒充这些测试。

## 9. 验证范围与人工责任

已有测试可作为局部证据，不是第 8 节问题已经被守住的证明：

- [resident 超预算拒绝](../../packages/core/test/memory.test.ts#test=resident-超预算拒拒因带整理指引)：写入超预算时返回整理指引；同文件另有索引、路径、层绑定与 system 冻结测试。
- [具名角色的目录](../../packages/core/test/create-agent.test.ts#test=有角色名时-role-层就在落在-agents角色名memory与角色定义同一棵树)：默认 role 层的装配落点；同文件另有无角色名的情形。
- [Dream 未达写入门不启动](../../packages/core/test/dream-schedule.test.ts#test=门不满足-不跑写入数没到)：基本触发条件；同文件另有前台并行、主 transcript 隔离、失败不记成功及 stop 等待测试。
- [后台工作不列成 admission run](../../packages/core/test/observability-runtime.test.ts#test=记忆的后台活不再是-admission-run用户那条照常可查run-列表里只有它)：观测列表的当前口径。

旧测试中的 session 层是显式 fixture，不代表默认产品仍有该层；标题中的“只整理 session”不能被当成当前全局设计。链接门只检查文件或符号存在，不审判这些测试的语义。

```bash
bun test packages/core/test/memory.test.ts packages/core/test/dream-schedule.test.ts \
  packages/core/test/create-agent.test.ts packages/core/test/observability-runtime.test.ts
bun scripts/docs-lint.ts
bun test test/docs.test.ts test/export-jsdoc.test.ts
```

仍需人审或真实模型评测的内容：记忆是否真实、选层是否适当、用户偏好是否被过度泛化、Dream 是否删掉关键事实、description 能否帮助召回、提取与整理的额外费用是否值得，以及跨会话可见性是否符合产品隐私预期。当前不存在证明这些性质的机器门。
