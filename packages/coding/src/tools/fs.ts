// 文件三件套:read_file / write_file / edit_file。
//
// 这些是**产品层工具**(对外部世界动手),所以住这儿不住 core(判据 2026-08-04 拍定)。
// 路径纪律:相对路径以 ctx.workspace 解析,**解析结果必须落在 workspace 之内**——
// 越界一律拒绝(`../../etc/passwd` 这类,不管是模型手滑还是注入)。workspace 是 session 级事实（2026-09-01），
// 既是起点也是边界,一个字段。
//
// description 与结果文本是模型逐字读的资产（全英文，2026-09-01）；跨工具的用法（先读后改、glob/grep 优先）
// 在 `prompt.ts` 的 `tool:workspace` 段，这里只讲单个工具自己的语义。

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { toolError, toolOk, type ModelTool, type ToolExecutionContext } from "@echo-agent/core";

/** 读回显的上限:超过就截断并标注——一个 50MB 的日志不该挤爆上下文。 */
const READ_CAP = 50_000;

/**
 * **改前必读、读后未变**（2026-09-01 用户拍板，照 Claude Code 的 Edit / Write 门）：
 * `edit_file` / `write_file` 只接受本会话用 `read_file` 读过、且盘上自那次读之后没被别人改过的文件
 * （mtime 相等判据）。此前只在 description 里写了一句「先读」——那是纪律不是门：模型没读就改、
 * 或者用户在编辑器里刚改过的文件被模型按旧内容覆盖，都不会被拦住。
 *
 * 一张表跟着一次 `makeFsTools()` 走（= 一个 agent）：键是绝对路径，值是读到 / 我们自己写完时的 mtime。
 * 新建文件（盘上不存在）不需要先读。
 */
type SeenFiles = Map<string, number>;

export function makeFsTools(): ModelTool[] {
  const seen: SeenFiles = new Map();
  return [readFileTool(seen), writeFileTool(seen), editFileTool(seen)] as ModelTool[];
}

/**
 * 改之前的门。返回 null = 可以改；否则是给模型看的拒绝理由。
 * `exists` 由调用方决定新建文件算不算（`write_file` 新建不用先读）。
 */
async function assertFreshlyRead(seen: SeenFiles, abs: string, path: string): Promise<string | null> {
  const st = await stat(abs).catch(() => null);
  if (st === null) return null; // 不存在：write_file 新建；edit_file 随后读文件时会报 File not found
  const readAt = seen.get(abs);
  if (readAt === undefined) return `Read ${path} with read_file before changing it`;
  if (st.mtimeMs !== readAt) return `${path} changed on disk since you read it; read it again before changing it`;
  return null;
}

/** 读完 / 写完之后记下盘上的 mtime。 */
async function markSeen(seen: SeenFiles, abs: string): Promise<void> {
  const st = await stat(abs).catch(() => null);
  if (st !== null) seen.set(abs, st.mtimeMs);
}

/** 解析 + 越界守卫。返回 null = 越界。 */
export function resolveSafe(ctx: ToolExecutionContext, path: string): string | null {
  const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.workspace, path);
  const root = resolve(ctx.workspace);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

function readFileTool(seen: SeenFiles): ModelTool<{ path: string; offset?: number; limit?: number }> {
  return {
    kind: "model",
    name: "read_file",
    label: "读文件",
    // 只读：模型一口气读五个文件时同批同跑。`seen` 只按路径记一条 mtime，同批互不覆盖。
    concurrent: true,
    description:
      "Read a file with line numbers. Use offset/limit to read a large file in parts. Read a file before editing it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        offset: { type: "number", description: "First line to read (1-based), default from the start" },
        limit: { type: "number", description: "Maximum number of lines, default 2000" },
      },
      required: ["path"],
    },
    async execute({ path, offset, limit }, ctx) {
      const abs = resolveSafe(ctx, path);
      if (abs === null) return toolError(`Path outside the workspace: '${path}'`);
      let raw: string;
      try {
        raw = await readFile(abs, "utf8");
      } catch (e) {
        return toolError(readErrText(e, path));
      }
      await markSeen(seen, abs); // 从这一刻起它才算「读过」：edit_file / write_file 的门看这个
      const lines = raw.split("\n");
      const from = Math.max(1, offset ?? 1);
      const take = Math.max(1, limit ?? 2000);
      const slice = lines.slice(from - 1, from - 1 + take);
      let text = slice.map((l, i) => `${from + i}\t${l}`).join("\n");
      if (text.length > READ_CAP) text = `${text.slice(0, READ_CAP)}\n…[truncated: over ${READ_CAP} characters, read in parts with offset/limit]`;
      const tail = from - 1 + take < lines.length ? `\n…(${lines.length} lines in total, ${lines.length - (from - 1 + take)} not shown)` : "";
      return toolOk(text + tail, { path, lines: lines.length });
    },
  };
}

