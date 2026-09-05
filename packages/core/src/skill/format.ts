// skill 的**文本格式**：Skill ↔ `SKILL.md`（frontmatter + 正文）。**纯函数，不碰 fs**——
// `Agent` 从 `skillStore` 字节面恢复与落盘时用它，`loader.ts`（扫盘，拖 `node:`）
// 也用同一套，两边判据不漂移。
//
// 格式是生态的（Claude Code / pi 的目录式 skill：`<name>/SKILL.md`），不是自造的：
// `skill_create` 落盘的东西人能读、外部 loader 也认。
//
// **保真是契约**：`serializeSkill` 写出去的，`parseSkillText` 读回来必须逐字相等。
// 做不到的值在 `validateSkillInput` 里就拒绝（首尾引号会被 frontmatter 剥掉、换行进不了单行值），
// 落盘前再用 `roundTripError` 兜底——静默变值比拒绝更不诚实。

import type { Diagnostic } from "../errors.ts";
import { parseFrontmatter } from "../prompt/markdown.ts";
import { validateSkillInput } from "./harness.ts";
import type { Skill } from "./types.ts";

export const SKILL_ENTRY_FILE = "SKILL.md";

/** 目录式入口在 store 里的键：`<name>/SKILL.md`。name 已由校验限定为 `[a-z0-9-]`，没有路径逃逸。 */
export function skillEntryPath(name: string): string {
  return `${name}/${SKILL_ENTRY_FILE}`;
}

/** `<name>/SKILL.md` → name；别的键（附件、无关文件）→ null。 */
export function skillNameOfEntry(key: string): string | null {
  const m = /^([^/]+)\/SKILL\.md$/.exec(key);
  return m === null ? null : m[1]!;
}

/** 文本 → Skill（单文件形态）。坏的返回 null 并写 diagnostics，**不 throw**——与 loader 同姿态。 */
export function parseSkillText(fallbackName: string, raw: string, diagnostics: Diagnostic[], path: string): Skill | null {
  const { meta, body } = parseFrontmatter(raw);
  return buildSkill(meta.name ?? fallbackName, meta, body, diagnostics, path);
}

/** Skill → 文本。只写 description 与正文：`skill_create` 产出的 skill 没有别的字段；name 由文件名承载。 */
export function serializeSkill(skill: Pick<Skill, "description" | "content">): string {
  return `---\ndescription: ${skill.description}\n---\n\n${skill.content}\n`;
}

/**
 * 落盘前的保真兜底：写出去再读回来，description / content 必须逐字相等。
 * 返回 null = 保真；否则是一句能直接给模型看的原因。
 * 正常情况下校验已经把不保真的值挡在池外，这里红了说明校验漏了一种情况——那也要**报出来**而不是写下去。
 */
export function roundTripError(skill: Pick<Skill, "name" | "description" | "content">): string | null {
  const diagnostics: Diagnostic[] = [];
  const back = parseSkillText(skill.name, serializeSkill(skill), diagnostics, skillEntryPath(skill.name));
  if (back === null) return `落盘格式读不回来：${diagnostics.map((d) => d.message).join("；")}`;
  if (back.description !== skill.description) return `description 落盘再读会变成「${back.description}」`;
  if (back.content !== skill.content) return "content 落盘再读会变（首尾空白不保真）";
  return null;
}

export function buildSkill(
  name: string,
  meta: Record<string, string>,
  body: string,
  diagnostics: Diagnostic[],
  path: string,
): Skill | null {
  const description = meta.description ?? "";
  if (description.trim() === "") {
    // description 是唯一致命必填:没有它,模型永远想不起来用这个 skill——装进去只是死重量
    diagnostics.push({ code: "skill_missing_description", message: `skill '${name}' 缺 description,已跳过`, path });
    return null;
  }
  const errors = validateSkillInput(name, description);
  if (errors.length > 0) {
    diagnostics.push({ code: "skill_invalid", message: `skill '${name}':${errors.join("；")}`, path });
    return null;
  }
  return {
    name,
    description,
    content: body.trim(),
    files: [],
    requiredTools: splitList(meta["required-tools"]),
    // 非标准字段,给产品留的口:model-invocable: false = 只给人和 hook 用
    modelInvocable: meta["model-invocable"] !== "false",
    frontmatter: meta, // 原样透传,**不可信数据**——渲染层绝不碰它
  };
}

/** `a, b, c` → ["a","b","c"]；空/缺 → []。 */
export function splitList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
