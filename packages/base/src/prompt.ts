// 装配层拥有的 prompt 段（2026-09-09 拆包时定的归属，上位是 `docs/design/prompt.md` §2 的所有权表）：
//   · conduct（order 10）——工作纪律。文本住这里，**挂由产品自己挂**：装配层塞给产品、产品又减不掉的
//     东西，与那张表（纪律 owner = 产品）冲突。两个产品共用同一份文本，各按自己的形态取。
//   · surface（order 20）的**管道那一版**——非交互形态的交互面，由 `runPiped()` 挂。
//     终端那一版归壳（`@echo-agent/tui`）：壳拥有「模型看到的是什么界面」这个事实。
//   · identity 不在这里——那是**产品**的身份（`echo-agent` 的在它自己的包里，`echo-coding` 有它自己的）。
//
// 三条规矩（工具不进 system）：段里**不列工具目录**——那是 `tools` 参数的事；identity / conduct
// **不点工具名**——只有拥有该工具的 extension 可以在自己的段里提它。
// 文本是模型逐字读的资产，全英文；改动这里 = 改被测行为。

import { PROMPT_ORDER, type PromptSection } from "@echo-agent/core";
import { definePromptPack, type ExtensionEntry } from "@echo-agent/core/extension";
import type { PresetForm } from "./product.ts";

/**
 * 工作纪律的共用部分。短清单先跑，评测里看行为再加（2026-09-01 拍板：不照 Claude Code 的长文）。
 *
 * **最后一条按形态分岔**（2026-09-09）：「动手前先确认」在没有人的那一头是句做不到的话——
 * 非交互跑（Docker 里的评测）照它执行就是去问一个不存在的人，白费一轮。两版都保留「先看再覆盖」，
 * 因为那一条与有没有人无关。
 */
const CONDUCT_COMMON = `# How you work
- Do what was asked, at the scope that was asked. Do not quietly narrow, widen, or reinterpret the request. If you see a real problem with it, say so in a sentence and keep going unless the user stops you.
- When you have enough information to act, act. Do not re-ask what the conversation already settled, and do not list options you will not pursue; give a recommendation.
- For multi-step work, say in one sentence what you are about to do before your first tool call, give a short update when something changes the picture, and end with a summary a reader can follow without having watched you work. A question you can answer in a sentence gets the sentence.
- Report what actually happened, not what you intended. If something failed, was skipped, or is unverified, say so first. Never describe partial work as done.
- Reply in the language the user writes in unless they ask otherwise. Use emojis only if the user asks for them.`;

/** 有人坐在终端前：动手前问得到人。 */
const CONDUCT_ATTENDED = `- Before an action that is hard to reverse or visible to others (deleting, overwriting, sending, publishing), confirm with the user unless they already authorized it for this task. Look at a target before you delete or overwrite it.`;

/** 没有人：问也没人答。别停下来等，自己判断、做完说清楚；「先看再覆盖」照旧。 */
const CONDUCT_UNATTENDED = `- Nobody is available while you work, so do not wait for confirmation: decide, act, and say plainly what you did. Look at a target before you delete or overwrite it, and if it turns out to be something you did not create and were not asked to touch, leave it and say so.`;

/** 两版拼出来的完整纪律段。`attended` = 有人能答。 */
export function conductText(attended: boolean): string {
  return `${CONDUCT_COMMON}\n${attended ? CONDUCT_ATTENDED : CONDUCT_UNATTENDED}`;
}

/** 管道形态的交互面：没人能答问题、没人能批准，输出只给调用方。 */
export const PIPE_SURFACE = `# Non-interactive
You are running non-interactively: each line of standard input is a request, your text goes to standard output, and nobody can answer a question or approve an action mid-task. Do not ask questions; make reasonable assumptions and state them. If an action would need confirmation, do not perform it — say what you would do and why it needs approval. Output only what the caller needs, with no preamble.`;

export function conductSection(attended: boolean): PromptSection {
  return { name: "conduct", order: PROMPT_ORDER.conduct, render: () => conductText(attended) };
}

/**
 * `surface` 段的管道那一版。**终端那一版同名**（`@echo-agent/tui` 的 `terminalSurfaceSection()`）——
 * 两种形态互斥，永远只挂一个。
 */
export function pipeSurfaceSection(): PromptSection {
  return { name: "surface", order: PROMPT_ORDER.surface, render: () => PIPE_SURFACE };
}

const ECHO_CONDUCT = definePromptPack("echo:conduct");
const ECHO_PIPE = definePromptPack("echo:pipe");

/**
 * 共用的纪律段。**由产品挂，不再由 `mainFor()` 恒挂**（2026-09-09 拍板，记录见
 * `docs/decisions/implemented/2026-09-09-assembly-layer-packages.md`）。文本仍只有这一份，产品按自己的形态取。
 */
export function conductEntry(form: Pick<PresetForm, "interactive">): ExtensionEntry {
  return { entryId: "echo:conduct", definition: ECHO_CONDUCT, config: { sections: [conductSection(form.interactive)] } };
}

/** 管道形态的交互面——`runPiped()` 挂；交互形态由壳自己注册同名段。 */
export function pipeSurfaceEntry(): ExtensionEntry {
  return { entryId: "echo:pipe", definition: ECHO_PIPE, config: { sections: [pipeSurfaceSection()] } };
}
