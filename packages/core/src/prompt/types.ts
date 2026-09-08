// prompt 组装的接口。设计见 docs/design/prompt.md。
//
// 架构（2026-08-05 拍定，2026-09-01 改为 extension 出段）:
//   prompt 模块定义 **PromptSection(段)** 与 **PromptVariable(变量)** 两个接口;
//   段与变量一律经 extension ABI 的 `AgentPrompt` registry 注册——内建的 `echo:*` 也不例外,
//   只是来源不同(代码字面量 / `sectionFromMarkdown` 读 md);
//   Agent 上一个装配方法(assemblePrompt)收拢:按 order 排、渲染、插值、拼接。
//   依赖方向单向:各机制 → prompt 模块;prompt 模块不认识任何机制。
//
// 缓存按请求体三个载体保证(tools → system → messages,任何一处字节变,其后全失效):
//   tools    一轮内集合不变(轮边界调和)+ **投影按名排序**(注册时序天然不稳定,尤其 MCP 异步连接)
//   system   每次 run 装配一次(冻结的是时刻);段按 order 升序,变化频繁的段给大 order 沉底;空段丢弃
//   messages transcript 只 push;每轮注入永远拼在最末尾,不进 transcript

import type { AgentMessage } from "../messages.ts";

/**
 * 一次装配的上下文:装配那一刻 Agent 的事实,只读。段的 `render` 与变量 provider 都拿它。
 * 只放**事实**,不放机制对象——段要机制数据(skill 池、记忆)靠自己的闭包,不靠这里。
 */
export type AssembleContext = Readonly<{
  /** session 的工作目录:文件工具的边界与起点。宿主给的绝对路径,core 不解释它。 */
  workspace: string;
  /** 本次 run 冻结的模型(admission 时定的 binding)。 */
  model: Readonly<{ provider: string; id: string }>;
  agentId: string;
  /** 当前 session;null = 未持久化的临时对话。 */
  sessionId: string | null;
}>;

/**
 * 段的 order 约定带(按**变化频率**排,不是按重要性):越稳定越靠前,前缀缓存命中越多。
 * 这是约定不是闭集——extension 可以用任何数;同数按注册序打平。
 */
export const PROMPT_ORDER = Object.freeze({
  /** 产品身份,永远第一段。 */
  identity: 0,
  /** 工作纪律(通用 10、产品专属 11…)。 */
  conduct: 10,
  /** 交互面:终端 / 管道 / 将来的 Web。 */
  surface: 20,
  /** 工具的跨调用习惯:100–199,拥有该工具的 extension 出。 */
  tools: 100,
  /** 事实:workspace、模型。换 session 才变。 */
  environment: 300,
  /** 项目指令文件(AGENTS.md)。改文件才变。 */
  instructions: 400,
  /** skill 目录。池增删才变。 */
  skills: 500,
  /** 记忆。最常变,沉底。 */
  memory: 900,
});

export type PromptSection = {
  /** 段名。同一 Agent 内唯一——registry 同名注册抛。内建:"environment" / "skills" / "memory"。 */
  readonly name: string;
  /** 升序拼接;约定带见 {@link PROMPT_ORDER}。同数按注册序。 */
  readonly order: number;
  /**
   * 渲染本段(从自己闭包的数据出发)。"" = 本次不出段(空段丢弃,不留空行)。
   * 文本可含 `{{name}}`,装配时从本次变量表取值——严格:引用了没有的变量,整次装配失败。
   */
  render(ctx: AssembleContext): Promise<string> | string;
};

/**
 * `{{name}}` 的取值函数。返回 `undefined` = 本次无值——引用它的段会让装配失败,
 * 所以「可选事实」要么别注册,要么由段自己判断再引用。名字只能是 `[a-z][a-z0-9_]*`。
 */
export type PromptVariable = (ctx: AssembleContext) => string | undefined;

/** 变量名合法形状:段文本里 `{{` 与 `}}` 之间写的样子。 */
export const PROMPT_VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * 每轮注入的来源(Agent 内部用):run 中途会变的内容,拼在消息末尾、不进 transcript。
 * system 段不再从这里供货——那是 `AgentPrompt` registry 的事。
 */
export interface PromptSource {
  turnInjections?(): readonly AgentMessage[];
}
