// Host 自带的 Service（§14.7.4「保留裸领域实体，用 sidecar ledger 记录归属」）。**两类，别混**：
//
//   · **registry**（tools / hooks / skills）——扩展**往 agent 里注册东西**的口子。
//     包住现有 harness，**不给 AgentTool / Skill 加 source 或 Fiber 字段**。
//   · **能力端口**（background）——扩展**用 agent 已有能力**的口子（`kind: "single"`）。
//
// 第二类是 2026-08-31 补的，起因是 first-party 的 `echo:shell` 撞上了：bash 工具要
// `agent.background` 才能支持 `background: true`，而扩展面**只有「注册进去」没有「用起来」**——
// 于是产品层只能在 `createEcho()` 外面自己造 Agent、自己 mount，那正是「第二个装配现场」。
// 规格说 first-party Extension 是「公开扩展面是否够用的第一个 conformance consumer」，
// 这是那句话第一次真的抓到东西：缺的不是 shell 的特例通道，是**能力端口**这一整类。
// 补上之后第三方扩展也能跑后台任务了。
//
// 归属靠 disposer：Fiber 把 `register()` 返回的 disposer 交给 `ctx.effect()` 持有，unload 时 LIFO 卸。
// disposer 只认对象身份（O1a 的 exact-reference 契约）：条目已被别的显式操作替换成 A2 时，旧 Fiber 的 disposer 不动 A2。
// 同名注册 fail-loud；受控 replace 不在 O2a（等有真实消费者再开）。

import { registerTool, type ToolMap } from "../tools/harness.ts";
import type { AgentTool } from "../tools/types.ts";
import type { HookRuntime } from "../hooks/runtime.ts";
import type { AgentBackground } from "../background/types.ts";
import { addSkills, type ActiveSkillMap, type SkillMap } from "../skill/harness.ts";
import type { Skill } from "../skill/types.ts";
import { PROMPT_VARIABLE_NAME, type PromptSection, type PromptVariable } from "../prompt/types.ts";
import type { CompactionStage } from "../compaction/types.ts";
import { defineService, type Disposer, type ServiceKey } from "./abi.ts";

export interface AgentToolsRegistry {
  /** 同名已存在 → 抛。返回的 disposer 只卸这个对象。 */
  register(tool: AgentTool): Disposer;
}

export interface AgentHooksRegistry {
  /** 与 `HookRuntime.on()` 同形（两组 overload 的类型门一并继承）。返回的 disposer 认 entry 身份。 */
  on: HookRuntime["on"];
}

export interface AgentSkillsRegistry {
  /** 任一同名已存在 → 抛（先查后写，不留半批）。disposer 只卸注册那一刻的那批对象。 */
  add(skills: readonly Skill[]): Disposer;
}

/**
 * system prompt 的注册口（2026-09-01）：段与变量都从这里进，**内建的 `echo:*` 也不例外**。
 * 工具目录不进 system；单工具语义只在 description；这里放的是身份、纪律、交互面、事实、
 * 以及工具的**跨调用习惯**——由拥有该工具的 extension 出。
 */
export interface AgentPromptRegistry {
  /** 同名已存在 → 抛；order 非有限数 → 抛。返回的 disposer 只卸这个对象。 */
  section(section: PromptSection): Disposer;
  /** `{{name}}` 的值。名字不合 `[a-z][a-z0-9_]*` 或同名已存在 → 抛。disposer 只卸这个 provider。 */
  variable(name: string, provider: PromptVariable): Disposer;
}

/**
 * 压缩阶段的注册口（2026-09-02）：**压缩策略是 extension**。内建的 `echo:compaction` 与产品 / 第三方的阶段
 * 走同一个 `stage()`，同一份所有权账本；流水线每次跑之前从 Agent 的阶段表重取，装卸在轮边界生效。
 * core 只拥有状态、校验、投影、事件与落盘（`compaction/`），阶段只产状态。
 */
