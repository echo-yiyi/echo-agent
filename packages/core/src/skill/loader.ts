// skill 加载器:扫盘 → Skill[]。设计见 docs/design/AGENT-CORE.md §5A.5。
//
// **判据:别人写的 skill 能不能在我们这跑起来**(2026-08-04 用户拍定)——
// 所以 Claude Code / pi 的目录式 skill(`<dir>/SKILL.md` + frontmatter + 同目录文件)
// 与根层单文件 `.md` 都必须认。
// 它住 core(2026-08-05 用户拍定:core 是可执行的最小 agent,零依赖宪法已废,
// FileDir 早就 import node:fs 了——加载器没理由再流放在外面)。
//
// frontmatter 用 core 自己的子集解析器(prompt/markdown.ts):`key: value` 单行值。
// **已知局限,登记不隐瞒**:多行 YAML 值(如 `allowed-tools:` 换行列表)解析不出——
// 那种行没有冒号,被跳过,skill 本体照常加载,只是对应字段为空。
// name / description 在生态里都是单行,主链路不受影响。
//
// 失败姿态:**一个坏 skill 不拖垮整批**——跳过 + 诊断,绝不 throw;
// 目录不存在 = 空结果(缺省目录本来就可能没建),不是错误。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "../errors.ts";
import { errText } from "../errors.ts";
import { parseSkillText, SKILL_ENTRY_FILE } from "./format.ts";
import type { LoadedSkills, Skill } from "./types.ts";

// 格式（parse / serialize / buildSkill）住 `format.ts`（纯）；这里保住既有导出路径。
export { SKILL_ENTRY_FILE, parseSkillText } from "./format.ts";

export type { LoadedSkills } from "./types.ts"; // 声明移居 types.ts（engine 面要用），这里保住既有导出路径

/**
 * 扫多个目录。撞名**先到先得 + 诊断**(目录顺序就是优先级:项目级排前面赢过全局级),
 * 与 `addSkills` 的 fail-loud 不同——加载是批量吞外部世界,一个重名不该炸掉整批。
 */
export async function loadSkills(dirs: readonly string[]): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, string>(); // name → 来源目录
  for (const dir of dirs) {
    const one = await loadSkillsFromDir(dir);
    diagnostics.push(...one.diagnostics);
    for (const s of one.skills) {
      const prior = seen.get(s.name);
      if (prior !== undefined) {
        diagnostics.push({ code: "skill_name_clash", message: `skill '${s.name}' 已由 ${prior} 提供,忽略后到的`, path: dir });
        continue;
      }
      seen.set(s.name, dir);
      skills.push(s);
    }
  }
  return { skills, diagnostics };
}

/** 扫一个目录:子目录里的 `SKILL.md` 各成一个 skill;根层其余 `.md` 各成单文件 skill。 */
export async function loadSkillsFromDir(dir: string): Promise<LoadedSkills> {
  const skills: Skill[] = [];
  const diagnostics: Diagnostic[] = [];

  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { skills, diagnostics }; // 目录不存在 = 空,不是错误
    diagnostics.push({ code: "skill_dir_unreadable", message: errText(e), path: dir });
    return { skills, diagnostics };
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    try {
      if (entry.isDirectory()) {
        const skill = await loadDirSkill(join(dir, entry.name), entry.name, diagnostics);
        if (skill !== null) skills.push(skill);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== SKILL_ENTRY_FILE) {
        const skill = await loadFileSkill(join(dir, entry.name), entry.name.slice(0, -3), diagnostics);
        if (skill !== null) skills.push(skill);
      }
    } catch (e) {
      // 单个坏 skill 不拖垮整批
      diagnostics.push({ code: "skill_load_failed", message: errText(e), path: join(dir, entry.name) });
    }
  }
  return { skills, diagnostics };
}

/* ─────────────── 两种形态 ─────────────── */

/** 目录式:`<dir>/SKILL.md`,name 缺省用目录名,同目录文件收进 files(供正文相对引用)。 */
async function loadDirSkill(skillDir: string, dirName: string, diagnostics: Diagnostic[]): Promise<Skill | null> {
  let raw: string;
  try {
    raw = await readFile(join(skillDir, SKILL_ENTRY_FILE), "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null; // 没有 SKILL.md 的目录不是 skill,静静跳过
    throw e;
  }
  const skill = parseSkillText(dirName, raw, diagnostics, join(skillDir, SKILL_ENTRY_FILE));
  if (skill === null) return null;
  return { ...skill, dir: skillDir, files: await listFiles(skillDir) };
}

/** 单文件式:`foo.md` → skill "foo"。没有 dir,引用不了旁边的文件。 */
async function loadFileSkill(path: string, fallbackName: string, diagnostics: Diagnostic[]): Promise<Skill | null> {
  return parseSkillText(fallbackName, await readFile(path, "utf8"), diagnostics, path);
}

/** 同目录文件清单(递归,相对路径),入口文件自身除外。省 agent 一轮 ls。 */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(join(dir, e.name), rel)));
    else if (e.isFile() && rel !== SKILL_ENTRY_FILE) out.push(rel);
  }
  return out.sort();
}
