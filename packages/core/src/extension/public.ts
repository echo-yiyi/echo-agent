// `@echo-agent/core/extension`（§14.2.6 冻结清单里的一条）—— Extension Host ABI：definition / Context / ServiceKey /
// Fiber 状态 / Effect / registries。不导出 RunPermit / concrete Agent / Fiber 与 EffectStack 本体。
//
// **2026-08-28 起已登记进 `package.json#exports`**（`./extension`）：第一个真实消费者是
// `examples/extension/extensions/current-year.ts`——用户写的 Extension 文件必须 import 得到
// `defineExtension` 与 `AgentTools`，否则「自动发现扩展」这句话对包外的人不成立。
// 在此之前它一直空着，是因为「exports 表无死条目」那道门要求每条子路径都有真实的跨包消费者
//（memory / schedule 等七条子路径就是因此建了又撤，见 docs/ISSUES.md OSS-2）。
//
// 这里的东西**纯**（不碰 `node:`）。

export {
  defineExtension,
  defineService,
  ExtensionAbiError,
  ExtensionDisposedError,
  RELOAD_BOUNDARY_RANK,
  type Disposer,
  type EffectLease,
  type ExtensionContext,
  type ExtensionDefinition,
  type ExtensionScope,
  type InjectDeclaration,
  type ReloadBoundary,
  type ServiceKey,
  type ServiceKind,
} from "./abi.ts";
export { ExtensionHost, ExtensionMountError, type ExtensionEntry, type FiberInfo } from "./host.ts";
export type { FiberStatus } from "./fiber.ts";
export {
  AgentBackgroundService,
  AgentHooks,
  AgentPrompt,
  AgentSkills,
  AgentTools,
  agentRegistries,
  type AgentHooksRegistry,
  type AgentPromptRegistry,
  type AgentSkillsRegistry,
  type AgentToolsRegistry,
} from "./registries.ts";
export {
  BUILTIN_GENERATION,
  builtinEntries,
  definePromptPack,
  defineToolPack,
  mountBuiltinTools,
  ECHO_MEMORY,
  ECHO_SCHEDULER,
  ECHO_SKILLS,
  ECHO_TASKS,
  type BuiltinToolGroup,
  type BuiltinToolGroups,
  type BuiltinToolsConfig,
  type PromptPackConfig,
} from "./builtin.ts";
export { unmountGenerations, type UnmountTarget } from "./cleanup.ts";
export { AgentRuntimeService, type AgentRuntime, type EquipResult, type RuntimeTurnResult } from "./runtime.ts";
export { ECHO_AGENT, agentRuntimeOf, type RuntimeSource } from "./builtin.ts";
