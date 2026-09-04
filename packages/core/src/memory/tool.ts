// memory 工具:六动词薄壳,逐个调 MemoryHarness 的方法。
//
// 命令面**对齐 Anthropic memory tool**(view/create/str_replace/insert/delete/rename)
// ——判据与 skill 加载器同一条:「别人训练好的行为能不能在我们这直接跑」。
// 路径接受 "/memories/..." 前缀(训练行为会带),规范化后 jail 在记忆树内。
//
// 复写(2026-08-05 用户拍定):**真操作在 harness 方法上,工具只是壳**——
// 上层写自己的工具(比如 remember),里面调 memoryCreate(memory, ...) 即可,
// 计数与索引重建都在方法里,换工具断不了。经 ToolHarness 普通注册(source "memory"),
// 无特权;整体顶掉用 register(mine, {replace:true}),只换一个动词用 opts.handlers。

import type { AgentToolResult, ModelTool, ToolExecutionContext } from "../tools/types.ts";
import {
  memoryCreate, memoryDelete, memoryInsert, memoryRename, memoryStrReplace, memoryView,
  type AgentMemories,
} from "./harness.ts";

export const MEMORY_TOOL_NAME = "memory";

export type MemoryCommand = "view" | "create" | "str_replace" | "insert" | "delete" | "rename";

export type MemoryToolParams = {
  command: MemoryCommand;
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
  new_path?: string;
};

/**
 * 纯字符串路径规范化 + jail(core 零 `node:` import,不需要 fs 语义):
 * 剥 "/memories" 前缀 → 拒绝反斜杠/控制字符 → 逐段拒绝 ".."、"." 与**点开头的段**
 * (点开头藏内部状态,如 .dream/——模型不可见不可写)。返回相对路径;"" = 根(只有 view 收)。
 */
export function normalizeMemoryPath(raw: string): string {
  let p = raw.trim();
  if (p === "/memories") p = "";
  if (p.startsWith("/memories/")) p = p.slice("/memories/".length);
  if (p.startsWith("/")) p = p.slice(1);
  if (p.includes("\\")) throw new Error(`Invalid path (backslashes are not accepted): '${raw}'`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) throw new Error(`Invalid path (contains control characters): '${raw}'`);
  if (p === "") return "";
  const trailingSlash = p.endsWith("/");
  const segments = p.replace(/\/+$/, "").split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") throw new Error(`Invalid path (empty segment, . or ..): '${raw}'`);
    if (seg.startsWith(".")) throw new Error(`Invalid path (segments starting with . are reserved): '${raw}'`);
  }
  return segments.join("/") + (trailingSlash ? "/" : "");
}

export type MemoryCommandHandler = (
  params: MemoryToolParams,
  memory: AgentMemories,
  ctx: ToolExecutionContext,
) => Promise<AgentToolResult>;

export type CreateMemoryToolOptions = {
  /** 覆盖工具 description(prompt 资产,上层必然要按自己的语气调)。 */
  description?: string;
  /** 细粒度复写:只换某个动词的行为,其余走缺省(缺省 = 调 harness 同名方法)。 */
  handlers?: Partial<Record<MemoryCommand, MemoryCommandHandler>>;
};

const DEFAULT_DESCRIPTION =
  "Read and write your persistent memory (kept across sessions). The regions and what goes in each are in the Memory section of the system prompt. " +
  "Commands: view (a directory — path ending in / or empty for everything — or a file), create (create or overwrite a whole file), " +
  "str_replace (replace the single occurrence of old_str with new_str), insert (insert after line insert_line), " +
  "delete, rename. A write that exceeds a region's budget is refused with the current numbers: consolidate (merge, delete stale entries) first, then write.";

const PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert", "delete", "rename"],
      description: "The operation to perform",
    },
    path: { type: "string", description: "Target path, e.g. agent.md or memory/xxx.md; for view, '' shows everything" },
    file_text: { type: "string", description: "create: the full file content" },
    old_str: { type: "string", description: "str_replace: the exact text to replace (must occur exactly once)" },
    new_str: { type: "string", description: "str_replace: the replacement text" },
    insert_line: { type: "number", description: "insert: insert after this line number (0 = start of file)" },
    insert_text: { type: "string", description: "insert: the text to insert" },
    new_path: { type: "string", description: "rename: the new path (must stay in the same region)" },
  },
  required: ["command", "path"],
};

export function createMemoryTool(memory: AgentMemories, opts?: CreateMemoryToolOptions): ModelTool<MemoryToolParams> {
  return {
    kind: "model",
    name: MEMORY_TOOL_NAME,
    label: "记忆",
    description: opts?.description ?? DEFAULT_DESCRIPTION,
    parameters: PARAMETERS,
    prepareArguments(raw: unknown): MemoryToolParams {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`Expected an object argument, got ${Array.isArray(raw) ? "an array" : typeof raw}`);
      }
      const r = raw as Record<string, unknown>;
      const command = String(r["command"] ?? "");
      if (!["view", "create", "str_replace", "insert", "delete", "rename"].includes(command)) {
        throw new Error(`Unknown command '${command}' (available: view/create/str_replace/insert/delete/rename)`);
      }
      const params: MemoryToolParams = { command: command as MemoryCommand, path: String(r["path"] ?? "") };
      if (r["file_text"] !== undefined) params.file_text = String(r["file_text"]);
      if (r["old_str"] !== undefined) params.old_str = String(r["old_str"]);
      if (r["new_str"] !== undefined) params.new_str = String(r["new_str"]);
      if (r["insert_text"] !== undefined) params.insert_text = String(r["insert_text"]);
      if (r["insert_line"] !== undefined) params.insert_line = Number(r["insert_line"]);
      if (r["new_path"] !== undefined) params.new_path = String(r["new_path"]);
      return params;
    },
    async execute(params, ctx): Promise<AgentToolResult> {
      const custom = opts?.handlers?.[params.command];
      if (custom !== undefined) return custom(params, memory, ctx);
      switch (params.command) {
        case "view":
          return memoryView(memory, params.path);
        case "create":
          if (params.file_text === undefined) return { content: "create needs file_text", isError: true, metadata: null };
          return memoryCreate(memory, params.path, params.file_text);
        case "str_replace":
          return memoryStrReplace(memory, params.path, params.old_str ?? "", params.new_str ?? "");
        case "insert":
          if (params.insert_text === undefined) return { content: "insert needs insert_text", isError: true, metadata: null };
          return memoryInsert(memory, params.path, params.insert_line ?? -1, params.insert_text);
        case "delete":
          return memoryDelete(memory, params.path);
        case "rename":
          if (params.new_path === undefined) return { content: "rename needs new_path", isError: true, metadata: null };
          return memoryRename(memory, params.path, params.new_path);
      }
    },
  };
}
