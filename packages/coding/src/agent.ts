// `codingPreset()`：**一份配置，不是一个装配现场**（2026-08-31 用户拍板）。
//
// ## 它替掉了什么
//
// 原先这里是 `createCodingAgent()`：自己造 Models、自己 `new Agent()`、自己造 ExtensionHost、
// 自己 mount 两代、自己 `loadTasks`、自己实现一套与 `Echo.stop()` 同形的收摊。
// 那就是**第二个 composition root**——而这一路刚立的规矩是「装配只有一处」。
// 更要命的是它会分家：`createEcho()` 后来补的每一条（inline 工具转 Extension、
// 清单与真相相等、失败路径逆序卸载），这边都得再补一遍，漏一条就是两种行为。
//
// 现在这里只出**数据**：权限策略、三条 Extension 的 Entry（产品的 prompt 段也在其中）。
// 装配归 `createEcho()`，一处。
//
// ```ts
// const echo = await createEcho({
//   provider: kimiProvider(),
//   workspace: root,          // session 级事实，宿主给（2026-09-01）
//   ...codingPreset(),
// });
// await echo.agent.start();
// ```
//
// system prompt（2026-09-01）：不再有 `systemPrompt` 字符串。产品的身份与编码纪律是 `echo:coding`
// 这条 prompt pack 的两段；文件 / shell 工具的习惯段随 `echo:workspace` / `echo:shell` 走
// （文本都在 `prompt.ts`）。工具目录不进 system。

import { DEFAULT_MAX_ITERATIONS, type AssembleContext } from "@echo-agent/core"; // 执行预算的唯一出处(identity 读它)
import { definePromptPack, type ExtensionEntry } from "@echo-agent/core/extension";
import type { PermissionPolicy as CorePermissionPolicy, PromptSection, Skill } from "@echo-agent/core";
import { makeBashTool, makeShellTools } from "./tools/bash.ts";
import { makeFsTools } from "./tools/fs.ts";
import { makeSearchTools } from "./tools/search.ts";
import { ECHO_SHELL, ECHO_WORKSPACE } from "./extensions.ts";
import { permissionPolicyFor, type PermissionPolicy } from "./permission.ts";
import { codingConductSection, codingIdentitySection, shellToolsSection, workspaceToolsSection } from "./prompt.ts";

export type CodingPresetOptions = {
  /** 权限策略;false = 全放行(评测/CI)。缺省「读随便,动手先问」——没配裁决人时动手会被拒。 */
  permission?: PermissionPolicy | false;
  /**
   * 已经扫好的 skill。**本函数不扫盘**——它是同步的一份配置，读盘是调用方的事
   * （`loadSkills()` 在 core 公共面上）。评测传空就是「不加载仓库 skill」。
   */
  skills?: Skill[];
  maxIterations?: number;
};

/**
 * 交给 `createEcho()` 的配置片段：`...codingPreset()` 展开即可。
 *
 * 形状对着 `CreateEchoOptions` 的两个字段，故意不多包一层——多一层就得跟着
 * `createEcho` 的入参演进，而那正是上一版「两处各写一遍」的病根。
 */
export type CodingPreset = {
  agent: {
    permission?: CorePermissionPolicy;
    // `Skill[]` 而不是 `readonly Skill[]`：形状跟着 `AgentOptions` 走，
    // 自己另定一份「更严格」的类型只会在 spread 进 `createEcho()` 时打架。
    skills?: Skill[];
    maxIterations?: number;
  };
  extensions: readonly ExtensionEntry[];
};

/** 缺省模型的**唯一**出处:identity 与调用方都读它,不各手抄一份(review 五轮 #3)。 */
export const CODING_DEFAULT_MODEL = { provider: "kimi", model: "kimi-k3" } as const;

/** 产品的身份 + 编码纪律，一条 prompt pack。 */
const ECHO_CODING_PROMPT = definePromptPack("echo:coding");

/**
 * core 的 `echo:*` builtin 装上来的工具。产品层管不到它们,但它们同样决定被测行为,必须进 digest。
 *
 * **2026-08-31 从 4 件变成 9 件**：装配从低层 `new Agent()` 换成 `createEcho()` 之后,
 * 这个 agent 拿到的是**完整 Runtime**——按状态根装了 skillStore 与 schedule,
 * 于是 `echo:skills` / `echo:scheduler` 两条 builtin 有工具可注册。
 * 原先那个窄工具集是低层装配的副产品,不是设计意图。
 * 用户 2026-08-31 拍板接受这个变化（被测行为与 digest 都会变，不为它保留第二条装配路径）。
 *
 * **这里手写的名字由 `test/identity.test.ts` 的「与真 agent 工具集完全相等」断言守着**——
 * core 增删任何一件 builtin 工具,该测试立刻红,不会静默漂移。
 */
