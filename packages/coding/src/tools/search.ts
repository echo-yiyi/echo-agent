// 搜索两件套:glob(找文件)/ grep(找内容)。用 Bun.Glob,零依赖。
// node_modules / .git 恒排除——那里面的匹配对写代码没用,还会把结果挤爆。
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

import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { toolError, toolOk, type ModelTool, type ToolExecutionContext } from "@echo-agent/core";
import { resolveSafe } from "./fs.ts";

const GLOB_CAP = 500;
const GREP_CAP = 200;
const GREP_FILE_MAX = 1_000_000; // >1MB 的文件跳过(多半是产物/数据,不是代码)
const LINE_CAP = 250;
const LIST_CAP = 500;

const EXCLUDED = /(^|\/)(node_modules|\.git)(\/|$)/;

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
  const abs = path === undefined || path === "" ? resolve(ctx.workspace) : await resolveSafe(ctx, path);
  if (abs === null) return { ok: false, error: `Path outside the workspace: '${path}'` };
  const st = await stat(abs).catch(() => null);
  if (st === null) return { ok: false, error: `path not found: ${path ?? abs}` };
  return { ok: true, kind: st.isFile() ? "file" : "dir", abs };
}

/** 目录里按 glob 扫，产出绝对路径；node_modules / .git 恒排除。 */
async function* scanDir(dir: string, pattern: string): AsyncGenerator<string> {
  for await (const p of new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true, dot: false })) {
    if (EXCLUDED.test(p)) continue;
    yield resolve(dir, p);
  }
}

function globTool(): ModelTool<{ pattern: string; path?: string }> {
  return {
    kind: "model",
    name: "glob",
    label: "找文件",
    concurrent: true, // 只读
    description:
      'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.test.ts". Returns paths relative to the workspace.',
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
      const out: string[] = [];
      try {
        for await (const abs of scanDir(target.abs, pattern)) {
          out.push(display(ctx, abs));
          if (out.length >= GLOB_CAP) break;
        }
      } catch (e) {
        return toolError(`glob failed: ${String(e)}`);
      }
      out.sort();
      const cap = out.length >= GLOB_CAP ? `\n…[hit the ${GLOB_CAP}-result limit; narrow the pattern]` : "";
      return toolOk(out.length === 0 ? "(no matches)" : out.join("\n") + cap, { count: out.length });
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

function grepTool(): ModelTool<{ pattern: string; path?: string; glob?: string }> {
  return {
    kind: "model",
    name: "grep",
    label: "找内容",
    concurrent: true, // 只读
    description:
      "Search file contents with a regular expression; returns file:line:text with paths relative to the workspace. " +
      "path may be a directory (searched recursively, narrowed by glob) or a single file (searched alone).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression (without slashes)" },
        path: { type: "string", description: "Directory or file to search, default the workspace" },
        glob: { type: "string", description: 'Limit to these files when path is a directory, default "**/*"' },
      },
      required: ["pattern"],
    },
    async execute({ pattern, path, glob }, ctx) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return toolError(`Invalid regular expression: ${String(e)}`);
      }
      const target = await resolveTarget(ctx, path);
      if (!target.ok) return toolError(target.error);
      // 单文件：用户点名的那一个，不过 glob 也不过排除表——点名了就是要搜它
      const files: Iterable<string> | AsyncIterable<string> =
        target.kind === "file" ? [target.abs] : scanDir(target.abs, glob ?? "**/*");
      const lines: string[] = [];
      let scanned = 0;
      try {
        for await (const abs of files) {
          const st = await stat(abs).catch(() => null);
          if (st === null || st.size > GREP_FILE_MAX) continue;
          scanned += 1;
          let raw: string;
          try {
            raw = await readFile(abs, "utf8");
          } catch {
            continue; // 读不动的(二进制、权限)跳过
          }
          if (raw.includes("\u0000")) continue; // 二进制
          const shown = display(ctx, abs);
          const fileLines = raw.split("\n");
          for (let i = 0; i < fileLines.length; i++) {
            const line = fileLines[i]!;
            if (!re.test(line)) continue;
            lines.push(`${shown}:${i + 1}:${line.length > LINE_CAP ? line.slice(0, LINE_CAP) + "…" : line}`);
            if (lines.length >= GREP_CAP) break;
          }
          if (lines.length >= GREP_CAP) break;
        }
      } catch (e) {
        return toolError(`grep failed: ${String(e)}`);
      }
      const cap = lines.length >= GREP_CAP ? `\n…[hit the ${GREP_CAP}-match limit; narrow the pattern or glob]` : "";
      return toolOk(lines.length === 0 ? `(no matches in ${scanned} files)` : lines.join("\n") + cap, {
        matches: lines.length,
        scanned,
      });
    },
  };
}
