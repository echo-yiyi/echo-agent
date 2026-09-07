// 记忆的数据形状。
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
import { MEMORY_SCOPES, isMemoryScope, orderScopes, splitScopePath, type MemoryScope } from "./scope.ts";

/**
 * 存储端口 = 通用 StorageDir(哑文件面,memory / schedule 共用一个抽象)。
 * default 真盘实现 FileDir 在 core 内(storage/file-dir.ts),缺省根 ~/.echo/。
 *
 * 三级作用域之后,交给 harness 的那一份是 `memoryScopeDir()` 出的**带作用域前缀的树**
 * (`user/…`、`project/…`、`session/…`),三个真根由装配层接上。
 */
export type MemoryDir = StorageDir;

type MemoryBase = {
  /** 分区名,harness 内唯一。**只是分区**(记的是什么),作用域是另一个轴。 */
  readonly name: string;
  /** 分区内的位置,**不带作用域前缀**:resident 是一个文件("agent.md"),indexed 是一个目录("memory/",恒以 / 结尾)。 */
  readonly path: string;
  /**
   * 这个分区在哪几层有(「切法」的落盘表):`agent` / `user` 两个分区是 user + project,
   * 笔记分区三层都有。落盘路径 = `<scope>/<path>`,同一分区每层各一份、各有各的预算。
   */
  readonly scopes: readonly MemoryScope[];
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

/** 自定义种类至少要有名字和判别符;有 path **且**有 scopes 才参与工具写入的路由。 */
export type MemoryShape = {
  readonly name: string;
  readonly mode: string;
  readonly path?: string;
  readonly scopes?: readonly MemoryScope[];
  readonly instructions?: string;
};

export type AnyMemory = Memory | (CustomMemories[keyof CustomMemories] & MemoryShape);

/* ───────────────────────── 构造器与内建值 ───────────────────────── */

/** 不点名作用域 = 只在 user 层(与三层引入前同形):多层是分区自己声明出来的,不是缺省长出来的。 */
const DEFAULT_SCOPES: readonly MemoryScope[] = ["user"];

export function residentMemory(
  name: string,
  opts?: { path?: string; budget?: number; scopes?: readonly MemoryScope[]; instructions?: string },
): ResidentMemory {
  return {
    mode: "resident",
    name,
    path: opts?.path ?? `${name}.md`,
    scopes: orderScopes(opts?.scopes ?? DEFAULT_SCOPES),
    budget: opts?.budget ?? 2000,
    instructions: opts?.instructions ?? "",
  };
}

export function indexedMemory(
  name: string,
  opts?: { path?: string; budget?: number; fileBudget?: number; scopes?: readonly MemoryScope[]; instructions?: string },
): IndexedMemory {
  const path = opts?.path ?? `${name}/`;
  if (!path.endsWith("/")) throw new Error(`an indexed memory region's path must end with / (a directory): '${path}'`);
  return {
    mode: "indexed",
    name,
    path,
    scopes: orderScopes(opts?.scopes ?? DEFAULT_SCOPES),
    budget: opts?.budget ?? 25_000,
    fileBudget: opts?.fileBudget ?? 4096,
    instructions: opts?.instructions ?? "",
  };
}

/** agent 自己的稳定经验(预算量级取自 Hermes MEMORY.md 的 2200 chars)。user + project 两层。 */
export const agentMemory: ResidentMemory = residentMemory("agent", {
  budget: 2200,
  scopes: ["user", "project"],
  instructions: "your own stable knowledge — environment facts, project conventions, tool quirks, lessons learned. Keep it dense; delete what is stale.",
});

/** 用户是谁(预算量级取自 Hermes USER.md 的 1375 chars)。user + project 两层。 */
export const userMemory: ResidentMemory = residentMemory("user", {
  budget: 1400,
  scopes: ["user", "project"],
  instructions: "who the user is — identity, preferences, how they communicate, corrections they gave you. Keep it dense.",
});

/**
 * 大而稀疏的知识仓库(索引 cap 取自 Claude Code MEMORY.md 的 25KB,单文件 4096 取其注入预算)。
 * **三层都有**,session 那一层是 dream 唯一整理的地方。
 */
export const notesMemory: IndexedMemory = indexedMemory("memory", {
  budget: 25_000,
  fileBudget: 4096,
  scopes: MEMORY_SCOPES,
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

/** 这个分区在哪几层有。自定义种类没声明 scopes = 不参与路由(与没有 path 同一条 fail-closed)。 */
export function memoryScopes(m: AnyMemory): readonly MemoryScope[] {
  const raw = (m as { scopes?: readonly string[] }).scopes;
  if (!Array.isArray(raw)) return [];
  return orderScopes(raw.filter(isMemoryScope));
}

/** 这个分区落盘的全部路径,按 user → project → session。`agent` → `["user/agent.md", "project/agent.md"]`。 */
export function memoryPaths(m: AnyMemory): readonly { scope: MemoryScope; path: string }[] {
  if (typeof m.path !== "string" || m.path === "") return [];
  return memoryScopes(m).map((scope) => ({ scope, path: `${scope}/${m.path as string}` }));
}

/**
 * path 归不归这份记忆管(工具按它路由写入)。收的是**带作用域前缀的全路径**。
 * 分区在那一层没有(比如 `session/agent.md`)就是不归——写入被拒并列出可用分区,
 * 这正是「session 层没有 agent.md」那条判红。
 */
export function memoryOwns(m: AnyMemory, path: string): boolean {
  if (typeof m.path !== "string" || m.path === "") return false;
  const at = splitScopePath(path);
  if (at === null || !memoryScopes(m).includes(at.scope)) return false;
  if (m.path.endsWith("/")) return at.rest.startsWith(m.path) && at.rest.length > m.path.length;
  return at.rest === m.path;
}
