// 任务清单的契约门。
//
// 判据面对应设计里那几条硬话：
//   ① 批量原子 + 同批 ref 互引    ② 成环即拒、整批回滚
//   ③ 前置未完不许开工，且**点名是谁卡着**  ④ 删点不留悬空边
//   ⑤ 形状开放行为不开放（非 blocks 边照存不管、自定义状态算未了结）
//   ⑥ 不写边就退化成线性清单       ⑦ 落盘 + 续号不撞 id

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import {
  createTasks, updateTask, removeTask, linkTasks, getTask, listTasks,
  taskGraph, taskSnapshot, loadTasks, saveTasks, type TaskMap,
} from "../src/task/harness.ts";
import { makeTaskTools, renderList } from "../src/task/tools.ts";
import { registerTool } from "../src/tools/harness.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import type { TaskItem, TaskStore } from "../src/task/types.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";

function harness(): TaskMap {
  return new Map();
}

/* ══════════ 建：批量原子 + ref ══════════ */

test("批量建 + 同批 ref 互相引用：边真的连上了", () => {
  const h = harness();
  const r = createTasks(h, [
    { ref: "a", title: "改 parser" },
    { ref: "b", title: "改 lexer" },
    { title: "更新测试", blockedBy: ["a", "b"] },
  ]);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const [a, b, c] = r.tasks;
  // blockedBy 是**书写便利**：落地时写成对方的出边，存储只有一个方向
  expect(a?.links).toEqual([{ to: c!.id, kind: "blocks" }]);
  expect(b?.links).toEqual([{ to: c!.id, kind: "blocks" }]);
  expect(c?.links).toEqual([]);

  const view = getTask(h, c!.id);
  expect([...(view?.derived.blockedBy ?? [])].sort()).toEqual([a!.id, b!.id].sort());
  expect(view?.derived.ready).toBe(false);
  // 扇出的两条互不相干 → 同时可做，这正是图买到的东西
  expect(getTask(h, a!.id)?.derived.ready).toBe(true);
  expect(getTask(h, b!.id)?.derived.ready).toBe(true);
});

