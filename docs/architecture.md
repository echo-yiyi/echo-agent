# 架构总览

> 读者：要改 core、写产品或 extension、或评审设计的人。假设已读 [README](../README.md) 与 [packages/core/README.md](../packages/core/README.md) 的「跑起来」与硬约定，本文不重复它们<br>
> 状态：按 2026-09-07 的 main 写**现状**；正在变的形状集中在 §7，每条指向决策记录。词以仓库根 [CONTEXT.md](../CONTEXT.md) 为准<br>
> 解决什么：代码分成哪几块、一个 agent 怎么装起来、一轮怎么跑、状态落在哪、扩展从哪进。每条断言落到文件<br>
> Non-Goals：不复述各子系统的契约（在 [docs/design/](design/)）；不写规划（在 [docs/decisions/proposed/](decisions/proposed/)）；不重述源码树<br>
> 验收：本文引用的每个路径存在（`scripts/docs-lint.ts` 的 filerefs 门）；§7 列的每条决策都有记录且状态行带拍板日期

## 1. 三个包，一个方向

依赖只有一个方向：`@echo-agent/core` ← `echo-agent`（`packages/cli/`）← `echo-coding`（`packages/coding/`）。各包的职责见 [CLAUDE.md](../CLAUDE.md) 的仓库地图，这里只说边界：

- **core 是纯库**：零运行时依赖（门：`packages/core/test/zero-runtime-deps.test.ts`），不出可执行文件。
- **echo-agent 是通用产品也是壳**：唯一的可执行文件、TUI、管道形态、`observe` 子命令都在这里。它不认识任何具体产品。
- **echo-coding 是产品**：只交一份数据给 echo-agent 的启动逻辑。`Product = { name, version, preset }`（`packages/cli/src/product.ts`），`preset` 返回 `createEcho()` 的 `agent` 与 `extensions` 两个字段（`packages/coding/src/agent.ts` 的 `codingPreset`）；可执行文件是 `mainFor(ECHO_CODING)`（`packages/coding/src/cli.ts`），参数解析、凭据、形态分叉、装配、收摊一行不复制。

## 2. 一个装配现场

只有一处把东西装成 agent：`createEcho()`（`packages/core/src/create-echo.ts`）。它调内部的 `createAgent()`（`packages/core/src/create-agent.ts`）造 `Agent`，再把 extension 装上去。顺序：

1. **先扫盘、后造 Agent**：发现 `<cwd>/extensions/` 下的文件，此时一行用户代码都不执行。
2. **`createAgent()`**：解析模型（唯一一次 IO；不看凭据，缺 key 是运行态）、定 session id 与状态根、`store` 与 `lock` 必须成对、开观测库、经所有权账本（`packages/core/src/assembly/ledger.ts`，adopt / borrow 二分）造各内建能力的存储视图与容器（adopt slot 按 `echo:memory` / `echo:schedule` / `echo:inbox` / `echo:session` 这些名字记账，skill 的视图跟着上一层走、不单独占 slot；这是按 dispose 所有权切的，与 §4 按「机制 / 缺省内容」切的五件不是同一个集合）、`new Agent()`、把写入闸与观测 runtime 经 WeakMap 侧挂（`packages/core/src/state/host-wiring.ts`、`packages/core/src/observability/host-wiring.ts`——它们不进公共 `AgentOptions`）。
3. **mount**，按代：`builtin`（`echo:*` 表，`packages/core/src/extension/builtin.ts`）→ `boot:inline`（`agent.tools` 转成的 `echo:inline-tools`，加容器开了会话面时的 `echo:sessions`）→ 盘上发现的每个扩展**各一代**（坏一个只回滚它自己、记一条 `Echo.diagnostics`，agent 照起）→ `boot`（显式传入的 `opts.extensions`，含壳；失败 fail-loud 整体不起）。
4. 返回 `Echo` 句柄：`agent`、`send()`、`observations`、`extensions`、`diagnostics`、`sessions`、`stop()`。`stop()` single-flight，按 mount 的逆序卸所有代再停 Agent。

容器随后显式 `await echo.start()`（就是 `agent.start()`，2026-09-08 起 `Echo` 自己带，第三方不必碰 `agent`）：取单写者 lease、恢复 session / skill / tasks / schedule / inbox、打开 intake 与自主活动。装配不启动，启动不装配。

## 3. Agent 与四层循环

`Agent`（`packages/core/src/agent.ts`）是状态的唯一所有者：公开的 `AgentState` 投影、实例相位（`new → starting → restored → running → pausing → stopping → stopped`，加吸收态 `lost`）、admission（`packages/core/src/admission/standalone.ts`，同一时刻一个执行许可，foreground 优先于 dream）、intake（`packages/core/src/loop/intake.ts`，steer / followUp 的原子接受与关门）、session 账本的 append。

