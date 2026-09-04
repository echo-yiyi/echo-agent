// skill 的操作方法。
//
// **这个文件里全是方法,没有 interface、没有类、没有状态**（2026-08-05 用户拍定）:
// 数据是 agent 的——`agent.skills` 是 `Map<string, Skill>`（装 **Skill 本体**,
// 不是 `SkillEntry` 包装）、`agent.activeSkills` 是 `Map<string, ActiveSkill>`。
// 这里只封装对它们的操作。
//
// **两层模型**:池（装进来的全部,可能几百个）与工作集（激活的那些,正文进 prompt）。
// 装进来只是「可用」,**不激活**——这正是渐进式披露的落点。
//
// 加载器（扫盘 + YAML + ignore）**不在 core 里**:判据是「**别人写的 skill 能不能在我们这跑起来**」,
// 兼容外部生态要真的 YAML 解析器。加载器产出 `Skill[]`,`addSkills()` 收下即可。

import type { ActiveSkill, Skill, SkillActivation, SkillCreation } from "./types.ts";
import { activeSkillCost, SKILL_ACTIVE_TOTAL_CAP } from "./compose.ts";

/** 池:装进来的全部。 */
export type SkillMap = Map<string, Skill>;
/** 工作集:激活的那些。**Map 保插入序 = 激活顺序**。 */
export type ActiveSkillMap = Map<string, ActiveSkill>;

/* ─────────────── 池 ─────────────── */

/**
 * 把加载器产出的数据装进来。**装进来只是「可用」,不激活**。
 * 撞名 fail-loud,与工具面同规矩;热重载路径必须显式 `replace: true`
 * ——否则 fs 回调里抛出就是未捕获拒绝。
 *
 * 返回的卸载器**只认对象身份**（§14.7.5 第 5 条）:某个名字若已被显式 replace 成另一个 Skill 对象,
 * 它不动那条。给了 `active` 时,卸掉的同时撤下激活（与 `removeSkill` 同规矩）。返回真卸掉的名字。
 */
export function addSkills(
  skills: SkillMap,
  list: readonly Skill[],
  opts?: { replace?: boolean; active?: ActiveSkillMap },
): () => readonly string[] {
  // **先拷一份**：`list` 与 `opts` 都是调用方的对象，注册后可以合法地改/清；卸载器只认注册那一刻的快照，
  // 否则热重载会留下旧 generation 的 orphan（实测：注册后清空 `list`，卸载器一个都不卸）。
  const registered = [...list];
  const active = opts?.active;
  if (opts?.replace !== true) {
    const clash = registered.find((s) => skills.has(s.name));
    if (clash !== undefined) throw new Error(`skill '${clash.name}' 已存在；覆盖须显式 replace:true`);
  }
  for (const s of registered) skills.set(s.name, s);
  return () =>
    registered
      .filter((s) => {
        if (skills.get(s.name) !== s) return false;
        skills.delete(s.name);
        active?.delete(s.name);
        return true;
      })
      .map((s) => s.name);
}

/** 卸一个。**若它正激活,一并撤下**——否则渲染会去找一个不存在的 skill。 */
export function removeSkill(skills: SkillMap, active: ActiveSkillMap, name: string): boolean {
  if (!skills.delete(name)) return false;
  active.delete(name);
  return true;
}

export function getSkill(skills: SkillMap, name: string): Skill | undefined {
  return skills.get(name);
}

export function listSkills(skills: SkillMap): readonly Skill[] {
  return [...skills.values()];
}

/* ─────────────── 工作集 ─────────────── */

/**
 * 激活。**不抛,返回结果**:not_found / missing_tools（带缺哪几个）。
 * 已激活再调 = ok 且更新 instructions,**不改激活顺序**。
 *
 * **不查 `modelInvocable`**——那是给模型的门（在 `skill_activate` 工具里查）,
 * 人和 hook 有权激活任何一个。
 *
 * `hasTool` 由调用方给（Agent 传 `(n) => agent.tools.has(n)`）:
 * 工具面的权威在 agent,不在某个集合的副本。
 */
