// 文件三件套:read_file / write_file / edit_file。
//
// 这些是**产品层工具**(对外部世界动手),所以住这儿不住 core(判据 2026-08-04 拍定)。
// 路径纪律:相对路径以 ctx.workspace 解析,**解析结果必须落在 workspace 之内**——
// 越界一律拒绝(`../../etc/passwd` 这类,不管是模型手滑还是注入)。workspace 是 session 级事实（2026-09-01），
// 既是起点也是边界,一个字段。
//
// description 与结果文本是模型逐字读的资产（全英文，2026-09-01）；跨工具的用法（先读后改、glob/grep 优先）
// 在 `prompt.ts` 的 `tool:workspace` 段，这里只讲单个工具自己的语义。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { toolError, toolOk, type ModelTool, type ToolExecutionContext } from "@echo-agent/core";

/** 读回显的上限:超过就截断并标注——一个 50MB 的日志不该挤爆上下文。 */
const READ_CAP = 50_000;

export function makeFsTools(): ModelTool[] {
  return [readFileTool(), writeFileTool(), editFileTool()] as ModelTool[];
}

/** 解析 + 越界守卫。返回 null = 越界。 */
export function resolveSafe(ctx: ToolExecutionContext, path: string): string | null {
  const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.workspace, path);
  const root = resolve(ctx.workspace);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

function readFileTool(): ModelTool<{ path: string; offset?: number; limit?: number }> {
  return {
    kind: "model",
    name: "read_file",
    label: "读文件",
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

function writeFileTool(): ModelTool<{ path: string; content: string }> {
  return {
    kind: "model",
    name: "write_file",
    label: "写文件",
    description: "Write a whole file (created if missing, parent directories created). To change an existing file prefer edit_file; overwriting loses whatever you did not notice.",
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
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return toolOk(`Wrote ${path} (${content.length} characters)`, { path, bytes: content.length });
    },
  };
}

function editFileTool(): ModelTool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> {
  return {
    kind: "model",
    name: "edit_file",
    label: "改文件",
    description:
      "Exact replacement: old_string must match the file content byte for byte (including indentation) and occur exactly once. " +
      "If it matches several places, give more surrounding context or set replace_all: true. Read the file first.",
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
      const next = replace_all === true ? raw.split(old_string).join(new_string) : raw.replace(old_string, new_string);
      await writeFile(abs, next, "utf8");
      return toolOk(`Replaced ${replace_all === true ? count : 1} occurrence(s) in ${path}`, { path, replaced: count });
    },
  };
}

function readErrText(e: unknown, path: string): string {
  return (e as { code?: string }).code === "ENOENT" ? `File not found: ${path}` : `Read failed: ${String(e)}`;
}