test("成环 → 整批不落地（不是只拒那一条）", () => {
  const h = harness();
  const r = createTasks(h, [
    { ref: "a", title: "A", blocks: ["b"] },
    { ref: "b", title: "B", blocks: ["a"] },
  ]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("create a cycle");
  expect(listTasks(h).length).toBe(0); // 半条都不许留
});

test("边指向不存在的任务 → 拒（我们的方法不许自己造脏数据）", () => {
  const h = harness();
  const r = createTasks(h, [{ title: "A", blockedBy: ["999"] }]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("999");
  expect(listTasks(h).length).toBe(0);
});

test("update 加边成环 → 拒，且原有边不受影响", () => {
  const h = harness();
  const r = createTasks(h, [{ title: "A" }, { title: "B" }]);
  if (!r.ok) throw new Error("建失败");
  const [a, b] = r.tasks;
  expect(linkTasks(h, a!.id, b!.id).ok).toBe(true);
  const back = linkTasks(h, b!.id, a!.id);
  expect(back.ok).toBe(false);
  if (!back.ok) expect(back.error).toMatch(/create a cycle.*→/);
  expect(getTask(h, b!.id)?.links).toEqual([]);
});

/* ══════════ 拓扑约束是真执行的 ══════════ */

test("前置没完就开工 → 拒，且**点名是谁卡着**", () => {
  const h = harness();
  const r = createTasks(h, [
    { ref: "p", title: "重构 parser" },
    { title: "更新测试", blockedBy: ["p"] },
  ]);
  if (!r.ok) throw new Error("建失败");
  const [p, t] = r.tasks;
  const bad = updateTask(h, t!.id, { status: "in_progress" });
  expect(bad.ok).toBe(false);
  if (!bad.ok) {
    expect(bad.error).toContain("重构 parser"); // 不是含糊的「非法状态」
    expect(bad.error).toContain(`#${p!.id}`);
  }
  // 前置做完 → 自动解锁，不需要谁去改下游
  expect(updateTask(h, p!.id, { status: "done" }).ok).toBe(true);
  expect(getTask(h, t!.id)?.derived.ready).toBe(true);
  expect(updateTask(h, t!.id, { status: "in_progress" }).ok).toBe(true);
  expect(getTask(h, t!.id)?.derived.ready).toBe(false); // 在做的不算「可做」
});

test("前置取消：不级联改状态，只标 unreachable，且不挡开工", () => {
  const h = harness();
  const r = createTasks(h, [
    { ref: "p", title: "前置" },
    { title: "下游", blockedBy: ["p"] },
  ]);
  if (!r.ok) throw new Error("建失败");
  const [p, d] = r.tasks;
  updateTask(h, p!.id, { status: "cancelled" });

  const view = getTask(h, d!.id);
  expect(view?.status).toBe("pending"); // **状态没被级联改**
  expect(view?.derived.unreachable).toBe(true); // 但看得见前提黄了
  expect(view?.derived.blockedBy).toEqual([]); // cancelled 也是了结
  expect(view?.derived.ready).toBe(true); // 提示归提示，不逼模型多打一次工具
});

/* ══════════ 删点 ══════════ */

test("删点：指向它的边一并清掉，不留悬空引用", () => {
  const h = harness();
  const r = createTasks(h, [
    { ref: "a", title: "A" },
    { title: "B", blockedBy: ["a"] },
  ]);
  if (!r.ok) throw new Error("建失败");
  const [a, b] = r.tasks;
  expect(removeTask(h, a!.id)).toBe(true);
  expect(getTask(h, b!.id)?.derived.blockedBy).toEqual([]);
  expect(taskGraph(h).edges).toEqual([]);
  expect(removeTask(h, a!.id)).toBe(false);
});

/* ══════════ 形状开放，行为不开放 ══════════ */

test("非 blocks 的边照存不管：不参与拓扑，也不被丢弃", () => {
  const h = harness();
  const r = createTasks(h, [{ title: "想法" }, { title: "子想法" }]);
  if (!r.ok) throw new Error("建失败");
  const [a, b] = r.tasks;
  expect(linkTasks(h, a!.id, b!.id, "child").ok).toBe(true);
  // 存下来了
  expect(getTask(h, a!.id)?.links).toEqual([{ to: b!.id, kind: "child" }]);
  expect(taskGraph(h).edges).toEqual([{ from: a!.id, to: b!.id, kind: "child" }]);
  // 但不卡住谁——我们的方法只对 blocks 负责
  expect(getTask(h, b!.id)?.derived.blockedBy).toEqual([]);
  expect(getTask(h, b!.id)?.derived.ready).toBe(true);
});

test("自定义状态：照存，且一律算「未了结」（不认识就当没做完，是安全的一侧）", () => {
  const h = harness();
  const r = createTasks(h, [
    { ref: "p", title: "待验证的前置", status: "needs_review" },
    { title: "下游", blockedBy: ["p"] },
  ]);
  if (!r.ok) throw new Error("建失败");
  const [, d] = r.tasks;
  expect(getTask(h, d!.id)?.derived.blockedBy.length).toBe(1);
  expect(taskSnapshot(h).counts.needs_review).toBe(1);
});

test("不写边 = 线性清单：同一套方法，退化成一条链", () => {
  const h = harness();
  const r = createTasks(h, [{ title: "一" }, { title: "二" }, { title: "三" }]);
  expect(r.ok).toBe(true);
  const list = listTasks(h);
  expect(list.map((t) => t.title)).toEqual(["一", "二", "三"]); // order 排序
  expect(list.every((t) => t.derived.ready)).toBe(true); // 谁也不卡谁
  expect(taskGraph(h).edges).toEqual([]);
});

/* ══════════ 渐进式披露 ══════════ */

test("list 不含 detail，get 才给", () => {
  const h = harness();
  const r = createTasks(h, [{ title: "A", detail: "很长的展开说明".repeat(50) }]);
  if (!r.ok) throw new Error("建失败");
  expect("detail" in (listTasks(h)[0] as object)).toBe(false);
  expect(getTask(h, r.tasks[0]!.id)?.detail).toContain("很长的展开说明");
});

test("executor 是不透明字符串：core 不解释、不自动填", () => {
  const h = harness();
  const r = createTasks(h, [{ title: "A" }]);
  if (!r.ok) throw new Error("建失败");
  const id = r.tasks[0]!.id;
  expect(getTask(h, id)?.executor).toBeUndefined(); // 开工也不会被自动填
  updateTask(h, id, { status: "in_progress" });
  expect(getTask(h, id)?.executor).toBeUndefined();
  updateTask(h, id, { executor: "subagent:reviewer" });
  expect(getTask(h, id)?.executor).toBe("subagent:reviewer");
  updateTask(h, id, { executor: null });
  expect(getTask(h, id)?.executor).toBeUndefined();
});

/* ══════════ 落盘 ══════════ */

/** 字节面的内存 Store——**它只搬字节**，编解码与验形在 `loadTasks` 里（D3）。 */
function memStore(): TaskStore & { text: string | null } {
  const box = {
    text: null as string | null,
    async read() {
      return box.text;
    },
    async write(t: string) {
      box.text = t;
    },
  };
  return box;
}

test("落盘：save 写全量；load 回来后新建的 id 不撞已有的", async () => {
  const store = memStore();

  const h1 = harness();
  createTasks(h1, [{ ref: "a", title: "A" }, { title: "B", blockedBy: ["a"] }]);
  await saveTasks(h1, store);
  expect(JSON.parse(store.text!)).toHaveLength(2);

  // 新 agent 起来：清单回来了，且新建的 id 不撞老的
  const h2 = harness();
  await loadTasks(h2, store);
  expect(listTasks(h2).map((t) => t.title)).toEqual(["A", "B"]);
  expect(createTasks(h2, [{ title: "C" }]).ok).toBe(true);
  expect(listTasks(h2).length).toBe(3);
  expect(new Set(listTasks(h2).map((t) => t.id)).size).toBe(3); // id 唯一
});

test("load 覆盖当前内容——盘上的是权威", async () => {
  const store = memStore();
  store.text = "[]";
  const h = harness();
  createTasks(h, [{ title: "内存里的" }]);
  await loadTasks(h, store);
  expect(listTasks(h).length).toBe(0);
});

/* ══════════ 接到 Agent 上 ══════════ */

test("state.tasks 是派生投影（清单本身在 agent.tasks）", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    tasks: [{ ref: "a", title: "A" }, { title: "B", blockedBy: ["a"] }],
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）

  expect(agent.state.tasks.total).toBe(2);
  expect(agent.state.tasks.counts.pending).toBe(2);
  expect(agent.state.tasks.ready.map((t) => t.title)).toEqual(["A"]);
  expect(agent.state.tasks.active).toEqual([]);
  // 注意：**没有 task_changed 事件**——任务操作是纯函数，改 Map 的人不经过 agent。
  // 想让 UI 知道清单变了，读 `agent.state.tasks` 即可（它是每次现算的）。

  await agent.dispose();
  expect(agent.state.tasks.total).toBe(0);
});

test("模型点名 TaskCreate → 真的建上，回执里带整份清单", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([
      toolTurn("c1", "TaskCreate", { tasks: [{ ref: "a", title: "写设计" }, { title: "写实现", blockedBy: ["a"] }] }),
      textTurn("清单建好了"),
    ]),
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  // 不用自己注册了：Task 是 Agent 自己的能力，构造期就装上（2026-08-23 拍板）

  await agent.prompt("先规划一下");
  const result = agent.messages.find((m) => m.role === "toolResult") as { content: string; isError: boolean };
  expect(result.isError).toBe(false);
  expect(result.content).toContain("写设计");
  expect(result.content).toContain("[ready]");
  expect(agent.state.tasks.total).toBe(2);
  await agent.dispose();
});

