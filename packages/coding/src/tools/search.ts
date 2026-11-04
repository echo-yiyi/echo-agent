// 搜索两件套:glob(找文件)/ grep(找内容)。用 Bun.Glob 与 git,零依赖。
//
// **候选文件从哪来**（`candidateFiles`）：起点在 git 工作树里，就取 `git ls-files --cached --others --exclude-standard`
// ——跟踪的文件加上没被忽略的新文件，与 ripgrep 的忽略语义一致：被 .gitignore 的 dist / build 不进来，
// .github 这类点目录照进。不在 git 工作树里（或 git 不可用）就目录遍历，点目录同样照进。
// git 列出来一个都没有（点名的目录整个被忽略）也退回目录遍历：点名了就是要搜它。
// node_modules / .git 两种来源都恒排除——那里面的匹配对写代码没用,还会把结果挤爆。软链不跟（目录遍历本就不跟，
// git 列出的软链也跳过）：经软链可以出工作区，边界只在起点 `path` 上查过一次。
// 结果**按路径排序之后再截**，截断时说出总数——按扫描顺序截，留下的是哪些全凭目录遍历的顺序。
//
// **`path` 指到文件就只搜这一个文件**（2026-09-01，实测 bug）：模型把 grep 当 `grep <pattern> <file>` 用是常态，
// 此前把文件当 cwd 交给 Bun.Glob，甩给模型一句 `ENOTDIR: not a directory`，相对、绝对路径都炸。
// glob 拿到文件则明说「要目录」并指回 grep——静默返回 0 个匹配是「写了没生效」。
//
// **结果路径一律相对工作区**：read_file / edit_file 收的是工作区相对路径，搜索若按 `path` 相对报
// （在 `packages/core/src` 里搜到 `agent.ts:260`），模型拿着 `agent.ts` 去读就找不到。
//
// **边界与文件三件套同一条**（review 2026-09-07）：`path` 经 fs.ts 的 `resolveSafe` 解析，越界（含经软链）一律拒。
// 此前这三件没有任何边界，而 system 段对模型说的是「工作区之外的路径会被拒」——契约与实现两张皮，
// 且凡是把 bash 设成 ask 的策略，grep 都是绕开那道门读整块盘的路。

import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { toolError, toolOk, type ModelTool, type ToolExecutionContext } from "@echo-agent/core";
import { resolveSafe } from "./fs.ts";

const GLOB_CAP = 500;
/** grep 最多回这么多条（content 是行，另两种是文件）。 */
const GREP_CAP = 200;
const GREP_FILE_MAX = 1_000_000; // >1MB 的文件跳过(多半是产物/数据,不是代码)，跳过几个在结果尾部说
const LINE_CAP = 250;
const LIST_CAP = 500;

const EXCLUDED = /(^|\/)(node_modules|\.git)(\/|$)/;

const OUTPUT_MODES = ["content", "files_with_matches", "count"] as const;
type OutputMode = (typeof OUTPUT_MODES)[number];

/** 说明排除规则的那一句：glob 与 grep 的 description 共用。 */
const SCOPE_TEXT =
  "Inside a git repository it searches the files git sees (tracked plus untracked, honoring .gitignore), otherwise every file under path; " +
  "dot-directories such as .github are included, .git and node_modules never are, symlinks are not followed. " +
  "Naming an ignored directory as path searches it.";

/** 搜索三件：glob / grep / list_dir。`list_dir` 是 2026-09-02 补的——glob 只出文件，模型看不到目录结构，只能 `bash ls`。 */
export function makeSearchTools(): ModelTool[] {
  return [globTool(), grepTool(), listDirTool()] as ModelTool[];
}

/** 结果里怎么报这个文件：相对工作区——起点已经过了越界守卫，结果只可能在工作区内。 */
function display(ctx: ToolExecutionContext, abs: string): string {
  return relative(ctx.workspace, abs);
}

type Target = { ok: true; kind: "file" | "dir"; abs: string } | { ok: false; error: string };

/** `path` → 搜索起点。越界、不存在、是文件、是目录分开说，错误文案要让模型知道下一步怎么办。 */
async function resolveTarget(ctx: ToolExecutionContext, path?: string): Promise<Target> {
  const safe = path === undefined || path === "" ? { ok: true as const, abs: resolve(ctx.workspace) } : await resolveSafe(ctx, path);
  if (!safe.ok) return { ok: false, error: safe.error };
  const abs = safe.abs;
  const st = await stat(abs).catch(() => null);
  if (st === null) return { ok: false, error: `path not found: ${path ?? abs}` };
  return { ok: true, kind: st.isFile() ? "file" : "dir", abs };
}