循环是**纯函数**：`packages/core/src/loop/run-loop.ts` 与 `run-turn.ts`，吃快照 + 装备 + 通道、吐事件，不认识 `Agent` 类、不认识盘。四层 **run ⊃ reply ⊃ turn ⊃ attempt**，每层一对事件、一个 ID、一个函数；重试是同一 turn 的下一个 attempt；工具与 hook 的工作集在 turn 开头定格。契约与判据见 [Run Loop 的四层](design/run-loop-layers.md)，工作入口（prompt / steer / followUp / inbox / dream）的接纳规则见 [Lifecycle 与 Run Loop](design/lifecycle-and-run-loop.md) §2。

一个事件的处理顺序固定：应用到 `AgentState`（私有 `processEvents()`）→ 必需的 session 持久化（`message_end`、`compaction_end`、error 的 `agent_end`）→ 观测 tap（不阻塞控制流）→ 普通 listener。run 内投影的主要字段由事件驱动；不走事件的显式写路径另有几条——装备面 setter（`model` / `thinkingLevel`）、`reset()` 与恢复、`setWorkspace()`、run 开合处的 `status` / `startedAt` / `lastError`——它们都在 `Agent` 类内，但「状态只能被事件改」是**纪律**不是门（§8）。实例相位、intake 队列、lease 也不在事件这条路上。

## 4. 内建五件：机制在 core，缺省内容是 extension

压缩是这个分法的样板：状态与流水线在 core（`packages/core/src/compaction/pipeline.ts`），别人往里注册的口是 `AgentCompaction` registry，缺省阶梯是 `echo:compaction` 这条 extension。五件内建能力按同一分法（2026-09-07 拍板，见 §7）：

| 能力 | 机制与状态（core） | 缺省内容（`echo:*`） | 让别人扩展的口 |
|---|---|---|---|
| memory | `packages/core/src/memory/harness.ts`：模块表、唯一写路径、索引重建、预算校验、文件锁；作用域由产品声明（`memory/scope.ts`）；提取与整理各走一条后台通道 | `echo:memory`：`memory` 工具、记忆段、内建三个记忆模块 | `AgentMemory.module()`：第三方注册自己的记忆模块，与内建的同一条 |
| tasks | `packages/core/src/task/harness.ts`：DAG、落盘尾巴 | `echo:tasks`：四件 Task 工具 | 无 |
| schedule | `packages/core/src/schedule/harness.ts`：cron、tick、补跑 | `echo:scheduler`：三件工具 | 无 |
| skills | `packages/core/src/skill/harness.ts`：池与激活 | `echo:skills`：激活 / 创建工具、目录段 | `AgentSkills` registry |
| inbox | `packages/core/src/inbox/store.ts`：at-least-once、dedupe、ack、轮询 | 无工具 | 无 |

工具对象在 `Agent` 构造函数里造好（含持久化与租约包装），由 `builtinEntriesFor()` 变成 entry 交给 Host 注册——**注册与第三方同一条路、同一本所有权账本**，`echo.extensions` 因此列得出内建。`Agent` 不瘦，这是设计选择不是问题。

上表只列有 core 侧机制与状态的五件。内建 extension 不止这些：`echo:agent`（壳协议，§5）、`echo:compaction`（缺省阶梯）、`echo:tool-search` / `echo:ask` / `echo:subagent`（只有工具与 prompt 段，没有恢复期状态）走同一条注册路，缺省装配下 `echo.extensions` 列出九条（`packages/core/src/extension/builtin.ts`）。

## 5. 扩展从哪进

**ABI**（`packages/core/src/extension/abi.ts`，`@echo-agent/core/extension` 子路径）：`defineExtension({ name, hostAbiVersion, inject, provide, reload, config, apply(ctx, config) })`。长期副作用只能在 `apply()` 里经 `ctx.effect()` 建，Host 持有 disposer。

**Host**（`packages/core/src/extension/host.ts`）：按代 mount，依赖图拓扑排序（`graph.ts`），一代全有或全无，卸载逆序；后代可以 inject 前代已 ACTIVE 的 Service。没有热重载：同一路径的模块进程内只求值一次。

**Service 两种**（`packages/core/src/extension/registries.ts`）：

- **registry**，extension 往 agent 里注册：`AgentTools`、`AgentHooks`、`AgentSkills`、`AgentPrompt`、`AgentCompaction`。同名 fail-loud。
- **能力端口**，extension 用 agent 已有的：`AgentBackgroundService`（后台队列）、`AgentSessionsService`（会话面）。