export interface AgentCompactionRegistry {
  /** 同名已存在 → 抛；order 非有限数 → 抛。返回的 disposer 只卸这个对象。 */
  stage(stage: CompactionStage): Disposer;
}

export const AgentTools: ServiceKey<AgentToolsRegistry> = defineService<AgentToolsRegistry>({
  id: "echo.agent.tools",
  version: 1,
  kind: "registry",
  scope: "agent",
  reload: "turn",
});

export const AgentHooks: ServiceKey<AgentHooksRegistry> = defineService<AgentHooksRegistry>({
  id: "echo.agent.hooks",
  version: 1,
  kind: "registry",
  scope: "agent",
  reload: "turn",
});

export const AgentSkills: ServiceKey<AgentSkillsRegistry> = defineService<AgentSkillsRegistry>({
  id: "echo.agent.skills",
  version: 1,
  kind: "registry",
  scope: "agent",
  reload: "turn",
});

/** prompt 段与变量的注册口（`AgentPromptRegistry`）：`kind:"registry"`，段的增删下个 run 生效。 */
export const AgentPrompt: ServiceKey<AgentPromptRegistry> = defineService<AgentPromptRegistry>({
  id: "echo.agent.prompt",
  version: 1,
  kind: "registry",
  scope: "agent",
  // `turn`：system 每次 run 装配一次，段的增删在下一个 run 才被看见——比 turn 还弱，声明 turn 已经够
  reload: "turn",
});

/** 压缩阶段的注册口（`AgentCompactionRegistry`）：`kind:"registry"`，阶段的增删在下一次流水线跑时生效（轮边界）。 */
export const AgentCompaction: ServiceKey<AgentCompactionRegistry> = defineService<AgentCompactionRegistry>({
  id: "echo.agent.compaction",
  version: 1,
  kind: "registry",
  scope: "agent",
  reload: "turn",
});

/**
 * **能力端口**：Agent 的后台队列（闸 / 缓冲 / 收摊都在 core，扩展只填「跑什么」）。
 *
 * `kind` 是 `"single"` 不是 `"registry"`——它不收注册，是把 agent 已有的**那一个**东西交出去
 * （`AgentRuntimeService` 同理）。**没有为它新造一个 `ServiceKind`**：枚举加值是公共面的开闭决定，
 * 现有两值够表达，就不该顺手加第三个。
 * `reload: "agent"`：后台队列与 Agent 同寿，换一份就等于把在跑的任务扔了。
 *
 * **消费方应当声明 `required: true`**：ABI 里没有读 optional 的方法——`ctx.get()` 遇到
 * 没有 provider 的 optional 依赖直接抛，扩展也无从先问一句「有没有」。所以把能力端口
 * 声明成 optional 得不到「优雅降级」，只会在缺它时**装不上却说成可选**
 * （2026-08-31 review 实测；要真支持可选依赖，得先给 ABI 加 `tryGet()` 并补 conformance）。
 *
 * 这不构成负担：`agent.background` 是 **Agent 恒有的能力**（构造函数无条件造），
 * 任何由 Agent 造出来的 registries 都提供得了它。
 */
export const AgentBackgroundService: ServiceKey<AgentBackground> = defineService<AgentBackground>({
  id: "echo.agent.background",
  version: 1,
  kind: "single",
  scope: "agent",
  reload: "agent",
});

/**
 * 给 `new ExtensionHost({ services })` 用：把一个 Agent 已公开的 Map / HookRuntime / 能力端口
 * 包成 Service。Agent 本身一行不改——它仍直接拥有原始领域对象。
 *
 * 可选项**不给就不提供那条 Service**（不是提供一个空壳）：扩展 `inject` 时
 * `required: true` 会诚实装不上，`required: false` 拿到 `undefined` 自己降级。
 * 这与「能力不在」和「能力在但为空」是两件事那条口径一致。
 */
