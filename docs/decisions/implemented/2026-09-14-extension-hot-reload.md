# 盘上扩展的热部署：两次 run 之间卸旧装新，装不上就装回去

> 状态:implemented · 提出 2026-09-13 · 拍板 2026-09-13（口头：不引 Cordis、不抄 dsh，agent 自己给自己换代；① 触发只来自人和程序，② 协议加 `reloadExtensions()`，③ `Echo.extensions` / `diagnostics` 改现算，④ 快照放原文件旁边）· 合入 2026-09-14（PR #3）· **① 于 2026-09-14 改写**：模型也能触发，见 [模型自己触发热部署](2026-09-14-model-triggered-reload.md) · 参考 `~/Code/deepseek-harness`（dsh）的 HMR 与数据热刷新，只借做法不借依赖

**给谁看**：改 `createEcho()` / `ExtensionHost` / `AgentRuntime` 的人，和写 `extensions/` 里扩展的人。假设已知 extension 的 generation / Fiber / Effect 模型（[架构总览](../../architecture.md) §5）。

**解决什么**：常驻 agent 改一个盘上扩展要整个进程重启，会话跟着断。做完之后：改了 `extensions/foo.ts`，TUI 敲 `/reload`（或程序调 `echo.reloadExtensions()`），下一个 run 就用新的；改坏了旧的照用、报出原因；会话 id 不变。

## 现状（拍板前）

`ExtensionHost` 只有按代 mount / unmount；`reload` 边界（`turn < run < agent < process`）自 2026-08 起只有声明期校验，运行时没有任何代码读它（2026-09-07 code review 登记过）。`createEcho()` 直接 `import()` 原文件，同一路径的模块进程内只求值一次，头注写着「改了文件要重启」。dsh 的宿主模块 HMR 靠 Node 内部 ESM loader（`--expose-internals`），Bun 下没有；换插件的生命周期靠 Cordis；出厂的 web / headless 两个配置里 `disabled: true`。

## 不拍板的代价

要么一直重启（常驻 agent 的「常驻」打折），要么引 Cordis 一类框架把 Fiber / Effect 那一层重做一遍——而那一层 echo 已经有了，缺的是四件接线：加载新代码、换代事务、安全时机、触发入口。

## 选项

- **A. agent 内部机制，三处各管一件。** `Agent.betweenRuns()` 出让安全时机（经 admission 拿 permit，与 `compact()` 同一条路）；`ExtensionHost.replace()` 做换代事务（卸旧 → 装新 → 失败装回旧）；`createEcho()` 重扫目录、比对内容、复制快照加载新代码。触发只来自人和程序。
- **B. A 再给模型一件 `extension_reload` 工具**，agent 自己写好扩展自己上线。难点：工具在 run 内调用拿不到 permit，只能登记下来等 run 结束再执行，结果怎么回给模型要另外设计。
- **C. 监听文件变化自动换。** 与 B 卡在同一个问题（run 中途触发怎么办），外加 agent 自己写文件写到一半就触发。

## 决定

**A**（2026-09-13 用户拍板）。B、C 登记为后续（见 Non-Goals）。附四条：

1. **只重载盘上发现的扩展**。builtin、`opts.extensions`（产品自带的）、壳、角色定义四代不在账上，reload 碰不到它们。
2. **加载新代码 = 复制到原文件旁边再 import**：`extensions/foo.ts` → `extensions/.foo.echo-<pid>-<n>.ts`，子目录整棵复制到 `extensions/.bar.echo-<pid>-<n>/`。路径变了就是新模块（Node / Bun 都实测过：同路径加 query 不重新求值，或入口刷了依赖不刷），相对路径（`./helper.ts`、`../shared.ts`）与 `node_modules` 的查找仍落在原处。快照在这一代 ACTIVE 期间留着（扩展可能按 `import.meta.url` 读旁边的文件），换代 / 删除 / 收摊时删，发现规则跳过这种命名。**import 用 realpath**：Bun 按目录缓存解析条目，目录路径经软链时新文件经软链路径找不到（实测）。
3. **先卸再装，不先装再卸**：依赖图允许两代 overlap，但工具 / skill / prompt 段按名注册，新的先装会撞名。所以 import 与验形在卸之前做——那一步失败旧代一个字不动。
4. **要换得了，扩展得声明 `reload: "run"`（或 `"turn"`）**。ABI 缺省是 `agent`（保守），在 run 边界会被拒；拒绝的报文告诉作者加哪一行。这是 `ReloadBoundary` 第一次在运行时被读取——它的含义随之写实：`turn` / `run` = 两次 run 之间可换，`agent` = 与这一代 Agent 同寿、要换只能重启 Agent，`process` = 要换只能重启进程（`abi.ts`）。不做「按 Effect 边界推断」：那会让「不声明」有两种意思。

