// `echo:*` builtin Extension 表。
//
// 规格原话：`echo:*` 通过**内置模块表**解析，不从安装目录动态找文件；但**进入 ExtensionHost 后
// 与第三方一样**获得 Fiber、Effect、依赖检查与 dispose。first-party Extension 不得 import
// 未公开私有捷径；**它们是公开扩展面是否够用的第一个 conformance consumer**。
//
// ## 这个文件解决的是什么
//
// 在它之前，工具注册有**两条路**：内建在 `Agent` 构造函数里直调 `registerTools(this.tools, …)`，
// 扩展走 `ctx.get(AgentTools).register()`。后果不是洁癖问题，是四件实在的事：
//   ① 公共 API 没被自己人行使过——`AgentTools.register` 的坑只有扩展作者会撞上；
//   ② 所有权不对称——extension 注册的有 Fiber 持 disposer，内建的**装上就下不来**；
//   ③ 可见性不对称——`echo.extensions` 列不出内建，用户看到的能力清单是残的；
//   ④ 顺序无统一裁决——两批注册在不同时机发生，撞名怎么办没人定义。
//
// 现在只有一条路。**构造仍在 core**（Agent 构造函数造能力本体、并把工具连同持久化/租约包装一起造好），
// **注册全走 extension**——这正是 2026-08-31 用户拍的那句「可以用构造函数去在 core 构造，
// 但机制必须同一份，都要走 extension」。
//
// ## 为什么按能力分成四条而不是打成一包
//
// 一条一个 `echo:*` 名字，于是 `echo.extensions` 就是**「这个 agent 默认会什么」的可读清单**；
// 将来要关掉某一件（`--no-tasks`）也有抓手。打成一包这两件都做不到。

import type { AgentTool } from "../tools/types.ts";
import type { ToolMap, ToolRestrictions } from "../tools/harness.ts";
import type { HookRuntime } from "../hooks/runtime.ts";
import type { ActiveSkillMap, SkillMap } from "../skill/harness.ts";
import type { AgentBackground } from "../background/types.ts";
import { defineExtension, type ExtensionDefinition } from "./abi.ts";
import { ExtensionHost, type ExtensionEntry } from "./host.ts";
import { AgentCompaction, AgentPrompt, AgentTools, agentRegistries } from "./registries.ts";
import type { PromptSection, PromptVariable } from "../prompt/types.ts";
import { builtinVariables, environmentSection } from "../prompt/sections.ts";
import { AgentRuntimeService, type AgentRuntime, type CompactResult, type EquipResult } from "./runtime.ts";
import type { CompactionStage } from "../compaction/types.ts";
import type { CompactionPackConfig } from "../compaction/builtin.ts";
import type { ServiceKey } from "./abi.ts";
import type { AgentMessage, ImageBlock } from "../messages.ts";
import type { AgentOutcome } from "../events.ts";
import { errText } from "../errors.ts";
import type { Model, ThinkingLevel } from "../provider/types.ts";

/**
 * builtin 的 config 形状：一组已经造好的工具，外加这组工具的 **prompt 段**（跨调用习惯、目录段）。
 * **构造归 core，这里只负责注册。** 段与工具同 owner、同生命周期：工具卸了，讲它怎么用的那段也走。
 */
export type BuiltinToolsConfig = { readonly tools: readonly AgentTool[]; readonly sections?: readonly PromptSection[] };

function isToolArray(v: unknown): v is readonly AgentTool[] {
  return Array.isArray(v) && v.every((t) => typeof t === "object" && t !== null && typeof (t as { name?: unknown }).name === "string");
}

function isSectionArray(v: unknown): v is readonly PromptSection[] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as { name?: unknown }).name === "string" &&
        typeof (s as { order?: unknown }).order === "number" &&
        typeof (s as { render?: unknown }).render === "function",
    )
  );
}

/**
 * 在一个 effect 里把一组注册（工具、段、变量）**原子地**装上：中途任一失败，已装的逆序全撤再抛。
 * `defineToolPack` / `definePromptPack` / `ECHO_AGENT` 共用——回滚逻辑只写一份。
 */
function registerAll(registrations: ReadonlyArray<() => () => unknown>): { value: number; dispose: () => void } {
  const offs: (() => unknown)[] = [];
  const undoAll = (): void => {
    // 逆序撤销：与注册顺序对称，撞名 replace 的语义才不会错位
    for (let i = offs.length - 1; i >= 0; i--) offs[i]!();
  };
  try {
    for (const register of registrations) offs.push(register());
  } catch (e) {
    undoAll(); // **全有或全无**：这一步失败，registry 必须回到调用前的样子
    throw e;
  }
  return { value: offs.length, dispose: undoAll };
}

