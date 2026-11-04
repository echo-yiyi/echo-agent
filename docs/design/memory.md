# 持久记忆

> 读者：配置产品记忆、编写记忆 extension 或排查读写与召回的人<br>
> 范围：作用域、模块、预算、提取、Dream、并发与收摊<br>
> 状态：当前实现说明；专用工具与提取策略的限制见 §8

## 导读

**解决什么。** 保存另一段会话仍有用的内容，同时控制常驻上下文和后台维护成本。

**设计主线。** 作用域决定共享范围，模块决定内容类型；resident 全文常驻，indexed 只常驻索引。前台工具与后台提取产生记忆，Dream 整理已有记忆，各写入路径共享预算与提交保护。

**边界。** 记忆不代替 transcript 或任务进度；模型对事实真实性、持久性和共享范围的判断仍需评测与人工审查。

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

设计取舍分别见：[作用域](../decisions/implemented/2026-09-07-memory-scopes-by-product.md)、[记忆模块](../decisions/implemented/2026-09-07-memory-modules.md)、[提取](../decisions/implemented/2026-09-07-memory-extraction.md)、[Dream](../decisions/implemented/2026-09-07-dream-rework.md)、[并发](../decisions/implemented/2026-09-07-memory-concurrency.md)。本文维护当前机制与限制，决策记录保留取舍。

## 2. 产品怎么装配，数据在哪里

