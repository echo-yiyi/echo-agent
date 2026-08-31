// 无属主模块的两个内建段:identity 与 environment,格式归 prompt 模块。
// (skill 的段在 SkillHarness.promptSections、memory 的在 MemoryHarness.promptSections——
//  归属规则:谁拥有数据,谁拥有它的 prompt format。)

import type { PromptSection } from "./types.ts";

/**
 * 身份段:产品端的 base(装备 systemPrompt)原样放最前。
 * 字节何时变:产品改装备时(仅 idle)——run 之间几乎恒定。
 */
export function identitySection(base: () => string | null): PromptSection {
  return {
    name: "identity",
    tier: "stable",
    render: () => base() ?? "",
  };
}

/**
 * 环境段:工作目录。
 * 字节何时变:换 workspace 时。**刻意没有时间戳**——分钟级时间戳让每条重建路径的缓存
 * 必然未命中;模型需要时间用工具查,产品真要可以自己加一段(volatile)。
 */
export function environmentSection(env: () => { workspaceRoot: string; cwd: string }): PromptSection {
  return {
    name: "environment",
    tier: "stable",
    render: () => {
      const { workspaceRoot, cwd } = env();
      return `# 环境\n工作目录:${workspaceRoot}${cwd !== workspaceRoot ? `\n当前目录:${cwd}` : ""}`;
    },
  };
}