test("模型抢跑（前置没完就 TaskUpdate → in_progress）→ 拿到点名的拒绝", async () => {
  const h = harness();
  const r = createTasks(h, [{ ref: "a", title: "前置活" }, { title: "后置活", blockedBy: ["a"] }]);
  if (!r.ok) throw new Error("建失败");
  const tools = makeTaskTools(h);
  const update = tools.find((t) => t.name === "TaskUpdate");
  const out = await update!.execute({ id: r.tasks[1]!.id, status: "in_progress" }, ctx());
  expect(out.isError).toBe(true);
  expect(out.content).toContain("前置活");
});

test("TaskUpdate 的 delete 会删点；TaskGet 未知 id 诚实报错", async () => {
  const h = harness();
  const r = createTasks(h, [{ title: "A" }]);
  if (!r.ok) throw new Error("建失败");
  const tools = makeTaskTools(h);
  const get = tools.find((t) => t.name === "TaskGet")!;
  const update = tools.find((t) => t.name === "TaskUpdate")!;

  expect((await get.execute({ id: "nope" }, ctx())).isError).toBe(true);
  const del = await update.execute({ id: r.tasks[0]!.id, delete: true }, ctx());
  expect(del.isError).toBe(false);
  expect(listTasks(h).length).toBe(0);
});

