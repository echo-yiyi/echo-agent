// `@echo-agent/core/extension` —— Extension Host ABI：definition / Context / ServiceKey /
// Fiber 状态 / Effect / registries。不导出 RunPermit / concrete Agent / Fiber 与 EffectStack 本体。
//
// **2026-08-28 起已登记进 `package.json#exports`**（`./extension`）：第一个真实消费者是
// `examples/extension/extensions/current-year.ts`——用户写的 Extension 文件必须 import 得到
// `defineExtension` 与 `AgentTools`，否则「自动发现扩展」这句话对包外的人不成立。
// 在此之前它一直空着，是因为「exports 表无死条目」这条纪律要求每条子路径都有真实的跨包消费者
//（memory / schedule 等七条子路径就是因此建了又撤；这是纪律不是门，见 index.ts 头注）。
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
  AgentCompaction,
  AgentHooks,
  AgentMemory,
  AgentPrompt,
  AgentPolicies,
  type AgentPoliciesRegistry,
  AgentSessionsService,
  AgentSkills,
  AgentTools,
  agentRegistries,
  type AgentCompactionRegistry,
  type AgentHooksRegistry,
  type AgentMemoryRegistry,
  type AgentPromptRegistry,
  type AgentSkillsRegistry,
  type AgentToolsRegistry,
} from "./registries.ts";
// 记忆模块（2026-09-10 进公共面）：第一个真实的包外消费者是陪伴产品——它要在 extension 里经
// `AgentMemory.module()` 声明自己的模块（relationship / collaboration / experiences），并在
// `memory.builtin: false` 之后按需把内建的某几个再注册回来。所以内建三个的**定义**与模块的**类型**
// 一起导出；harness 的操作面仍不导出——扩展只声明数据，写入永远走 core 的唯一写路径。
export { agentMemory, notesMemory, userMemory } from "../memory/types.ts";
export type { AnyMemory, IndexedMemory, Memory, ResidentMemory } from "../memory/types.ts";
export type { MemoryCommand } from "../memory/tool-commands.ts";
export {
  BUILTIN_GENERATION,
  builtinEntries,
  definePromptPack,
  defineToolPack,
  mountBuiltinTools,
  ECHO_COMPACTION,
  ECHO_MEMORY,
  ECHO_SCHEDULER,
  ECHO_SKILLS,
  ECHO_TASKS,
  ECHO_TOOL_SEARCH,
  ECHO_ASK,
  ECHO_SUBAGENT,
  type BuiltinToolGroup,
  type BuiltinToolGroups,
  type BuiltinToolsConfig,
  type PromptPackConfig,
} from "./builtin.ts";
export { unmountGenerations, type UnmountTarget } from "./cleanup.ts";
export { AgentRuntimeService, type AgentRuntime, type CompactResult, type EquipResult, type RuntimeTurnResult } from "./runtime.ts";
export { ECHO_AGENT, agentRuntimeOf, type RuntimeSource } from "./builtin.ts";

/** `AgentPolicies.declare()` 收的形状与三项的全集：扩展作者写 config 时要念得出它们。 */
export type { AgentPolicyValues, DeclaredPolicies } from "../policies.ts";