**壳也是 extension**：`echo:agent` provide 封闭协议 `AgentRuntime`（`packages/core/src/extension/runtime.ts`：看、说、答、换、停五组，没有 `start` / `stop` / `deliver`），`echo:tui`（`packages/cli/src/extension.ts`）inject 它。换壳只是换一条 inject 同一个 Service 的 extension。

仓内的消费者：cli 的 `echo:tui` / `echo:identity` / `echo:conduct` / `echo:pipe` / `echo:instructions`；coding 的 `echo:coding` / `echo:workspace` / `echo:shell` / `echo:worktree` / `echo:web`（`packages/coding/src/extensions.ts`）；`examples/extension` 是第一个仓外样例。

## 6. 状态落在哪

**状态根 = 一段 session 的目录**（`resolveStateDir()`，`packages/core/src/create-agent.ts`）：`<ECHO_HOME>/sessions/<id>/` 下是 meta、transcript 账本（一条 entry 一个文件）、inbox、tasks、schedule、dream 状态、lease、`status.json`、观测库。布局与不变量见 [会话与 agent 集群](design/sessions.md) §3。记忆的作用域由产品声明（`packages/core/src/memory/scope.ts`，core 不认识层名）；core 的缺省表是 user / project / role 三层（`DEFAULT_MEMORY_SCOPES`，`packages/core/src/create-agent.ts`）：user 层在 `<ECHO_HOME>/memory/`，project 层在 `<ECHO_HOME>/projects/<workspace 哈希>/memory/`，role 层在 `<ECHO_HOME>/agents/<角色名>/memory/`（没有角色名的 session 没有这层）；每层的 dream 状态（`.dream/`）跟着那层走。技能在 `<ECHO_HOME>/skills/`。

三条硬约定怎么守：

- **single-writer**：每段一把 lease（`packages/core/src/storage/file-lock.ts`），core 不猜对面死没死，也不抢占没有自称可让位的持有者（可让位的实例被请走时自己交还，2026-09-07）；门 `packages/core/test/state-lock.test.ts`（互斥与坏锁）、`packages/core/test/lease-handoff.test.ts`（可让位交还）。lease 之下还有一道 Host-internal 的写入闸（`packages/core/src/state/write-gate.ts`）：拿到 lease 之前、revoke 之后任何**经闸的状态根写入**都被拒（读与 list 不经闸），门 `packages/core/test/write-gate.test.ts`。**观测库是闸外的例外**：它是 `createAgent()` 直接开的 SQLite，装配期（拿到 lease 之前）就建目录建库，写也不经闸；它的封口走 lease lifecycle port（`packages/core/src/state/lease-lifecycle.ts`，装配侧接在 `createAgent()` 里）——正常交还前 flush 尾巴，丢锁或失败后交还则只封不 flush。把建库推迟到拿到 lease 之后是另一件事，见 §7。
- **一次写失败就封存该会话**：`packages/core/src/session/service.ts`，继续写只会产出 parent 指向不存在 entry 的坏档。
- **观测不得影响执行**：观测库是 SQLite（`packages/core/src/observability/sqlite-store.ts`），落状态根下；给了自定义 `store` 又没点名 `stateDir` 时落 `:memory:`，所以注入内存端口的装配一个文件都不写。store 写不动时 run 照跑、`observationPersistence` 报 degraded；`echo-agent observe` 只读它，不装配、不取锁（`packages/cli/src/observe.ts`）。

会话之间只有一种通道：往对方 `inbox/` 写一条 record（`packages/core/src/session/sessions.ts` 的 `EchoSessions`），同进程与跨进程一条路；持 lease 的进程每秒重扫一次自己的 inbox。core 不起进程，谁把一段跑起来是容器的事。

## 7. 正在变的形状（2026-09-07 拍板；标「已实现」的已落地，本表只为指路，其余未实现）