export function activateSkill(
  skills: SkillMap,
  active: ActiveSkillMap,
  name: string,
  opts?: { instructions?: string; hasTool?: (name: string) => boolean },
): SkillActivation {
  const skill = skills.get(name);
  if (skill === undefined) return { ok: false, reason: "not_found" };

  const missing = skill.requiredTools.filter((t) => opts?.hasTool?.(t) !== true);
  if (missing.length > 0) return { ok: false, reason: "missing_tools", missing };

  // 总预算闸（2026-09-01）：重复激活同一个不重复计费；池里已卸掉的激活项不计（渲染时也会跳过它）
  const others = [...active.keys()].filter((n) => n !== name);
  const used = others.reduce((sum, n) => sum + activeSkillCost(skills.get(n)?.content ?? ""), 0);
  const needed = activeSkillCost(skill.content);
  if (used + needed > SKILL_ACTIVE_TOTAL_CAP) {
    return { ok: false, reason: "budget", used, needed, cap: SKILL_ACTIVE_TOTAL_CAP, active: others };
  }

  const prev = active.get(name);
  active.set(name, {
    name,
    ...(opts?.instructions !== undefined ? { instructions: opts.instructions } : {}),
    activatedAt: prev?.activatedAt ?? Date.now(), // 重复激活不改顺序,只更新 instructions
  });
  return { ok: true, skill };
}

export function deactivateSkill(active: ActiveSkillMap, name: string): boolean {
  return active.delete(name);
}

export function listActiveSkills(active: ActiveSkillMap): readonly ActiveSkill[] {
  return [...active.values()];
}

/* ─────────────── 创建 ─────────────── */

/**
 * agent 把自己学到的做法固化成一个 skill。
 *
 * **只进池,不落盘**——所以造出来的没有 `dir`,引用不了同目录文件。
 * 要真落盘,调用方在这之后自己写 SKILL.md（core 不认识文件系统）。
 */
export function createSkill(
  skills: SkillMap,
  input: { name: string; description: string; content: string },
): SkillCreation {
  if (skills.has(input.name)) return { ok: false, reason: "exists" };
  const errors = validateSkillInput(input.name, input.description);
  if (errors.length > 0) return { ok: false, reason: "invalid", message: errors.join("; ") };

  const skill: Skill = {
    name: input.name,
    description: input.description,
    // **在进池这一刻规整**，不是落盘时：loader 读回来的正文是 trim 过的，池里若留着首尾空白，
    // 重启后就静默变值。一处规整、处处一致；模型给的正文带个尾换行是常态，拒绝它太苛刻。
    content: input.content.trim(),
    files: [],
    requiredTools: [],
    modelInvocable: true,
    frontmatter: {},
  };
  skills.set(skill.name, skill);
  return { ok: true, skill };
}

/* ─────────────── 校验（纯函数,上层加载器也该用同一套） ─────────────── */

const NAME_RE = /^[a-z0-9-]+$/;
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;

/** 返回错误列表;空数组 = 合法。与磁盘加载器共用同一套规矩,免得两处判据漂移。 */
export function validateSkillInput(name: string, description: string): string[] {
  const errors: string[] = [];
  if (name.length === 0) errors.push("name must not be empty");
  else if (name.length > MAX_SKILL_NAME) errors.push(`name is longer than ${MAX_SKILL_NAME} characters (${name.length})`);
  if (!NAME_RE.test(name)) errors.push("name may only use lowercase letters, digits, and hyphens");
  if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
  if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
  if (description.trim() === "") errors.push("description is required (without it the model never thinks of using this skill)");
  // 下面三条都是**保真约束不是偏好**：skill 落盘走 frontmatter 单行值（`description: …`），
  // 读回来时会 trim 首尾空白、剥掉成对的首尾引号，换行根本进不了一行。
  // 拒绝比静默变值诚实——「落盘再读 ≠ 原值」是本仓最不能接受的那种失败。
  // loader 路径不受影响：它解析出的值天然已是这个形状。
  else if (/[\r\n]/.test(description)) errors.push("description must be a single line (it is stored as a single-line frontmatter value)");
  else if (description !== description.trim()) errors.push("description must not start or end with whitespace (it is trimmed when read back)");
  else if (/^(["']).*\1$/.test(description)) errors.push("description must not be wrapped in matching quotes (they are stripped when read back)");
  else if (description.length > MAX_SKILL_DESCRIPTION)
    errors.push(`description is longer than ${MAX_SKILL_DESCRIPTION} characters (${description.length})`);
  return errors;
}