/**
 * 造一条「注册这组工具」的 Extension。**公开**——first-party 与产品层共用同一份实现，
 * 不各抄一遍（coding-agent 的 `echo:workspace` / `echo:shell` 走的就是它）。
 *
 * 两条不变量：
 *   · **disposer 交给 `ctx.effect()`**：卸载时按注册的**逆序**撤销。直调 `registerTools`
 *     装上去的工具没有 owner，热重载时无从下手；
 *   · **注册是原子的**：中途撞名就把已经注册上的**全部撤回**再抛。
 *     上一版是 `tools.map(register)`——第 3 个撞名时前两个已经进了 registry，而 `start()` 还没返回
 *     lease，Host 拿不到 disposer、回滚不了它们。于是 mount 报「已回滚」而 registry 里有残留
 *     （review 实测 `TaskCreate` / `TaskList` 留着）——**那是最坏的一种假绿：门说干净了，其实没有。**
 */
export function defineToolPack(name: string): ExtensionDefinition<BuiltinToolsConfig> {
  return defineExtension<BuiltinToolsConfig>({
    name,
    hostAbiVersion: 1,
    // 与第三方扩展**同一个** Service、同一个 `register()`——这就是「机制只有一份」的落点
    inject: {
      tools: { service: AgentTools, required: true },
      prompt: { service: AgentPrompt, required: true },
    },
    config: (input: unknown): BuiltinToolsConfig => {
      const tools = (input as { tools?: unknown } | undefined)?.tools;
      const sections = (input as { sections?: unknown } | undefined)?.sections;
      if (!isToolArray(tools)) throw new Error(`${name} 的 config 必须是 { tools: AgentTool[], sections?: PromptSection[] }`);
      if (sections !== undefined && !isSectionArray(sections)) {
        throw new Error(`${name} 的 config.sections 必须是 PromptSection[]（{ name, order, render }）`);
      }
      return sections === undefined ? { tools } : { tools, sections };
    },
    apply(ctx, config) {
      const sections = config.sections ?? [];
      if (config.tools.length === 0 && sections.length === 0) return; // 空组不占 Fiber 的 effect 位
      const tools = ctx.get(AgentTools);
      const prompt = ctx.get(AgentPrompt);
      void ctx.effect({
        // `turn`：工具面每轮都可能变，这是最弱的安全点——声明得比实际需要强会挡住热重载
        boundary: "turn",
        start: () =>
          registerAll([
            ...config.tools.map((t) => () => tools.register(t)),
            ...sections.map((s) => () => prompt.section(s)),
          ]),
      });
    },
  });
}

/** `definePromptPack` 的 config：只出段，不带工具（身份、纪律、交互面、项目指令）。 */
export type PromptPackConfig = { readonly sections: readonly PromptSection[] };

/**
 * 造一条「只注册这几段 prompt」的 Extension。给产品层的身份 / 纪律段、壳的交互面段、
 * 项目指令段用——它们没有工具，走 `defineToolPack` 会让「工具包」这个名字撒谎。
 * 注册与回滚规则与 `defineToolPack` 同一份（`registerAll`）。
 */
export function definePromptPack(name: string): ExtensionDefinition<PromptPackConfig> {
  return defineExtension<PromptPackConfig>({
    name,
    hostAbiVersion: 1,
    inject: { prompt: { service: AgentPrompt, required: true } },
    config: (input: unknown): PromptPackConfig => {
      const sections = (input as { sections?: unknown } | undefined)?.sections;
      if (!isSectionArray(sections)) throw new Error(`${name} 的 config 必须是 { sections: PromptSection[] }（{ name, order, render }）`);
      return { sections };
    },
    apply(ctx, config) {
      if (config.sections.length === 0) return;
      const prompt = ctx.get(AgentPrompt);
      void ctx.effect({
        boundary: "turn",
        start: () => registerAll(config.sections.map((s) => () => prompt.section(s))),
      });
    },
  });
}