受支持入口是 [`createEcho()`](../../packages/core/src/create-echo.ts#symbol=createEcho)。默认装配记忆；一次性评测或不希望保留跨任务状态时传 `withoutMemory: true`，记忆工具、记忆 section 及这两条后台工作随能力一起缺席。不要围着裸 Agent 复制装配。

**开关归用户，形状归产品。** `withoutMemory` 对应用户的 `--no-memory`，产品碰不到；装哪些模块、分哪几层由产品经 `Product.preset` 返回的 `memory` 决定。`memory.builtin: false` 不装内建的三个模块（agent / user / memory——笔记模块的名字就是 `memory`，点名、关 dream、重新注册都用这个键），模块全部来自扩展经 `AgentMemory.module()` 的注册——扩展注册在缺省情况下只是**追加**，要替换就得先关掉内建这组。想保留其中某几个，就把 `@echo-agent/core/extension` 导出的定义再注册一遍。**什么值得记的判据写在各模块自己的 instructions 里**：记忆段、提取、整理三处 prompt 只讲机制（先看再写、合并不新增近似条、超预算先整理、绝不存凭据、可以什么都不写），所以 `builtin: false` 会连同内建模块的判据一起拿掉，产品模块用自己的 instructions 带自己的判据。

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

内建模块与第三方都经 [`AgentMemoryRegistry.module()`](../../packages/core/src/extension/registries.ts#symbol=AgentMemoryRegistry.module) 登记。extension 注入 `AgentMemory`，在自己的 effect 中注册并交还 disposer；没有记忆能力时这个 service 缺席。扩展只增加内容声明，不另建落盘流程。模块声明的 `ops` 在 harness 的写路径上生效（`op_not_supported` 拒绝），不在工具 schema 上——一把工具服务所有模块，动词枚举是全局的；落在方法上则无论缺省工具还是复写的 handlers 都挡得住。实际支持的动词是**声明的 `ops` 与该 mode 默认集的交集**（[`memoryOps()`](../../packages/core/src/memory/tool-commands.ts#symbol=memoryOps)）：**只能收紧，不能放宽**——resident 的默认集里没有 `rename`（[`defaultOpsForMode()`](../../packages/core/src/memory/tool-commands.ts#symbol=defaultOpsForMode)），写进 `ops` 也不会生效。这道闸只管五个写动词，`view` 不过闸、禁不掉。整理那把工具除了限定在当前层，还碰不到同层声明了 `dream: false` 的模块（读不拦）。

当前内建定义见 [`agentMemory`](../../packages/core/src/memory/types.ts#symbol=agentMemory)、[`userMemory`](../../packages/core/src/memory/types.ts#symbol=userMemory)、[`notesMemory`](../../packages/core/src/memory/types.ts#symbol=notesMemory)：

| 模块 | 路径 | 呈现模式 | 语义 |
| --- | --- | --- | --- |
| agent | `agent.md` | resident：全文进 system | 经常性的做事习惯、应重复或避免的行为 |
| user | `user.md` | resident：全文进 system | 对用户的认知、偏好与沟通方式 |
| memory（笔记） | `memory/` | indexed：索引进 system，正文用工具读取 | 长期事实及以后去哪里找东西 |

模块不填 `scopes` 表示当前所有层都有；填写则限定在那些层。同一模块每层独立存储、独立预算。[`residentMemory()`](../../packages/core/src/memory/types.ts#symbol=residentMemory) / [`indexedMemory()`](../../packages/core/src/memory/types.ts#symbol=indexedMemory) 是仓内的声明构造器，**不在公共面上**：包外扩展交的是纯数据 `AnyMemory`（必填 `name` / `mode` / `path` / `budget` / `instructions` / `dream`，indexed 另有 `fileBudget` 且 `path` 以 `/` 结尾），或把 `@echo-agent/core/extension` 导出的内建定义再注册一遍。构造器本身也不会自行装入运行中的产品。重复名字、已绑定后的路径重叠会拒绝，避免同一路径落进两个预算域。

当前缺省值如下。**真源是链接的符号**，数值随构造器与内建定义改：

| 项 | 缺省 | 真源 |
| --- | --- | --- |
| agent / user 预算 | 2200 / 1400 字符 | [`agentMemory`](../../packages/core/src/memory/types.ts#symbol=agentMemory)、[`userMemory`](../../packages/core/src/memory/types.ts#symbol=userMemory) |
| 笔记模块预算 | 索引 25000，单文件 4096 | [`notesMemory`](../../packages/core/src/memory/types.ts#symbol=notesMemory) |
| 构造器缺省 | resident 2000；indexed 索引 25000、单文件 4096 | [`residentMemory()`](../../packages/core/src/memory/types.ts#symbol=residentMemory)、[`indexedMemory()`](../../packages/core/src/memory/types.ts#symbol=indexedMemory) |
| 索引描述行 | 单行化后截断 200 字符 | [`indexEntries()`](../../packages/core/src/memory/compose.ts#symbol=indexEntries) |
| Dream 门 | 写 5 次、10 个 indexed 文件、24 小时、水位 0.8；**没有轮数门** | [`DEFAULT_DREAM_GATES`](../../packages/core/src/memory/dream.ts#symbol=DEFAULT_DREAM_GATES) |
| startedAt 过期 | 1 小时 | [`DREAM_LOCK_STALE_MS`](../../packages/core/src/memory/dream.ts#symbol=DREAM_LOCK_STALE_MS) |
| 提取轮数上限 | 5 | [`DEFAULT_EXTRACT_MAX_TURNS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_MAX_TURNS) |
| 提取门槛 | 用户说的话 8 个词，且攒满 3 轮用户输入 | [`DEFAULT_EXTRACT_MIN_USER_WORDS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_MIN_USER_WORDS)、[`DEFAULT_EXTRACT_EVERY_TURNS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_EVERY_TURNS) |
| 退出前补提取最多等 | 15 秒 | [`DEFAULT_EXTRACT_DRAIN_MS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_DRAIN_MS) |
| 提交锁等待 | 10 秒 | [`DEFAULT_LOCK_TIMEOUT_MS`](../../packages/core/src/storage/name-lock.ts#symbol=DEFAULT_LOCK_TIMEOUT_MS) |

预算以 JavaScript 字符串 `length` 计，不是 token 或 UTF-8 字节。resident 校验全文；indexed 同时校验单文件全文和该层完整索引的渲染长度。模块数量和作用域数量可以增长，因此单模块预算不等于最终 system 的总上界。

### 索引是派生物，不是记忆真源

[`indexEntries()`](../../packages/core/src/memory/compose.ts#symbol=indexEntries) 从文件生成路径与描述：优先 frontmatter 的 description，否则取正文首个非空行。索引描述会单行化并截断；正文不因此成为可信指令。

`INDEX.md` 由写方法重建，不能通过默认记忆写方法直接改它，也不索引它自身。组装时优先读已有非空索引；没有索引时才现场扫描。**手工改正文不保证马上更新已有索引**，下一次相关写入重建前可能继续使用旧描述。

[`defaultComposeMemory`](../../packages/core/src/memory/compose.ts#symbol=defaultComposeMemory) 为每个模块的非空层生成带路径的块；模块按注册次序遍历，模块内部按作用域顺序遍历。它不会加载 indexed 正文来代替索引。读入超预算的手工文件会截断并留标记，不能据此承诺文件本身已被修复。

[`memoryPromptSections()`](../../packages/core/src/memory/harness.ts#symbol=memoryPromptSections) 把规则和内容接进 system，**会话内冻结**：第一次组装时取一次，之后每个 run 原样复用；压缩落地、transcript 被清空（`reset`）或从盘上换掉（续会话）时作废，下一次组装重取。冻结的是生成后的字符串，不是多个记忆文件的事务快照。

两次 run 之间记忆变了（提取、Dream、模型自己写、别的 session 写），system 不动，改由 [`memoryUpdateMessage()`](../../packages/core/src/memory/harness.ts#symbol=memoryUpdateMessage) 在下一个前台 run 的输入之前追加一条 environment 消息（`source` 为 `memory`），**只列哪些文件变了**（changed / added / removed，每类最多 20 条），不带内容——要看就 `view`（2026-11-03，决策见 [变化只发路径通知](../decisions/implemented/2026-11-03-memory-change-notice-and-reads.md)；此前每次追加整段新记忆，长会话里堆着几十份全量快照）。「变没变」比的是冻结那一刻记下的每个文件内容（[`MemorySystemFreeze`](../../packages/core/src/memory/harness.ts#symbol=MemorySystemFreeze) 的 `files`；indexed 模块的 `INDEX.md` 与点开头的簿记文件不算），发完一条就换成那一刻的。冻结时正文与这份基线出自同一份读：每个文件只读一次，先记基线、组装复用同一份内容，后台写入恰好落在组装途中也不会漏掉通知（[同一份读](../../packages/core/test/memory.test.ts#test=冻结那一刻的正文与变化基线出自同一份读后台恰好在两次读之间写入下个-run-照样收到通知)）。完整内容在作废后随重新冻结的 system 回来，基线一起重记——所以续会话、压缩之后历史里留着的旧通知只说「那时变过」，不会被当成内容。run 内写记忆本 run 看不到（system 与已发的消息都不变），模型仍可用 `view` 主动读取。续跑（被打断的 run 接着跑）不追加。

为什么这样：provider 的缓存按前缀命中，记忆段之后是工具定义与整段对话。每个 run 重组时，两次 run 之间记忆一变，下一次请求就丢掉这一大截缓存（实测 98% → 38%，对话越长越低）。决策见 [记忆段会话内冻结](../decisions/implemented/2026-10-29-memory-frozen-in-system.md)。

## 4. 模型读写与失败语义

默认只有一把 [`memory`](../../packages/core/src/memory/tool.ts#symbol=createMemoryTool) 工具，command 选择操作：

| 操作 | 当前行为 |
| --- | --- |
| view | 空路径看概览；目录看列表；文件返回带行号内容 |
| create | 新建或整文件覆盖，不是 create-if-absent |
| str_replace | old_str 必须非空且恰好命中一次 |
| insert | 指定行之后插入，零表示文件开头；拒绝非法或越界行号 |
| delete | 删除属于已注册模块的文件 |
| rename | 同一作用域、同一模块内移名；目标必须不存在。**resident 模块没有这个动词**（见第 3 节的动词交集） |

**先看后写**：`create` 覆盖已有文件、`insert`、`delete` 之前，这把工具必须 `view` 过那个文件，而且看到的就是现在这一版，否则拒（`not_read` / `stale_read`，机制见第 7 节）。`str_replace` 与 `rename` 不需要——前者拿 `old_str` 在最新内容上对，后者搬的就是最新内容。**看目录或看概览不算看过那个文件**：只有读文件才记账。

路径先经 [`normalizeMemoryPath()`](../../packages/core/src/memory/tool.ts#symbol=normalizeMemoryPath) 规范化，接受 `/memories/` 前缀，拒绝路径穿越、反斜杠、控制字符、点开头的内部段。`.dream` 状态不通过该工具暴露。这是路径协议的判据，不是模型语义安全保证。

写入骨架归 [`writeMemory()`](../../packages/core/src/memory/harness.ts#symbol=writeMemory)：规范化 → 保护索引 → 路由模块 → **动词闸** → 进**「层 × 模块」提交锁**（[`commitUnderLock()`](../../packages/core/src/memory/harness.ts#symbol=commitUnderLock)，第 7 节）→ 锁内读取并准备新正文、**核对读到的版本** → 预算检查 → 新鲜度检查 → 写入 → 记账、更新计数与索引 → 出锁发 mutation 事实。删除、改名有各自路径（同样过动词闸与同一把提交锁，删除另核对读到的版本），但不能假定三条路径的保护逐条相同。

工具拒绝或失败用 error result 回给模型；成功正文写入后索引重建失败，正文仍已提交，诊断为 `memory_index_rebuild_failed`，事实的 `indexOutcome` 为 failed。改名先写目标再删源，删源失败报告 partial，可能留下两份文件，不是事务回滚。判据与事实生成见 [`finishMemoryMutation()`](../../packages/core/src/memory/harness.ts#symbol=finishMemoryMutation)。模型看得到的拒绝分四类：**路径与归属**（`invalid_path`、`not_a_file`、`index_file_protected`、`outside_regions`、`not_found`、`cross_region`、`cross_scope`、`target_exists`）、**内容与配额**（`old_str_not_found`、`old_str_ambiguous`、`empty_old_str`、`bad_line`、`line_out_of_range`、`budget_exceeded`）、**动词闸**（`op_not_supported`）、**并发**（`not_read`、`stale_read`、`busy`）。`budget_exceeded` 的文案带当前字符数、上限与整理指引；`busy` 带层名、模块名与持有者。

默认工具通过 harness 共用操作面执行预算和 ops 校验，Dream 工具另限制可写模块。逐动词复写 handlers 时，第四个参数 `caller`（[`MemoryCaller`](../../packages/core/src/memory/harness.ts#symbol=MemoryCaller)）必须原样传给 harness 方法；换掉 `view` 的实现还要自己把读到的全文记进 `caller.reads`，否则之后的覆写一律判 `not_read`。内部代码仍能接触字节面，因此这些保证只覆盖受支持的写入路径；包外扩展使用公开 registry 声明模块。

## 5. 记忆怎样产生：前台与提取

前台仍可主动记忆，触发提示和排除项由 [`renderMemorySystem()`](../../packages/core/src/memory/compose.ts#symbol=renderMemorySystem) 提供。提取是另一条后台通道，入口是主事件流的 reply_end，而不是每次模型请求。

当前 [`Agent.enqueueExtract()`](../../packages/core/src/agent.ts#symbol=Agent.enqueueExtract) 依次检查：记忆已绑定、生命周期允许工作且有运行 scope；**一个模块都没有就不跑**（不为提取起一次模型调用）；本 reply 的重叠保护标志——前台这轮写过记忆，这条 reply 就不单独起提取（游标不动，见下）。都过了就把 reply 结束时的 transcript 与菜单定格，排进提取通道。

**游标、门槛与频率**（2026-10-30 / 2026-11-03，决策见 [记忆提取降频](../decisions/implemented/2026-10-30-memory-extraction-gate.md) 与 [从主对话分叉](../decisions/implemented/2026-11-03-memory-extraction-fork.md)）：Agent 记一个 transcript 下标，之前的部分算已看过。真跑的那一刻从游标读起，过两道门才起模型调用：游标之后**用户亲口说的话**攒够 [`DEFAULT_EXTRACT_MIN_USER_WORDS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_MIN_USER_WORDS)（[`userProseWords()`](../../packages/core/src/memory/extract.ts#symbol=userProseWords)：只数 `human` / `steer` 的用户正文，中日韩文字一字一词、其余按空白分词），且**用户输入**攒满 [`DEFAULT_EXTRACT_EVERY_TURNS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_EVERY_TURNS) 轮（[`humanTurns()`](../../packages/core/src/memory/extract.ts#symbol=humanTurns)：一条 `human` 用户消息一轮）。任一没过就不跑、游标不动——攒着，下一次一并看。**正常跑完**才把游标推到这次材料的末尾，并在会话里记一条 `memory_reviewed` entry（落盘消息的下标，见 [`SessionEntry`](../../packages/core/src/session/types.ts#symbol=SessionEntry)）；出错、轮数用完、被中止都不动。压缩不改 transcript 下标，游标照样有效；`reset` 归零（`/clear` 只清内存、不写会话，所以落盘下标要越过 reset 之前那几条，Agent 记着这个偏移）；**续会话取盘上最后一条 `memory_reviewed`**（一条都没有 = 0）——上个进程没提取的那截跨重启接着攒，被杀、退出前那次补跑没跑完都不丢（2026-11-03）。

**退出前补一次**（[`Agent.drainExtract()`](../../packages/core/src/agent.ts#symbol=Agent.drainExtract)）：不看攒了几轮（仍过词数门槛），等它跑完，最多 [`DEFAULT_EXTRACT_DRAIN_MS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_DRAIN_MS)，到点照常收摊（提取被中止、游标不动）。`echo.stop()` 在卸 Extension **之前**调它——记忆模块、记忆工具与 prompt 段都是 builtin 挂的，卸完就没得提取，前缀也对不上；`Agent.stop()` 在改相位之前再调一次，给不经 `createEcho()` 的低层用法兜底。丢锁与 handoff 让位不补；本进程一个 run 都没跑过（只是续上来看一眼就退）也不补——没有运行 scope，`enqueueExtract` 直接返回。所以「没攒满就结束」的那一截通常当场就被看到；没赶上的（进程被杀、补跑到点）由盘上的游标留给下一次续会话。

**提取从主对话分叉**（[`Agent.runExtract()`](../../packages/core/src/agent.ts#symbol=Agent.runExtract)）：system 是主循环每个 run 装配的那一份（记忆段是冻结的那一版），菜单是 reply 收尾时主循环的菜单，消息是主循环的 working context（含最后那条回答），末尾接一条提取指令——前缀与主循环最后一次请求逐字相同，厂商的前缀缓存直接接着用。每轮注入（激活 skill 正文、任务清单）不带：它们拼在消息末尾、本来不在共享前缀里。提取与 Dream 的子循环不做压缩（见 [压缩](compaction.md) §4）。菜单照原样摆，只换执行：记忆工具换成这次提取的实例（同一份 schema），其余换成同名同 schema、一点名就在修参那一步拒掉的替身——早于 preToolUse 与权限，后台复盘不会去问人。主菜单上没有记忆工具时补在末尾（前缀在工具那段断开，但照样能写）。

[`defaultExtractPrompt()`](../../packages/core/src/memory/extract.ts#symbol=defaultExtractPrompt) 只说清看哪一段——上文的最后几条、从哪句用户原话开始（两样都给：provider 换算消息时会拆合，单给条数模型数不准）——连同作用域与模块说明，要求**先对照指令自带的已存清单**（`Stored now` 一节：system 里的记忆段是会话开头那一版，之后写的看不到，所以由 [`memoryManifest()`](../../packages/core/src/memory/harness.ts#symbol=memoryManifest) 现取，与前台记忆段同一种呈现：常驻模块全文、indexed 模块给索引）、只在要改某个文件之前 `view`、避免重复、只保留以后有用的事实，允许什么都不写；并说明 INDEX.md 由系统重建。上限来自 [`DEFAULT_EXTRACT_MAX_TURNS`](../../packages/core/src/memory/extract.ts#symbol=DEFAULT_EXTRACT_MAX_TURNS)。模型绑定仍来自父 scope，**没有单独实现“便宜模型档”选择**；轮数上限也不等于费用或墙钟时间的硬上界。

提取不通过 admission，不抢前台许可；独立消息数组（分叉时复制的是 reply 收尾时的快照）、不消费前台 steer / followUp，子循环事件不发进主 transcript。但它复用父的循环配置与相关服务，不能笼统宣称与前台完全不共享可变状态。

目前重叠保护是“前台那把 memory 工具一次**非 view** 的调用成功结束”（2026-11-03：此前看的是工具结束事件，只读的 view 也算，用户报「读记忆被当成写、那一轮被跳过」），并非已提交 mutation 事实；别名工具的写入不触发。它**不推游标**（2026-11-03）：攒满几轮才跑之后，推过去会把前面攒着、前台没看过的几轮一起丢掉；分叉出来的提取在上文里看得见前台那次写入。**标志只在走到它那一步时复位**：前面两道任一挡住（比如这条 reply 收尾时刚丢锁，或一个模块都没有），标志会留到下一条 reply。提取还在跑时又结束的几条 reply 会折叠成一次：[`MemoryChannel`](../../packages/core/src/memory/channel.ts#symbol=MemoryChannel) 跑完只再跑最后排进来的那次，它从游标读起，看的是前一次没看过的全部；丢锁时还没开始的那次直接丢掉。所以不承诺每条 reply 各跑一次提取。

## 6. Dream 怎样整理

主 agent 回 idle 后可排 Dream——**inbox 还有待消费时那一轮先让给 inbox**。`autoDream` 在裸 `Agent` 上默认关着，受管激活时为已有记忆打开；pause 与 inbox 状态不明时会关掉。它走与提取分开的 [`MemoryChannel`](../../packages/core/src/memory/channel.ts#symbol=MemoryChannel)，两条通道各自同时至多一个任务在跑，前台不会通过 admission 抢占它们。

[`dreamScopes()`](../../packages/core/src/memory/harness.ts#symbol=dreamScopes) 选出 dream 模块涉及的层，按作用域顺序逐层处理。每层的 [`shouldDream()`](../../packages/core/src/memory/harness.ts#symbol=shouldDream) 判据为：

1. 有未过期 startedAt 标记时不启动。
2. 否则，任一参与整理模块达到配置水位即可启动——前提是**上次整理之后有过新写入**（或从没整理过；[`DreamState`](../../packages/core/src/memory/dream.ts#symbol=DreamState) 的 `writesAtLastPass`，2026-11-03）。占用压不下去（内容都值得留）时，没有新写入就再整理一遍看到的是同一份内容；不加这一条，每次回到 idle 都会再整理一次。
3. 未达水位时，所有**已配置**的节流条件都满足才启动：间隔、写入数、轮数、indexed 文件数——缺省门里没有轮数这一条（见第 3 节的缺省值表），没配的条件不参与。

缺省阈值以 [`DEFAULT_DREAM_GATES`](../../packages/core/src/memory/dream.ts#symbol=DEFAULT_DREAM_GATES) 为准。水位对 resident 看全文，对 indexed 看索引，不看 indexed 单个正文是否快满。轮次来自前台 turn_end 并向各参与层计数；状态存于各层 `.dream/state.json`。

[`dreamTask()`](../../packages/core/src/memory/harness.ts#symbol=dreamTask) 写 startedAt 并生成限定该层的 memory 工具；写操作还会拒绝同层 dream:false 的模块。读取不受该模块整理开关限制。同一层同时只有一个整理者，靠的是第 7 节那把 `.dream/pass` 的试拿；startedAt 管的是失败之后的退避。

[`defaultDreamPrompt()`](../../packages/core/src/memory/dream.ts#symbol=defaultDreamPrompt) 要求去重、把错放的内容重建到正确模块后从原处删掉、剪枝、保留无法裁决的冲突及控制预算。这些语义步骤不具备事务性，也没有机器判据证明模型真的完成了它们。

[`Agent.runDreamPass()`](../../packages/core/src/agent.ts#symbol=Agent.runDreamPass) 仅在子循环 outcome 为 completed 且未 abort 时调用 [`markDreamed()`](../../packages/core/src/memory/harness.ts#symbol=markDreamed)，记录时间、清除标记及计数。失败不记成功，标记等过期再允许重来；**轮数用完例外**（2026-11-03）：已提交的改动是真的，按「做了一部分」记（[`markDreamPartial()`](../../packages/core/src/memory/harness.ts#symbol=markDreamPartial)：放锁、记时间、计数不清，报 `dream_partial`），下次按正常间隔接着做——当失败记的话，层大到一次做不完时锁每小时过期一次、门还满着，就每小时整套重跑。单层错误报诊断后继续其他层。completed 仅说明循环完成，不说明记忆质量变好。

Dream 与提取都不带父的每轮注入（激活 skill 正文、任务清单；Dream 是 2026-11-03 起）；Dream 的迭代预算沿用父配置。

## 7. 并发、收摊与可观测性

当前只能确认以下边界：

- **提交锁**：同一层、同一个记忆模块的一次提交（读、改、预算校验、落盘、重建索引）整段独占，锁挂在那一层的**字节面**上，名字 `.locks/<模块>`（[`withMemoryRegionLock()`](../../packages/core/src/memory/lock.ts#symbol=withMemoryRegionLock)）。字节面有 `lock` 原语时——`FileDir` 的锁目录（带递增编号的锁，与 lease 同一个实现）、`InMemoryDir` 的实例内互斥，经前缀视图与写入闸视图一路转发——跨实例、跨进程都互斥；没有时按字节面对象在进程内互斥。等不到（缺省 10 秒）返回 `busy`，一个字节都不写。
- **持有者崩溃后自动接管**（与 lease 同一个实现，[决策](../decisions/implemented/2026-09-10-generation-lock-takeover.md)）：持有者崩在持锁窗口里，下一个写者确认它已死（同一台机器、pid 查无此号）就接管，不会一直 `busy`。确认不了死活（别的机器、pid 被复用）或记录被写坏时，照旧等到超时返回 `busy`，报错里带锁的位置与持有者。
- **覆写前核对读到的版本**（[决策](../decisions/implemented/2026-09-11-memory-read-version-check.md)）：提交锁只罩住一次工具调用，而模型「读完 → 思考 → 写回」横跨好几次调用。每把记忆工具记一本 [`MemoryReads`](../../packages/core/src/memory/harness.ts#symbol=MemoryReads)（view 看到的全文）；整份覆写已有文件、insert、delete 之前核对它还是不是现在这一版，不是就拒（`not_read` / `stale_read`）——**拒绝里附上现行内容并记成看过**，模型照着重做就放行，不必再单独 view 一轮（超过 8000 字符的不附、不记；2026-11-03）。str_replace 不核对（old_str 在最新内容上找得到本身就是核对），rename 搬的就是最新内容。前台那把工具、每次提取、每次整理各一本账；**提取那本从前台克隆**（上文里前台 view 过的，提取也算看过），并预记指令里全文展示过的常驻文件（缺省组装、没被截尾时）；两本之后各记各的。程序直接调写方法、不给账，就不核对。
- **本进程里后台改记忆排成一条**（2026-11-03）：提取与整理各走各的通道、都不挡前台，但同一时刻只有一个在改记忆（[`Agent.oneBackgroundWriter()`](../../packages/core/src/agent.ts#symbol=Agent.oneBackgroundWriter)）——此前同一次空闲里二者能并发改同一层，互相 `stale_read`。
- [`assertFresh()`](../../packages/core/src/memory/lock.ts#symbol=assertFresh) 仍在落盘前重读旧内容，挡的是**不守提交锁**的写者（人手改文件）。
- **一层同时只有一个整理者**：每层先判一次门，过了才按层试拿一次 `.dream/pass`（[`claimDreamPass()`](../../packages/core/src/memory/harness.ts#symbol=claimDreamPass)，只试一次、不等）；拿不到（别的 session 正在整理这一层）就跳过这一层，拿到之后**再判一次门**——刚放手的那个 session 可能已经整理完、把计数清零了。startedAt 仍是状态文件里的标记，管的是失败之后的退避。
- 正文、预算、索引在同一把提交锁里；Dream 状态（计数、startedAt）的读改写在这一层另一把短锁（`.dream/state`）里，多个 session 同时记数不丢增量。

[`Agent.settleDream()`](../../packages/core/src/agent.ts#symbol=Agent.settleDream) 虽沿用旧名字，实际会同时 abort 并等待提取、Dream 两条通道，接入 stop / 丢锁路径。停发新工作与等待在飞工作结束是两件事；不能以“后台不阻塞前台”推导“退出不必等后台”。正常 `stop()` 在它之前先给提取一个跑完的机会（第 5 节「退出前补一次」），到点没跑完才由它中止。

正文变更由 [`MemoryFact`](../../packages/core/src/memory/observe.ts#symbol=MemoryFact) 表达 committed / rejected / failed / partial；索引结果单独记录。后台循环不经 admission，但每次提取 / 整理在观测账本里各是一个子循环 run：`source` 带 `parentRunId` 链回排它的那次 run（见[观测 §7「子循环」](observability.md#7-谁在发事实)）。子循环里那把记忆工具带自己的事实 sink：由 [`Agent.memoryFactsFor()`](../../packages/core/src/agent.ts#symbol=Agent.memoryFactsFor) 造，scope 里放的是这个子循环的 runId，随那把工具的调用方状态（[`MemoryCaller`](../../packages/core/src/memory/harness.ts#symbol=MemoryCaller)，同时也是「读到过的版本」那本账）传下去。于是写入事实挂在那次提取 / 整理自己的 run 上，不借 Agent 此刻开着的 admission run。提取没跑完会报诊断 `memory_extract_failed`，并说明此前已写入几条（那几条已经落盘）：通道兜住的抛错，与子循环以 error 收场（provider 出错、轮数用完）是同一个 code；stop / 丢锁造成的 aborted 不报。

## 8. 当前限制

以下能力尚未完整实现，产品不能依赖它们作为当前公共保证。

### 模块自带工具未落地

记忆模块决策里的 `tools` 回调（模块自带工具，只拿 harness 方法、拿不到字节面）没有落地：registry 接收的是 `AnyMemory`，模块形状里没有这一格。harness 的写方法也不在公共面上，所以**包外扩展今天没有办法给自己的模块配一件专用写工具**，只能靠缺省的 `memory` 工具。声明构造器 `residentMemory()` / `indexedMemory()` 同样不在公共面，包外只能手写纯数据 `AnyMemory`（第 3 节）。

### 提取的输入、重叠保护与模型档

[提取决策](../decisions/implemented/2026-09-07-memory-extraction.md)中的以下目标与当前实现（第 5 节）不同：

- **重叠保护**：决策按本 reply 是否出现 `memory.mutation.committed` 事实判断；实现看的是前台那把 memory 工具的非 view 调用是否成功，别名工具的写入不算。
- **输入**：决策给「这次 reply 实际送给模型的那份」；实现给 reply 收尾时的 working context（经同一份循环配置的 transform 投影），外加最后那条回答，但不带每轮注入。
- **模型档**：决策走产品配的便宜档；实现沿用父 scope 的模型绑定。

## 9. 验证范围与人工责任

以下用例验证当前机制，第 8 节列出的限制不在其保证范围内：

- [resident 超预算拒绝](../../packages/core/test/memory.test.ts#test=resident-超预算拒拒因带整理指引)：写入超预算时返回整理指引；同文件另有索引、路径、层绑定与 system 冻结测试。
- [具名角色的目录](../../packages/core/test/create-agent.test.ts#test=有角色名时-role-层就在落在-agents角色名memory与角色定义同一棵树)：默认 role 层的装配落点；同文件另有无角色名的情形。
- [Dream 未达写入门不启动](../../packages/core/test/dream-schedule.test.ts#test=门不满足-不跑写入数没到)：基本触发条件；同文件另有前台并行、主 transcript 隔离、失败不记成功及 stop 等待测试。
- [提取真的起来](../../packages/core/test/memory-extract.test.ts#test=攒满三轮-提取起来从主对话分叉上文就是这几轮对话指令说清从哪句看起模型用记忆工具写的东西落了盘)：攒满三轮后提取从主对话分叉起来，指令说清从哪句看起，模型经记忆工具写的内容落了盘；同文件另有[前缀与前台最后一次请求逐字相同](../../packages/core/test/memory-extract.test.ts#test=提取请求的前缀与前台最后一次请求逐字相同同一份-system同一份工具菜单消息是它的延续厂商前缀缓存接得上)、非记忆工具被拒、退出前补一次及其上限、忙时折叠与没跑完报诊断，通道的折叠语义另见 `memory-channel.test.ts`。它们不判断提取选得对不对。
- [提取是自己的 run，写入事实挂在它上面](../../packages/core/test/observability-runtime.test.ts#test=记忆提取是自己的-run它写的记忆事实挂在这个-run-上不是空-run也不是父-run2026-09-14-实测此前-runid-为空)：提取写的 `memory.mutation.committed` 落在提取那个 run 下，父 run 里没有；同文件另有[子 agent 的端到端用例](../../packages/core/test/observability-runtime.test.ts#test=前台子-agent-是自己的-run链回派出它的工具调用turn-挂在自己的-runid-下不与父撞lastrun-仍是用户那条)（提取、整理与子 agent 共用 `Agent.runSubagent`）。整理本身没有端到端的观测用例。

旧测试中的 session 层是显式 fixture，不代表默认产品仍有该层；标题中的“只整理 session”不能被当成当前全局设计。链接门只检查文件或符号存在，不审判这些测试的语义。

```bash
bun test packages/core/test/memory.test.ts packages/core/test/memory-extract.test.ts packages/core/test/memory-channel.test.ts packages/core/test/dream-schedule.test.ts \
  packages/core/test/create-agent.test.ts packages/core/test/observability-runtime.test.ts
bun scripts/docs-lint.ts
bun test test/docs.test.ts test/export-jsdoc.test.ts
```

仍需人审或真实模型评测的内容：记忆是否真实、选层是否适当、用户偏好是否被过度泛化、Dream 是否删掉关键事实、description 能否帮助召回、提取与整理的额外费用是否值得，以及跨会话可见性是否符合产品隐私预期。当前不存在证明这些性质的机器门。
