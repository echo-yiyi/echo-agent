// 任务清单的操作方法：一个 DAG。设计见 docs/design/AGENT-CORE.md §5D。
//
// **这个文件里全是方法,没有 interface、没有类、没有状态**（2026-08-05 用户拍定）:
// 清单是 agent 的——`agent.tasks` 就是 `Map<string, TaskItem>`,装的是**任务本体**。
//
// 两处强制（拓扑约束是真执行的,不是画着看的）:
//   ① 加边成环 → 拒,报错点名成环的路径
//   ② status 改成 in_progress 而前置未完 → 拒,报错点名是谁卡着
// 除此之外 core 不替产品做主:不自动派发、不级联取消、不认识 executor 的内容。

import {
  BLOCKS,
  DEAD_STATUSES,
  isSettled,
  type TaskBrief,
  type TaskCreateResult,
  type TaskDerived,
  type TaskFilter,
  type TaskGraph,
  type TaskItem,
  type TaskStore,
  type TaskLink,
  type TaskLinkResult,
  type TaskPatch,
  type TaskSnapshot,
  type TaskSpec,
  type TaskView,
  type TaskWriteResult,
} from "./types.ts";

/** agent 的任务清单。键是 `task.id`,值就是任务本体。 */
export type TaskMap = Map<string, TaskItem>;

/* ─────────────── 读面 ─────────────── */

export function getTask(tasks: TaskMap, id: string): TaskView | undefined {
  const item = tasks.get(id);
  if (item === undefined) return undefined;
  return { ...item, derived: derive(tasks).get(id) ?? EMPTY_DERIVED };
}

/** 轻量视图 + 派生，**不含 `detail`**（渐进式披露）。 */
export function listTasks(tasks: TaskMap, filter?: TaskFilter): readonly TaskBrief[] {
  const derived = derive(tasks);
  let out = [...tasks.values()]
    .sort((a, b) => a.order - b.order)
    .map((item) => toBrief(item, derived.get(item.id) ?? EMPTY_DERIVED));
  if (filter?.status !== undefined) {
    const wanted = new Set(filter.status);
    out = out.filter((t) => wanted.has(t.status));
  }
  if (filter?.executor !== undefined) out = out.filter((t) => t.executor === filter.executor);
  if (filter?.ready === true) out = out.filter((t) => t.derived.ready);
  return out;
}

/** 原样吐点与边，给渲染 / 导 mermaid。 */
export function taskGraph(tasks: TaskMap): TaskGraph {
  const edges: { from: string; to: string; kind: string }[] = [];
  for (const item of tasks.values()) {
    for (const l of item.links) edges.push({ from: item.id, to: l.to, kind: l.kind });
  }
  return { nodes: listTasks(tasks), edges };
}

/** 进 `agent.state.tasks` 的投影。counts 按 status 开放计数——自定义状态也算得出来。 */
export function taskSnapshot(tasks: TaskMap): TaskSnapshot {
  const all = listTasks(tasks);
  const counts: Record<string, number> = {};
  for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return {
    total: all.length,
    counts,
    ready: all.filter((t) => t.derived.ready),
    active: all.filter((t) => t.status === "in_progress"),
  };
}

/* ─────────────── 写面 ─────────────── */

/** 下一个 id。清单里最大数字 + 1——`load()` 回来之后也不会撞掉盘上已有的。 */
function nextId(tasks: TaskMap): number {
  let max = 0;
  for (const t of tasks.values()) {
    const n = Number(t.id);
    if (Number.isFinite(n) && n > max) max = n;
    if (t.order > max) max = t.order;
  }
  return max + 1;
}