export function agentRegistries(input: {
  tools: ToolMap;
  hooks: HookRuntime;
  skills?: { pool: SkillMap; active: ActiveSkillMap };
  /**
   * 后台队列（`agent.background`）。**由 Agent 造的 Host 应当恒传**——它是 Agent 恒有的能力，
   * 不传等于让消费它的扩展装不上（见上方 Service 定义处的注释）。
   * 仍是可选参数，是因为 Host 不一定由 Agent 造（测试里的假 Host 就不是）。
   */
  background?: AgentBackground;
  /**
   * prompt 段与变量的两张表（`agent.promptSections` / `agent.promptVariables`）。
   * 与 `background` 同款：Agent 恒有，由 Agent 造的 Host 应当恒传；可选只为假 Host。
   */
  prompt?: { sections: Map<string, PromptSection>; variables: Map<string, PromptVariable> };
  /** 压缩阶段表（`agent.compactionStages`）。与 `prompt` 同款：Agent 恒有，由 Agent 造的 Host 应当恒传。 */
  compaction?: Map<string, CompactionStage>;
}): ReadonlyArray<readonly [ServiceKey<unknown>, unknown]> {
  const tools: AgentToolsRegistry = {
    register: (tool) => {
      const off = registerTool(input.tools, tool);
      return () => void off();
    },
  };
  const hooks: AgentHooksRegistry = {
    on: input.hooks.on.bind(input.hooks) as HookRuntime["on"],
  };
  const out: (readonly [ServiceKey<unknown>, unknown])[] = [
    [AgentTools, tools],
    [AgentHooks, hooks],
  ];
  if (input.skills !== undefined) {
    const { pool, active } = input.skills;
    const skills: AgentSkillsRegistry = {
      add: (list) => {
        const off = addSkills(pool, list, { active });
        return () => void off();
      },
    };
    out.push([AgentSkills, skills]);
  }
  if (input.background !== undefined) out.push([AgentBackgroundService, input.background]);
  if (input.prompt !== undefined) out.push([AgentPrompt, promptRegistry(input.prompt.sections, input.prompt.variables)]);
  if (input.compaction !== undefined) out.push([AgentCompaction, compactionRegistry(input.compaction)]);
  return out;
}

/** 阶段表上的 registry：先查后写、fail-loud；disposer 认对象身份（与 prompt 段同款）。 */
function compactionRegistry(stages: Map<string, CompactionStage>): AgentCompactionRegistry {
  return {
    stage: (stage) => {
      if (typeof stage.name !== "string" || stage.name === "") throw new Error("压缩阶段缺 name");
      if (!Number.isFinite(stage.order)) throw new Error(`压缩阶段 '${stage.name}' 的 order 必须是有限数`);
      if (typeof stage.run !== "function") throw new Error(`压缩阶段 '${stage.name}' 缺 run()`);
      if (stages.has(stage.name)) throw new Error(`压缩阶段 '${stage.name}' 已存在`);
      stages.set(stage.name, stage);
      return () => {
        if (stages.get(stage.name) === stage) stages.delete(stage.name);
      };
    },
  };
}

/** 两张表上的 registry：先查后写、fail-loud；disposer 认对象身份（O1a exact-reference 契约）。 */
function promptRegistry(sections: Map<string, PromptSection>, variables: Map<string, PromptVariable>): AgentPromptRegistry {
  return {
    section: (section) => {
      if (typeof section.name !== "string" || section.name === "") throw new Error("prompt 段缺 name");
      if (!Number.isFinite(section.order)) throw new Error(`prompt 段 '${section.name}' 的 order 必须是有限数`);
      if (sections.has(section.name)) throw new Error(`prompt 段 '${section.name}' 已存在`);
      sections.set(section.name, section);
      return () => {
        if (sections.get(section.name) === section) sections.delete(section.name);
      };
    },
    variable: (name, provider) => {
      if (!PROMPT_VARIABLE_NAME.test(name)) throw new Error(`prompt 变量名 '${name}' 不合法（只能是 [a-z][a-z0-9_]*）`);
      if (variables.has(name)) throw new Error(`prompt 变量 '${name}' 已存在`);
      variables.set(name, provider);
      return () => {
        if (variables.get(name) === provider) variables.delete(name);
      };
    },
  };
}
