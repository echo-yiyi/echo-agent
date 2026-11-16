// `@echo-agent/tools` 公共面：**对外部世界动手的工具**，三组——工作区文件与搜索、shell（可包进操作系统沙箱）、web。
//
// 它们不属于任何一个产品：哪个产品要，就把对应的 Extension 列进自己的 preset（`echo-coding` 三条都挂）。
// 不住 core：core 不碰子进程与网络（判据 2026-08-04：对外部世界动手的工具不进内核）；
// 不住某个产品：产品之间平级、互不依赖，放在一个产品里别的产品就拿不到。

/** 三条 Extension：产品列进 `createEcho({ extensions })`。 */
export { ECHO_SHELL, ECHO_WEB, ECHO_WORKSPACE } from "./extensions.ts";
export type { ShellConfig } from "./extensions.ts";

/** 工作区文件：`read_file` / `write_file` / `edit_file`，以及它们与搜索共用的越界守卫。 */
export { makeFsTools, resolveSafe } from "./fs.ts";
/** 工作区搜索：`glob` / `grep` / `list_dir`。 */
export { makeSearchTools } from "./search.ts";

/** shell：`bash` / `job_output` / `job_stop`。 */
export { detectShellEnvironment, makeBashTool, makeShellTools } from "./bash.ts";
export type { BashDeps, ShellEnvironment } from "./bash.ts";
/** bash 的执行后端：直接起，或包进操作系统沙箱。 */
export { DIRECT_BACKEND, detectSandbox } from "./sandbox.ts";
export type { ShellBackend } from "./sandbox.ts";

/** web：`web_fetch` / `web_search`。 */
export { htmlToText, makeWebTools } from "./web.ts";
export type { WebDeps } from "./web.ts";

/** 跟着工具走的两段 prompt（`tool:workspace` / `tool:shell`）：`echo:workspace` 的 config 与产品的行为 digest 都从这里取。 */
export { shellToolsSection, workspaceToolsSection } from "./prompt.ts";
