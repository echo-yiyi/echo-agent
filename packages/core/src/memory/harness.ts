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
  DREAM_SCOPE,
  defaultDreamPrompt,
  readDreamState,
  writeDreamState,
  type DreamGates,
  type DreamState,
} from "./dream.ts";
import { createMemoryTool, hasHiddenSegment, normalizeMemoryPath, type CreateMemoryToolOptions, type MemoryToolParams } from "./tool.ts";
import { splitScopePath } from "./scope.ts";
import {
  agentMemory,
  MEMORY_INDEX_FILE,
  notesMemory,
  userMemory,
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
  /** 不传 = 内建三层(agent / user / memory)。传了 = 完全接管,内建一个都不带。 */
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
 * 记忆的一整包:分区表 + 落盘口 + 组装/校验分发 + 闸 + 计数 + 回调。
 *
 * **为什么是复数 `AgentMemories`**:单数 `AgentMemory` 在领域模型里有主——
 * 它是「agent 自己那份记忆」(agentMemory 分区,与 userMemory / CustomMemories 并列,
 * 判别联合与 message 同构,见 types.ts)。容器不许抢分区的词(2026-08-05 用户指出)。
 *
 * **跟 background / mcp / schedule 同一个理由做成上下文而不是裸 Map**:它需要
 * 落盘口与 agent 侧回调,单靠一个 `Map<string, AnyMemory>` 表达不了（2026-08-05 用户拍定）。
 */
export type AgentMemories = MemoryDeps & {
  /** 分区表:装的是 `AnyMemory` 本体。 */
  memories: Map<string, AnyMemory>;
  dir: MemoryDir;
  composeFn: ComposeMemory;
  checkFn: CheckWrite;
  gates: DreamGates;
  toolOpts?: CreateMemoryToolOptions;
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
export function createAgentMemories(dir: MemoryDir, opts?: MemoryHarnessOptions): AgentMemories {
  const ctx: AgentMemories = {
    memories: new Map(),
    dir,
    composeFn: opts?.composeMemory ?? defaultComposeMemory,
    checkFn: opts?.checkWrite ?? defaultCheckWrite,
    gates: opts?.dream ?? DEFAULT_DREAM_GATES,
    ...(opts?.tool !== undefined ? { toolOpts: opts.tool } : {}),
    writesSinceDream: 0,
    turnsSinceDream: 0,
  };
  for (const m of opts?.memories ?? [agentMemory, userMemory, notesMemory]) addMemory(ctx, m);
  return ctx;
}

/* ───────────── 分区注册表(开的地方) ───────────── */

/**
 * 撞名与**路径重叠**都 fail-loud——重叠会让写入路由二义(一个 path 两个预算域)。
 * 比的是**带作用域的全路径**:同一个分区内路径只要不在同一层就不重叠。
 */
export function addMemory(ctx: AgentMemories, memory: AnyMemory): void {
  if (ctx.memories.has(memory.name)) {
    throw new Error(`记忆分区 '${memory.name}' 已存在;先 remove 再 add`);
  }
  for (const mine of memoryPaths(memory)) {
    for (const existing of ctx.memories.values()) {
      for (const theirs of memoryPaths(existing)) {
        if (covers(theirs.path, mine.path) || covers(mine.path, theirs.path)) {
          throw new Error(`记忆分区路径重叠:'${memory.name}'(${mine.path}) 与 '${existing.name}'(${theirs.path})`);
        }
      }
    }
  }
  ctx.memories.set(memory.name, memory);
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

/** 写入路由:path 归哪个分区管。 */
export function memoryFor(ctx: AgentMemories, path: string): AnyMemory | undefined {
  for (const m of ctx.memories.values()) if (memoryOwns(m, path)) return m;
  return undefined;
}

/* ───────────── 操作方法:唯一写路径(工具与上层复写共用) ─────────────
   全部收相对路径(也认 /memories/ 前缀),内部统一 jail;绝不 throw,失败 = error 结果。 */

/** 看目录("" = 全部分区概览,目录以 / 结尾)或文件(带行号)。 */
export async function memoryView(ctx: AgentMemories, rawPath: string): Promise<AgentToolResult> {
  try {
    const path = normalizeMemoryPath(rawPath);
    if (path === "" || path.endsWith("/")) {
      // 点开头的段是内部状态(.dream/):jail 不许读写,列目录时也不许露出来
      const files = (await ctx.dir.list(path)).filter((f) => !hasHiddenSegment(f));
      if (path !== "") return toolOk(files.length > 0 ? files.join("\n") : `${path} (empty directory)`);
      // 概览:一个分区在每一层各一行,顺序 user → project → session
      const lines: string[] = [];
      for (const m of ctx.memories.values()) {
        for (const { path: full } of memoryPaths(m)) {
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
      return { ok: true, content: content.replace(oldStr, newStr) };
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
      return { ok: true, content: lines.join("\n") };
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
  let removed: boolean;
  try {
    removed = await ctx.dir.remove(path);
  } catch (e) {
    return finishMemoryMutation(ctx, frame, failed("remove", errText(e)));
  }
  if (!removed) return finishMemoryMutation(ctx, frame, rejected("not_found", `'${path}' does not exist`));
  await bumpWriteCounter(ctx);
  const indexOutcome = await refreshIndex(ctx, frame.owner, path);
  return finishMemoryMutation(ctx, frame, committed(undefined, indexOutcome, `Deleted ${path}`));
}

/**
 * 同分区内改名。跨分区 = 换预算域,不许静默发生——读出来在目标分区重新 create。
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
  await bumpWriteCounter(ctx);
  try {
    await ctx.dir.remove(from);
  } catch (e) {
    const indexOutcome = await refreshIndex(ctx, fromOwner, to);
    return finishMemoryMutation(ctx, frame, partial("remove-source", indexOutcome, `Renamed ${from} to ${to} but failed to remove the source: ${errText(e)}`));
  }
  const indexOutcome = await refreshIndex(ctx, fromOwner, to);
  return finishMemoryMutation(ctx, frame, committed(content.length, indexOutcome, `Renamed ${from} to ${to}`));
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

/** 一个分区怎么呈现,走可替换的组装分发。绝不 throw:坏分区隐形 + report 留痕。 */
export async function composeMemoryRegion(ctx: AgentMemories, memory: AnyMemory): Promise<string> {
  try {
    return await ctx.composeFn(memory, ctx.dir);
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

/* ───────────── Dream:判断归 harness,触发与执行归 core(Agent) ───────────── */

/**
 * 每个 `AgentMemories` 一条**状态更新串行链**。
 *
 * 为什么需要：`.dream/state.json` 的每次更新都是读改写，而**「单写者」防的是跨进程，
 * 防不了同一个 Agent 里的并发**——两个 `memoryCreate()` 并发时会双双读到 `writes = 0`、
 * 双双写回 1，最终少计一次（实测用 barrier 确定性复现）。计数少了，
 * `minWritesSinceLast` 就迟迟不满足，整理被推迟甚至不触发。
 *
 * 放在 `WeakMap` 而不是 `AgentMemories` 的字段上：它是实现细节，不该进公共类型。
 */
const dreamStateChain = new WeakMap<AgentMemories, Promise<unknown>>();

/**
 * 原子地读改写 dream 状态：**同一个 ctx 上的更新彼此串行**。
 * `mutate` 拿到的一定是上一次更新之后的盘上值。
 */
async function updateDreamState(
  ctx: AgentMemories,
  mutate: (current: DreamState) => DreamState,
): Promise<DreamState> {
  const prev = dreamStateChain.get(ctx) ?? Promise.resolve();
  // 前一次失败不该堵死后面的更新，所以两个分支都接上 work
  const run = prev.then(doUpdate, doUpdate);
  // 链上留一份吞掉错误的，免得别人 await 到一个 rejected 的前驱
  dreamStateChain.set(ctx, run.catch(() => undefined));
  return run;

  async function doUpdate(): Promise<DreamState> {
    const next = mutate(await readDreamState(ctx.dir));
    await writeDreamState(ctx.dir, next);
    ctx.writesSinceDream = next.writes;
    ctx.turnsSinceDream = next.turns;
    return next;
  }
}

/**
 * 轮次计数的入口。**`Agent` 装了记忆就自动订阅**（构造期），不需要装配方记得这一步——
 * 忘了订阅的后果是 `minTurnsSinceLast` 这道门永远不满足，而且**静默**：
 * 看起来配了轮次门，实际它从来没起过作用（实测过）。
 *
 * 计数落盘，所以这是个 async listener（`AgentListener` 允许返回 Promise，emit 会 await）。
 * 落盘失败只报诊断——整理是 best-effort，不该让前台那一轮跟着失败。
 */
export function memoryObserver(ctx: AgentMemories): AgentListener {
  return async (event: AgentEvent) => {
    if (event.type !== "turn_end") return;
    try {
      await bumpDreamCounters(ctx, { turns: 1 });
    } catch (e) {
      ctx.report?.({ code: "dream_counter_persist_failed", message: errText(e) });
    }
  };
}

/** 计数落盘。**必须走串行链**——并发读改写会丢更新（见 `updateDreamState` 的注释）。 */
async function bumpDreamCounters(ctx: AgentMemories, by: { writes?: number; turns?: number }): Promise<void> {
  await updateDreamState(ctx, (s) => ({
    ...s,
    writes: s.writes + (by.writes ?? 0),
    turns: s.turns + (by.turns ?? 0),
  }));
}

/** 纯判断,无副作用。全部已配置的门都满足才 true。 */
export async function shouldDream(ctx: AgentMemories): Promise<boolean> {
  const state = await readDreamState(ctx.dir);
  // 盘上那份是真相源；顺手把内存镜像刷成一致（新进程起来时它是 0）
  ctx.writesSinceDream = state.writes;
  ctx.turnsSinceDream = state.turns;
  const now = Date.now();
  if (state.startedAt !== null && now - state.startedAt < DREAM_LOCK_STALE_MS) return false; // 有一次整理进行中
  const g = ctx.gates;
  if (g.minIntervalMs !== undefined && state.lastAt !== null && now - state.lastAt < g.minIntervalMs) return false;
  if (g.minWritesSinceLast !== undefined && state.writes < g.minWritesSinceLast) return false;
  if (g.minTurnsSinceLast !== undefined && state.turns < g.minTurnsSinceLast) return false;
  if (g.minFiles !== undefined) {
    // **只数 session 层**:整理的范围就这一层,拿别的层的文件数来开这道门是把门开在别人身上
    let count = 0;
    for (const m of ctx.memories.values()) {
      for (const { scope, path } of memoryPaths(m)) {
        if (scope !== DREAM_SCOPE || !path.endsWith("/")) continue;
        const files = await ctx.dir.list(path);
        count += files.filter((f) => !f.endsWith(`/${MEMORY_INDEX_FILE}`)).length; // 索引不是一条记忆
      }
    }
    if (count < g.minFiles) return false;
  }
  return true;
}

/**
 * 备整理任务的料并上锁。拿去派一个**只带这套工具**的 subagent;跑完调 markDreamed()。
 *
 * 工具是**限定在 session 层**的那一把(不是前台那把):project / user 两层是别的 session
 * 也在写的,dream 不碰(「切法」第 3 条)。限定在工具上而不是只写进 prompt 里——
 * 后者是纪律,前者才是门。
 */
export async function dreamTask(ctx: AgentMemories): Promise<{ prompt: string; tools: ModelTool[] }> {
  // 上锁也走串行链：它是同一份状态的读改写，和计数并发时会互相盖掉
  await updateDreamState(ctx, (s) => ({ ...s, startedAt: Date.now() }));
  return {
    prompt: defaultDreamPrompt(listMemories(ctx), DREAM_SCOPE),
    tools: [createMemoryTool(ctx, { ...ctx.toolOpts, scope: DREAM_SCOPE })],
  };
}

/** 整理成功后:记时间、放锁、清计数。整理失败不调它——锁 1 小时后自动过期。 */
export async function markDreamed(ctx: AgentMemories): Promise<void> {
  // 清零同样走串行链：不然「读到 5 → markDreamed 清 0 → 写回 6」会把计数复活
  await updateDreamState(ctx, () => ({ lastAt: Date.now(), startedAt: null, writes: 0, turns: 0 }));
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

type Prepared = { ok: true; content: string } | { ok: false; reasonCode: string; message: string };

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

/** 计数落盘（与轮次同一个理由：只在内存的话重启就归零）。落盘失败不该把已经成功的写变成失败，只报诊断。 */
async function bumpWriteCounter(ctx: AgentMemories): Promise<void> {
  try {
    await bumpDreamCounters(ctx, { writes: 1 });
  } catch (e) {
    ctx.report?.({ code: "dream_counter_persist_failed", message: errText(e) });
  }
}

/** 写入的公共骨架:jail → 索引文件保护 → 路由分区 → 备内容 → checkWrite → 落盘 → 计数 + 重建索引 → 发事实。 */
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
  try {
    await ctx.dir.write(path, prepared.content);
  } catch (e) {
    return finishMemoryMutation(ctx, frame, failed("write", errText(e)));
  }
  await bumpWriteCounter(ctx);
  const indexOutcome = await refreshIndex(ctx, owner, path);
  return finishMemoryMutation(ctx, frame, committed(prepared.content.length, indexOutcome, okText(path, prepared.content.length)));
}

/** INDEX.md 由系统维护(写方法重建),不许直接写——直接改会被下一次重建覆盖,等于白改。返回拒绝原文。 */
function guardIndexFile(path: string): string | null {
  if (path.endsWith(`/${MEMORY_INDEX_FILE}`)) {
    return `${MEMORY_INDEX_FILE} is the system-maintained index and cannot be edited directly; edit the memory files and the index is rebuilt`;
  }
  return null;
}

/**
 * indexed 分区的落盘索引:每次写方法成功后重建(CC 的 MEMORY.md 同款)。
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
  return [...ctx.memories.values()]
    .map((m) => ({ m, paths: memoryPaths(m).map((p) => p.path) }))
    .filter((r) => r.paths.length > 0)
    .map((r) => `${r.m.name} (${r.paths.join(", ")})`)
    .join(", ");
}

/** a 覆盖 b:a 是目录且 b 落在其下,或两者同路径。 */
function covers(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith("/") && b.startsWith(a);
}