/* ══════════ 渲染（纯函数） ══════════ */

test("renderList：状态符号 + 在等谁 + 可做标记", () => {
  const h = harness();
  const r = createTasks(h, [
    { ref: "a", title: "A", status: "done" },
    { ref: "b", title: "B" },
    { title: "C", blockedBy: ["b"] },
  ]);
  if (!r.ok) throw new Error("建失败");
  const text = renderList(listTasks(h));
  expect(text).toContain("● #");
  expect(text).toContain("[ready]");
  expect(text).toContain(`waiting for #${r.tasks[1]!.id}`);
  expect(renderList([])).toBe("(the task list is empty)");
});

function ctx(): Parameters<ReturnType<typeof makeTaskTools>[number]["execute"]>[1] {
  return {
    toolCallId: "t1",
    workspace: "/",
    sessionId: null,
    iteration: 0,
  };
}

/* ══════════ 语义在 core：第三方 Store 使坏时必须判红（D3 / §13.12.2） ══════════ */
//
// `TaskStore` 收窄成字节面之前，JSON 解码、逐条验形、「文件不存在算空清单」全在实现方手里，
// 而 `loadTasks()` 只有三行、完全信任返回值——第三方可以静默丢记录、返回缺字段的 `TaskItem`
// （TS 类型运行时不存在），core 无从保证。下面这几条就是那半截语义收回来之后才测得了的。

test("脏数据①：JSON 解不开 → 抛，不是当空清单吞掉", async () => {
  const store = memStore();
  store.text = "{ 这不是 json";
  await expect(loadTasks(harness(), store)).rejects.toThrow(/解不开/);
});

test("脏数据②：顶层不是数组 → 抛", async () => {
  const store = memStore();
  store.text = JSON.stringify({ tasks: [] });
  await expect(loadTasks(harness(), store)).rejects.toThrow(/顶层应是数组/);
});

test("脏数据③：单条缺字段 → 抛，且说清坏在第几条", async () => {
  const store = memStore();
  store.text = JSON.stringify([
    { id: "a", title: "好的", status: "pending", order: 1, links: [], createdAt: 1, updatedAt: 1 },
    { id: "b", title: "缺 order", status: "pending", links: [], createdAt: 1, updatedAt: 1 },
  ]);
  await expect(loadTasks(harness(), store)).rejects.toThrow(/第 2 条 缺 order/);
});

test("脏数据④：重复 id → 抛（后写的会悄悄盖掉前一条 = 恢复期才发现的数据丢失）", async () => {
  const store = memStore();
  const one = { id: "same", title: "甲", status: "pending", order: 1, links: [], createdAt: 1, updatedAt: 1 };
  store.text = JSON.stringify([one, { ...one, title: "乙" }]);
  await expect(loadTasks(harness(), store)).rejects.toThrow(/id 重复：same/);
});