const AGENT_BUILTIN_TOOLS = [
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "schedule_cancel",
  "schedule_create",
  "schedule_list",
  "skill_activate",
  "skill_create",
  "transcript_read",
  // **会话面（`session_*`）不在这里**：挂不挂它是**容器**的决定（`CreateEchoOptions.sessions`），
  // 不是产品身份。cli 开着它，所以真跑起来的 echo-coding 会多三件；而这份 digest 描述的是
  // 「这个产品自己带什么」——把容器的选择写进产品身份，换个宿主就对不上了。
] as const;

/** 产品自己出的四段（identity / conduct:coding / tool:workspace / tool:shell），按 order 排。 */
function productSections(): PromptSection[] {
  return [codingIdentitySection(), codingConductSection(), workspaceToolsSection(), shellToolsSection()].sort((a, b) => a.order - b.order);
}

/** digest 用的固定装配上下文：产品四段都不引用变量，所以值无关紧要，只求确定。 */
const DIGEST_CONTEXT: AssembleContext = {
  workspace: "/workspace",
  model: { provider: CODING_DEFAULT_MODEL.provider, id: CODING_DEFAULT_MODEL.model },
  agentId: "default",
  sessionId: null,
};

/** 本 preset 的**行为身份快照**:把真正决定行为的东西一次性固定下来——产品自己出的 prompt 段逐字、缺省模型、
 *  执行预算、**完整**工具集(产品层三件套 + Agent 构造期自带)。它是可复现的 digest 材料:
 *  改任一段文本 / 换缺省模型 / 增删任一工具都会改 digest,两次结果一比就能判出静默漂移。
 *
 *  **不在公共面**(不从 `index.ts` 导出):本仓没有生产消费者,它现在只给 `test/identity.test.ts`
 *  当判据——手写的清单必须等于真装出来的工具集。 */
export function codingAgentIdentity(): {
  sections: readonly { name: string; order: number; text: string }[];
  defaultModel: string;
  maxIterations: number;
  toolNames: readonly string[];
} {
  return {
    sections: productSections().map((s) => {
      const text = s.render(DIGEST_CONTEXT);
      // 产品段都是字面量，同步返回；真变成异步了就是有人把读盘之类塞进了段——那不该属于 identity
      if (typeof text !== "string") throw new Error(`prompt 段 '${s.name}' 的 render 不是同步的，不能进 digest`);
      return { name: s.name, order: s.order, text };
    }),
    defaultModel: `${CODING_DEFAULT_MODEL.provider}/${CODING_DEFAULT_MODEL.model}`,
    // 执行预算也决定成绩(review 六轮 P1):**读 core 的常量,不手抄**——core 改默认值,digest 跟着变
    maxIterations: DEFAULT_MAX_ITERATIONS,
    // shell 一组也从工厂取名（bash / job_output / job_stop）：`echo:shell` 注册的就是这份，不手写
    toolNames: [...makeFsTools(), ...makeSearchTools(), ...makeShellTools()]
      .map((t) => t.name)
      .concat(...AGENT_BUILTIN_TOOLS)
      .sort(),
  };
}

export function codingPreset(opts: CodingPresetOptions = {}): CodingPreset {
  return {
    agent: {
      ...(opts.permission !== false ? { permission: permissionPolicyFor(opts.permission) } : {}),
      ...(opts.skills !== undefined && opts.skills.length > 0 ? { skills: opts.skills } : {}),
      ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    },
    extensions: [
      // 产品的身份与编码纪律
      { entryId: "echo:coding", definition: ECHO_CODING_PROMPT as never, config: { sections: [codingIdentitySection(), codingConductSection()] } },
      // fs / search 的工具是纯函数造出来的，可以在装配前就备好 → 走 `defineToolPack` 的 config；
      // 它们的跨调用习惯段跟工具同一个 config 进来：工具卸了段也走
      {
        entryId: "echo:workspace",
        definition: ECHO_WORKSPACE as never,
        config: { tools: [...makeFsTools(), ...makeSearchTools()], sections: [workspaceToolsSection()] },
      },
      // bash 不行：它要 `agent.background`。所以 `echo:shell` 自己 inject 那条能力端口并在 apply 里
      // 注册工具与段，这里只列 definition、不给 config（见 `extensions.ts` 的注释）。
      { entryId: "echo:shell", definition: ECHO_SHELL as never },
    ],
  };
}

/** `bash` 单独造一把（不经 Extension）。给「自己给端口、自己注册」的低层 `new Agent()` 用。 */
export { makeBashTool };
