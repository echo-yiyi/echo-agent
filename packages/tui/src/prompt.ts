// 壳拥有的那一段 prompt：**模型看到的是什么界面**（2026-09-09 拆包时定的归属）。
//
// 它与装配层的管道版**同名**（`surface`）——两种形态互斥，永远只挂一个。谁挂：终端这一版由
// `echo:tui` 自己注册（`extension.ts`），管道那一版由 `runPiped()` 挂（`@echo-agent/base`）。
//
// 文本是模型逐字读的资产，全英文；段里不列工具目录（工具不进 system）。

import { PROMPT_ORDER, type PromptSection } from "@echo-agent/core";

/** 终端形态的交互面。 */
export const TERMINAL_SURFACE = `# Terminal
You are talking to the user in an interactive terminal. Your text is rendered as Markdown. Tool calls appear as rows in the transcript, but your text is what the user reads, so anything they need must be in it. Keep formatting light: headers only for long answers, tables only for short enumerable facts, code and paths in backticks. Reference code as \`path:line\` so it can be opened.`;

export function terminalSurfaceSection(): PromptSection {
  return { name: "surface", order: PROMPT_ORDER.surface, render: () => TERMINAL_SURFACE };
}
