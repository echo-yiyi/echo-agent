// 记忆的数据形状。
//
// 写法与 messages.ts 同构:**纯数据判别联合**(mode ↔ role)+ 扩展位 + 构造器;
// 行为(组装 / 写入校验)是外置的分发函数(compose.ts),认不出的种类组装时隐形。
// 记忆模块可 JSON 序列化,能直接写进配置文件——它是配置,不是对象机器。
//
// 两种 mode = 两种进 system 的方式(2026-08-05 用户拍定,参照 Hermes s10 / Claude Code s09):
//   resident 学 Hermes:小而关键,**全文常驻** system(每次 run 冻结快照);
//   indexed  学 Claude Code:大而稀疏,**索引常驻、正文按需**(模型用 memory 工具自取)。
// Hermes 那句格言是分界依据:「小而关键的全量冻结注入;大而稀疏的才索引召回」。
//
// **模块不点名层**(2026-09-07):`scopes` 不给 = 这个模块在**当前装配的每一层**都有。core 不认识
// 任何具体层名(那是产品声明的,见 scope.ts),所以内建模块也不能写死层名——不给就是正解。
// 产品自己的模块要限制在某几层时才点名,点到不存在的层 → 注册当场抛。

import type { StorageDir } from "../storage/types.ts";
import { orderScopes, splitScopePath, type MemoryScopeTable } from "./scope.ts";
import type { MemoryCommand } from "./tool-commands.ts";

/**
 * 存储端口 = 通用 StorageDir(哑文件面,memory / schedule 共用一个抽象)。
 * default 真盘实现 FileDir 在 core 内(storage/file-dir.ts),缺省根 ~/.echo/。
 *
 * 交给 harness 的那一份是 `memoryScopeDir()` 出的**带作用域前缀的树**(`<层名>/…`),
 * 各层的真根由装配层按 `MemoryAnchor` 解析后接上,而且是 **session 加载完才绑定**。
 */
export type MemoryDir = StorageDir;

type MemoryBase = {
  /** 模块名,harness 内唯一。**只是模块**(记的是什么),作用域是另一个轴。 */
  readonly name: string;
  /** 模块内的位置,**不带作用域前缀**:resident 是一个文件("agent.md"),indexed 是一个目录("memory/",恒以 / 结尾)。 */
  readonly path: string;
  /**
   * 这个模块在哪几层有。**不给 = 当前装配的每一层**;给了就只在点到的那几层,
   * 点到当前装配里没有的层名 → 注册当场抛(与撞名、路径重叠同一条 fail-loud)。
   * 落盘路径 = `<层名>/<path>`,同一模块每层各一份、各有各的预算。
   */
  readonly scopes?: readonly string[];
  /** resident:全文字符上限;indexed:索引渲染后的字符上限。超限的写入被拒,要求模型先整理。 */
  readonly budget: number;
  /** 这份记忆存什么 / 不存什么——拼进 system 的记忆使用规则,是分层纪律的第一道门。 */
  readonly instructions: string;
  /**
   * 归不归 dream 整理(2026-09-07 用户拍板:**模块自己声明**,不由 core 按 mode 判)。
   * agent 会把不属于某个模块的东西写进去乱放,及时归位是 dream 的职责之一。
   */
  readonly dream: boolean;
  /**
   * 这个模块支持哪些动词。不给则按 `mode` 取默认(见 tool-commands.ts)。
   * **只能收紧,不能放宽**——限制在工具面上保证,不靠 prompt 里说一句。
   */
  readonly ops?: readonly MemoryCommand[];
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
  readonly scopes?: readonly string[];
  readonly instructions?: string;
  readonly dream?: boolean;
  readonly ops?: readonly MemoryCommand[];
};

/**
 * 一个记忆模块的声明：内核认识的两种（`Memory`），或上层经 `CustomMemories` 填进来的自定义种类。
 * `AgentMemory.module()` 收的就是它——纯数据，不需要构造器；写入永远走 core 的唯一写路径。
 */
export type AnyMemory = Memory | (CustomMemories[keyof CustomMemories] & MemoryShape);

/* ───────────────────────── 构造器与内建值 ───────────────────────── */

export function residentMemory(
  name: string,
  opts?: { path?: string; budget?: number; scopes?: readonly string[]; instructions?: string; dream?: boolean; ops?: readonly MemoryCommand[] },
): ResidentMemory {
  return {
    mode: "resident",
    name,
    path: opts?.path ?? `${name}.md`,
    ...(opts?.scopes === undefined ? {} : { scopes: opts.scopes }),
    budget: opts?.budget ?? 2000,
    instructions: opts?.instructions ?? "",
    dream: opts?.dream ?? true,
    ...(opts?.ops === undefined ? {} : { ops: opts.ops }),
  };
}

export function indexedMemory(
  name: string,
  opts?: {
    path?: string;
    budget?: number;
    fileBudget?: number;
    scopes?: readonly string[];
    instructions?: string;
    dream?: boolean;
    ops?: readonly MemoryCommand[];
  },
): IndexedMemory {
  const path = opts?.path ?? `${name}/`;
  if (!path.endsWith("/")) throw new Error(`an indexed memory module's path must end with / (a directory): '${path}'`);
  return {
    mode: "indexed",
    name,
    path,
    ...(opts?.scopes === undefined ? {} : { scopes: opts.scopes }),
    budget: opts?.budget ?? 25_000,
    fileBudget: opts?.fileBudget ?? 4096,
    instructions: opts?.instructions ?? "",
    dream: opts?.dream ?? true,
    ...(opts?.ops === undefined ? {} : { ops: opts.ops }),
  };
}

