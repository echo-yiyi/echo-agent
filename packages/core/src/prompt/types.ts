// prompt 组装的两个 interface。设计见 docs/design/parts/prompt.md。
//
// 架构(2026-08-05 用户拍定):
//   prompt 模块定义 **PromptSection(段)** 与 **PromptSource(组装来源)** 两个 interface;
//   ToolHarness / SkillHarness / MemoryHarness 各自实现 PromptSource——
//   谁拥有数据,谁拥有它的 prompt format,渲染从自己的数据出发,闭包自持,不需要公共 ctx;
//   Agent 上一个组装方法(assemblePrompt)把所有来源收拢。
//   依赖方向单向:harness 模块 → prompt 模块;prompt 模块不认识任何机制。
//
// 缓存按请求体三个载体保证(tools → system → messages,任何一处字节变,其后全失效):
//   tools    一轮内集合不变(轮边界调和)+ **投影按名排序**(注册时序天然不稳定,尤其 MCP 异步连接)
//   system   每次 run 装配一次(冻结的是时刻);段按变化频率排序,volatile 沉底;空段丢弃
//   messages transcript 只 push;每轮注入永远拼在最末尾,不进 transcript

import type { AgentMessage, ToolSchema } from "../messages.ts";

export type PromptTier = "stable" | "volatile";

export type PromptSection = {
  /** 段名。内建:"identity" / "environment" / "skills" / "memory"。 */
  readonly name: string;
  /**
   * 变化频率分层,排序依据(stable 在前,volatile 沉底)。判据:这段的字节在
   * **多次 run 之间**多久变一次。放错层没有机制拦,只会表现为缓存命中率下降——
   * 所以每个段的实现旁边都要写「字节什么时候会变」。
   */
  readonly tier: PromptTier;
  /** 渲染本段(从自己闭包的数据出发)。"" = 本次不出段(空段丢弃,不留空行)。 */
  render(): Promise<string> | string;
};

/**
 * 组装来源:能给「模型看到的固定前缀」供货的东西。三个方法都可选,实现者按自己有什么给什么。
 * 取用节奏各不相同,由 Agent 控制:
 *   promptSections —— 每次 **run** 取一次并渲染(冻结快照);
 *   turnInjections —— 每 **轮** 取(run 中途会变的内容,拼消息末尾、不进 transcript);
 *   toolSchemas    —— 每 **轮** 取(tools 参数的确定性投影)。
 */
export interface PromptSource {
  promptSections?(): readonly PromptSection[];
  turnInjections?(): readonly AgentMessage[];
  toolSchemas?(): readonly ToolSchema[];
}
