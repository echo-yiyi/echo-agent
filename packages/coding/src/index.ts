// `echo-coding` 公共面：coding agent **产品**——与 `echo-agent` 平级，互不依赖（2026-09-09 拆包）。
//
// **装配仍归 `createEcho()`，启动器部件归 `@echo-agent/base`**：`codingPreset()` 出配置；可执行文件
// `echo-coding` 是 base 的 `mainFor()` 绑上本产品与一个壳（`cli.ts`）。原先的 `createCodingAgent()`
// 自己造 Agent、造 Host、mount、收摊——那是第二个 composition root，2026-08-31 删掉了。

/** 可执行文件的实质：装配层的启动逻辑绑上本产品。`bin/echo-coding.ts` 调的就是它。 */
export { main, ECHO_CODING } from "./cli.ts";
export { codingPreset, CODING_DEFAULT_MODEL } from "./agent.ts";
export type { CodingPreset, CodingPresetOptions } from "./agent.ts";
export { ECHO_SHELL, ECHO_WORKSPACE } from "./extensions.ts";
export { makeFsTools, resolveSafe } from "./tools/fs.ts";
export { makeBashTool, makeShellTools } from "./tools/bash.ts";
export type { BashDeps } from "./tools/bash.ts";
export { makeSearchTools } from "./tools/search.ts";
export { permissionPolicyFor, DEFAULT_PERMISSION } from "./permission.ts";
export type { PermissionPolicy, PermissionRule } from "./permission.ts";
