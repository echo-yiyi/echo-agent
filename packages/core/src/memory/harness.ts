// MemoryHarness:记忆的操作面(与 SkillHarness / ToolHarness 平级的资源宿主)。
//
// 结构(2026-08-05 用户拍定):
//   **方法是唯一写路径,工具是薄壳**——view/create/strReplace/insert/delete/rename 是
//   harness 上的真方法;六动词工具逐个调它们。上层复写工具(比如自己的 remember),
//   里面调我们的 create 即可——计数、索引重建都在方法里,换工具断不了。
//   **拼 prompt 不归这里**——MemoryHarness 只管操作与数据;怎么进 system 是 prompt
//   组装层的设计,当前占位函数见 compose.ts 的 renderMemorySystem。
//
// 一致性(继承 Hermes 的取舍):盘上 read-after-write,system 快照任务边界刷新——
// run 中途写盘,工具立刻读得到;system 里的内容到下一次 run 才变,不破本 run 的 prompt cache。

import { errText } from "../errors.ts";
import type { AgentEvent, AgentListener } from "../events.ts";
import type { Diagnostic } from "../errors.ts";
import type { CapabilityFactSink } from "../observability/fact-sink.ts";
import type { MemoryFact, MemoryIndexOutcome, MemoryMutationStage, MemoryOperation } from "./observe.ts";

/** MemoryHarness 要 agent 给的**只有一件**：索引重建、写盘失败要能说出来。 */
export type MemoryDeps = { report?: (d: Diagnostic) => void };
import { PROMPT_ORDER, type PromptSection } from "../prompt/types.ts";
import { toolError, toolOk, type AgentToolResult, type ModelTool } from "../tools/types.ts";
import { defaultCheckWrite, defaultComposeMemory, indexEntries, renderIndex, renderMemorySystem } from "./compose.ts";
import {
  DEFAULT_DREAM_GATES,
  DREAM_LOCK_STALE_MS,
  defaultDreamPrompt,
  dreamStatePath,
  readDreamState,
  writeDreamState,
  type DreamGates,
  type DreamState,
} from "./dream.ts";
import { createMemoryTool, hasHiddenSegment, normalizeMemoryPath, type CreateMemoryToolOptions, type MemoryToolParams } from "./tool.ts";
import { lateBoundMemoryDir, splitScopePath, type LateBoundMemoryDir, type MemoryScopeTable } from "./scope.ts";
import { assertFresh, withMemoryFileLock } from "./lock.ts";
import {
  declaredScopes,
  MEMORY_INDEX_FILE,
  memoryOwns,
  memoryPaths,
  type AnyMemory,
  type CheckWrite,
  type ComposeMemory,
  type IndexedMemory,
  type MemoryDir,
} from "./types.ts";

export const MEMORY_KIND = "memory";

export type MemoryHarnessOptions = {
  /**
   * **传了 = 完全接管**:这些直接装上,`echo:memory` 那组内建模块不出场。
   * 不传 = 内建三个由 `echo:memory` 经 `AgentMemory.module()` 注册——与第三方同一条路
   * (2026-09-08,对齐压缩的 `builtin` 分法)。
   */
  memories?: readonly AnyMemory[];
  dream?: DreamGates;
  /** 替换组装分发(支持自定义 mode 时用)。 */
  composeMemory?: ComposeMemory;
  /** 替换写入校验分发。 */
  checkWrite?: CheckWrite;
  /** 透传给缺省工具工厂(description / 逐命令 handlers)。 */
  tool?: CreateMemoryToolOptions;
};

/**
 * 记忆的一整包:模块表 + 落盘口 + 组装/校验分发 + 闸 + 计数 + 回调。
 *
 * **为什么是复数 `AgentMemories`**:单数 `AgentMemory` 在领域模型里有主——
 * 它是「agent 自己那份记忆」(agentMemory 模块,与 userMemory / CustomMemories 并列,
 * 判别联合与 message 同构,见 types.ts)。容器不许抢模块的词(2026-08-05 用户指出)。
 *
 * **跟 background / mcp / schedule 同一个理由做成上下文而不是裸 Map**:它需要
 * 落盘口与 agent 侧回调,单靠一个 `Map<string, AnyMemory>` 表达不了（2026-08-05 用户拍定）。
 */
export type AgentMemories = MemoryDeps & {
  /** 模块表:装的是 `AnyMemory` 本体。 */
  memories: Map<string, AnyMemory>;
  /**
   * 记忆的字节面。**它是延迟绑定的**——作用域的根要等 session 从盘上加载完
   * (workspace / 角色 / 产品都是 session 级事实)才解析,绑定前任何读写都抛。
   */
  dir: MemoryDir;
  /** 作用域表的来源。`binding.bind(table)` 由装配层在 `start()` 里调一次。 */
  binding: LateBoundMemoryDir;
  composeFn: ComposeMemory;
  checkFn: CheckWrite;
  gates: DreamGates;
  toolOpts?: CreateMemoryToolOptions;
  /**
   * 内建那三个模块该不该由 `echo:memory` 注册。传了 `memories` = 完全接管 → false。
   * 放在这里而不是让装配方自己记:它是 `createAgentMemories` 那一刻就定了的事实。
   */
  builtinModules: boolean;
  /** 距上次 dream 的写次数 / 轮次——闸靠它判。 */
  writesSinceDream: number;
  turnsSinceDream: number;
  /**
   * 领域观测 sink（module-local、永不抛）：五种 mutation 的最外层与 compose 各发一次事实。
   * 没挂 = 不发。由 composition root / Agent 挂；工具与上层复写看不见它，也不该碰它。
   */
  observe?: CapabilityFactSink<MemoryFact>;
};

