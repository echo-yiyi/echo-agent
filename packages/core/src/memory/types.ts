// 记忆的数据形状。设计见 docs/design/parts/memory.md。
//
// 写法与 messages.ts 同构:**纯数据判别联合**(mode ↔ role)+ 扩展位 + 构造器;
// 行为(组装 / 写入校验)是外置的分发函数(compose.ts),认不出的种类组装时隐形。
// Memory 可 JSON 序列化,能直接写进配置文件——它是配置,不是对象机器。
//
// 三份内建值 = 三层架构(2026-08-05 用户拍定,参照 Hermes s10 / Claude Code s09 两个工业设计):
//   agent / user 学 Hermes:小而关键,**全文常驻** system(每次 run 冻结快照);
//   memory       学 Claude Code:大而稀疏,**索引常驻、正文按需**(模型用 memory 工具自取)。
// Hermes 那句格言是分界依据:「小而关键的全量冻结注入;大而稀疏的才索引召回」。

import type { StorageDir } from "../storage/types.ts";

/**
 * 存储端口 = 通用 StorageDir(哑文件面,memory / schedule 共用一个抽象)。
 * default 真盘实现 FileDir 在 core 内(storage/file-dir.ts),缺省根 ~/.echo/。
 */
export type MemoryDir = StorageDir;

type MemoryBase = {
  /** 分区名,harness 内唯一。 */
  readonly name: string;
  /** 在记忆树里的位置:resident 是一个文件("agent.md"),indexed 是一个目录("memory/",恒以 / 结尾)。 */
  readonly path: string;
  /** resident:全文字符上限;indexed:索引渲染后的字符上限。超限的写入被拒,要求模型先整理。 */
  readonly budget: number;
  /** 这份记忆存什么 / 不存什么——拼进 system 的记忆使用规则,是分层纪律的第一道门。 */
  readonly instructions: string;
};

/** 全文常驻 system(学 Hermes:小而关键,全量冻结注入)。 */
export type ResidentMemory = MemoryBase & { readonly mode: "resident" };

/** 索引常驻、正文按需(学 Claude Code:大而稀疏,索引召回)。 */
export type IndexedMemory = MemoryBase & {
  readonly mode: "indexed";
  /** 单文件字符上限。 */
  readonly fileBudget: number;
};

/** 内核认识的两种,闭合——内核只会两种「进 system」的方式。第三种方式 = 新机制,回设计。 */
export type Memory = ResidentMemory | IndexedMemory;

/**
 * 扩展位,与 CustomAgentMessages 同款:上层的记忆种类往里填(declaration merging,
 * 跨包用 `declare module "@echo-agent/core"`)。缺省分发函数认不出它 → 组装隐形、写入拒绝;
 * 要让它生效,替换 MemoryHarness 的 composeMemory / checkWrite(与 convertToLlm 同一个替换模式)。
 */
export interface CustomMemories {}

/** 自定义种类至少要有名字和判别符;有 path 才参与工具写入的路由。 */
export type MemoryShape = {
  readonly name: string;
  readonly mode: string;
  readonly path?: string;
  readonly instructions?: string;
};

export type AnyMemory = Memory | (CustomMemories[keyof CustomMemories] & MemoryShape);

/* ───────────────────────── 构造器与内建值 ───────────────────────── */

export function residentMemory(
  name: string,
  opts?: { path?: string; budget?: number; instructions?: string },
): ResidentMemory {
  return {
    mode: "resident",
    name,
    path: opts?.path ?? `${name}.md`,
    budget: opts?.budget ?? 2000,
    instructions: opts?.instructions ?? "",
  };
}

export function indexedMemory(
  name: string,
  opts?: { path?: string; budget?: number; fileBudget?: number; instructions?: string },
): IndexedMemory {
  const path = opts?.path ?? `${name}/`;
  if (!path.endsWith("/")) throw new Error(`an indexed memory region's path must end with / (a directory): '${path}'`);
  return {
    mode: "indexed",
    name,
    path,
    budget: opts?.budget ?? 25_000,
    fileBudget: opts?.fileBudget ?? 4096,
    instructions: opts?.instructions ?? "",
  };
}

/** agent 自己的稳定经验(预算量级取自 Hermes MEMORY.md 的 2200 chars)。 */
export const agentMemory: ResidentMemory = residentMemory("agent", {
  budget: 2200,
  instructions: "your own stable knowledge — environment facts, project conventions, tool quirks, lessons learned. Keep it dense; delete what is stale.",
});

/** 用户是谁(预算量级取自 Hermes USER.md 的 1375 chars)。 */
export const userMemory: ResidentMemory = residentMemory("user", {
  budget: 1400,
  instructions: "who the user is — identity, preferences, how they communicate, corrections they gave you. Keep it dense.",
});

/** 大而稀疏的知识仓库(索引 cap 取自 Claude Code MEMORY.md 的 25KB,单文件 4096 取其注入预算)。 */
export const notesMemory: IndexedMemory = indexedMemory("memory", {
  budget: 25_000,
  fileBudget: 4096,
  instructions:
    "knowledge worth keeping across sessions, one .md file per item, with frontmatter (name, description — the description decides whether you will find it again). " +
    "Only the index is shown in the system prompt; view a file to read it.",
});

/* ───────────────────────── 行为的函数类型(实现在 compose.ts) ───────────────────────── */

/**
 * indexed 分区的落盘索引文件名(CC 的 MEMORY.md 同款做法):由写方法在每次成功写入后重建。
 * 真源仍是那堆记忆文件——手改目录导致的过期会在下一次写入时自愈,直接改它则会被重建覆盖。
 */
export const MEMORY_INDEX_FILE = "INDEX.md";

export type WriteVerdict = { ok: true } | { ok: false; reason: string };

/** 一份记忆怎么进 system。契约:**绝不 throw**;"" = 这份没内容,不出段。 */
export type ComposeMemory = (memory: AnyMemory, dir: MemoryDir) => Promise<string>;

/** 一次写入(写完后的全文)能不能落。拒绝时 reason 原样回给模型——要说清怎么腾地方。 */
export type CheckWrite = (memory: AnyMemory, dir: MemoryDir, path: string, next: string) => Promise<WriteVerdict>;

/** path 归不归这份记忆管(工具按它路由写入)。 */
export function memoryOwns(m: AnyMemory, path: string): boolean {
  if (typeof m.path !== "string" || m.path === "") return false;
  if (m.path.endsWith("/")) return path.startsWith(m.path) && path.length > m.path.length;
  return path === m.path;
}