/** 生命周期 owner 的四条（本批只搬工具注册；session/background/mcp 等仍在各自的位置）。 */
export const ECHO_TASKS = defineToolPack("echo:tasks");
export const ECHO_SKILLS = defineToolPack("echo:skills");
export const ECHO_MEMORY = defineToolPack("echo:memory");
export const ECHO_SCHEDULER = defineToolPack("echo:scheduler");
/** 渐进式披露的入口 `tool_search`（2026-09-02）：恒装；延迟是工具自己的标记（`ToolBase.deferred`）。 */
export const ECHO_TOOL_SEARCH = defineToolPack("echo:tool-search");
/** 提问 `ask_user`（2026-09-05）：恒装；有没有人答由 `AgentOptions.questions` 定，没人时工具如实回话。 */
export const ECHO_ASK = defineToolPack("echo:ask");
/** 委派 `subagent`（2026-09-06）：恒装；子 agent 的 prompt / system / 工具集由模型在调用时决定。 */
export const ECHO_SUBAGENT = defineToolPack("echo:subagent");

function isStageArray(v: unknown): v is readonly CompactionStage[] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as { name?: unknown }).name === "string" &&
        typeof (s as { order?: unknown }).order === "number" &&
        typeof (s as { run?: unknown }).run === "function",
    )
  );
}

/**
 * `echo:compaction`（2026-09-02）：缺省的压缩阶梯 + `transcript_read` + 它的习惯段。
 *
 * **与第三方策略同一条路**：阶段经 `AgentCompaction.stage()`、工具经 `AgentTools.register()`、段经
 * `AgentPrompt.section()`，三者同一个 effect、`boundary: "turn"`——整组一起装、一起撤，热插拔在轮边界生效
 * （流水线每次跑之前重取阶段表）。产品要换策略：`compaction.builtin = false` 不装这组，再挂自己的扩展注册阶段。
 *
 * 不用 `defineToolPack`：它的 inject 只有 tools / prompt；给它加 required 的 `AgentCompaction` 会让
 * 所有 tool pack（含 `echo:workspace`）都依赖压缩 registry，假 Host 就装不上了。
 */
export const ECHO_COMPACTION: ExtensionDefinition<CompactionPackConfig> = defineExtension<CompactionPackConfig>({
  name: "echo:compaction",
  hostAbiVersion: 1,
  inject: {
    tools: { service: AgentTools, required: true },
    prompt: { service: AgentPrompt, required: true },
    compaction: { service: AgentCompaction, required: true },
  },
  config: (input: unknown): CompactionPackConfig => {
    const tools = (input as { tools?: unknown } | undefined)?.tools;
    const sections = (input as { sections?: unknown } | undefined)?.sections ?? [];
    const stages = (input as { stages?: unknown } | undefined)?.stages;
    if (!isToolArray(tools) || !isSectionArray(sections) || !isStageArray(stages)) {
      throw new Error("echo:compaction 的 config 必须是 { tools: AgentTool[], sections?: PromptSection[], stages: CompactionStage[] }");
    }
    return { tools, sections, stages };
  },
  apply(ctx, config) {
    if (config.tools.length === 0 && config.sections.length === 0 && config.stages.length === 0) return;
    const tools = ctx.get(AgentTools);
    const prompt = ctx.get(AgentPrompt);
    const compaction = ctx.get(AgentCompaction);
    void ctx.effect({
      boundary: "turn",
      start: () =>
        registerAll([
          ...config.tools.map((t) => () => tools.register(t)),
          ...config.sections.map((s) => () => prompt.section(s)),
          ...config.stages.map((s) => () => compaction.stage(s)),
        ]),
    });
  },
});

/**
 * 内建工具按能力分组。`Agent` 造好它们，装配层拿去 mount。
 *
 * **`undefined` = 这个能力压根不在**（没给 memory / 没给 schedule），与「在但零工具」
 * （空数组）是两件事——见 `builtinEntries()`。
 */
export type BuiltinToolGroups = {
  readonly tasks: BuiltinToolGroup | undefined;
  readonly skills: BuiltinToolGroup | undefined;
  readonly memory: BuiltinToolGroup | undefined;
  readonly scheduler: BuiltinToolGroup | undefined;
  /** 渐进式披露的入口（`tool_search`），恒在；上不上菜单由 `visibleTools()` 按池里有没有待取的延迟工具决定。 */
  readonly toolSearch: BuiltinToolGroup | undefined;
  /** 提问 `ask_user`，恒在。 */
  readonly askUser: BuiltinToolGroup | undefined;
  /** 委派 `subagent`，恒在。 */
  readonly subagent: BuiltinToolGroup | undefined;
  /** `undefined` = `compaction.builtin === false`：不装缺省阶梯（流水线与 registry 仍在，等别的扩展注册阶段）。 */
  readonly compaction: CompactionPackConfig | undefined;
};

