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
// 现在这里只出**数据**：系统 prompt、权限策略、两条 Extension 的 Entry。
// 装配归 `createEcho()`，一处。
//
// ```ts
// const echo = await createEcho({
//   provider: kimiProvider(),
//   ...codingPreset({ workspaceRoot: root }),
// });
// await echo.agent.start();
// ```
//
// ⚠️ CODING_SYSTEM 是模型逐字读的 prompt 资产,临时措辞,定稿归 prompt 治理。

import { DEFAULT_MAX_ITERATIONS } from "@echo-agent/core"; // 执行预算的唯一出处(identity 读它)
import type { ExtensionEntry } from "@echo-agent/core/extension";
import type { PermissionPolicy as CorePermissionPolicy, Skill } from "@echo-agent/core";
import { makeBashTool } from "./tools/bash.ts";
import { makeFsTools } from "./tools/fs.ts";
import { makeSearchTools } from "./tools/search.ts";
import { ECHO_SHELL, ECHO_WORKSPACE } from "./extensions.ts";
import { permissionPolicyFor, type PermissionPolicy } from "./permission.ts";

const CODING_SYSTEM = `你是一个 coding agent,在用户的代码仓里干活。

工作方式:
- 动手前先看:read_file / glob / grep 把相关代码读明白,不盲改。
- 多步任务先用 TaskCreate 列清单,做一步标一步——清单跨上下文存活,是你唯一可靠的进度记忆。
- 改动用 edit_file 精确替换;跑 bash 验证(测试、typecheck)之后才算做完。
- 诚实汇报:测试红就说红,没做完就说没做完。绝不谎称通过。`;

export type CodingPresetOptions = {
  /** 工作区根目录。所有文件操作被限制在它之内。 */
  workspaceRoot: string;
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
 * 交给 `createEcho()` 的配置片段：`...codingPreset({ workspaceRoot })` 展开即可。
 *
 * 形状对着 `CreateEchoOptions` 的两个字段，故意不多包一层——多一层就得跟着
 * `createEcho` 的入参演进，而那正是上一版「两处各写一遍」的病根。
 */
export type CodingPreset = {
  agent: {
    systemPrompt: string;
    workspaceRoot: string;
    cwd: string;
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
] as const;

/** 本 preset 的**行为身份快照**:把真正决定行为的东西一次性固定下来——系统 prompt 逐字、缺省模型、
 *  执行预算、**完整**工具集(产品层三件套 + Agent 构造期自带)。它是可复现的 digest 材料:
 *  改 prompt / 换缺省模型 / 增删任一工具都会改 digest,两次结果一比就能判出静默漂移。
 *
 *  **不在公共面**(不从 `index.ts` 导出):本仓没有生产消费者,它现在只给 `test/identity.test.ts`
 *  当判据——手写的清单必须等于真装出来的工具集。 */
export function codingAgentIdentity(): {
  systemPrompt: string;
  defaultModel: string;
  maxIterations: number;
  toolNames: readonly string[];
} {
  return {
    systemPrompt: CODING_SYSTEM,
    defaultModel: `${CODING_DEFAULT_MODEL.provider}/${CODING_DEFAULT_MODEL.model}`,
    // 执行预算也决定成绩(review 六轮 P1):**读 core 的常量,不手抄**——core 改默认值,digest 跟着变
    maxIterations: DEFAULT_MAX_ITERATIONS,
    toolNames: [...makeFsTools(), ...makeSearchTools()]
      .map((t) => t.name)
      .concat("bash", ...AGENT_BUILTIN_TOOLS)
      .sort(),
  };
}

export function codingPreset(opts: CodingPresetOptions): CodingPreset {
  const root = opts.workspaceRoot;
  return {
    agent: {
      systemPrompt: CODING_SYSTEM,
      workspaceRoot: root,
      cwd: root,
      ...(opts.permission !== false ? { permission: permissionPolicyFor(opts.permission) } : {}),
      ...(opts.skills !== undefined && opts.skills.length > 0 ? { skills: opts.skills } : {}),
      ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    },
    extensions: [
      // fs / search 的工具是纯函数造出来的，可以在装配前就备好 → 走 `defineToolPack` 的 config。
      { entryId: "echo:workspace", definition: ECHO_WORKSPACE as never, config: { tools: [...makeFsTools(), ...makeSearchTools()] } },
      // bash 不行：它要 `agent.background`。所以 `echo:shell` 自己 inject 那条能力端口，
      // 这里只列 definition、不给 config（见 `extensions.ts` 的注释）。
      { entryId: "echo:shell", definition: ECHO_SHELL as never },
    ],
  };
}

/** `bash` 单独造一把（不经 Extension）。给「自己给端口、自己注册」的低层 `new Agent()` 用。 */
export { makeBashTool };