/**
 * agent 自己**经常性的行为**(2026-09-07 用户重定语义:环境事实、项目约定这类**事实**
 * 下放到笔记模块,这里只留行为习惯)。预算量级取自 Hermes MEMORY.md 的 2200 chars。
 */
export const agentMemory: ResidentMemory = residentMemory("agent", {
  budget: 2200,
  instructions:
    "how you yourself tend to work here — habits worth repeating, approaches that went wrong, the shape of a good answer for this person. " +
    "Facts about the environment or the project belong in the notes module, not here. " +
    "Keep only what will still hold in a different session next month. Keep it short and dense.",
});

/** agent 对**这个用户**的认知(预算量级取自 Hermes USER.md 的 1375 chars)。 */
export const userMemory: ResidentMemory = residentMemory("user", {
  budget: 1400,
  instructions:
    "who the user is — identity, preferences, how they communicate, corrections they gave you. " +
    "Keep only what will still be true in a different session next month. Keep it dense.",
});

/**
 * 大而稀疏的知识仓库:**事实类记忆,以及「东西在哪找」**(2026-09-07 用户定的语义)。
 * 索引 cap 取自 Claude Code MEMORY.md 的 25KB,单文件 4096 取其注入预算。
 */
export const notesMemory: IndexedMemory = indexedMemory("memory", {
  budget: 25_000,
  fileBudget: 4096,
  instructions:
    "facts worth keeping across sessions, and where to find things. Worth keeping: the user corrected you or told you how they want you to work; " +
    "something that would trip you again (an environment quirk, a tool that behaves differently than its docs say); a decision that got settled, " +
    "with its reasoning; a fact you had to discover rather than read. Keep it only if it will still be true and useful in a different session next month. " +
    "Leave out progress on the current task (the transcript has it), anything the repository already states (layout, code, version history, its " +
    "instruction files), and anything true only inside this conversation. One fact per .md file, with frontmatter (name, description — the " +
    "description decides whether you will find it again); say why it matters, not just what happened. Only the index is shown in the system prompt; " +
    "view a file to read it.",
});

/* ───────────────────────── 行为的函数类型(实现在 compose.ts) ───────────────────────── */

/**
 * indexed 模块的落盘索引文件名(CC 的 MEMORY.md 同款做法):由写方法在每次成功写入后重建。
 * 真源仍是那堆记忆文件——手改目录导致的过期会在下一次写入时自愈,直接改它则会被重建覆盖。
 */
export const MEMORY_INDEX_FILE = "INDEX.md";

export type WriteVerdict = { ok: true } | { ok: false; reason: string };

/** 一份记忆怎么进 system。契约:**绝不 throw**;"" = 这份没内容,不出段。 */
export type ComposeMemory = (memory: AnyMemory, dir: MemoryDir, table: MemoryScopeTable) => Promise<string>;

/** 一次写入(写完后的全文)能不能落。拒绝时 reason 原样回给模型——要说清怎么腾地方。 */
export type CheckWrite = (memory: AnyMemory, dir: MemoryDir, path: string, next: string) => Promise<WriteVerdict>;

/**
 * 这个模块在哪几层有,**按表的 order**。不给 `scopes` = 每一层;
 * 给了就是交集(点到不存在的层由注册时的校验挡,这里只做交集,读取路径上不抛)。
 */
export function memoryScopes(table: MemoryScopeTable, m: AnyMemory): readonly string[] {
  const raw = (m as { scopes?: readonly string[] }).scopes;
  if (!Array.isArray(raw)) return table.entries.map((e) => e.def.name);
  return orderScopes(table, raw);
}

/** 这个模块声明里点名了哪几层(没点名 → undefined)。注册时的校验用它。 */
export function declaredScopes(m: AnyMemory): readonly string[] | undefined {
  const raw = (m as { scopes?: readonly string[] }).scopes;
  return Array.isArray(raw) ? raw : undefined;
}

/** 这个模块落盘的全部路径,按表的 order。 */
export function memoryPaths(table: MemoryScopeTable, m: AnyMemory): readonly { scope: string; path: string }[] {
  if (typeof m.path !== "string" || m.path === "") return [];
  return memoryScopes(table, m).map((scope) => ({ scope, path: `${scope}/${m.path as string}` }));
}

/**
 * path 归不归这个模块管(工具按它路由写入)。收的是**带作用域前缀的全路径**。
 * 模块在那一层没有就是不归——写入被拒并列出可用模块。
 */
export function memoryOwns(table: MemoryScopeTable, m: AnyMemory, path: string): boolean {
  if (typeof m.path !== "string" || m.path === "") return false;
  const at = splitScopePath(path);
  if (at === null || !memoryScopes(table, m).includes(at.scope)) return false;
  if (m.path.endsWith("/")) return at.rest.startsWith(m.path) && at.rest.length > m.path.length;
  return at.rest === m.path;
}
