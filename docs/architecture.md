# 架构总览

> 读者：理解仓库边界、编写产品或扩展、定位设计文档的人<br>
> 范围：包依赖、装配、运行与存储的整体关系；子系统契约由对应设计文档维护<br>
> 状态：当前实现说明；未完成的公开面调整见 §7

## 导读

**解决什么。** 为“产品从哪里进入、能力归谁、运行状态在哪里”提供一张稳定地图。

**设计主线。** createEcho 是唯一高层装配入口；core 拥有运行机制，extension 注册内容，base 连接宿主能力，壳通过运行时协议交互。各 session 独立持有账本与 lease，共享记忆按产品作用域配置。

**边界。** 本文不复制 API 清单、子系统算法或历史实施计划。设计取舍保存在 decisions，代码审阅快照保存在 code-review；术语以 [CONTEXT](../CONTEXT.md) 为准。

## 1. 五个包，一个方向

依赖只有一个方向：`@echo-agent/core` ← `@echo-agent/base` ← `@echo-agent/tui` ← 各产品（`echo-agent` 与 `echo-coding`，两者平级、互不依赖）。包边界取舍见 [装配层独立成包](decisions/implemented/2026-09-09-assembly-layer-packages.md)。各包的职责见 [CLAUDE.md](../CLAUDE.md) 的仓库地图，这里只说边界：

- **core 是纯库**：零运行时依赖（门：`packages/core/test/zero-runtime-deps.test.ts`），不出可执行文件。
- **base 是装配层**：启动器部件、产品契约、壳端口、宿主能力（凭据、设置、项目指令、`observe` 面板）、管道形态。**它不认识任何界面技术**——交互形态由产品挑一个 `Shell` 实现交进来，所以做 web 界面的产品依赖它而不必装终端库。
- **tui 是终端壳**：界面本体与引导设置，打成 `terminalShell` 一件东西。它是壳端口的终端实现，换壳就是换这个包。
- **两个产品都很薄**：各出自己的身份段、纪律段的挂载与可执行文件。`Product = { name, version, preset }`（`packages/base/src/product.ts`），`preset` 返回 createEcho 的 agent、extensions 与 memory 装配片段（`packages/coding/src/agent.ts` 的 `codingPreset`）；可执行文件是 `mainFor(产品, 壳)`，参数解析、凭据、形态分叉、装配、收摊一行不复制。

## 2. 一个装配现场

只有一处把东西装成 agent：`createEcho()`（`packages/core/src/create-echo.ts`）。它调内部的 `createAgent()`（`packages/core/src/create-agent.ts`）造 `Agent`，再把 extension 装上去。顺序：

1. **先扫盘、后造 Agent**：发现 `<cwd>/extensions/` 下的文件，此时一行用户代码都不执行。
2. **`createAgent()`**：解析模型并准备存储与观测资源（凭据失败按运行态处理）、定 session id 与状态根、`store` 与 `lock` 必须成对、开观测库、经所有权账本（`packages/core/src/assembly/ledger.ts`，adopt / borrow 二分）造各内建能力的存储视图与容器（adopt slot 按 `echo:memory` / `echo:schedule` / `echo:inbox` / `echo:session` 这些名字记账，skill 的视图跟着上一层走、不单独占 slot；这是按 dispose 所有权切的，与 §4 按「机制 / 缺省内容」切的五件不是同一个集合）、`new Agent()`、把写入闸与观测 runtime 经 WeakMap 侧挂（`packages/core/src/state/host-wiring.ts`、`packages/core/src/observability/host-wiring.ts`——它们不进公共 `AgentOptions`）。
3. **mount**，按代：`builtin`（`echo:*` 表，`packages/core/src/extension/builtin.ts`）→ `boot:inline`（`agent.tools` 转成的 `echo:inline-tools`，加容器开了会话面时的 `echo:sessions`）→ 盘上发现的每个扩展**各一代**（坏一个只回滚它自己、记一条 `Echo.diagnostics`，agent 照起）→ `boot`（显式传入的 opts.extensions，含壳；失败则整体构造失败）→ role（最后应用角色 identity 与工具限制）。
4. 返回 `Echo` 句柄：`agent`、`send()`、`observations`、`extensions`、`diagnostics`、`sessions`、`stop()`。`stop()` single-flight，按 mount 的逆序卸所有代再停 Agent。

