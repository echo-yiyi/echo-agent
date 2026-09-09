// `echo-agent` 这个**产品**自己的身份段（order 0）。
//
// 2026-09-09 拆包之后这里只剩身份：工作纪律的文本归装配层（`@echo-agent/base` 的 `prompt.ts`，
// 两个产品共用同一份、各自显式挂），交互面归壳（终端那版在 `@echo-agent/tui`）。
// `echo-coding` 有它自己的身份段，不用这一份。
//
// 规矩：身份里**不点工具名、不列工具目录**——能做什么由本次 session 装了什么工具决定。
// 文本是模型逐字读的资产，全英文；改动这里 = 改被测行为。

import { PROMPT_ORDER, type PromptSection } from "@echo-agent/core";
import { definePromptPack, type ExtensionEntry } from "@echo-agent/core/extension";

/** 通用 agent 的身份。它能做什么由本次 session 装了什么工具决定，所以身份里不许诺任何能力。 */
export const ECHO_AGENT_IDENTITY =
  "You are Echo, a general-purpose agent running in the user's terminal. You work for one user across many sessions. " +
  "What you can do in a session is defined by the tools you are given; do not claim to have done anything a tool did not do.";

export function identitySection(): PromptSection {
  return { name: "identity", order: PROMPT_ORDER.identity, render: () => ECHO_AGENT_IDENTITY };
}

const ECHO_IDENTITY = definePromptPack("echo:identity");

/** `echo-agent` 产品的身份段——挂在 `ECHO_AGENT.preset` 里。 */
export function identityEntry(): ExtensionEntry {
  return { entryId: "echo:identity", definition: ECHO_IDENTITY, config: { sections: [identitySection()] } };
}
