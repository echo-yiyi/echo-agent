// 文件三件套:read_file / write_file / edit_file。
//
// 这些是**产品层工具**(对外部世界动手),所以住这儿不住 core(判据 2026-08-04 拍定)。
// 路径纪律:相对路径以 ctx.cwd 解析,**解析结果必须落在 workspaceRoot 之内**——
// 越界一律拒绝(`../../etc/passwd` 这类,不管是模型手滑还是注入)。
//
// ⚠️ description 是模型逐字读的 prompt 资产,临时措辞,定稿归 prompt 治理。

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
  const abs = isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path);
  const root = resolve(ctx.workspaceRoot);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

function readFileTool(): ModelTool<{ path: string; offset?: number; limit?: number }> {
  return {
    kind: "model",
    name: "read_file",
    label: "读文件",
    description:
      "读一个文件的内容(带行号)。大文件用 offset/limit 分段读。改文件前先读它——不读就改是盲改。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的路径" },
        offset: { type: "number", description: "起始行号(1 起),缺省从头" },
        limit: { type: "number", description: "最多读多少行,缺省 2000" },
      },
      required: ["path"],
    },
    async execute({ path, offset, limit }, ctx) {
      const abs = resolveSafe(ctx, path);
      if (abs === null) return toolError(`路径越界:'${path}' 不在工作区内`);
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
      if (text.length > READ_CAP) text = `${text.slice(0, READ_CAP)}\n…[截断:超过 ${READ_CAP} 字,用 offset/limit 分段读]`;
      const tail = from - 1 + take < lines.length ? `\n…(共 ${lines.length} 行,还有 ${lines.length - (from - 1 + take)} 行未显示)` : "";
      return toolOk(text + tail, { path, lines: lines.length });
    },
  };
}

function writeFileTool(): ModelTool<{ path: string; content: string }> {
  return {
    kind: "model",
    name: "write_file",
    label: "写文件",
    description: "整文件覆写(不存在则创建,自动建目录)。改已有文件优先用 edit_file——覆写会丢掉你没注意到的部分。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
    async execute({ path, content }, ctx) {
      const abs = resolveSafe(ctx, path);
      if (abs === null) return toolError(`路径越界:'${path}' 不在工作区内`);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return toolOk(`已写入 ${path}(${content.length} 字)`, { path, bytes: content.length });
    },
  };
}

function editFileTool(): ModelTool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> {
  return {
    kind: "model",
    name: "edit_file",
    label: "改文件",
    description:
      "精确替换:old_string 必须与文件内容逐字节匹配且唯一(含缩进)。" +
      "匹配到多处时要么给更长的上下文,要么 replace_all: true。改前先 read_file。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "要替换的原文(逐字节,含缩进)" },
        new_string: { type: "string", description: "替换成什么" },
        replace_all: { type: "boolean", description: "替换全部匹配,缺省 false(要求唯一)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute({ path, old_string, new_string, replace_all }, ctx) {
      const abs = resolveSafe(ctx, path);
      if (abs === null) return toolError(`路径越界:'${path}' 不在工作区内`);
      if (old_string === new_string) return toolError("old_string 与 new_string 相同,没有可做的改动");
      let raw: string;
      try {
        raw = await readFile(abs, "utf8");
      } catch (e) {
        return toolError(readErrText(e, path));
      }
      const count = raw.split(old_string).length - 1;
      if (count === 0) return toolError(`没找到匹配:old_string 必须与文件内容逐字节一致(含缩进)。先 read_file 核对`);
      if (count > 1 && replace_all !== true) {
        return toolError(`匹配到 ${count} 处:给更长的上下文让它唯一,或用 replace_all: true`);
      }
      const next = replace_all === true ? raw.split(old_string).join(new_string) : raw.replace(old_string, new_string);
      await writeFile(abs, next, "utf8");
      return toolOk(`已替换 ${replace_all === true ? count : 1} 处:${path}`, { path, replaced: count });
    },
  };
}

function readErrText(e: unknown, path: string): string {
  return (e as { code?: string }).code === "ENOENT" ? `文件不存在:${path}` : `读取失败:${String(e)}`;
}