test("read 返回 null = 还没有清单，不是错误", async () => {
  const store = memStore(); // text 初始就是 null
  const h = harness();
  createTasks(h, [{ title: "内存里的" }]);
  await loadTasks(h, store);
  expect(listTasks(h)).toHaveLength(0); // 清空成功，没有抛
});

test("saveTasks 交出的是一份完整快照（原子性归 Store，不归这里）", async () => {
  const store = memStore();
  const h = harness();
  createTasks(h, [{ title: "甲" }, { title: "乙" }]);
  await saveTasks(h, store);
  expect(JSON.parse(store.text!) as unknown[]).toHaveLength(2);
  // 再 load 回来必须等价——编解码是一对
  const h2 = harness();
  await loadTasks(h2, store);
  expect(listTasks(h2).map((t) => t.title)).toEqual(["甲", "乙"]);
});

/* ══════════ 2026-08-20 review：验形要验到嵌套，恢复要么整份要么不动 ══════════ */

test("links 里的元素也验形——`links: [null]` 不许恢复成功", async () => {
  // 实测破坏：只检查 links 是数组，于是 `[null]` 能恢复，随后 `taskGraph()` 当场抛
  // ——错误发生在离坏档很远的地方。
  const store = memStore();
  const bad = [
    { name: "link 是 null", links: [null] },
    { name: "link 缺 to", links: [{ kind: "blocks" }] },
    { name: "link 缺 kind", links: [{ to: "a" }] },
  ];
  for (const c of bad) {
    store.text = JSON.stringify([
      { id: "a", title: "甲", status: "pending", order: 1, links: c.links, createdAt: 1, updatedAt: 1 },
    ]);
    await expect(loadTasks(harness(), store), c.name).rejects.toThrow(/link/);
  }
});

test("坏在第 N 条时**一条都不动**——不留半份恢复状态", async () => {
  // 实测破坏：旧实现先 clear 再逐条写进真 Map，第 2 条坏掉时前一条已经进去了、
  // 原来的清单也已经被清空——既不是盘上那份，也不是内存里原来那份。
  const store = memStore();
  store.text = JSON.stringify([
    { id: "a", title: "好的", status: "pending", order: 1, links: [], createdAt: 1, updatedAt: 1 },
    { id: "b", title: "坏的", status: "pending", order: 2, links: [null], createdAt: 1, updatedAt: 1 },
  ]);

  const h = harness();
  createTasks(h, [{ title: "原来就在内存里的" }]);
  await expect(loadTasks(h, store)).rejects.toThrow();

  // 原来那份原封不动：既没被清空，也没混进盘上那条 "好的"
  expect(listTasks(h).map((t) => t.title)).toEqual(["原来就在内存里的"]);
});

/* ══════════ 落盘：串行、可等、失败要说 ══════════ */
/* 三条都来自 2026-08-24 的 review，每条都带原样的复现手法。 */

/**
 * 可控 Store：`write` 的 resolve 时机由测试决定，用来把并发窗口摊开。
 *
 * `releaseAll()` 是收尾用的——`dispose()` 自己也会写一笔（收摊要等落盘），
 * 不放行它测试会卡在收摊上，而那与判据无关。
 */
function controllableStore(): {
  store: TaskStore;
  writes: string[];
  /** 放行第 i 笔写。 */
  release: (i: number) => void;
  /** 放行已挂起的全部，并让**之后**的写立刻完成。 */
  releaseAll: () => void;
} {
  const writes: string[] = [];
  const gates: (() => void)[] = [];
  let free = false;
  return {
    writes,
    release: (i: number) => gates[i]?.(),
    releaseAll: () => {
      free = true;
      for (const g of gates) g?.();
    },
    store: {
      read: async () => null,
      write: async (text: string) => {
        const at = writes.length;
        writes.push(text);
        if (free) return;
        await new Promise<void>((resolve) => {
          gates[at] = resolve;
        });
      },
    },
  };
}

