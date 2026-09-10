// agent 定义的加载：扫盘 → 一张按名查的表。
//
// **三处来源，按优先级合并**（`docs/decisions/implemented/2026-09-07-role-agent.md`）：
// 项目层 `<workspace>/.echo/agents/`（放仓库里、随 git 走）> user 层 `<ECHO_HOME>/agents/` >
// 产品自带。顺序与 skill 加载器同一条规矩——**目录顺序就是优先级，撞名先到先得 + 诊断**，
// 因为加载是批量吞外部世界，一个重名不该炸掉整批。
//
// **失败姿态与 skill 一致**：一个坏文件不拖垮整批（跳过 + 诊断），目录不存在 = 空结果
// 而不是错误（这些目录本来就多半没建）。
//
// **登记一处撞名**：`<ECHO_HOME>/agents/` 正是 2026-09-01 那版状态根的路径
// （`agents/<agentId>/`）。那层布局已经被「状态根 = session 目录」替代，残留目录里没有 `.md`，
// 扫出来是空的、不会误认；但机器上留着旧目录的人会看到一个同名却不同义的路径。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "../errors.ts";
import { errText } from "../errors.ts";
import { parseAgentFile, type ParsedAgentFile } from "./parse.ts";
import type { AgentDefinition } from "./types.ts";

/** 目录名：user 层与项目层共用（`<ECHO_HOME>/agents/`、`<workspace>/.echo/agents/`）。 */
export const AGENT_DEF_DIR = "agents";

/** 一次加载的结果：合并去重后的定义表，加上路上攒的诊断（坏档、撞名）。 */
export type LoadedAgentDefs = {
  /** 名字 → 定义。已经按优先级去过重，直接查。 */
  readonly defs: ReadonlyMap<string, AgentDefinition>;
  readonly diagnostics: readonly Diagnostic[];
};

/**
 * 扫一个目录里的 `*.md`，每个文件一份定义。文件名（去掉 `.md`）是 frontmatter 没写 `name` 时的缺省名。
 *
 * **不递归**：角色是扁平的一层，没有「目录式角色」这种形状要兼容（skill 有，是为了吃外部生态）。
 */
export async function loadAgentDefsFromDir(dir: string): Promise<{ files: readonly ParsedAgentFile[]; diagnostics: readonly Diagnostic[] }> {
  const files: ParsedAgentFile[] = [];
  const diagnostics: Diagnostic[] = [];
  let entries: { name: string; isFile(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files, diagnostics }; // 没建过这个目录是常态，不是错误
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const path = join(dir, e.name);
    try {
      files.push(parseAgentFile(await readFile(path, "utf8"), e.name.slice(0, -3)));
    } catch (err) {
      diagnostics.push({ code: "agent_def_bad", message: errText(err), path });
    }
  }
  return { files, diagnostics };
}

/**
 * 按优先级合并多处来源。`dirs` 在前的赢；`builtin`（产品自带）排在所有目录之后，
 * 所以人放在项目里或家目录里的同名角色**盖得住产品自带的**。
 */
export async function loadAgentDefs(dirs: readonly string[], builtin: readonly ParsedAgentFile[] = []): Promise<LoadedAgentDefs> {
  const defs = new Map<string, AgentDefinition>();
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, string>(); // name → 来源
  const take = (file: ParsedAgentFile, from: string): void => {
    const prior = seen.get(file.name);
    if (prior !== undefined) {
      diagnostics.push({ code: "agent_def_name_clash", message: `agent 定义 '${file.name}' 已由 ${prior} 提供，忽略后到的`, path: from });
      return;
    }
    seen.set(file.name, from);
    defs.set(file.name, file.definition);
  };
  for (const dir of dirs) {
    const one = await loadAgentDefsFromDir(dir);
    diagnostics.push(...one.diagnostics);
    for (const f of one.files) take(f, dir);
  }
  for (const f of builtin) take(f, "产品自带");
  return { defs, diagnostics };
}