形状：`Echo.reloadExtensions(): Promise<ReloadResult>` 与 `AgentRuntime.reloadExtensions()` 是同一个函数（壳的 `/reload` 调后者）；`ReloadResult` = `done` 带 `ReloadReport`（每个盘上扩展一条 `ReloadChange`：`added` / `removed` / `replaced` / `unchanged` / `refused` / `rolled_back` / `failed` / `lost`，含义在 `packages/core/src/extension/reload.ts`）或 `rejected`（忙、不排队）。`ExtensionHost.replace(old, next | null, { safePoint })` 返回 `replaced` / `refused` / `rolled_back` / `lost`，`unwindErrors` 一个不吞。`Echo.extensions` / `Echo.diagnostics` 改为每次读现算。

## Non-Goals（这一版不做；每条注明走哪条路）

- **不监听文件变化**（选项 C）：「延后到 run 结束执行」已随模型工具做出来（`Agent.afterRun()`，[模型自己触发热部署](2026-09-14-model-triggered-reload.md)），watcher 以后接在同一处。用 chokidar 算新增依赖，届时另拍。选项 B 已实现，不再是 Non-Goal。
- **不重载产品代码**（builtin / `opts.extensions` / 壳）：它们的代码在 `@echo-agent/core` 与 `node_modules` 里，进程内换等于装第二份 core。产品升级的热部署走**进程间交接**：可让位 lease（[决策](../implemented/2026-09-07-preemptible-lease.md)）+ `pauseManagedWork({ reason: "handoff" })` + `start({ activation: "deferred" })` / `activate()` 已在，缺编排与「请走不可让位的前台进程」的规矩，另拍。
- **角色定义不在这里**：它是 `.md` 数据不是代码，`loadAgentDefs()` 只在装配时读一次。刷新它是数据热刷新（同 AGENTS.md 每 run 重读那一类），便宜、另议：`session_create` 新开一段时现读，正在跑的段继续用创建期快照。
- **不做依赖方连带重装**：盘上扩展 A 用了盘上扩展 B provide 的 Service，换 B 时 `refused` 并点名 A。仓库里还没有这种扩展；真有了再按那个场景设计（Host 的 `dependentsOf` 已经在算这张表）。
- **不在 run 中途换**：忙就 `rejected`，不排队。
- **不解决旧模块留在内存里**：JS 运行时卸不掉已求值的模块，重载必然有 dev 级泄漏，dsh 也没解决。
- **单文件扩展 import 的目录外文件不刷新**（`./helper.ts` 落在原处，是旧模块）；子目录扩展整棵复制，目录内的都刷。
- **进程崩溃留下的快照不清**：收摊只清本进程的；别的进程的按 pid 认得出来，不动。

## 验收

`packages/core/test/extension-reload.test.ts`（全部走 `createEcho()`，扩展是写进临时目录的真文件）：

1. 改 `hello.ts` 的返回值 → `replaced`，模型调 `hello` 拿到新值，session id 不变，清单里仍只有一条；
2. 改成语法错 → `rolled_back`，旧版工具照用，`diagnostics` 恰一条（按路径替换不累加）；修好再 reload → `replaced`、诊断清掉；apply 抛 → `rolled_back`（卸了再装回来），工具还在；
3. run 进行中 → `rejected`，没留下快照；run 结束后能换；
4. 删文件 → `removed`，工具没了；新加 → `added`，工具有了；启动时坏着修好后 → `added`；
5. 子目录扩展只改 `helper.ts` → `replaced`，新值生效；
6. 声明 `reload: "agent"` → `refused`，报文说要重启 Agent；不声明 → `refused`，报文说加 `reload: "run"`；
7. 快照：连换两次只留最新一份，`stop()` 后一个不剩，发现规则看不见它。

`packages/core/test/extension-host.test.ts` 的 `replace()` 八条：先卸再装的顺序、回滚用原 entries 与原 config、boundary 拒绝零变化、依赖方拒绝、只卸、`lost`、disposer 抛不中断、事前校验。

**Node 侧只到机制层**：`createEcho()` 今天在 Node 下起不来（`createAgent()` 开观测库走 `bun:sqlite`，既有限制，与本条无关），所以 `test/distribution-gate.test.ts` 的热部署一条装 tarball、真 `node` 跑的是两截 Node 独有的实现——`fs.cp` 整棵复制 + 经 realpath 的 import 拿到新模块且 `./helper.mjs` 是新的，以及 dist 产物上的 `ExtensionHost.replace()` 先卸后装。装配层（`reloadExtensions()`）的 Node 证据要等观测库有 Node 路径之后再补。