test("工具说成功 = 盘上真有：慢 Store 下也不许提前回执", async () => {
  // review 第 1 条的复现：上一版只在 finally 里排一个 microtask 就返回成功，
  // 于是慢 Store 下模型收到「已建 N 条」而 `write()` 根本还没 resolve。
  const c = controllableStore();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: c.store,
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  const create = [...agent.tools.values()].find((t) => t.name === "TaskCreate")!;

  let settled = false;
  const call = (create.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean }>)(
    { tasks: [{ title: "落盘之前不许说成功" }] },
    ctx(),
  ).then((r) => {
    settled = true;
    return r;
  });

  // 让所有 microtask 跑完：**没有真的写完，工具就不许 settle**
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(settled, "write() 还没 resolve，工具却已经回执了").toBe(false);

  c.release(0);
  const out = await call;
  expect(out.isError).toBe(false);
  expect(c.writes.at(-1), "盘上没有那条任务").toContain("落盘之前不许说成功");
  c.releaseAll();
  await agent.dispose();
});

test("落盘失败不许返回成功——模型必须看得见", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: {
      read: async () => null,
      write: async () => {
        throw new Error("盘满了");
      },
    },
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  const create = [...agent.tools.values()].find((t) => t.name === "TaskCreate")!;
  const out = await (create.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }>)(
    { tasks: [{ title: "写不进去的" }] },
    ctx(),
  );
  expect(out.isError, "写失败了却回执成功").toBe(true);
  expect(out.content).toContain("盘满了");
  // **措辞要与真实状态一致**：内存里那条任务确实建上了，下一轮的任务注入里模型也看得见。
  // 回执却说「没有生效」的话，模型据此重试就会建出重复任务（2026-08-24 第二轮 review 第 2 条）。
  expect(agent.state.tasks.total, "前置：内存里确实改了").toBe(1);
  expect(out.content, "说了「没有生效」，可它明明在清单里").not.toContain("没有生效");
  expect(out.content).toContain("已经在当前进程里改好了");
  expect(out.content, "没告诉模型别重试——重试就会建重复的").toContain("不要重试");
  // 收摊时那一笔照样写不进去，`dispose()` 的契约是**逐段捕获、最后抛第一个错**——
  // 它不许把写失败咽下去，所以这里 expect 它抛，而不是 `await` 完当没事发生
  await expect(agent.dispose()).rejects.toThrow("盘满了");
});

test("两笔改动串行落盘：先发的写不会盖掉后发的（single writer）", async () => {
  // review 第 2 条的复现：`tasksDirty` 在 await 之前就清成 false，于是第二次改动
  // 能立刻排出第二笔并发写；第一笔阻塞、第二笔立刻完成时，旧快照后落、盖掉新状态。
  const c = controllableStore();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: c.store,
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  const create = [...agent.tools.values()].find((t) => t.name === "TaskCreate")!;
  const exec = create.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean }>;

  const first = exec({ tasks: [{ title: "第一条" }] }, ctx());
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const second = exec({ tasks: [{ title: "第二条" }] }, ctx());
  for (let i = 0; i < 20; i++) await Promise.resolve();

  // **串行的证据**：第一笔还没放行，第二笔一个字都还没写出去
  expect(c.writes.length, "第一笔没完，第二笔就开写了——并发窗口还在").toBe(1);

  c.release(0);
  await first;
  for (let i = 0; i < 20; i++) await Promise.resolve();
  c.release(1);
  await second;

  // 最后落盘的那份必须两条都在
  const last = c.writes.at(-1)!;
  expect(last).toContain("第一条");
  expect(last, "后发的快照被先发的盖掉了").toContain("第二条");
  c.releaseAll();
  await agent.dispose();
});

