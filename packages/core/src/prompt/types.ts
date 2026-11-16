// prompt 组装的接口。设计见 docs/design/prompt.md。
//
// 架构（2026-08-05 拍定，2026-09-01 改为 extension 出段）:
//   prompt 模块定义 **PromptSection(段)** 与 **PromptVariable(变量)** 两个接口;
//   段与变量一律经 extension ABI 的 `AgentPrompt` registry 注册——内建的 `echo:*` 也不例外,
//   只是来源不同(代码字面量 / `sectionFromMarkdown` 读 md);
//   Agent 上一个装配方法(assemblePrompt)收拢:按 order 排、渲染、插值、拼接。
//   依赖方向单向:各机制 → prompt 模块;prompt 模块不认识任何机制。
//
// 段有两种载体(`PromptSection.carrier`,2026-11-16):缺省进 system;声明 `"messages"` 的段不进 system,
// 每段渲染成一条环境消息排在对话最前面。system 只放开发者写的东西;装着模型或仓库文件写的内容的段
// (项目指令、skill 目录、记忆正文)用 messages。两种段同一个注册口、同一套排序 / 插值 / 失败规则。
//
// 缓存按请求体三个载体保证(tools → system → messages,任何一处字节变,其后全失效):
//   tools    一轮内集合不变(轮边界调和)+ **投影按名排序**(注册时序天然不稳定,尤其 MCP 异步连接)
//   system   每次 run 装配一次(冻结的是时刻);段按 order 升序,变化频繁的段给大 order 沉底;空段丢弃
//   messages 最前面是 messages 载体的段(每次 run 装配一次,文本没变就是同一条);transcript 只 push;
//            每轮注入永远拼在最末尾,不进 transcript

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
 * 两种载体各排各的:system 的段按 order 拼成一条字符串,messages 的段按 order 排成几条消息。
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
  /** 项目指令文件(AGENTS.md)。改文件才变。messages 载体。 */
  instructions: 400,
  /** skill:规则段(system)与目录段(messages)。目录在池增删时变。 */
  skills: 500,
  /** 记忆:规则段(system)与正文段(messages)。正文最常变,沉底。 */
  memory: 900,
});

/**
 * 一段放在哪(2026-11-16):
 *   · `"system"`(缺省):拼进 system prompt。给开发者写的东西——身份、纪律、交互面、工具习惯、规则。
 *   · `"messages"`:不进 system。每段渲染成一条环境消息(`source` 是段名),按 order 排在对话最前面;
 *     不进 transcript、不落 session、压缩不动它。给装着模型、仓库文件或第三方写的内容的段——项目指令、skill 目录、记忆正文。
 * 封闭的两种:模型请求里放得下常驻文本的载体只有这两个(工具 schema 不是文本段)。
 */
export type PromptCarrier = "system" | "messages";

export type PromptSection = {
  /** 段名。同一 Agent 内唯一——registry 同名注册抛。内建:"environment" / "skills" / "skills-catalog" / "memory" / "memory-contents"。 */
  readonly name: string;
  /** 升序拼接;约定带见 {@link PROMPT_ORDER}。同数按注册序。 */
  readonly order: number;
  /** 这段放在哪,见 {@link PromptCarrier}。不给 = `"system"`。 */
  readonly carrier?: PromptCarrier;
  /**
   * 渲染本段(从自己闭包的数据出发)。"" = 本次不出段(空段丢弃,不留空行、不出消息)。
   * 文本原样送出;声明了 `interpolate` 的段才按 `{{name}}` 插值。
   */
  render(ctx: AssembleContext): Promise<string> | string;
  /**
   * `true` = 渲染结果按 `{{name}}` 从本次变量表插值,严格:引用了没有的变量、无值或畸形,整次装配失败。
   * 不给 = 原样,文本里的 `{{…}}` 是普通字符。只给作者有意写变量的段(环境段、产品导入的 md 段);
   * 装进第三方或模型写的文本(项目指令、记忆、skill、角色正文)的段不声明——否则一行 `${{ secrets.X }}`
   * 就让每个 run 失败。
   */
  readonly interpolate?: boolean;
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