/** **批量原子**：同批内可用 `ref` 互相引用；任一条成环 → 整批不落地。 */
export function createTasks(tasks: TaskMap, specs: readonly TaskSpec[]): TaskCreateResult {
  if (specs.length === 0) return { ok: true, tasks: [] };

  // 先在副本上建全，验通过才提交。
  const draft = new Map<string, TaskItem>(tasks);
  const now = Date.now();
  let seq = nextId(tasks) - 1;
  const created: TaskItem[] = [];
  const refToId = new Map<string, string>();

  for (const spec of specs) {
    if (spec.title.trim() === "") return { ok: false, error: "title 不能为空" };
    const id = String(++seq);
    if (spec.ref !== undefined) {
      if (refToId.has(spec.ref)) return { ok: false, error: `ref '${spec.ref}' 在同一批里重复` };
      refToId.set(spec.ref, id);
    }
    const item: TaskItem = {
      id,
      title: spec.title,
      ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
      status: spec.status ?? "pending",
      ...(spec.executor !== undefined ? { executor: spec.executor } : {}),
      order: seq,
      links: [],
      ...(spec.meta !== undefined ? { meta: spec.meta } : {}),
      createdAt: now,
      updatedAt: now,
    };
    draft.set(id, item);
    created.push(item);
  }

  // 边在**建完全部点之后**才连——否则同批里「先声明的引用后声明的」必然找不到。
  for (const [i, spec] of specs.entries()) {
    const self = created[i];
    if (self === undefined) continue;
    for (const raw of spec.blocks ?? []) {
      const target = refToId.get(raw) ?? raw;
      if (!draft.has(target)) return { ok: false, error: `blocks 指向不存在的任务 '${raw}'` };
      addEdge(draft, self.id, target);
    }
    for (const raw of spec.blockedBy ?? []) {
      const source = refToId.get(raw) ?? raw;
      if (!draft.has(source)) return { ok: false, error: `blockedBy 指向不存在的任务 '${raw}'` };
      // 书写便利：落地时写成**对方的出边**，存储只有一个方向。
      addEdge(draft, source, self.id);
    }
  }

  const cycle = findCycle(draft);
  if (cycle !== undefined) return { ok: false, error: `会成环：${cycle.join(" → ")}` };

  commit(tasks, draft);
  return { ok: true, tasks: created.map((c) => draft.get(c.id) as TaskItem) };
}

/** **唯一写入口**。语义方法（start/complete/…）一概不设——状态是开放的，写死的转移必然是错的。 */
export function updateTask(tasks: TaskMap, id: string, patch: TaskPatch): TaskWriteResult {
  if (!tasks.has(id)) return { ok: false, error: `未知任务 '${id}'` };

  const draft = new Map<string, TaskItem>(tasks);

  for (const raw of patch.addBlocks ?? []) {
    if (!draft.has(raw)) return { ok: false, error: `blocks 指向不存在的任务 '${raw}'` };
    addEdge(draft, id, raw);
  }
  for (const raw of patch.addBlockedBy ?? []) {
    if (!draft.has(raw)) return { ok: false, error: `blockedBy 指向不存在的任务 '${raw}'` };
    addEdge(draft, raw, id);
  }
  for (const raw of patch.removeBlocks ?? []) removeEdge(draft, id, raw);
  for (const raw of patch.removeBlockedBy ?? []) removeEdge(draft, raw, id);

  const next: TaskItem = {
    ...(draft.get(id) as TaskItem),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
    updatedAt: Date.now(),
  };
  if (patch.executor !== undefined) {
    if (patch.executor === null) delete (next as { executor?: string }).executor;
    else (next as { executor?: string }).executor = patch.executor;
  }
  draft.set(id, next);

  const cycle = findCycle(draft);
  if (cycle !== undefined) return { ok: false, error: `会成环：${cycle.join(" → ")}` };

  // 拓扑约束**在这里真被执行**：前置没完，就不许开工。
  // 报错点名是谁卡着——模型据此能立刻做对的事，「非法状态」它只能瞎试。
  if (patch.status === "in_progress") {
    const blockers = derive(draft).get(id)?.blockedBy ?? [];
    if (blockers.length > 0) {
      const named = blockers.map((b) => `#${b}「${draft.get(b)?.title ?? "?"}」`).join("、");
      return { ok: false, error: `任务 #${id} 被这些未完成的前置卡着：${named}` };
    }
  }

  commit(tasks, draft);
  return { ok: true, task: next };
}

/** 删点 + **删掉所有指向它的边**——留悬空引用等于自己造脏数据。 */
export function removeTask(tasks: TaskMap, id: string): boolean {
  if (!tasks.has(id)) return false;
  const draft = new Map<string, TaskItem>(tasks);
  draft.delete(id);
  for (const [key, item] of draft) {
    if (item.links.some((l) => l.to === id)) {
      draft.set(key, { ...item, links: item.links.filter((l) => l.to !== id), updatedAt: Date.now() });
    }
  }
  commit(tasks, draft);
  return true;
}