test("绕过工具直接改 map（公开的 createTasks）也会自动落盘", async () => {
  // review 第 1 条的后半：`createTasks(agent.tasks, …)` 完全绕过工具那层包装，
  // 上一版要等到 `stop()` 才写回去，与「Task 变化由 Agent 自动持久化」不符。
  const written: string[] = [];
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: {
      read: async () => null,
      write: async (text: string) => {
        written.push(text);
      },
    },
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）

  createTasks(agent.tasks, [{ title: "没经过工具的" }]);
  // 自动挂钩合并同一拍的改动，下一个 microtask 才写
  for (let i = 0; i < 20; i++) await Promise.resolve();

  expect(written.length, "改了 map 却没落盘").toBeGreaterThan(0);
  expect(written.at(-1)).toContain("没经过工具的");
  await agent.dispose();
});

test("没拿到租约就改任务：工具不许回执成功（取消 ≠ 成功）", async () => {
  // 2026-08-24 第三轮 review：上一版把「成功写完」与「因为没拿锁/丢锁而取消」
  // 都表示成 resolve，于是盘上什么都没有，工具却照样说成功。
  const written: string[] = [];
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: {
      read: async () => null,
      write: async (text: string) => {
        written.push(text);
      },
    },
    // 有锁 = 受生命周期管；**故意不 start()**，也就没有单写者资格
    stateLock: new InMemoryStateLock(),
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  const create = [...agent.tools.values()].find((t) => t.name === "TaskCreate")!;
  const out = await (create.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }>)(
    { tasks: [{ title: "没拿锁就想存" }] },
    ctx(),
  );

  expect(written, "没拿锁却写了盘").toEqual([]);
  expect(out.isError, "取消被当成了成功").toBe(true);
  expect(out.content).toContain("单写者租约");
  expect(out.content, "没告诉模型别重试").toContain("不要重试");
  // 与真实状态一致：内存里确实有
  expect(agent.state.tasks.total).toBe(1);

  // **判据要跨过收摊**：`dispose()` 自己会写一笔最终快照，只在它之前断言就是假绿
  // （2026-08-24 第五轮 review 抓到的正是这一点）。没拿过租约就一次都不许写。
  await agent.dispose();
  expect(written, "收摊时越权写了一次——从没拿到过锁，seal 拦不住这种").toEqual([]);
});

test("丢锁之后改任务：工具同样不许回执成功", async () => {
  const lock = new InMemoryStateLock();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: { read: async () => null, write: async () => undefined },
    stateLock: lock,
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  await agent.start();
  lock.simulateLost("租约过期");
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  const create = [...agent.tools.values()].find((t) => t.name === "TaskCreate")!;
  const out = await (create.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }>)(
    { tasks: [{ title: "丢锁之后" }] },
    ctx(),
  );
  expect(out.isError, "丢锁之后的取消被当成了成功").toBe(true);
  expect(out.content).toContain("单写者租约");
  await agent.stop().catch(() => undefined);
});

test("排队之后、真正写之前丢锁：工具回执也得说取消（执行点那一次判定）", async () => {
  // 前两条盯的是「排队时就不允许」。这一条盯**执行点**：排队时租约还在，
  // 轮到自己写的时候已经丢了——那一笔被撤回，回执同样不许说成功。
  const c = controllableStore();
  const lock = new InMemoryStateLock();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: c.store,
    stateLock: lock,
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  await agent.start();

  // 先占住写链：这一笔卡着不放行，后面排队的都得等它
  createTasks(agent.tasks, [{ title: "占住写链的" }]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(c.writes.length, "前置没成立：第一笔没开始写").toBe(1);

  const create = [...agent.tools.values()].find((t) => t.name === "TaskCreate")!;
  const call = (create.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }>)(
    { tasks: [{ title: "排队时合法" }] },
    ctx(),
  );
  for (let i = 0; i < 20; i++) await Promise.resolve();

  // 排队完成之后才丢锁——所以排队时那次检查是放行的
  lock.simulateLost("排队期间过期");
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  c.releaseAll();

  const out = await call;
  expect(out.isError, "执行点撤回了那一笔，回执却说成功").toBe(true);
  expect(out.content).toContain("单写者租约");
  expect(c.writes.length, "丢锁之后还是把它写出去了").toBe(1);
  await agent.stop().catch(() => undefined);
});