/** 一组内建：工具 + 这组工具自己的 prompt 段，就是 `defineToolPack` 的 config 形状。 */
export type BuiltinToolGroup = BuiltinToolsConfig;

/**
 * builtin 表 → `ExtensionEntry[]`。**这就是「内置模块表」**：名字在这里解析成 definition，
 * 不去安装目录找文件；之后与外部扩展走同一条 `host.mount()`。
 *
 * **能力不在就不出条目**（review 二轮 P2）。上一版无条件列四条，于是
 * `withoutMemory: true` 装出来的 agent——memory harness 压根没造、工具也不存在——
 * `echo.extensions` 里却写着 `echo:memory`。**那是在报告一个不存在的能力**，
 * 而 `echo.extensions` 的全部价值就是「这个 agent 会什么」的可信答案。
 *
 * 「能力在但零工具」与「能力不在」是**两件事**，不能都用空数组表达：
 *   · 能力在、零工具（比如 skill 池是空的）→ **出条目**，工具组为空，`apply()` 直接返回；
 *   · 能力不在（没给 memory / schedule）→ **不出条目**。
 * 所以 `BuiltinToolGroups` 用 `undefined` 表示后者——空数组只表示前者。
 */
export function builtinEntries(
  groups: BuiltinToolGroups,
  /** 有它就多出 `echo:agent` 一条——**壳子 inject 的那个 Service 由它 provide**。 */
  runtime?: AgentRuntime,
): readonly { entryId: string; definition: ExtensionDefinition<unknown>; config: unknown }[] {
  const agentEntry =
    runtime === undefined
      ? []
      : [{ entryId: "echo:agent", definition: ECHO_AGENT as ExtensionDefinition<unknown>, config: { runtime } }];
  const table: readonly [string, ExtensionDefinition<unknown>, BuiltinToolGroup | CompactionPackConfig | undefined][] = [
    ["echo:tasks", ECHO_TASKS as ExtensionDefinition<unknown>, groups.tasks],
    ["echo:skills", ECHO_SKILLS as ExtensionDefinition<unknown>, groups.skills],
    ["echo:memory", ECHO_MEMORY as ExtensionDefinition<unknown>, groups.memory],
    ["echo:scheduler", ECHO_SCHEDULER as ExtensionDefinition<unknown>, groups.scheduler],
    ["echo:tool-search", ECHO_TOOL_SEARCH as ExtensionDefinition<unknown>, groups.toolSearch],
    ["echo:ask", ECHO_ASK as ExtensionDefinition<unknown>, groups.askUser],
    ["echo:subagent", ECHO_SUBAGENT as ExtensionDefinition<unknown>, groups.subagent],
    ["echo:compaction", ECHO_COMPACTION as ExtensionDefinition<unknown>, groups.compaction],
  ];
  return [
    // **`echo:agent` 排在最前**：它 provide 的 `AgentRuntime` 是别人 inject 的东西，
    // 拓扑排序会保证顺序，但把它写在前面读起来也更像那么回事。
    ...agentEntry,
    ...table
      .filter((row): row is [string, ExtensionDefinition<unknown>, BuiltinToolGroup | CompactionPackConfig] => row[2] !== undefined)
      .map(([entryId, definition, group]) => ({ entryId, definition, config: group })),
  ];
}

/**
 * 把 `echo:*` builtin 表 mount 到一个已经造好的 Agent 上，返回那个 Host。
 *
 * **这不是第二个 composition root**：它不装配 Agent（不解析模型、不开状态根、不取锁），
 * 只做「把内建工具经公共 registry 注册上去」这一件事。`createEcho()` 内部用的就是它，
 * 所以两边**是同一条路、同一张表**——不存在「装配层走一套、别人走另一套」。
 *
 * 谁会直接用它：
 *   · 低层 `new Agent()` 的用户，想要内建工具但不需要落盘装配；
 *   · 单测——否则每验一次 Task 工具都得先起一个真状态根。
 */