/** `dir` 必给（2026-08-17 起）：能力层不自带落盘默认件，理由见下方 doc comment。评测/单测传 InMemoryDir。 */
/**
 * **`dir` 必给，本层不自带落盘默认件**（2026-08-17，C12/D16）。
 *
 * 从前这里写 `dir ?? new FileDir(join(echoHome(), "memory"))`——一个「顺手带的默认实现」，
 * 代价是把 `node:fs`/`node:os` 拖进 `Agent` 的依赖闭包：能力层只该定义语义与端口，
 * 默认件属于装配层（「Agent 拥有 Service，外部注入 Store」）。
 *
 * 「默认落盘」不是没有了，是**上移**：M3 的 `await createAgent()`（async，D17）负责注入 FileDir。
 */
export function createAgentMemories(opts?: MemoryHarnessOptions): AgentMemories {
  const binding = lateBoundMemoryDir();
  const ctx: AgentMemories = {
    memories: new Map(),
    dir: binding.dir,
    binding,
    composeFn: opts?.composeMemory ?? defaultComposeMemory,
    checkFn: opts?.checkWrite ?? defaultCheckWrite,
    gates: opts?.dream ?? DEFAULT_DREAM_GATES,
    ...(opts?.tool !== undefined ? { toolOpts: opts.tool } : {}),
    builtinModules: opts?.memories === undefined,
    writesSinceDream: 0,
    turnsSinceDream: 0,
  };
  for (const m of opts?.memories ?? []) addMemory(ctx, m);
  return ctx;
}

/**
 * 作用域表就位:装配层在 `start()` 里 session 加载完之后调**一次**。
 * 这一刻才谈得上"这个模块点的层存不存在""两个模块的路径重不重叠"——绑定前没有层可查。
 */
export function bindMemoryScopes(ctx: AgentMemories, table: MemoryScopeTable): void {
  if (ctx.binding.bound()) return;
  ctx.binding.bind(table);
  for (const m of ctx.memories.values()) assertScopesResolve(ctx, m);
  const seen: AnyMemory[] = [];
  for (const m of ctx.memories.values()) {
    assertNoPathOverlap(ctx, m, seen);
    seen.push(m);
  }
}

/** 当前的作用域表;绑定前抛(那说明有人在 session 加载完之前碰记忆)。 */
export function memoryScopeTableOf(ctx: AgentMemories): MemoryScopeTable {
  return ctx.binding.table();
}

/* ───────────── 模块注册表(开的地方) ───────────── */

/**
 * 撞名 fail-loud。**路径重叠与层名合法性要等作用域表就位**——绑定之前没有层可查,
 * 所以那两项校验:绑定前注册的攒到 `bindMemoryScopes()` 一起做,绑定后注册的当场做。
 */
export function addMemory(ctx: AgentMemories, memory: AnyMemory): void {
  if (ctx.memories.has(memory.name)) {
    throw new Error(`记忆模块 '${memory.name}' 已存在;先 remove 再 add`);
  }
  if (ctx.binding.bound()) {
    assertScopesResolve(ctx, memory);
    assertNoPathOverlap(ctx, memory, [...ctx.memories.values()]);
  }
  ctx.memories.set(memory.name, memory);
}

/** 模块点名的层必须在本次装配里存在。点到不存在的 = 那部分记忆无声消失,所以 fail-loud。 */
function assertScopesResolve(ctx: AgentMemories, memory: AnyMemory): void {
  const declared = declaredScopes(memory);
  if (declared === undefined) return;
  const table = ctx.binding.table();
  const missing = declared.filter((s) => !table.byName.has(s));
  if (missing.length > 0) {
    const known = table.entries.map((e) => e.def.name).join(" / ") || "(本次装配没有任何记忆作用域)";
    throw new Error(`记忆模块 '${memory.name}' 点了本次装配里没有的作用域:${missing.join(", ")}(可用:${known})`);
  }
}

/** 路径重叠会让写入路由二义(一个 path 两个预算域)。比的是**带作用域的全路径**。 */
function assertNoPathOverlap(ctx: AgentMemories, memory: AnyMemory, against: readonly AnyMemory[]): void {
  const table = ctx.binding.table();
  for (const mine of memoryPaths(table, memory)) {
    for (const existing of against) {
      if (existing.name === memory.name) continue;
      for (const theirs of memoryPaths(table, existing)) {
        if (covers(theirs.path, mine.path) || covers(mine.path, theirs.path)) {
          throw new Error(`记忆模块路径重叠:'${memory.name}'(${mine.path}) 与 '${existing.name}'(${theirs.path})`);
        }
      }
    }
  }
}

