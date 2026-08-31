// `@echo/core` 根入口。设计真相源：docs/design/AGENT-CORE.md §13（D13 / D16）。
//
// 边界一句话：**Agent 管机制，用户换策略与基础设施**（§13.3）。
// 状态机、恢复与提交顺序归 core 自己拥有；用户注入的是 Store / Strategy / Source / Clock / Executor / Lock，
// 它们只换介质与策略，换不掉语义。
//
// **形状 = `/engine` + 落盘那几件。** 一个 `Agent` 类、两种装配（D16）：
//   - `@echo-agent/core/engine`：Web-standard，调用方必须自己给 `StorageDir` 之类的端口实现；
//   - `@echo/core`（本文件）：多给 node 的 first-party 默认件。
//
// 现在这里只多出下面那两组 node-only 导出；M3 起 `await createEcho()`（async，D17）与 first-party 的 Store 也落在这一层
// （§13.6 的「不要求用户实现我们的基础能力」就是这条入口的承诺），engine 那条**不跟进**。
//
// 加导出前先判断：纯的放 `engine.ts`，拖 `node:` 的才放这里。
// 放错地方 `test/engine-purity.test.ts` 会红——它从 `engine.ts` 出发算闭包。
//
// 测试替身不在这条面上——它走 `@echo-agent/core/testing`。

export * from "./engine.ts";

// —— 以下是 engine 面**没有**的部分：node-only 的 first-party 默认件 ——

/** 真盘的 `StorageDir` 实现（`node:fs` / `node:os` / `node:path`）。 */
export { FileDir, echoHome } from "./storage/file-dir.ts";

/** first-party 的 single-writer 文件锁（`node:fs`）。端口 `StateLock` 本身在 engine 面。 */
export { fileStateLock, inspectStateLock } from "./storage/file-lock.ts";
export type { PeekedLockRecord, StateLockInspection } from "./storage/file-lock.ts";

/**
 * **两个使用高度，一个 composition root**（§14.2）：
 *   - 根入口 = `createEcho()`，**唯一**的装配现场；
 *   - `/engine` = `new Agent()`，低层——自己给端口、自己注册工具。
 *
 * `createAgent` **不在公共面上**（2026-08-31 收）：它曾经是第二个 composition root，
 * 与 §14.2 的标题「一个包、两个使用高度、**一个** composition root」直接冲突。
 * 现在它降为 `create-agent.ts` 里的内部装配函数，只有 `createEcho()` 调它。
 * 模型解析与状态根解析这两个纯函数仍然导出——它们是**判据**不是装配现场，
 * 消费方（Runner / 测试）要先算出 `stateDir` 或校验模型 id 时用得上。
 */
export { resolveModel, resolveStateDir } from "./create-agent.ts";
export {
  createEcho,
  discoverExtensionFiles,
  loadExtensionFile,
  resolveExtensionDirs,
  ExtensionLoadError,
  EXTENSIONS_DIR,
} from "./create-echo.ts";
export type { CreateEchoOptions, Echo, LoadedExtension } from "./create-echo.ts";

/** skill 加载器：扫目录读文件（`node:fs/promises`）。skill 的形状与操作在 engine 面。 */
export { loadSkills, loadSkillsFromDir, SKILL_ENTRY_FILE } from "./skill/loader.ts";
export type { LoadedSkills } from "./skill/loader.ts";