export type BuiltinMountable = RuntimeSource & {
  readonly builtinTools: BuiltinToolGroups;
  readonly tools: ToolMap;
  /** 收紧工作集的那一叠。同理：Agent 恒有，默认 Host 要接上，否则 `AgentTools.restrict()` 无处生效。 */
  readonly toolRestrictions: ToolRestrictions;
  readonly hooks: HookRuntime;
  readonly skills: SkillMap;
  readonly activeSkills: ActiveSkillMap;
  /**
   * 后台队列。**默认 Host 要把它作为 Service 提供出去**，否则消费它的扩展装不上
   * （2026-08-31 review 四轮 P1：`echo:shell` 改成 `required: true` 之后，低层路径
   * `new Agent()` → `mountBuiltinTools(agent)` → mount `ECHO_SHELL` 当场报
   * 「required 依赖 'echo.agent.background' 没有 provider」——上一轮只改了 `createEcho()`
   * 那一处调用，漏了这里自己造的默认 Host）。
   *
   * 它是 `Agent` 恒有的字段，所以放进这个结构不构成新要求。
   */
  readonly background: AgentBackground;
  /** prompt 段与变量的两张表。与 `background` 同理：Agent 恒有，默认 Host 要把 `AgentPrompt` 提供出去。 */
  readonly promptSections: Map<string, PromptSection>;
  readonly promptVariables: Map<string, PromptVariable>;
  /** 压缩阶段表。同理：Agent 恒有，默认 Host 要把 `AgentCompaction` 提供出去，否则 `echo:compaction` 装不上。 */
  readonly compactionStages: Map<string, CompactionStage>;
};

/**
 * 这一代要 mount 的**全部** entries。**只算一次**（2026-08-31 review 二轮 P1）：
 * 上一版 `createEcho()` 自己调一次不带 runtime 的 `builtinEntries()` 拿去做公开清单，
 * 而 `mountBuiltinTools()` 内部另算一次带 runtime 的拿去 mount——于是 `echo:agent`
 * 真的装上了、清单里却没有。**清单与真相分家是最难查的一类假绿**：看清单的人以为它不在。
 */
export function builtinEntriesFor(agent: BuiltinMountable): readonly ExtensionEntry[] {
  return builtinEntries(agent.builtinTools, agentRuntimeOf(agent)) as readonly ExtensionEntry[];
}

export async function mountBuiltinTools(
  agent: BuiltinMountable,
  host: ExtensionHost = new ExtensionHost({
    services: agentRegistries({
      tools: agent.tools,
      toolRestrictions: agent.toolRestrictions,
      hooks: agent.hooks,
      skills: { pool: agent.skills, active: agent.activeSkills },
      // **能力端口也要给**：少了它，`inject` 后台队列的扩展在这条低层路径上装不上
      background: agent.background,
      prompt: { sections: agent.promptSections, variables: agent.promptVariables },
      compaction: agent.compactionStages,
    }),
  }),
  /** 调用方已经算好的那份。**传进来就用它**，不再自己算一份——两份就会分家。 */
  entries: readonly ExtensionEntry[] = builtinEntriesFor(agent),
): Promise<ExtensionHost> {
  await host.mount(BUILTIN_GENERATION, entries);
  return host;
}

/** 内建那一代的 generation 名。装配层卸载时要按名字来。 */
export const BUILTIN_GENERATION = "builtin";

/**
 * `echo:agent` —— **provide `AgentRuntime`** 的那一条。
 *
 * 它是「壳也是 extension」这件事的支点：壳（TUI / Web）`inject` 这个 Service，
 * 于是它们与工具扩展**长在同一套机制上**，而不是 core 外面套的一层。
 *
 * 本批只做 provide 这一半——`echo:agent` 还要「seal AgentAssembly、构造/恢复低层 Agent」
 * （candidate/seal 换代流程）。那是 O3 正题，这里用**已经造好的** Agent
 * 交出协议，形状对、顺序对，只是还没有 candidate 那套。**不假装它已经是完整的 O3。**
 */