export function removeMemoryRegion(ctx: AgentMemories, name: string): boolean {
  return ctx.memories.delete(name);
}

export function listMemories(ctx: AgentMemories): readonly AnyMemory[] {
  return [...ctx.memories.values()];
}

export function getMemory(ctx: AgentMemories, name: string): AnyMemory | undefined {
  return ctx.memories.get(name);
}

/** 写入路由:path 归哪个模块管。 */
export function memoryFor(ctx: AgentMemories, path: string): AnyMemory | undefined {
  const table = ctx.binding.table();
  for (const m of ctx.memories.values()) if (memoryOwns(table, m, path)) return m;
  return undefined;
}

/* ───────────── 操作方法:唯一写路径(工具与上层复写共用) ─────────────
   全部收相对路径(也认 /memories/ 前缀),内部统一 jail;绝不 throw,失败 = error 结果。 */

/** 看目录("" = 全部模块概览,目录以 / 结尾)或文件(带行号)。 */
export async function memoryView(ctx: AgentMemories, rawPath: string): Promise<AgentToolResult> {
  try {
    const path = normalizeMemoryPath(rawPath);
    if (path === "" || path.endsWith("/")) {
      // 点开头的段是内部状态(.dream/):jail 不许读写,列目录时也不许露出来
      const files = (await ctx.dir.list(path)).filter((f) => !hasHiddenSegment(f));
      if (path !== "") return toolOk(files.length > 0 ? files.join("\n") : `${path} (empty directory)`);
      // 概览:一个模块在每一层各一行,层的顺序就是作用域表的 order
      const lines: string[] = [];
      const table = ctx.binding.table();
      for (const m of ctx.memories.values()) {
        for (const { path: full } of memoryPaths(table, m)) {
          if (full.endsWith("/")) {
            const inside = files.filter((f) => f.startsWith(full));
            lines.push(`${full} (${inside.length} files)`);
            for (const f of inside) lines.push(`  ${f}`);
          } else {
            lines.push(`${full}${files.includes(full) ? "" : " (empty)"}`);
          }
        }
      }
      return toolOk(lines.length > 0 ? lines.join("\n") : "(no memories yet)");
    }
    const content = await ctx.dir.read(path);
    if (content === null) return toolError(`'${path}' does not exist`);
    return toolOk(content.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"));
  } catch (e) {
    return toolError(errText(e));
  }
}

/** 建/整文件覆写。上层自己的写入工具(remember 之类)最终都该落到这里。 */
export async function memoryCreate(ctx: AgentMemories, rawPath: string, text: string): Promise<AgentToolResult> {
  return writeMemory(ctx, "create", rawPath, async () => ({ ok: true, content: text }), (path, n) => `Wrote ${path} (${n} characters)`);
}

/** 把唯一出现的 oldStr 换成 newStr。零命中/多义都拒(为 LLM 设计的寻址协议)。 */
export async function memoryStrReplace(ctx: AgentMemories, rawPath: string, oldStr: string, newStr: string): Promise<AgentToolResult> {
  if (oldStr === "") {
    return finishMemoryMutation(ctx, { operation: "replace", path: pathForFact(rawPath), at: Date.now() }, rejected("empty_old_str", "str_replace needs old_str"));
  }
  return writeMemory(
    ctx,
    "replace",
    rawPath,
    async (path) => {
      const content = await ctx.dir.read(path);
      if (content === null) return reject("not_found", `'${path}' does not exist`);
      const hits = content.split(oldStr).length - 1;
      if (hits === 0) return reject("old_str_not_found", `old_str not found (view '${path}' first and copy the exact text)`);
      if (hits > 1) return reject("old_str_ambiguous", `old_str occurs ${hits} times; it must be unique, include more context`);
      return { ok: true, content: content.replace(oldStr, newStr), basedOn: content };
    },
    (path, n) => `Replaced one occurrence in ${path} (now ${n} characters)`,
  );
}

/** 在第 line 行之后插入(0 = 文件开头)。 */
export async function memoryInsert(ctx: AgentMemories, rawPath: string, line: number, text: string): Promise<AgentToolResult> {
  if (!Number.isInteger(line) || line < 0) {
    return finishMemoryMutation(ctx, { operation: "insert", path: pathForFact(rawPath), at: Date.now() }, rejected("bad_line", "insert_line must be an integer ≥ 0 (0 = start of file)"));
  }
  return writeMemory(
    ctx,
    "insert",
    rawPath,
    async (path) => {
      const content = await ctx.dir.read(path);
      if (content === null) return reject("not_found", `'${path}' does not exist (use create for a new file)`);
      const lines = content.split("\n");
      if (line > lines.length) return reject("line_out_of_range", `insert_line out of range: the file has only ${lines.length} lines`);
      lines.splice(line, 0, text);
      return { ok: true, content: lines.join("\n"), basedOn: content };
    },
    (path, n) => `Inserted after line ${line} of ${path} (now ${n} characters)`,
  );
}

export async function memoryDelete(ctx: AgentMemories, rawPath: string): Promise<AgentToolResult> {
  const at = Date.now();
  const norm = normalizeOrReject(rawPath);
  if (!norm.ok) return finishMemoryMutation(ctx, { operation: "delete", path: pathForFact(rawPath), at }, norm.verdict);
  const path = norm.path;
  const frame: MutationFrame = { operation: "delete", path, owner: memoryFor(ctx, path), at };
  if (path === "" || path.endsWith("/")) return finishMemoryMutation(ctx, frame, rejected("not_a_file", "delete needs a file path, not a directory"));
  const guard = guardIndexFile(path);
  if (guard !== null) return finishMemoryMutation(ctx, frame, rejected("index_file_protected", guard));
  return withMemoryFileLock(ctx, path, async () => {
    let removed: boolean;
    try {
      removed = await ctx.dir.remove(path);
    } catch (e) {
      return finishMemoryMutation(ctx, frame, failed("remove", errText(e)));
    }
    if (!removed) return finishMemoryMutation(ctx, frame, rejected("not_found", `'${path}' does not exist`));
    await bumpWriteCounter(ctx, path);
    const indexOutcome = await refreshIndex(ctx, frame.owner, path);
    return finishMemoryMutation(ctx, frame, committed(undefined, indexOutcome, `Deleted ${path}`));
  });
}

/**
 * 同模块内改名。跨模块 = 换预算域,不许静默发生——读出来在目标模块重新 create。
 *
 * **不复用公开的 `memoryCreate()`**：那会在 rename 之外再发一条 create 事实（「rename 内部不得双发」）。
 * 目标写成功、源删失败是 **partial**（带 stage），不能谎报 committed，也不能像从前那样报成整体失败。
 */
export async function memoryRename(ctx: AgentMemories, rawFrom: string, rawTo: string): Promise<AgentToolResult> {
  const at = Date.now();
  const normFrom = normalizeOrReject(rawFrom);
  if (!normFrom.ok) return finishMemoryMutation(ctx, { operation: "rename", path: pathForFact(rawFrom), toPath: pathForFact(rawTo), at }, normFrom.verdict);
  const normTo = normalizeOrReject(rawTo);
  if (!normTo.ok) return finishMemoryMutation(ctx, { operation: "rename", path: normFrom.path, toPath: pathForFact(rawTo), at }, normTo.verdict);
  const from = normFrom.path;
  const to = normTo.path;
  const fromOwner = memoryFor(ctx, from);
  const frame: MutationFrame = { operation: "rename", path: from, toPath: to, owner: fromOwner, at };
  if (to === "" || to.endsWith("/")) return finishMemoryMutation(ctx, frame, rejected("not_a_file", "new_path needs a file path"));
  const toOwner = memoryFor(ctx, to);
  if (fromOwner === undefined || toOwner === undefined || fromOwner.name !== toOwner.name) {
    return finishMemoryMutation(ctx, frame, rejected("cross_region", `rename must stay within one region (${String(fromOwner?.name)} → ${String(toOwner?.name)})`));
  }
  // 换层 = 换「谁看得见」,也换预算域:同样不许靠 rename 静默发生——读出来在目标层重新 create
  const fromScope = splitScopePath(from)?.scope;
  const toScope = splitScopePath(to)?.scope;
  if (fromScope !== toScope) {
    return finishMemoryMutation(
      ctx,
      frame,
      rejected("cross_scope", `rename must stay within one scope (${String(fromScope)} → ${String(toScope)}); create it in the other layer instead`),
    );
  }
  const guard = guardIndexFile(from) ?? guardIndexFile(to);
  if (guard !== null) return finishMemoryMutation(ctx, frame, rejected("index_file_protected", guard));
  // **只锁目标**（写入点）。两个都锁的话，两个方向相反的并发 rename 会互锁；
  // 源的删除是幂等的，最坏是留下一份副本，不会丢内容。
  return withMemoryFileLock(ctx, to, async () => {
  let content: string | null;
  let existing: string | null;
  try {
    content = await ctx.dir.read(from);
    existing = content === null ? null : await ctx.dir.read(to);
  } catch (e) {
    return finishMemoryMutation(ctx, frame, failed("read", errText(e)));
  }
  if (content === null) return finishMemoryMutation(ctx, frame, rejected("not_found", `'${from}' does not exist`));
  if (existing !== null) return finishMemoryMutation(ctx, frame, rejected("target_exists", `Target '${to}' already exists`));
  let verdict: Awaited<ReturnType<CheckWrite>>;
  try {
    verdict = await ctx.checkFn(fromOwner, ctx.dir, to, content);
  } catch (e) {
    return finishMemoryMutation(ctx, frame, failed("check", errText(e)));
  }
  if (!verdict.ok) return finishMemoryMutation(ctx, frame, rejected("budget_exceeded", verdict.reason));
  try {
    await ctx.dir.write(to, content);
  } catch (e) {
    return finishMemoryMutation(ctx, frame, failed("write", errText(e)));
  }
  await bumpWriteCounter(ctx, to);
  try {
    await ctx.dir.remove(from);
  } catch (e) {
    const indexOutcome = await refreshIndex(ctx, fromOwner, to);
    return finishMemoryMutation(ctx, frame, partial("remove-source", indexOutcome, `Renamed ${from} to ${to} but failed to remove the source: ${errText(e)}`));
  }
  const indexOutcome = await refreshIndex(ctx, fromOwner, to);
  return finishMemoryMutation(ctx, frame, committed(content.length, indexOutcome, `Renamed ${from} to ${to}`));
  });
}

/* ───────────── 记忆进 system 的段(格式在 compose.ts;由 echo:memory builtin 注册) ───────────── */

export function memoryPromptSections(ctx: AgentMemories): readonly PromptSection[] {
  return [
    {
      name: "memory",
      // 字节何时变:记忆文件变化后的**下一次 run**(冻结快照:run 内写盘不动本 run 的 system)。
      // 沉底(order 最大):它是最常变的段,变了只打掉自己之后的缓存。
      order: PROMPT_ORDER.memory,
      render: () => renderMemorySystem(ctx),
    },
  ];
}

/* ───────────── 给 prompt 组装层的数据面(只读) ───────────── */

/** 一个模块怎么呈现,走可替换的组装分发。绝不 throw:坏模块隐形 + report 留痕。 */
export async function composeMemoryRegion(ctx: AgentMemories, memory: AnyMemory): Promise<string> {
  try {
    return await ctx.composeFn(memory, ctx.dir, ctx.binding.table());
  } catch (e) {
    ctx.report?.({
      code: "memory_compose_failed",
      message: errText(e),
      ...(typeof memory.path === "string" ? { path: memory.path } : {}),
    });
    return "";
  }
}

/** 缺省 memory 工具(六动词薄壳,逐个调上面的方法)。Agent 构造时注册(source "memory")。 */
export function memoryTool(ctx: AgentMemories): ModelTool<MemoryToolParams> {
  return createMemoryTool(ctx, ctx.toolOpts);
}

/* ───────────── Dream:判断归 harness,触发与执行归 core(Agent 的独立通道) ───────────── */

/**
 * 每个 (`AgentMemories`, 层) 一条**状态更新串行链**。
 *
 * 为什么需要:`.dream/state.json` 的每次更新都是读改写,而**「单写者」防的是跨进程,
 * 防不了同一个 Agent 里的并发**——两个 `memoryCreate()` 并发时会双双读到 `writes = 0`、
 * 双双写回 1,最终少计一次(实测用 barrier 确定性复现)。计数少了,
 * `minWritesSinceLast` 就迟迟不满足,整理被推迟甚至不触发。
 *
 * 放在 `WeakMap` 而不是 `AgentMemories` 的字段上:它是实现细节,不该进公共类型。
 * 按层分链:两层的状态是两个文件,没有互相串行的理由。
 */
const dreamStateChain = new WeakMap<AgentMemories, Map<string, Promise<unknown>>>();

/**
 * 原子地读改写某一层的 dream 状态:**同一个 ctx 的同一层上,更新彼此串行**。
 * `mutate` 拿到的一定是上一次更新之后的盘上值。
 */
async function updateDreamState(
  ctx: AgentMemories,
  scope: string,
  mutate: (current: DreamState) => DreamState,
): Promise<DreamState> {
  let chains = dreamStateChain.get(ctx);
  if (chains === undefined) {
    chains = new Map();
    dreamStateChain.set(ctx, chains);
  }
  const prev = chains.get(scope) ?? Promise.resolve();
  // 前一次失败不该堵死后面的更新,所以两个分支都接上 work
  const run = prev.then(doUpdate, doUpdate);
  // 链上留一份吞掉错误的,免得别人 await 到一个 rejected 的前驱
  chains.set(scope, run.catch(() => undefined));
  return run;

  async function doUpdate(): Promise<DreamState> {
    const next = mutate(await readDreamState(ctx.dir, scope));
    await writeDreamState(ctx.dir, scope, next);
    return next;
  }
}

/**
 * 哪几层要整理:声明了 `dream` 的模块所覆盖的层,按表的 order。
 * 没有任何模块声明 dream = 空,整理这件事就不发生。
 */
export function dreamScopes(ctx: AgentMemories): readonly string[] {
  const table = ctx.binding.table();
  const want = new Set<string>();
  for (const m of ctx.memories.values()) {
    if (m.dream !== true) continue;
    for (const { scope } of memoryPaths(table, m)) want.add(scope);
  }
  return table.entries.map((e) => e.def.name).filter((n) => want.has(n));
}

/**
 * 轮次计数的入口。**`Agent` 装了记忆就自动订阅**(构造期),不需要装配方记得这一步——
 * 忘了订阅的后果是 `minTurnsSinceLast` 这道门永远不满足,而且**静默**:
 * 看起来配了轮次门,实际它从来没起过作用(实测过)。
 *
 * 轮数是全局事实(一次 `turn_end` 就是一轮),所以**每个要整理的层各记一次**。
 * 计数落盘,所以这是个 async listener(`AgentListener` 允许返回 Promise,emit 会 await)。
 * 落盘失败只报诊断——整理是 best-effort,不该让前台那一轮跟着失败。
 */
export function memoryObserver(ctx: AgentMemories): AgentListener {
  return async (event: AgentEvent) => {
    if (event.type !== "turn_end") return;
    if (!ctx.binding.bound()) return; // session 还没加载完,没有层可记
    try {
      for (const scope of dreamScopes(ctx)) {
        await updateDreamState(ctx, scope, (s) => ({ ...s, turns: s.turns + 1 }));
      }
      ctx.turnsSinceDream += 1;
    } catch (e) {
      ctx.report?.({ code: "dream_counter_persist_failed", message: errText(e) });
    }
  };
}

/** 某一层的写入计数 +1。**必须走串行链**——并发读改写会丢更新(见 `updateDreamState` 的注释)。 */
async function bumpWriteCount(ctx: AgentMemories, scope: string): Promise<void> {
  await updateDreamState(ctx, scope, (s) => ({ ...s, writes: s.writes + 1 }));
}

/**
 * 这一层某个模块的预算用掉多少(0..1,取各模块的最大值)。水位门按它判。
 * resident 按全文字符数,indexed 按索引渲染后的字符数——与 `checkWrite` 同一把尺。
 */
async function budgetPressure(ctx: AgentMemories, scope: string): Promise<number> {
  const table = ctx.binding.table();
  let worst = 0;
  for (const m of ctx.memories.values()) {
    if (m.dream !== true) continue;
    const budget = "budget" in m && typeof m.budget === "number" ? m.budget : 0;
    if (budget <= 0) continue;
    for (const { scope: s, path } of memoryPaths(table, m)) {
      if (s !== scope) continue;
      let used = 0;
      if (path.endsWith("/")) {
        const stored = await ctx.dir.read(`${path}${MEMORY_INDEX_FILE}`);
        used = stored === null ? renderIndex(await indexEntries(m as IndexedMemory, ctx.dir, scope)).length : stored.length;
      } else {
        used = ((await ctx.dir.read(path)) ?? "").length;
      }
      worst = Math.max(worst, used / budget);
    }
  }
  return worst;
}

/**
 * 纯判断,无副作用。**节流四道全满足,或者水位单独到线**——两组门语义相反,不做 AND
 * (见 `DreamGates.budgetRatio` 的注释)。
 */
export async function shouldDream(ctx: AgentMemories, scope: string): Promise<boolean> {
  const state = await readDreamState(ctx.dir, scope);
  // 盘上那份是真相源；顺手把内存镜像刷成**刚查的这一层**的值（新进程起来时它是 0）。
  // 按层之后这两个字段就只是"最近查过的那层"的快照，诊断用，不参与判断。
  ctx.writesSinceDream = state.writes;
  ctx.turnsSinceDream = state.turns;
  const now = Date.now();
  if (state.startedAt !== null && now - state.startedAt < DREAM_LOCK_STALE_MS) return false; // 这一层有一次整理进行中
  const g = ctx.gates;
  // 水位:告警,单独成立
  if (g.budgetRatio !== undefined && (await budgetPressure(ctx, scope)) >= g.budgetRatio) return true;
  // 节流:四道全满足
  if (g.minIntervalMs !== undefined && state.lastAt !== null && now - state.lastAt < g.minIntervalMs) return false;
  if (g.minWritesSinceLast !== undefined && state.writes < g.minWritesSinceLast) return false;
  if (g.minTurnsSinceLast !== undefined && state.turns < g.minTurnsSinceLast) return false;
  if (g.minFiles !== undefined) {
    // **只数这一层**:整理的范围就这一层,拿别的层的文件数来开这道门是把门开在别人身上
    const table = ctx.binding.table();
    let files = 0;
    for (const m of ctx.memories.values()) {
      if (m.dream !== true) continue;
      for (const { scope: s, path } of memoryPaths(table, m)) {
        if (s !== scope || !path.endsWith("/")) continue;
        const found = await ctx.dir.list(path);
        files += found.filter((f) => !f.endsWith(`/${MEMORY_INDEX_FILE}`)).length; // 索引不是一条记忆
      }
    }
    if (files < g.minFiles) return false;
  }
  return true;
}

/**
 * 备某一层整理任务的料并上锁。拿去派一个**只带这套工具**的子循环;跑完调 markDreamed()。
 *
 * 工具是**限定在这一层**的那一把(不是前台那把):别的层不在这次整理的范围里。
 * 限定在工具上而不是只写进 prompt 里——后者是纪律,前者才是门。
 */
export async function dreamTask(ctx: AgentMemories, scope: string): Promise<{ prompt: string; tools: ModelTool[] }> {
  // 上锁也走串行链:它是同一份状态的读改写,和计数并发时会互相盖掉
  await updateDreamState(ctx, scope, (s) => ({ ...s, startedAt: Date.now() }));
  return {
    prompt: defaultDreamPrompt(listMemories(ctx), ctx.binding.table(), scope),
    tools: [createMemoryTool(ctx, { ...ctx.toolOpts, scope })],
  };
}

/** 某一层整理成功后:记时间、放锁、清计数。整理失败不调它——锁 1 小时后自动过期。 */
export async function markDreamed(ctx: AgentMemories, scope: string): Promise<void> {
  // 清零同样走串行链:不然「读到 5 → markDreamed 清 0 → 写回 6」会把计数复活
  await updateDreamState(ctx, scope, () => ({ lastAt: Date.now(), startedAt: null, writes: 0, turns: 0 }));
}

/* ───────────── AgentHarness 基座 ───────────── */


export async function disposeMemory(ctx: AgentMemories): Promise<void> {
  await ctx.dir.close?.();
}

/* ───────────── 私有：mutation 骨架（typed outcome → 观测事实 → AgentToolResult） ─────────────
   先形成 typed outcome，再投影成现有 AgentToolResult；不能靠解析成功 / 错误字符串猜阶段。
   semantic guard / not-found = rejected；primary I/O 抛错且未改数据 = failed；改了一半 = partial（带 stage）。 */

type MutationFrame = {
  operation: MemoryOperation;
  path: string;
  toPath?: string;
  owner?: AnyMemory;
  at: number;
};

type MutationVerdict =
  | { outcome: "committed"; chars: number | undefined; indexOutcome: MemoryIndexOutcome; text: string }
  | { outcome: "rejected"; reasonCode: string; message: string }
  | { outcome: "failed"; stage: MemoryMutationStage; message: string }
  | { outcome: "partial"; stage: MemoryMutationStage; indexOutcome: MemoryIndexOutcome; message: string };

type Prepared =
  /** `basedOn` = 这次写基于的那份旧内容;不给 = 整文件覆写 / 新建,没什么可校验的。 */
  | { ok: true; content: string; basedOn?: string }
  | { ok: false; reasonCode: string; message: string };

function reject(reasonCode: string, message: string): Prepared {
  return { ok: false, reasonCode, message };
}
function rejected(reasonCode: string, message: string): MutationVerdict {
  return { outcome: "rejected", reasonCode, message };
}
function failed(stage: MemoryMutationStage, message: string): MutationVerdict {
  return { outcome: "failed", stage, message };
}
function partial(stage: MemoryMutationStage, indexOutcome: MemoryIndexOutcome, message: string): MutationVerdict {
  return { outcome: "partial", stage, indexOutcome, message };
}
function committed(chars: number | undefined, indexOutcome: MemoryIndexOutcome, text: string): MutationVerdict {
  return { outcome: "committed", chars, indexOutcome, text };
}

/** jail 校验：非法路径是 semantic reject，不是 I/O failure。 */
function normalizeOrReject(raw: string): { ok: true; path: string } | { ok: false; verdict: MutationVerdict } {
  try {
    return { ok: true, path: normalizeMemoryPath(raw) };
  } catch (e) {
    return { ok: false, verdict: rejected("invalid_path", errText(e)) };
  }
}

/** 还没走到 jail 就拒了的 mutation：事实里的 path 尽力 normalize，normalize 不了就原样（只进 digest / content）。 */
function pathForFact(raw: string): string {
  try {
    return normalizeMemoryPath(raw);
  } catch {
    return raw;
  }
}

/**
 * **唯一 emission point**：五种 mutation 在 semantic reject、primary storage settle、index refresh outcome
 * 都已知之后到这里，恰发一次事实，再投影成 `AgentToolResult`。sink 按契约永不抛，这里再兜一层。
 */
function finishMemoryMutation(ctx: AgentMemories, frame: MutationFrame, verdict: MutationVerdict): AgentToolResult {
  const fact: MemoryFact = {
    kind: "mutation",
    operation: frame.operation,
    outcome: verdict.outcome,
    path: frame.path,
    ...(frame.toPath === undefined ? {} : { toPath: frame.toPath }),
    ...(frame.owner === undefined ? {} : { partition: frame.owner.name, mode: String(frame.owner.mode) }),
    ...(verdict.outcome === "committed" && verdict.chars !== undefined ? { chars: verdict.chars } : {}),
    ...(verdict.outcome === "failed" || verdict.outcome === "partial" ? { stage: verdict.stage } : {}),
    ...(verdict.outcome === "committed" || verdict.outcome === "partial" ? { indexOutcome: verdict.indexOutcome } : {}),
    ...(verdict.outcome === "rejected" ? { reasonCode: verdict.reasonCode } : {}),
    ...(verdict.outcome === "committed" ? {} : { message: verdict.message }),
    occurredAt: frame.at,
  };
  try {
    ctx.observe?.offer(fact);
  } catch {
    // sink 契约是 never-throw；真抛了也不能改变 mutation 的结果
  }
  return verdict.outcome === "committed" ? toolOk(verdict.text) : toolError(verdict.message);
}

/**
 * 写入计数落盘,**记在被写的那一层**(与轮次同一个理由:只在内存的话重启就归零)。
 * 整理是按层各整理各的,计数自然也按层——写 user 层不该把 project 层的门往前推。
 * 落盘失败不该把已经成功的写变成失败,只报诊断。
 */
async function bumpWriteCounter(ctx: AgentMemories, path: string): Promise<void> {
  const scope = splitScopePath(path)?.scope;
  if (scope === undefined) return;
  try {
    await bumpWriteCount(ctx, scope);
    ctx.writesSinceDream += 1;
  } catch (e) {
    ctx.report?.({ code: "dream_counter_persist_failed", message: errText(e) });
  }
}

/** 写入的公共骨架:jail → 索引文件保护 → 路由模块 → 备内容 → checkWrite → 落盘 → 计数 + 重建索引 → 发事实。 */
async function writeMemory(
  ctx: AgentMemories,
  operation: MemoryOperation,
  rawPath: string,
  prepare: (path: string) => Promise<Prepared>,
  okText: (path: string, chars: number) => string,
): Promise<AgentToolResult> {
  const at = Date.now();
  const norm = normalizeOrReject(rawPath);
  if (!norm.ok) return finishMemoryMutation(ctx, { operation, path: pathForFact(rawPath), at }, norm.verdict);
  const path = norm.path;
  const frame: MutationFrame = { operation, path, at };
  if (path === "" || path.endsWith("/")) return finishMemoryMutation(ctx, frame, rejected("not_a_file", "a file path is required, not a directory"));
  const guard = guardIndexFile(path);
  if (guard !== null) return finishMemoryMutation(ctx, frame, rejected("index_file_protected", guard));
  const owner = memoryFor(ctx, path);
  if (owner === undefined) {
    return finishMemoryMutation(ctx, frame, rejected("outside_regions", `Path '${path}' is not inside any memory region. Regions: ${describeRegions(ctx)}`));
  }
  frame.owner = owner;
  // **「读—改—写」整段进锁**:同一进程里的前台、提取、整理三个写者对同一个文件真互斥。
  // 跨进程那一半靠落盘前的 `assertFresh`——两者合起来才是"读改写不被插队"(memory/lock.ts)。
  return withMemoryFileLock(ctx, path, async () => {
    let prepared: Prepared;
    try {
      prepared = await prepare(path);
    } catch (e) {
      return finishMemoryMutation(ctx, frame, failed("read", errText(e)));
    }
    if (!prepared.ok) return finishMemoryMutation(ctx, frame, rejected(prepared.reasonCode, prepared.message));
    let verdict: Awaited<ReturnType<CheckWrite>>;
    try {
      verdict = await ctx.checkFn(owner, ctx.dir, path, prepared.content);
    } catch (e) {
      return finishMemoryMutation(ctx, frame, failed("check", errText(e)));
    }
    if (!verdict.ok) return finishMemoryMutation(ctx, frame, rejected("budget_exceeded", verdict.reason));
    // 别的进程在这几毫秒里改过同一个文件 → **拒绝而不是覆盖**:无声吃掉别人一条记忆
    // 是查不出来的丢失,让模型重看一次再改便宜得多。
    let fresh: Awaited<ReturnType<typeof assertFresh>>;
    try {
      fresh = await assertFresh(ctx.dir, path, prepared.basedOn);
    } catch (e) {
      return finishMemoryMutation(ctx, frame, failed("read", errText(e)));
    }
    if (!fresh.fresh) return finishMemoryMutation(ctx, frame, rejected("stale_read", fresh.reason));
    try {
      await ctx.dir.write(path, prepared.content);
    } catch (e) {
      return finishMemoryMutation(ctx, frame, failed("write", errText(e)));
    }
    await bumpWriteCounter(ctx, path);
    const indexOutcome = await refreshIndex(ctx, owner, path);
    return finishMemoryMutation(ctx, frame, committed(prepared.content.length, indexOutcome, okText(path, prepared.content.length)));
  });
}

/** INDEX.md 由系统维护(写方法重建),不许直接写——直接改会被下一次重建覆盖,等于白改。返回拒绝原文。 */
function guardIndexFile(path: string): string | null {
  if (path.endsWith(`/${MEMORY_INDEX_FILE}`)) {
    return `${MEMORY_INDEX_FILE} is the system-maintained index and cannot be edited directly; edit the memory files and the index is rebuilt`;
  }
  return null;
}

/**
 * indexed 模块的落盘索引:每次写方法成功后重建(CC 的 MEMORY.md 同款)。
 * **只重建被写的那一层**——索引一层一份,别的层是别的 session 在写的,不该被这次写入顺手覆盖。
 * 保持 no-throw + report，但把结果交出去：主 mutation 仍 committed，`indexOutcome:"failed"` 必须可见。
 */
async function refreshIndex(ctx: AgentMemories, owner: AnyMemory | undefined, path: string): Promise<MemoryIndexOutcome> {
  if (owner === undefined || owner.mode !== "indexed") return "not-applicable";
  const im = owner as IndexedMemory;
  const scope = splitScopePath(path)?.scope;
  if (scope === undefined) return "not-applicable";
  const dirPath = `${scope}/${im.path}`;
  try {
    const entries = await indexEntries(im, ctx.dir, scope);
    await ctx.dir.write(`${dirPath}${MEMORY_INDEX_FILE}`, renderIndex(entries));
    return "ok";
  } catch (e) {
    ctx.report?.({ code: "memory_index_rebuild_failed", message: errText(e), path: dirPath });
    return "failed";
  }
}

function describeRegions(ctx: AgentMemories): string {
  const table = ctx.binding.table();
  return [...ctx.memories.values()]
    .map((m) => ({ m, paths: memoryPaths(table, m).map((p) => p.path) }))
    .filter((r) => r.paths.length > 0)
    .map((r) => `${r.m.name} (${r.paths.join(", ")})`)
    .join(", ");
}

/** a 覆盖 b:a 是目录且 b 落在其下,或两者同路径。 */
function covers(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith("/") && b.startsWith(a);
}