容器随后显式 `await echo.start()`：取单写者 lease、恢复 session / skill / tasks / schedule / inbox、打开 intake 与自主活动。装配不启动，启动不装配。

## 3. Agent 与四层循环

`Agent`（`packages/core/src/agent.ts`）是状态的唯一所有者：公开的 `AgentState` 投影、实例相位（`new → starting → restored → running → pausing → stopping → stopped`，加吸收态 `lost`）、admission（`packages/core/src/admission/standalone.ts`，前台同一时刻一个执行许可；记忆子循环走独立通道）、intake（`packages/core/src/loop/intake.ts`，steer / followUp 的原子接受与关门）、session 账本的 append。

循环通过参数接入模型、工具与事件：`packages/core/src/loop/run-loop.ts` 与 `run-turn.ts`，吃快照 + 装备 + 通道、吐事件，不认识 `Agent` 类、不认识盘。四层 **run ⊃ reply ⊃ turn ⊃ attempt**，每层一对事件、一个 ID、一个函数；重试是同一 turn 的下一个 attempt；工具与 hook 的工作集在 turn 开头定格。契约与判据见 [Run Loop 的四层](design/run-loop-layers.md)，前台工作入口与独立后台通道的边界见 [Lifecycle 与 Run Loop](design/lifecycle-and-run-loop.md) §2。

一个事件的处理顺序固定：应用到 `AgentState`（私有 `processEvents()`）→ 必需的 session 持久化（`message_end`、`compaction_end`、error 的 `agent_end`）→ 普通 listener；观测在对应执行节点独立插桩。run 内投影的主要字段由事件驱动；不走事件的显式写路径另有几条——装备面 setter（`model` / `thinkingLevel`）、`reset()` 与恢复、`setWorkspace()`、run 开合处的 `status` / `startedAt` / `lastError`——因此不能把全部状态都描述成事件溯源。实例相位、intake 队列、lease 也不在事件这条路上。

## 4. 内建五件：机制在 core，缺省内容是 extension

压缩是这个分法的样板：状态与流水线在 core（`packages/core/src/compaction/pipeline.ts`），别人往里注册的口是 `AgentCompaction` registry，缺省阶梯是 `echo:compaction` 这条 extension。五件内建能力按同一分法：

| 能力 | 机制与状态（core） | 缺省内容（`echo:*`） | 让别人扩展的口 |
|---|---|---|---|
| memory | `packages/core/src/memory/harness.ts`：模块表、唯一写路径、索引重建、预算校验、文件锁；作用域由产品声明（`memory/scope.ts`）；提取与整理各走一条后台通道 | `echo:memory`：`memory` 工具、记忆段、内建三个记忆模块 | `AgentMemory.module()`：第三方注册自己的记忆模块，与内建的同一条 |
| tasks | `packages/core/src/task/harness.ts`：DAG、落盘尾巴 | `echo:tasks`：四件 Task 工具 | 无 |
| schedule | `packages/core/src/schedule/harness.ts`：cron、tick、补跑 | `echo:scheduler`：三件工具 | 无 |
| skills | `packages/core/src/skill/harness.ts`：池与激活 | `echo:skills`：激活 / 创建工具、目录段 | `AgentSkills` registry |
| inbox | `packages/core/src/inbox/store.ts`：at-least-once、dedupe、ack、轮询 | 无工具 | 无 |

工具对象在 `Agent` 构造函数里造好（含持久化与租约包装），由 `builtinEntriesFor()` 变成 entry 交给 Host 注册——**注册与第三方同一条路、同一本所有权账本**，`echo.extensions` 因此列得出内建。业务状态与默认内容分开，不以 Agent 类的代码体积判断边界。

上表只列有 core 侧机制与状态的五件。内建 extension 不止这些：`echo:agent`（壳协议，§5）、`echo:compaction`（缺省阶梯）、`echo:tool-search` / `echo:ask` / `echo:subagent` / `echo:reload`（只有工具，没有 prompt 段与恢复期状态）走同一条注册路，当前装配清单由 echo.extensions 返回（`packages/core/src/extension/builtin.ts`）。

## 5. 扩展从哪进