export function linkTasks(tasks: TaskMap, from: string, to: string, kind: string = BLOCKS): TaskLinkResult {
  if (!tasks.has(from)) return { ok: false, error: `未知任务 '${from}'` };
  if (!tasks.has(to)) return { ok: false, error: `未知任务 '${to}'` };
  if (from === to) return { ok: false, error: "任务不能指向自己" };
  const draft = new Map<string, TaskItem>(tasks);
  addEdge(draft, from, to, kind);
  const cycle = findCycle(draft);
  if (cycle !== undefined) return { ok: false, error: `会成环：${cycle.join(" → ")}` };
  commit(tasks, draft);
  return { ok: true };
}

export function unlinkTasks(tasks: TaskMap, from: string, to: string, kind: string = BLOCKS): boolean {
  const item = tasks.get(from);
  if (item === undefined || !item.links.some((l) => l.to === to && l.kind === kind)) return false;
  const draft = new Map<string, TaskItem>(tasks);
  removeEdge(draft, from, to, kind);
  commit(tasks, draft);
  return true;
}

function commit(tasks: TaskMap, draft: Map<string, TaskItem>): void {
  tasks.clear();
  for (const [k, v] of draft) tasks.set(k, v);
}

/* ─────────────── 落盘（端口在 types.ts，实现在调用方） ─────────────── */

/** 从端口读回清单。**覆盖当前内容**——它是权威。 */
/**
 * 从字节面读回清单。**编解码与验形都在这里**（D3：语义归 core，端口只搬字节）。
 *
 * 三条策略写死在 core，换 Store 换不掉：
 *   · 读到 `null` = 还没有清单 → 空表，不是错误
 *   · JSON 解不开 / 顶层不是数组 → **抛**，不返回半截
 *   · 单条缺必要字段 → 抛，且**说清楚坏在第几条**（整份打不开时人得知道去改哪里）
 */
