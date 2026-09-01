// core 自己拥有的事实:环境段与内建变量。由 `echo:agent` builtin Extension 注册
// (归属规则:谁拥有数据,谁拥有它的 prompt format——这些事实归 Agent,所以归 core 的那条 extension)。

import { PROMPT_ORDER, type PromptSection, type PromptVariable } from "./types.ts";

/**
 * 环境段:workspace 与模型。字节何时变:换 session(workspace)或换模型——都是 run 之间的事。
 * **刻意没有时间戳**(2026-09-01 拍定:日期不进 prompt)——分钟级时间戳让每条重建路径的缓存必然未命中;
 * 模型需要时间用工具查(shell 的段会提醒它)。
 * 段文本自己就用变量写——机制自洽的第一个消费者。
 */
export function environmentSection(): PromptSection {
  return {
    name: "environment",
    order: PROMPT_ORDER.environment,
    render: () => "# Environment\nWorkspace: {{workspace}}\nModel: {{model}} ({{provider}})",
  };
}

/** 内建变量:全部是 AssembleContext 的投影,一个事实只写一处。 */
export function builtinVariables(): ReadonlyArray<readonly [string, PromptVariable]> {
  return [
    ["workspace", (ctx) => ctx.workspace],
    ["model", (ctx) => ctx.model.id],
    ["provider", (ctx) => ctx.model.provider],
  ];
}