export const ECHO_AGENT: ExtensionDefinition<{ runtime: AgentRuntime }> = defineExtension<{ runtime: AgentRuntime }>({
  name: "echo:agent",
  hostAbiVersion: 1,
  provide: [AgentRuntimeService as ServiceKey<unknown>],
  inject: { prompt: { service: AgentPrompt, required: true } },
  // `agent`：换代要在 run 之间——不能在轮中途把壳脚下的 Runtime 抽走
  reload: "agent",
  config: (input: unknown): { runtime: AgentRuntime } => {
    const runtime = (input as { runtime?: unknown } | undefined)?.runtime;
    if (typeof runtime !== "object" || runtime === null) throw new Error("echo:agent 的 config 必须是 { runtime: AgentRuntime }");
    return { runtime: runtime as AgentRuntime };
  },
  apply(ctx, config) {
    ctx.provide(AgentRuntimeService, config.runtime);
    // core 自己拥有的 prompt 事实：环境段 + 内建变量（workspace / model / provider）。
    // 走同一个 registry——core 对自己没有特权通道。
    const prompt = ctx.get(AgentPrompt);
    void ctx.effect({
      boundary: "turn",
      start: () =>
        registerAll([
          ...builtinVariables().map(([name, provider]) => () => prompt.variable(name, provider)),
          () => prompt.section(environmentSection()),
        ]),
    });
  },
});

/**
 * 把一个 Agent 收窄成 `AgentRuntime`。
 *
 * **是收窄不是转发**：协议里没有 `start`/`stop`/`deliver`/`consumeInbox`/`pauseManagedWork`——
 * 壳子拿不到它们（理由见 `runtime.ts` 文件头那张表）。这一层的存在就是为了让
 * 「壳能碰什么」由协议说了算，而不是「Agent 上有什么壳就能调什么」。
 */
export function agentRuntimeOf(agent: RuntimeSource): AgentRuntime {
  /** 装备操作的统一包法：守卫抛什么（正在运行 / 形状不合格）就把原因原样带出去，**不抛不静默**。 */
  const equip = (change: () => void): Promise<EquipResult> => {
    try {
      change();
      return Promise.resolve({ kind: "accepted" });
    } catch (e) {
      return Promise.resolve({ kind: "rejected", reason: errText(e) });
    }
  };
  return {
    get state() {
      return agent.state;
    },
    subscribe: (l) => agent.subscribe(l),
    subscribeLifecycle: (l) => agent.subscribeLifecycle(l),
    prompt: async (input, images) => agent.prompt(input, images),
    steer: (m) => agent.steer(m),
    followUp: (m) => agent.followUp(m),
    answerPermission: (a) => agent.answerPermission(a),
    get pendingPermissions() {
      return agent.pendingPermissions;
    },
    answerQuestion: (a) => agent.answerQuestion(a),
    get pendingQuestions() {
      return agent.pendingQuestions;
    },
    abort: (reason) => agent.abort(reason),
    // 换装备（P3a）：机制在 Agent 的装备 setter 与 reset() 上，这里只是接口到协议的映射
    setModel: (model) =>
      equip(() => {
        agent.model = model;
      }),
    setThinkingLevel: (level) =>
      equip(() => {
        agent.thinkingLevel = level;
      }),
    reset: () => equip(() => agent.reset()),
    compact: (instructions) => agent.compact(instructions),
    // 切工作目录：Agent 只拒空串 / 入账失败，这里把抛出的原因带出去
    setWorkspace: async (workspace) => {
      try {
        await agent.setWorkspace(workspace);
        return { kind: "accepted" };
      } catch (e) {
        return { kind: "rejected", reason: errText(e) };
      }
    },
    get acceptsWork() {
      return agent.acceptsWork;
    },
  };
}

/** `agentRuntimeOf` 要用到的那部分 Agent。**不收整个 Agent 类**——收窄从这里就开始。 */
export type RuntimeSource = Pick<
  AgentRuntime,
  | "state"
  | "subscribe"
  | "subscribeLifecycle"
  | "steer"
  | "followUp"
  | "answerPermission"
  | "pendingPermissions"
  | "answerQuestion"
  | "pendingQuestions"
  | "abort"
  | "acceptsWork"
> & {
  prompt(input: string | AgentMessage | AgentMessage[], images?: ImageBlock[]): Promise<{ outcome: AgentOutcome }>;
  /** 装备面（P3a）：Agent 的 get/set 属性对与 `reset()`。守 idle 的抛在 Agent 里，`equip()` 只做映射。 */
  model: Model;
  thinkingLevel: ThinkingLevel;
  reset(): void;
  /** 手动压缩：Agent 自己不抛、返回结果（忙 / 没阶段都是 rejected），这里只转发。 */
  compact(instructions?: string): Promise<CompactResult>;
  /** 切工作目录（worktree 隔离）：跑着也能换，抛只在空串 / 入账失败。 */
  setWorkspace(workspace: string): Promise<void>;
};
