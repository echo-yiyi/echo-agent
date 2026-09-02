// skill 的 prompt format——**归属规则:谁拥有数据,谁拥有它的 prompt format**。
// 目录行怎么写、激活正文的起止标记,都是 skill 模块的资产;prompt 模块只管把段拼起来。
// 消毒原语从 prompt/sanitize.ts 同源消费(公共防线,不自持第二份)。

import { environmentMessage, type AgentMessage } from "../messages.ts";
import { fenceSafe, singleLine, truncateMarked } from "../prompt/sanitize.ts";
import type { ActiveSkillMap, SkillMap } from "./harness.ts";
import type { ActiveSkill } from "./types.ts";

/** 目录预算:描述单条 1024、目录总量 8000;正文注入单条 16000。 */
export const SKILL_CATALOG_CAPS = { descriptionMax: 1024, catalogTotal: 8000 } as const;
export const SKILL_BODY_CAP = 16_000;
/**
 * 激活集合的**总**预算（2026-09-01）：所有激活 skill 的正文（各自按 SKILL_BODY_CAP 截后）合计上限。
 * 单条上限管不住「模型连续激活 100 个」——每轮注入无界、后续请求持续超 context window（review 实测 1.6M 字符）。
 * 闸在**激活时**（`activateSkill`），拒绝并告诉模型现状；不在渲染末端静默截掉已声明激活的指令。
 */
export const SKILL_ACTIVE_TOTAL_CAP = 64_000;

/** 一个 skill 激活后占多少预算：正文按单条上限截后的长度（与渲染时一致）。 */
export function activeSkillCost(content: string): number {
  return Math.min(content.length, SKILL_BODY_CAP);
}

/**
 * 目录(通道 A,进 system):池里 modelInvocable 的每个一行「- 名字:描述」。
 * 描述是第三方 SKILL.md 里的任意文本——单行化 + 截断,一行数据不许伪装成多段 system。
 * 字节何时变:池增删时;**激活/停用不影响本段**(那是通道 B 的事),激活不打 system 缓存。
 * "" = 池里没有可列的。门控(工具在不在)不在这里——那是装配现场的知识,归段(prompt/sections.ts)。
 */
export function renderSkillCatalog(skills: SkillMap): string {
  const list = [...skills.values()].filter((s) => s.modelInvocable);
  if (list.length === 0) return "";
  const lines: string[] = [];
  let budget = SKILL_CATALOG_CAPS.catalogTotal;
  for (const s of list) {
    const line = `- ${s.name}: ${truncateMarked(singleLine(s.description), SKILL_CATALOG_CAPS.descriptionMax)}`;
    if (budget - line.length < 0 && lines.length > 0) break;
    budget -= line.length;
    lines.push(line);
  }
  return `# Skills\nSkills are packaged instructions for specific kinds of work. When a task matches one of these descriptions, activate it with skill_activate before starting; its full instructions then appear in your context.\n${lines.join("\n")}`;
}

/**
 * 激活正文(通道 B,每轮注入):每个激活的 skill 一条 environment 消息,
 * 拼在本轮消息末尾、**不进 transcript**。生命周期零状态,全是「每轮从工作集现算」的结果:
 * 激活 → 下一轮出现;工作集不变 → 每轮都在;停用 → 下一轮消失。
 * 缓存:注入在消息最末尾,真实对话前缀字节不动。
 * 消毒:正文与 instructions 都是第三方 / 模型可控文本——正文中和反引号 + 截断,
 * instructions 单行化(它被行内嵌进标记行)。
 */
export function renderSkillInjections(skills: SkillMap, active: ActiveSkillMap): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const a of active.values()) {
    const skill = skills.get(a.name);
    if (skill === undefined) continue; // 池里已被卸掉:与工作集的短暂错位,轮边界会调和
    out.push(environmentMessage(renderOneSkill(a, skill.content), "skill", a.name, 0));
  }
  return out;
}

function renderOneSkill(active: ActiveSkill, content: string): string {
  const head = `# Skill: ${active.name} (instructions begin)`;
  const tail = `# Skill: ${active.name} (instructions end)`;
  const body = truncateMarked(fenceSafe(content), SKILL_BODY_CAP);
  const ask =
    active.instructions !== undefined && active.instructions !== ""
      ? `\nFor this task: ${truncateMarked(singleLine(active.instructions), 500)}`
      : "";
  return `${head}\n${body}${ask}\n${tail}`;
}