export async function loadTasks(tasks: TaskMap, store: TaskStore): Promise<void> {
  const raw = await store.read();
  if (raw === null || raw.trim() === "") {
    tasks.clear();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`任务清单解不开：${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("任务清单格式不对（顶层应是数组）");

  // **先在临时 Map 里验完再整体替换**。此前是「先 clear 再逐条写进真 Map」——
  // 第 3 条坏掉时，前两条已经进去了、清单也已经被清空，留下**半份恢复状态**：
  // 既不是盘上那份，也不是原来内存里那份。恢复要么整份成立，要么一条不动。
  const staged = new Map<string, TaskItem>();
  for (const [i, item] of parsed.entries()) {
    assertTaskItem(item, `任务清单第 ${i + 1} 条`);
    // 重复 id 会让后写的悄悄盖掉前一条——那是恢复期才发现的数据丢失
    if (staged.has(item.id)) throw new Error(`任务清单第 ${i + 1} 条的 id 重复：${item.id}`);
    staged.set(item.id, item);
  }

  tasks.clear();
  for (const [id, item] of staged) tasks.set(id, item);
}

/**
 * 运行时验形。**TS 类型在运行时不存在**，第三方 Store 塞什么进来都得自己查。
 *
 * **验到嵌套一层**：此前只看 `links` 是不是数组，于是 `links: [null]` 能恢复成功，
 * 随后 `taskGraph()` 当场抛（实测）——错误发生在离坏档很远的地方。
 * `createdAt` / `updatedAt` 同样必填：它们是 `TaskItem` 的非可选字段，缺了下游拿到 undefined。
 */
function assertTaskItem(v: unknown, where: string): asserts v is TaskItem {
  if (typeof v !== "object" || v === null) throw new Error(`${where} 不是对象`);
  const o = v as Record<string, unknown>;
  for (const k of ["id", "title", "status"]) {
    if (typeof o[k] !== "string") throw new Error(`${where} 缺 ${k}（或不是字符串）`);
  }
  for (const k of ["order", "createdAt", "updatedAt"]) {
    if (typeof o[k] !== "number") throw new Error(`${where} 缺 ${k}（或不是数字）`);
  }
  const links = o["links"];
  if (!Array.isArray(links)) throw new Error(`${where} 的 links 不是数组`);
  for (const [j, link] of links.entries()) {
    if (typeof link !== "object" || link === null) throw new Error(`${where} 的第 ${j + 1} 条 link 不是对象`);
    const l = link as Record<string, unknown>;
    if (typeof l["to"] !== "string") throw new Error(`${where} 的第 ${j + 1} 条 link 缺 to`);
    if (typeof l["kind"] !== "string") throw new Error(`${where} 的第 ${j + 1} 条 link 缺 kind`);
  }
}

/** 写回端口。调用方决定时机（每次改完、轮边界、dispose）。 */
/** 一次完整快照。序列化在 core；**「要么整份生效」是 Store 的 conformance**，不在这里做。 */
export async function saveTasks(tasks: TaskMap, store: TaskStore): Promise<void> {
  await store.write(`${JSON.stringify([...tasks.values()], null, 2)}\n`);
}

/* ─────────────── 纯函数：派生与图 ─────────────── */

const EMPTY_DERIVED: TaskDerived = { blockedBy: [], ready: false, unreachable: false };

/** 反向算前置。图就几十个点，**不缓存反向索引 → 没有失效 bug**。 */
export function derive(items: ReadonlyMap<string, TaskItem>): Map<string, TaskDerived> {
  const prereq = new Map<string, string[]>();
  for (const item of items.values()) {
    for (const l of item.links) {
      if (l.kind !== BLOCKS) continue; // 只对 blocks 负责：别的 kind 照存不管
      const list = prereq.get(l.to);
      if (list === undefined) prereq.set(l.to, [item.id]);
      else list.push(item.id);
    }
  }
  const out = new Map<string, TaskDerived>();
  for (const item of items.values()) {
    const ps = prereq.get(item.id) ?? [];
    const blockedBy = ps.filter((p) => {
      const s = items.get(p)?.status;
      return s !== undefined && !isSettled(s);
    });
    const unreachable = ps.some((p) => {
      const s = items.get(p)?.status;
      return s !== undefined && DEAD_STATUSES.has(s);
    });
    out.set(item.id, {
      blockedBy,
      // cancelled 也是了结，所以它不进 blockedBy、也不挡 ready；
      // unreachable 是**纯提示**（这条路的前提黄了，你可能要重新想想），不影响可否开工。
      ready: !isSettled(item.status) && item.status !== "in_progress" && blockedBy.length === 0,
      unreachable,
    });
  }
  return out;
}

/** 返回成环的路径（含闭合的那一跳）；无环返回 undefined。只看 blocks 边。 */
export function findCycle(items: ReadonlyMap<string, TaskItem>): string[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    color.set(id, GRAY);
    stack.push(id);
    for (const l of items.get(id)?.links ?? []) {
      if (l.kind !== BLOCKS) continue;
      if (!items.has(l.to)) continue;
      const c = color.get(l.to) ?? WHITE;
      if (c === GRAY) {
        const from = stack.indexOf(l.to);
        return [...stack.slice(from), l.to];
      }
      if (c === WHITE) {
        const found = visit(l.to);
        if (found !== undefined) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return undefined;
  };

  for (const id of items.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const found = visit(id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function addEdge(draft: Map<string, TaskItem>, from: string, to: string, kind: string = BLOCKS): void {
  const item = draft.get(from);
  if (item === undefined) return;
  if (item.links.some((l) => l.to === to && l.kind === kind)) return; // 幂等
  const link: TaskLink = { to, kind };
  draft.set(from, { ...item, links: [...item.links, link], updatedAt: Date.now() });
}

function removeEdge(draft: Map<string, TaskItem>, from: string, to: string, kind: string = BLOCKS): void {
  const item = draft.get(from);
  if (item === undefined) return;
  const links = item.links.filter((l) => !(l.to === to && l.kind === kind));
  if (links.length === item.links.length) return;
  draft.set(from, { ...item, links, updatedAt: Date.now() });
}

function toBrief(item: TaskItem, derived: TaskDerived): TaskBrief {
  const { detail: _detail, ...rest } = item;
  return { ...rest, derived };
}