/**
 * 目录 `dir` 下匹配 `pattern` 的文件，绝对路径、按路径排好。来源见文件头：git 工作树里取 git 认的文件，否则目录遍历；
 * node_modules / .git 恒排除，软链不跟。
 */
async function candidateFiles(dir: string, pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const rels: string[] = [];
  const listed = await gitListFiles(dir);
  if (listed !== null && listed.length > 0) {
    for (const p of listed) {
      if (EXCLUDED.test(p) || !glob.match(p)) continue;
      // 已删未提交（index 里还有）、子模块（目录）、软链：都不是这里要读的普通文件，与目录遍历同一口径
      const st = await lstat(resolve(dir, p)).catch(() => null);
      if (st?.isFile() === true) rels.push(p);
    }
  } else {
    for await (const p of glob.scan({ cwd: dir, onlyFiles: true, dot: true })) {
      if (!EXCLUDED.test(p)) rels.push(p);
    }
  }
  rels.sort();
  return rels.map((p) => resolve(dir, p));
}

/** `dir` 下 git 认的文件（相对 `dir`，去重）。不是 git 工作树、git 不可用 → null。 */
async function gitListFiles(dir: string): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    // 有冲突时 --cached 会把同一路径按 stage 列好几遍
    return [...new Set(out.split("\0").filter((p) => p !== ""))];
  } catch {
    return null;
  }
}

function globTool(): ModelTool<{ pattern: string; path?: string }> {
  return {
    kind: "model",
    name: "glob",
    label: "找文件",
    concurrent: true, // 只读
    description:
      `Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.test.ts". Returns paths relative to the workspace, sorted, at most ${GLOB_CAP}. ` +
      SCOPE_TEXT,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory to start from, default the workspace" },
      },
      required: ["pattern"],
    },
    async execute({ pattern, path }, ctx) {
      const target = await resolveTarget(ctx, path);
      if (!target.ok) return toolError(target.error);
      if (target.kind === "file") {
        return toolError(`path is a file, glob needs a directory: ${path}. To search inside one file, use grep with path=${path}.`);
      }
      let all: string[];
      try {
        all = await candidateFiles(target.abs, pattern);
      } catch (e) {
        return toolError(`glob failed: ${String(e)}`);
      }
      const shown = all.slice(0, GLOB_CAP).map((abs) => display(ctx, abs));
      const cap = all.length > GLOB_CAP ? `\n…[${all.length} files match; showing the first ${GLOB_CAP} by path. Narrow the pattern or path]` : "";
      return toolOk(shown.length === 0 ? "(no matches)" : shown.join("\n") + cap, { count: all.length });
    },
  };
}