function writeFileTool(seen: SeenFiles): ModelTool<{ path: string; content: string }> {
  return {
    kind: "model",
    name: "write_file",
    label: "写文件",
    description:
      "Write a whole file (created if missing, parent directories created). To change an existing file prefer edit_file; overwriting loses whatever you did not notice. " +
      "An existing file must have been read with read_file in this session and be unchanged on disk since.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        content: { type: "string", description: "The full file content" },
      },
      required: ["path", "content"],
    },
    async execute({ path, content }, ctx) {
      const abs = resolveSafe(ctx, path);
      if (abs === null) return toolError(`Path outside the workspace: '${path}'`);
      const refused = await assertFreshlyRead(seen, abs, path); // 新建不用先读；覆盖已有的必须
      if (refused !== null) return toolError(refused);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      await markSeen(seen, abs); // 自己写的算读过：接着 edit_file 不用再读一遍
      return toolOk(`Wrote ${path} (${content.length} characters)`, { path, bytes: content.length });
    },
  };
}

function editFileTool(seen: SeenFiles): ModelTool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> {
  return {
    kind: "model",
    name: "edit_file",
    label: "改文件",
    description:
      "Exact replacement: old_string must match the file content byte for byte (including indentation) and occur exactly once. " +
      "If it matches several places, give more surrounding context or set replace_all: true. " +
      "The file must have been read with read_file in this session and be unchanged on disk since.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "The exact text to replace (byte for byte, including indentation)" },
        new_string: { type: "string", description: "The replacement text" },
        replace_all: { type: "boolean", description: "Replace every match; default false (the match must be unique)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute({ path, old_string, new_string, replace_all }, ctx) {
      const abs = resolveSafe(ctx, path);
      if (abs === null) return toolError(`Path outside the workspace: '${path}'`);
      if (old_string === new_string) return toolError("old_string and new_string are identical; nothing to change");
      const refused = await assertFreshlyRead(seen, abs, path);
      if (refused !== null) return toolError(refused);
      let raw: string;
      try {
        raw = await readFile(abs, "utf8");
      } catch (e) {
        return toolError(readErrText(e, path));
      }
      const count = raw.split(old_string).length - 1;
      if (count === 0) return toolError("No match: old_string must equal the file content byte for byte (including indentation). Read the file with read_file and copy it exactly");
      if (count > 1 && replace_all !== true) {
        return toolError(`${count} matches: add surrounding context to make old_string unique, or set replace_all: true`);
      }
      // 替换文本用函数给：字符串形式会解释 `$&` / `$$` 这类模式，new_string 里带 `$` 的代码就会被替错
      const next = replace_all === true ? raw.split(old_string).join(new_string) : raw.replace(old_string, () => new_string);
      await writeFile(abs, next, "utf8");
      await markSeen(seen, abs); // 连续几次 edit 不用中间重读
      return toolOk(`Replaced ${replace_all === true ? count : 1} occurrence(s) in ${path}`, { path, replaced: count });
    },
  };
}

function readErrText(e: unknown, path: string): string {
  return (e as { code?: string }).code === "ENOENT" ? `File not found: ${path}` : `Read failed: ${String(e)}`;
}
