// memory 工具:六动词薄壳,逐个调 MemoryHarness 的方法。设计见 docs/design/parts/memory.md。
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
  if (p.includes("\\")) throw new Error(`路径不合法(不接受反斜杠):'${raw}'`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) throw new Error(`路径不合法(含控制字符):'${raw}'`);
  if (p === "") return "";
  const trailingSlash = p.endsWith("/");
  const segments = p.replace(/\/+$/, "").split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") throw new Error(`路径不合法(空段 / . / ..):'${raw}'`);
    if (seg.startsWith(".")) throw new Error(`路径不合法(点开头的段是内部保留):'${raw}'`);
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
  "读写你的持久记忆(跨会话保留)。分区与用途见 system 里「记忆」一节。" +
  "命令:view(看目录或文件,目录以 / 结尾或传空看全部)、create(建/整文件覆写)、" +
  "str_replace(把唯一出现的 old_str 换成 new_str)、insert(在第 insert_line 行后插入)、" +
  "delete、rename。写入超预算会被拒并告知现状——先整理(合并/删过时)再写。";

const PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert", "delete", "rename"],
      description: "要执行的操作",
    },
    path: { type: "string", description: "目标路径,如 agent.md / memory/xxx.md;view 传 '' 看全部" },
    file_text: { type: "string", description: "create:文件全文" },
    old_str: { type: "string", description: "str_replace:要替换的原文(必须唯一命中)" },
    new_str: { type: "string", description: "str_replace:替换后的文本" },
    insert_line: { type: "number", description: "insert:在第几行之后插入(0 = 文件开头)" },
    insert_text: { type: "string", description: "insert:要插入的文本" },
    new_path: { type: "string", description: "rename:新路径(须与原路径同一分区)" },
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
        throw new Error(`期望对象参数,收到 ${Array.isArray(raw) ? "数组" : typeof raw}`);
      }
      const r = raw as Record<string, unknown>;
      const command = String(r["command"] ?? "");
      if (!["view", "create", "str_replace", "insert", "delete", "rename"].includes(command)) {
        throw new Error(`未知命令 '${command}'(可用:view/create/str_replace/insert/delete/rename)`);
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
          if (params.file_text === undefined) return { content: "create 缺少 file_text", isError: true, metadata: null };
          return memoryCreate(memory, params.path, params.file_text);
        case "str_replace":
          return memoryStrReplace(memory, params.path, params.old_str ?? "", params.new_str ?? "");
        case "insert":
          if (params.insert_text === undefined) return { content: "insert 缺少 insert_text", isError: true, metadata: null };
          return memoryInsert(memory, params.path, params.insert_line ?? -1, params.insert_text);
        case "delete":
          return memoryDelete(memory, params.path);
        case "rename":
          if (params.new_path === undefined) return { content: "rename 缺少 new_path", isError: true, metadata: null };
          return memoryRename(memory, params.path, params.new_path);
      }
    },
  };
}