机制以 [扩展、装配与所有权](design/extensions.md) 为准：ABI、Host 的 PREPARE / LOADING / ACTIVE 与换代事务、依赖图的规则、effect 的所有权与卸载顺序、热部署的时机 / 范围 / 结果怎么读，都在那里，这里不复述。入口是 `@echo-agent/core/extension` 子路径的 `defineExtension()`（`packages/core/src/extension/abi.ts`）；长期副作用只能在 `apply()` 里经 `ctx.effect()` 建，Host 持有 disposer。热部署（`Echo.reloadExtensions()` / 壳的 `/reload` / 模型的 `extension_reload`）只管 `extensions/` 目录里发现的扩展，决策见 [热部署](decisions/implemented/2026-09-14-extension-hot-reload.md) 与 [模型触发](decisions/implemented/2026-09-14-model-triggered-reload.md)。

**Service 两种**（`packages/core/src/extension/registries.ts`）：

- **registry**，extension 往 agent 里注册：`AgentTools`、`AgentHooks`、`AgentSkills`、`AgentPrompt`、`AgentCompaction`、`AgentMemory`、`AgentPolicies`。具名条目的冲突由各 registry 判定；`AgentHooks` 的条目无名，同 id 可并存、disposer 认对象身份（门 `packages/core/test/seams.test.ts`）。
- **能力端口**，extension 用 agent 已有的：`AgentBackgroundService`（后台队列）、`AgentSessionsService`（会话面）、`AgentInbox`（等在自己的 inbox 上，命中即消费；`session_send` 的 `wait` 用它）、`AgentRuntimeService`（壳协议；由 `echo:agent` provide 而不是 Host 自带，所以「只有壳拿得到」没有门——`echo:worktree` 就注入了它）。

**壳也是 extension**：`echo:agent` provide 封闭协议 `AgentRuntime`（`packages/core/src/extension/runtime.ts`：看、说、答、换、停五组，没有 `start` / `stop` / `deliver`），`echo:tui`（`packages/tui/src/extension.ts`）inject 它。换壳只是换一条 inject 同一个 Service 的 extension。

仓内的消费者：cli 的 `echo:tui` / `echo:identity` / `echo:conduct` / `echo:pipe` / `echo:instructions`；coding 的 `echo:coding` / `echo:workspace` / `echo:shell` / `echo:worktree` / `echo:web`（`packages/coding/src/extensions.ts`）；`examples/extension` 是第一个仓外样例。

## 6. 状态落在哪

**状态根 = 一段 session 的目录**（`resolveStateDir()`，`packages/core/src/create-agent.ts`）：`<ECHO_HOME>/sessions/<id>/` 下是 meta、transcript 账本（一条 entry 一个文件）、inbox、tasks、schedule、lease、`status.json`、观测库。布局与不变量见 [会话与 agent 集群](design/sessions.md) §3。记忆的作用域由产品声明（`packages/core/src/memory/scope.ts`，core 不认识层名）；core 的缺省表是 user / project / role 三层（`DEFAULT_MEMORY_SCOPES`，`packages/core/src/create-agent.ts`）：user 层在 `<ECHO_HOME>/memory/`，project 层在 `<ECHO_HOME>/projects/<workspace 哈希>/memory/`，role 层在 `<ECHO_HOME>/agents/<角色名>/memory/`（没有角色名的 session 没有这层）；每层的 dream 状态（`.dream/`）跟着那层走。技能在 `<ECHO_HOME>/skills/`。

三条硬约定怎么守：

