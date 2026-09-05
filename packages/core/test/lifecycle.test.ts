import { test, expect } from "bun:test";
import { createAgent } from "../src/create-agent.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import { createTasks, listTasks } from "../src/task/harness.ts";
import { addSchedule, listSchedules } from "../src/schedule/harness.ts";
import { scriptedDialect, textTurn } from "../src/testing.ts";
import type { Provider } from "../src/provider/types.ts";
import type { StorageDir } from "../src/storage/types.ts";

// M5 · 统一生命周期的搬迁清单：
// 这些以前全靠用户往 `AgentOptions` 里逐项塞、再手动 `loadTasks()` / `schedule.start()`；
// D4 之后归 `createAgent` 装配、`start()` 统一恢复与启动。
//
// **判据不是「字段传进去了」，是「重启之后东西真的回来了」**——
// 探到能力 ≠ 用了能力，这一批已经栽过一次（M3 的 persist 加了字段却没接线）。

function provider(): Provider {
  return createProvider({
    id: "t",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "scripted" }],
    api: createProviderStreams(scriptedDialect([textTurn("ok")])),
  });
}

function opts(store: StorageDir, extra: Record<string, unknown> = {}): never {
  // sessionId 显式给 "main"：下面有测试直接操作 `meta.json` / `entries/…`；缺省每次启动是新的一段
  return { provider: provider(), store, lock: new InMemoryStateLock(), allowNetwork: false, sessionId: "main", ...extra } as never;
}

test("任务清单跨重启回来（start() 统一恢复，不用手动 loadTasks）", async () => {
  const store = new InMemoryDir();

  const first = await createAgent(opts(store));
  await first.start();
  createTasks(first.tasks, [{ title: "甲" }, { title: "乙" }]);
  await first.stop(); // dispose 里会 saveTasks

  const second = await createAgent(opts(store));
  await second.start();
  expect(listTasks(second.tasks).map((t) => t.title)).toEqual(["甲", "乙"]);
  await second.stop();
});

test("闹钟跨重启回来，且 start() 直接把它启动了（不用手动 schedule.start()）", async () => {
  const store = new InMemoryDir();
  const clock = new FakeClock(0);

  const first = await createAgent(opts(store, { clock }));
  await first.start();
  await addSchedule(
    first.schedule!,
    { id: "s1", kind: "every", everyMs: 60_000, prompt: "叮", createdAt: 0 },
    0,
  );
  await first.stop();

  const second = await createAgent(opts(store, { clock: new FakeClock(0) }));
  await second.start();
  expect((await listSchedules(second.schedule!)).map((e) => e.schedule.id)).toEqual(["s1"]);
  await second.stop();
});

test("stop() 之后不留野定时器", async () => {
  const clock = new FakeClock(0);
  const agent = await createAgent(opts(new InMemoryDir(), { clock }));
  await agent.start();
  expect(clock.pending).toBeGreaterThan(0); // start 起了 tick
  await agent.stop();
  expect(clock.pending).toBe(0); // 收干净
});

test("start() 中途失败：lease 还回去，**且不留野定时器**", async () => {
  const lock = new InMemoryStateLock();
  const clock = new FakeClock(0);
  const store = new InMemoryDir();
  await store.write("meta.json", "不是 json"); // 让 createOrResume 炸

  const a = await createAgent(opts(store, { lock, clock }));
  await expect(a.start()).rejects.toThrow(/meta\.json 解不开/);

  expect(clock.pending).toBe(0); // 没有半启动的定时器活着
  // lease 还回去了：另一个 agent 还能起来
  const b = await createAgent(opts(new InMemoryDir(), { lock, clock: new FakeClock(0) }));
  await b.start();
  await b.stop();
});

test("start() 幂等：重复调不会起两套定时器", async () => {
  const clock = new FakeClock(0);
  const agent = await createAgent(opts(new InMemoryDir(), { clock }));
  await agent.start();
  const after1 = clock.pending;
  await agent.start();
  expect(clock.pending).toBe(after1);
  await agent.stop();
  expect(clock.pending).toBe(0);
});

test("start() 打开常驻行为：会自己醒、会自己整理", async () => {
  const agent = await createAgent(opts(new InMemoryDir(), { clock: new FakeClock(0) }));
  expect(agent.autoConsumeInbox).toBe(false); // 构造后还没开
  expect(agent.autoDream).toBe(false);
  await agent.start();
  expect(agent.autoConsumeInbox).toBe(true); // 「常驻」在机制上就是这两条
  expect(agent.autoDream).toBe(true);
  await agent.stop();
});