| 决定 | 一句话 | 记录 |
|---|---|---|
| 受众与版本（根决策） | 受众 = 第三方可装的内核；公共面按「第三方需要不需要」划；0.x，`hostAbiVersion` 独立成线，tag 由人定 | [记录](decisions/proposed/2026-09-07-audience-and-versioning.md) |
| `Agent` 类内部化 | 仓外只剩 `createEcho()` / `AgentRuntime` / `./testing`；正门是 extension ABI，不是裸 `Agent` | [记录](decisions/proposed/2026-09-07-agent-class-internal.md) |
| 内建五件留 core | 不搬出 `Agent`；按压缩分法；memory 的 registry 等第一个消费者 | [记录](decisions/proposed/2026-09-07-builtin-capabilities-stay-core.md) |
| 观测的公开线 | 读面 + extension 发口公开，写面内部；观测 store 从写死的路径分支变成可注入的端口 | [记录](decisions/proposed/2026-09-07-observation-public-face.md) |
| 并行工具（已合入 59beb8c，本表只为指路） | 工具声明 `concurrent`，连续批；结果按 tool_use 顺序；`toolExecution` 选项删 | [记录](decisions/implemented/2026-09-07-parallel-tools.md) |
| 落单的 `tool_use`（已实现） | 中止后没跑的调用账本里就是没有结果，送模前由投影补一条 error 结果让请求合法 | [记录](decisions/implemented/2026-09-07-orphan-tool-use.md) |
| 角色定义 | session 的 agent 定义是产品内的角色，不是产品打包；`section(replace)` 与 `restrict()` 两个口 | [记录](decisions/proposed/2026-09-07-role-agent.md) |
| 记忆的模块与作用域两个轴（已实现） | 路径前缀选层，工具不加参数 | [记录](decisions/implemented/2026-09-03-memory-three-scopes.md) |
| 作用域由产品声明，core 不认识层名（已实现） | 锚点闭合、变量闭合、名字开放；session 加载完才绑定一次 | [记录](decisions/implemented/2026-09-07-memory-scopes-by-product.md) |
| 记忆模块走 registry，内建与第三方同一条（已实现） | 动词集按模块配置；`resident` 没有 rename | [记录](decisions/implemented/2026-09-07-memory-modules.md) |
| 记忆的产生补上提取，不再只靠前台自觉（已实现） | 每条 reply 结束跑一次隔离子 agent，走独立通道不进 admission | [记录](decisions/implemented/2026-09-07-memory-extraction.md) |
| dream 按层各整理各的，门加一道水位单开（已实现） | 整理哪些模块由模块声明；从 admission 挪进独立通道 | [记录](decisions/implemented/2026-09-07-dream-rework.md) |
| 记忆文件的并发（已实现） | 进程内按路径串行 + 跨进程乐观校验；`stop()` 等两条通道收完 | [记录](decisions/implemented/2026-09-07-memory-concurrency.md) |
| session 的身份 | meta 记 `product`（哪个产品开的）与 `agent`（角色）；`agentId` / `agentName` 退场 | [记录](decisions/proposed/2026-09-07-session-identity.md) |
| 人优先，后台让位（已合入 e48a366，本表只为措辞改准） | 自称可让位的实例被请走时交还 lease；不可让位的照旧不抢占 | [记录](decisions/implemented/2026-09-07-preemptible-lease.md) |
| lifecycle 四条小决策（已落地；第二个 prompt 那条就是现状） | abort reason 保留、`agent_end` 保留名字、stop hook 三次留硬编码、第二个 prompt 留 fail-fast | [abort](decisions/implemented/2026-09-01-abort-reason.md) · [agent_end](decisions/implemented/2026-09-01-agent-end-barrier.md) · [stop hook](decisions/implemented/2026-09-01-stop-continuation-limit.md) · [second prompt](decisions/proposed/2026-09-01-second-prompt-policy.md) |
| session 线剩余 | 角色定义先做，再 `/clear`（换 Agent 实例）与 `wait` | [会话与 agent 集群](design/sessions.md) §9 |

## 8. 门

| 守什么 | 在哪 |
|---|---|
| 公共符号表不漂 | `packages/core/test/api-snapshot.test.ts`（清点脚本 `packages/core/scripts/api-inventory.ts`） |
| core 零运行时依赖（manifest 三字段恒空；`src/**` 里 import 只许 `node:` / `bun` / 相对路径） | `packages/core/test/zero-runtime-deps.test.ts` |
| 四层事件成对且严格嵌套（允许空层：reply 可零 turn、turn 可零 attempt） | `packages/core/test/loop-layers.test.ts` |
| 单写者（互斥、可让位交还）与写入闸 | `packages/core/test/state-lock.test.ts`、`packages/core/test/lease-handoff.test.ts`、`packages/core/test/write-gate.test.ts` |
| 装配所有权（adopt / borrow、失败 unwind） | `packages/core/test/assembly.test.ts`、`packages/core/test/create-echo.test.ts` |
| 文档花名册、链接、代码块编译、文件引用 | `scripts/docs-lint.ts`、`test/docs.test.ts`、`test/export-jsdoc.test.ts` |
| 分发（tarball 装得上、examples 跑得通） | `test/distribution-gate.test.ts` |

「有门守着」和「是纪律」分开标：上表之外的承诺（fail-loud、`write()` resolve 即持久、观测不影响执行）是纪律，靠 review。
