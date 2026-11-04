# 装配零件收进 core 内部：`ExtensionHost`、内建 `echo:*` 定义与扩展的发现 / 加载不再公开

> 状态:implemented · 提出 2026-11-03（公共导出面盘点）· 拍板 2026-11-03（用户：「全部按推荐修，并参考成熟实现」）· 判据的上位记录:[`Agent` 类收进内部](2026-09-07-agent-class-internal.md) 第 1 条（第三方建产品 / 写扩展 / 换壳需要不需要）· 落地 `packages/core/src/extension/public.ts`、`packages/core/src/index.ts` · 判据 `packages/core/test/api-snapshot.txt`、`test/distribution-gate.test.ts`

**给谁看**：改 core 公共入口、写 extension 的人。假设已知 [扩展、装配与所有权](../../design/extensions.md) §1、§4。

**一句话**：`@echo-agent/core/extension` 只留写扩展用的 ABI；Host、内建定义、内建挂载 / 卸载的零件和根入口上的扩展发现 / 加载函数撤回 core 内部——装 extension 的只有 `createEcho()` 一处。

## 现状（拍板前）

`@echo-agent/core/extension` 导出了 `ExtensionHost`、`ExtensionMountError`、`agentRegistries`、`mountBuiltinTools`、`builtinEntries`、`BUILTIN_GENERATION`、`unmountGenerations`（及其参数类型 `UnmountTarget`）、10 个内建定义（`ECHO_AGENT` / `ECHO_ASK` / `ECHO_COMPACTION` / `ECHO_MEMORY` / `ECHO_RELOAD` / `ECHO_SCHEDULER` / `ECHO_SKILLS` / `ECHO_SUBAGENT` / `ECHO_TASKS` / `ECHO_TOOL_SEARCH`）、Host 的结果类型 `FiberInfo` / `ReplaceResult`；根入口导出了 `discoverExtensionFiles`、`loadExtensionFile`、`resolveExtensionDirs`、`EXTENSIONS_DIR`、`ExtensionLoadError`。

- 凑起来就是 `createEcho()` 之外的第二个装配现场：自己 `new ExtensionHost()`、自己发现和加载盘上文件、自己挂内建定义——与 CLAUDE.md「只有一处装配」直接冲突。
- 有几件仓外根本用不了：`mountBuiltinTools` / `builtinEntries` 要的 `BuiltinMountable` 本身不导出（是 `Agent` 的形状），`agentRegistries` 要 `Agent` 的工具表、收紧叠与策略槽。[`Agent` 类收进内部](2026-09-07-agent-class-internal.md) 的实现注已经登记了这一条，当时没拍。
- `ExtensionLoadError` 从不出 `createEcho()`：盘上坏扩展在装配里记成诊断。

引用盘点（2026-11-03，`packages/base`、`tui`、`cli`、`coding` 与 `examples/` 的非测试代码）：以上符号**零引用**。`ECHO_AGENT` 在 `packages/cli` 里有同名符号，那是 `echo-agent` 产品的 `Product` 常量，不是 core 的内建定义；`ExtensionHost` 在 tui / coding 里只出现在注释里。从公共入口 import 它们的只有 core 自己的三个测试与 `test/distribution-gate.test.ts` 的热部署一条。

## 选项

- **A. 零引用、第三方也用不到的从公共入口撤掉**，core 内部照用，仓内测试改从 src 路径 import。
- **B. 留在公共面，文档写「仅供内部」。** 发布后再收窄是破坏性变更；公共面上的「内部」没有门守。
- **C. 挪到一条 `./internal` 子路径。** 仍是能 import 的公共面，等于 B。

## 决定

**A**。

1. 撤掉上面「现状」列的全部符号。`@echo-agent/core/extension` 82 → 62 个符号，根入口 357 → 352。
2. **留下的**：`defineExtension` / `defineService` 等 ABI、全部 registry 与能力端口的 token 和类型、`registerAll` / `defineToolPack` / `definePromptPack`（第三方写工具包、prompt 包用的同一份实现）、`ExtensionEntry`（`createEcho({ extensions })` 的元素类型）、`AgentRuntimeService` 与壳协议类型、热部署的结果类型、记忆模块的内建定义（`agentMemory` / `notesMemory` / `userMemory`，产品关掉内建记忆后要再注册回来）。`echo.observations` 那组不动（[观测的公开线](../proposed/2026-09-07-observation-public-face.md) 在等拍板）。
3. 分发门里验 Node 热部署的那一条原来直接 `new ExtensionHost()` 调 `replace()`，改成第三方能走的那条路：`createEcho({ extensionDirs })` 发现子目录扩展，改它的相对依赖，`echo.reloadExtensions()` 报 `replaced`、新代码拿到新的 `./helper.mjs`、旧代先卸新代后装。[热部署](2026-09-14-extension-hot-reload.md) 记录里「装配层的 Node 证据要等之后再补」那一句由它补上。

## Non-Goals

- `BuiltinToolGroup` / `BuiltinToolGroups` 两个类型只描述 `builtinEntries()` 的输入，仓外同样零引用；这次只动明确点名的符号，类型留着，下一次盘公共面时按同一判据再看。
- 不改 `createEcho()` 的失败行为：显式装配（`createEcho({ extensions })`）挂不上照旧抛 Host 给的错（LOADING 失败是 `ExtensionMountError`，收摊也失败时包进 `AggregateError`），只是这个类不再从公共入口导出；仓外没有按类区分它的调用方。
- 不动设计文档里指向这些符号的源码链接：它们讲的是机制，链接指 src 里的声明，不等于公开。

## 验收

- [API 快照](../../../packages/core/test/api-snapshot.test.ts#test=snapshot-与实际公共面一致不等即红跑---write-重录并人审-diff) 里没有上面列的任一符号；`./extension` 62 个、根入口 352 个。
- `packages/{base,tui,cli,coding}/src`、`examples/`、`test/` 里没有从 `@echo-agent/core` 或 `@echo-agent/core/extension` import 它们。
- [Node 热部署走 createEcho](../../../test/distribution-gate.test.ts#test=node热部署createecho-发现子目录扩展改了相对依赖之后-reloadextensions-拿到新代码旧代先卸新代后装)：装 tarball、真 `node` 跑，`changes` 是 `["replaced"]`、`applied` 是 `["h1", "dispose:h1", "h2"]`、没有诊断。