function listDirTool(): ModelTool<{ path?: string }> {
  return {
    kind: "model",
    name: "list_dir",
    label: "列目录",
    concurrent: true, // 只读
    description:
      "List the entries of one directory, not recursive: subdirectories first and marked with a trailing '/'. Default the workspace root. To find files by pattern use glob.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list, default the workspace" },
      },
    },
    async execute({ path }, ctx) {
      const target = await resolveTarget(ctx, path);
      if (!target.ok) return toolError(target.error);
      if (target.kind === "file") return toolError(`path is a file, list_dir needs a directory: ${path}. Use read_file to read it.`);
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = await readdir(target.abs, { withFileTypes: true });
      } catch (e) {
        return toolError(`list_dir failed: ${String(e)}`);
      }
      // 目录在前、各自按名排：一眼分得出结构。node_modules / .git 照列——这是目录的真相，不是搜索结果
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`).sort();
      const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
      const all = [...dirs, ...files];
      const shown = all.slice(0, LIST_CAP);
      const cap = all.length > LIST_CAP ? `\n…[${all.length - LIST_CAP} more entries not shown]` : "";
      return toolOk(shown.length === 0 ? "(empty directory)" : shown.join("\n") + cap, { count: all.length });
    },
  };
}

type GrepParams = { pattern: string; path?: string; glob?: string; ignore_case?: boolean; output_mode?: string };

/**
 * grep 的两个参数（2026-11-03 拍板，`docs/decisions/implemented/2026-11-03-grep-ignore-case-and-output-mode.md`）：
 * `ignore_case`（JS 正则没有 `(?i)` 内联写法）与 `output_mode`——只要知道「哪些文件有」或「各有几处」时，
 * 不必把每一行都搬进上下文。缺省 `content`，与此前的输出逐字相同。
 */
function grepTool(): ModelTool<GrepParams> {
  return {
    kind: "model",
    name: "grep",
    label: "找内容",
    concurrent: true, // 只读
    description:
      "Search file contents with a regular expression; paths in the results are relative to the workspace. " +
      "path may be a directory (searched recursively, narrowed by glob) or a single file (searched alone). " +
      `output_mode "content" (default) returns file:line:text, "files_with_matches" returns the matching files, "count" returns file:count. ` +
      `Results are sorted by path, at most ${GREP_CAP} entries; files over 1 MB are skipped and counted at the end. ${SCOPE_TEXT}`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression (without slashes or inline flags)" },
        path: { type: "string", description: "Directory or file to search, default the workspace" },
        glob: { type: "string", description: 'Limit to these files when path is a directory, default "**/*"' },
        ignore_case: { type: "boolean", description: "Match case-insensitively, default false" },
        output_mode: { type: "string", enum: [...OUTPUT_MODES], description: 'What to return, default "content"' },
      },
      required: ["pattern"],
    },
    async execute({ pattern, path, glob, ignore_case, output_mode }, ctx) {
      const mode = (output_mode ?? "content") as OutputMode;
      if (!OUTPUT_MODES.includes(mode)) return toolError(`output_mode must be one of ${OUTPUT_MODES.join(", ")} (got '${output_mode}')`);
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case === true ? "i" : "");
      } catch (e) {
        const inline = /^\(\?[a-z]+\)/.test(pattern) ? " JavaScript regular expressions have no inline flags such as (?i); use ignore_case: true." : "";
        return toolError(`Invalid regular expression: ${String(e)}.${inline}`);
      }
      const target = await resolveTarget(ctx, path);
      if (!target.ok) return toolError(target.error);
      let files: string[];
      try {
        // 单文件：用户点名的那一个，不过 glob 也不过排除表——点名了就是要搜它
        files = target.kind === "file" ? [target.abs] : await candidateFiles(target.abs, glob ?? "**/*");
      } catch (e) {
        return toolError(`grep failed: ${String(e)}`);
      }
      const entries: string[] = [];
      let total = 0; // content = 匹配的行数；另两种 = 有匹配的文件数
      let scanned = 0;
      let tooLarge = 0;
      for (const abs of files) {
        const st = await stat(abs).catch(() => null);
        if (st === null) continue;
        if (st.size > GREP_FILE_MAX) {
          tooLarge += 1;
          continue;
        }
        let raw: string;
        try {
          raw = await readFile(abs, "utf8");
        } catch {
          continue; // 读不动的（权限）跳过
        }
        if (raw.includes("\u0000")) continue; // 二进制
        scanned += 1;
        const shown = display(ctx, abs);
        let inFile = 0;
        for (const [i, line] of raw.split("\n").entries()) {
          if (!re.test(line)) continue;
          inFile += 1;
          if (mode === "files_with_matches") break;
          if (mode === "content") {
            total += 1;
            if (entries.length < GREP_CAP) entries.push(`${shown}:${i + 1}:${line.length > LINE_CAP ? line.slice(0, LINE_CAP) + "…" : line}`);
          }
        }
        if (inFile > 0 && mode !== "content") {
          total += 1;
          if (entries.length < GREP_CAP) entries.push(mode === "count" ? `${shown}:${inFile}` : shown);
        }
      }
      const unit = mode === "content" ? "matching lines" : "files match";
      const cap = total > GREP_CAP ? `\n…[${total} ${unit} in total; showing the first ${GREP_CAP} by path. Narrow the pattern, path or glob]` : "";
      const skipped = tooLarge === 0 ? "" : `\n(${tooLarge} ${tooLarge === 1 ? "file" : "files"} over 1 MB not searched; search them with bash if you need to)`;
      return toolOk((entries.length === 0 ? `(no matches in ${scanned} files)` : entries.join("\n") + cap) + skipped, {
        matches: total,
        scanned,
        tooLarge,
      });
    },
  };
}