- **single-writer**：每段一把 lease（`packages/core/src/storage/file-lock.ts`，底下是带递增编号的锁 `generation-lock.ts`）。活着的持有者不会被抢；持有者确认已死（同一台机器、pid 查无此号）时下一个 acquire 自动接管（2026-09-10）；没有自称可让位的持有者不会被请走（可让位的实例被请走时自己交还，2026-09-07）；门 `packages/core/test/state-lock.test.ts`（互斥、崩溃接管、坏锁、多进程压测）、`packages/core/test/lease-handoff.test.ts`（可让位交还）。lease 之下还有一道 Host-internal 的写入闸（`packages/core/src/state/write-gate.ts`）：拿到 lease 之前、revoke 之后任何**经闸的状态根写入**都被拒（读与 list 不经闸），门 `packages/core/test/write-gate.test.ts`。**观测文档是闸外的例外**：写不经闸，也不挂 lease——观测线程只写本进程自己的文件（批文件、自己 run 的概要、自己的 head；runtimeId 每个进程唯一，与别的写者不相交），不碰以前进程留下的东西；清理是产品自己调的 `expireObservations()`，只凭盘上事实删（[记录](decisions/implemented/2026-09-14-observation-off-main-loop.md)）。
- **一次写失败就封存该会话**：`packages/core/src/session/service.ts`，继续写只会产出 parent 指向不存在 entry 的坏档。
- **观测不得影响执行**：观测是状态根里的文档（`packages/core/src/observability/document-store.ts`，[记录](decisions/implemented/2026-09-14-observation-document-store.md)），经状态根的存储写在 `observability/` 下，所以注入内存端口的装配观测也在内存、一个文件都不写。**观测的任何功能都不在主流程上**（[记录](decisions/implemented/2026-09-14-observation-off-main-loop.md)）：探针只在节点上取字段交给进程里的观测线程（`packages/core/src/observability/thread-host.ts`），编码与落盘都在那边，admission、装配、`start` / `stop`、lease 都不等它；清理是产品自己调的 `expireObservations()`，不调不删。store 写不动时 run 照跑、写入端 health 报 degraded；`echo-agent observe` 只读它，不装配、不取锁（`packages/base/src/observe.ts`）；旧格式的 `observations.sqlite` 不读。

会话之间只有一种通道：往对方 `inbox/` 写一条 record（`packages/core/src/session/sessions.ts` 的 `EchoSessions`），同进程与跨进程一条路；持 lease 的进程每秒重扫一次自己的 inbox。core 不起进程，谁把一段跑起来是容器的事。

## 7. 当前限制与设计入口

Agent 类内部化和观测公开面的收窄仍由各自决策管理；“已拍板”不等于代码已完成，类型出口以当前源码为准。入口见 [Agent 公共面](decisions/proposed/2026-09-07-agent-class-internal.md) 与 [观测公开面](decisions/proposed/2026-09-07-observation-public-face.md)。

| 要理解什么 | 当前设计 |
| --- | --- |
| 实例启动、工作接纳、停止 | [Lifecycle](design/lifecycle-and-run-loop.md) |
| run / reply / turn / attempt | [循环分层](design/run-loop-layers.md) |
| 消息账本与送模投影 | [上下文与消息流](design/context-and-message-flow.md) |
| 模型输入的来源与刷新 | [Prompt](design/prompt.md) |
| 长会话上下文预算 | [Compaction](design/compaction.md) |
| 跨会话事实与整理 | [Memory](design/memory.md) |
| 扩展所有权与重载 | [Extensions](design/extensions.md) |
| 会话身份与通信 | [Sessions](design/sessions.md) |
| 运行记录与诊断 | [Observability](design/observability.md) |
| 终端交互 | [TUI](design/tui.md) |

各设计文档的限制段描述当前尚未提供的保证；实现计划与历史争论不在本总览复制。

## 8. 验证

| 守什么 | 在哪 |
|---|---|
| 公共符号表不漂 | `packages/core/test/api-snapshot.test.ts`（清点脚本 `packages/core/scripts/api-inventory.ts`） |
| core 零运行时依赖（manifest 三字段恒空；`src/**` 里 import 只许 `node:` / `bun` / 相对路径） | `packages/core/test/zero-runtime-deps.test.ts` |
| 四层事件成对且严格嵌套（允许空层：reply 可零 turn、turn 可零 attempt） | `packages/core/test/loop-layers.test.ts` |
| 单写者（互斥、崩溃接管、可让位交还）与写入闸 | `packages/core/test/state-lock.test.ts`、`packages/core/test/lease-handoff.test.ts`、`packages/core/test/write-gate.test.ts` |
| 装配所有权（adopt / borrow、失败 unwind） | `packages/core/test/assembly.test.ts`、`packages/core/test/create-echo.test.ts` |
| 文档花名册、链接、代码块编译、文件引用 | `scripts/docs-lint.ts`、`test/docs.test.ts`、`test/export-jsdoc.test.ts` |
| 分发（tarball 装得上、examples 跑得通） | `test/distribution-gate.test.ts` |

上表只列跨模块判据，不穷举子系统测试。门只证明对应断言；接口注释、作者承诺与人工 review 不自动成为机器保证。