test("收摊途中丢锁：dispose 的最终写也要撤回（stop() 路径上的最后一块）", async () => {
  // 2026-08-24 第四轮 review。`doStop()` 曾在 `dispose()` **之前**就把 `this.lease`
  // 置 undefined，而 `watchLease` 的过期判据正是 `this.lease !== lease`——于是收摊途中
  // 真的丢了锁，会被当成「已经正常还回去了」而直接忽略：不 seal，最终写照写。
  const c = controllableStore();
  const lock = new InMemoryStateLock();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: c.store,
    stateLock: lock,
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  await agent.start();

  // 占住写链：这一笔卡着，`stop()` 会停在等它落盘上——收摊的窗口就在这里
  createTasks(agent.tasks, [{ title: "占住写链的" }]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(c.writes.length, "前置没成立：第一笔没开始写").toBe(1);

  const stopping = agent.stop().catch(() => undefined);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  // **收摊进行中**丢锁：租约归了别人，从这一刻起本进程一个字都不许再写
  lock.simulateLost("收摊途中过期");
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  c.releaseAll();
  await stopping;

  expect(c.writes.length, "收摊途中丢了锁，dispose 的最终写还是写出去了").toBe(1);
  expect(agent.state.status, "丢锁没被记下来").toBeDefined();
});

test("绕过工具的改动被取消时不许静默——诊断要说出来", async () => {
  // 工具路径有回执承载「取消了」这件事；公开的 `createTasks()` 直接改 map 没有返回值，
  // 而 `"cancelled"` 是**正常返回值不是异常**，上一版只 `.catch()` 于是完全静默——
  // 改动进了内存、盘上什么都没有，调用方以为存下了。这正是「绝不静默降级」要拦的。
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  const written: string[] = [];
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: {
      read: async () => null,
      write: async (text: string) => {
        written.push(text);
      },
    },
    stateLock: new InMemoryStateLock(), // 受生命周期管；**故意不 start()**
    hooks,
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）

  createTasks(agent.tasks, [{ title: "没拿锁就想存" }]);
  for (let i = 0; i < 20; i++) await Promise.resolve();

  expect(written, "没拿锁却写了盘").toEqual([]);
  expect(notices.join("\n"), "取消得静悄悄，没人知道改动没落盘").toContain("tasks_persist_skipped");
  expect(notices.join("\n")).toContain("单写者租约");
  await agent.dispose();
  expect(written, "收摊时越权写了一次").toEqual([]);
});

test("从没拿到过租约：dispose() 与 stop() 的最终写都不许发生", async () => {
  // 2026-08-24 第五轮 review：`dispose()` 直接调 `enqueueTaskWrite()`，上一版只看 seal，
  // 而 seal 只在「拿到过又丢了」时才置上——**拦不住「从没拿到过」**。
  // 于是没 `start()` 过的 Agent 一收摊就往状态根写一次。两条收摊入口各验一次。
  for (const how of ["dispose", "stop"] as const) {
    const written: string[] = [];
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: scriptedStreamFn([]),
      taskStore: { read: async () => null, write: async (t: string) => void written.push(t) },
      stateLock: new InMemoryStateLock(), // 受生命周期管；**故意不 start()**
    });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
    createTasks(agent.tasks, [{ title: "无租约" }]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect([how, written.length], "收摊之前就写了").toEqual([how, 0]);

    if (how === "dispose") await agent.dispose();
    else await agent.stop().catch(() => undefined);

    expect([how, written.length], `${how}() 越权写了一次`).toEqual([how, 0]);
  }
});

test("拿到过租约的正常收摊：最终写照写（判据不是「永远不写」）", async () => {
  const written: string[] = [];
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    taskStore: { read: async () => null, write: async (t: string) => void written.push(t) },
    stateLock: new InMemoryStateLock(),
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册（不再由构造函数直装）
  await agent.start();
  createTasks(agent.tasks, [{ title: "有租约" }]);
  await agent.stop();
  expect(written.length, "持有租约却不写了——清单会丢").toBeGreaterThan(0);
  expect(written.at(-1)).toContain("有租约");
});
