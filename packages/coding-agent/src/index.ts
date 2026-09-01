// @echo/coding-agent 公共面。
//
// **它是一份 preset，不是第二个装配入口**（2026-08-31 用户拍板）：
// `codingPreset()` 出配置，`createEcho()` 装配。原先的 `createCodingAgent()` 自己造 Agent、
// 造 Host、mount、收摊——那是第二个 composition root，删掉了。
export { codingPreset, CODING_DEFAULT_MODEL } from "./agent.ts";
export type { CodingPreset, CodingPresetOptions } from "./agent.ts";
export { ECHO_SHELL, ECHO_WORKSPACE } from "./extensions.ts";
export { makeFsTools, resolveSafe } from "./tools/fs.ts";
export { makeBashTool } from "./tools/bash.ts";
export type { BashDeps } from "./tools/bash.ts";
export { makeSearchTools } from "./tools/search.ts";
export { FileSessionManager } from "./sessions.ts";
export { permissionPolicyFor, DEFAULT_PERMISSION } from "./permission.ts";
export type { PermissionPolicy, PermissionRule } from "./permission.ts";
