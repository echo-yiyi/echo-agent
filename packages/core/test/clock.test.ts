import { test, expect } from "bun:test";
import { FakeClock, systemClock } from "../src/schedule/clock.ts";
import { createAgentSchedule, addSchedule, startSchedule, stopSchedule } from "../src/schedule/harness.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import type { AgentMessage } from "../src/messages.ts";

// Clock 端口（D3 的第四类）。
//
// **立它的理由不是「时间有多种实现」，是确定性测试**：`schedule/harness.ts` 原先直接
// `setInterval` + `Date.now()`，于是「到点了会不会投递」只能靠 sleep 去撞——要么慢要么飘。
// 下面最后两条就是这个理由的兑现：**零 sleep**，把时间拨过去，断言恰好投了几次。

test("FakeClock：时间只在 advance 时前进", () => {
  const c = new FakeClock(1000);
  expect(c.now()).toBe(1000);
  c.advance(500);
  expect(c.now()).toBe(1500);
});

test("FakeClock：定时器按到期顺序逐个触发，不是跳到终点补一次", () => {
  const c = new FakeClock(0);
  const at: number[] = [];
  c.setInterval(() => at.push(c.now()), 100);
  c.advance(350);
  // 100 / 200 / 300 各一次——如果实现是「跳到 350 再补三次」，这里会全是 350
  expect(at).toEqual([100, 200, 300]);
  expect(c.now()).toBe(350);
});

test("FakeClock：取消之后不再触发，且 pending 归零", () => {
  const c = new FakeClock(0);
  let n = 0;
  const cancel = c.setInterval(() => n++, 10);
  c.advance(25);
  expect(n).toBe(2);
  cancel();
  c.advance(100);
  expect(n).toBe(2);
  expect(c.pending).toBe(0);
  cancel(); // 幂等：再调不炸
});

test("FakeClock：非正间隔判红（否则 advance 会死循环）", () => {
  const c = new FakeClock(0);
  expect(() => c.setInterval(() => {}, 0)).toThrow(/间隔必须为正/);
  expect(() => c.setInterval(() => {}, -1)).toThrow(/间隔必须为正/);
});

test("systemClock：真时钟返回取消函数，不暴露 handle", () => {
  // 类型上就拿不到 handle——这是为了不把 NodeJS.Timeout / number 拖进公共面
  const cancel = systemClock.setInterval(() => {}, 1000);
  expect(typeof cancel).toBe("function");
  cancel();
  expect(systemClock.now()).toBeGreaterThan(0);
});

/**
 * 排空微任务队列。`tickSchedule` 是 async（内部要读盘），而 `FakeClock` 是同步触发的——
 * 拨完时间要给那条 promise 链跑完的机会。**这不是 sleep**：没有等待真实时间，
 * 只是让已经排好的微任务执行完。
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ── 这两条是 Clock 端口存在的全部理由：零 sleep 地测 schedule ──

test("schedule + FakeClock：到点投递，一次不多一次不少（零 sleep）", async () => {
  const clock = new FakeClock(0);
  const delivered: AgentMessage[] = [];
  const ctx = createAgentSchedule(new InMemoryDir(), { clock, tickMs: 1000 });
  ctx.deliver = (m) => void delivered.push(m);

  // `everyMs` 有 60 秒下限（防空转）——**真时钟下这条测试要等一分钟**，
  // 假时钟下 advance 是瞬间的。这就是 Clock 端口存在的最直接理由。
  await addSchedule(ctx, { id: "s1", kind: "every", everyMs: 60_000, prompt: "该喝水了", createdAt: 0 }, 0);
  await startSchedule(ctx, 0);

  clock.advance(59_000); // 还没到
  await flush();
  expect(delivered).toHaveLength(0);

  clock.advance(2_000); // 越过 60_000
  await flush();
  expect(delivered).toHaveLength(1); // 恰好一次，不是「至少一次」

  stopSchedule(ctx);
  expect(clock.pending).toBe(0); // 收摊不留野定时器
});

test("schedule + FakeClock：stop 之后再拨时间也不投递", async () => {
  const clock = new FakeClock(0);
  const delivered: AgentMessage[] = [];
  const ctx = createAgentSchedule(new InMemoryDir(), { clock, tickMs: 1000 });
  ctx.deliver = (m) => void delivered.push(m);

  await addSchedule(ctx, { id: "s1", kind: "every", everyMs: 60_000, prompt: "叮", createdAt: 0 }, 0);
  await startSchedule(ctx, 0);
  stopSchedule(ctx);

  clock.advance(10 * 60_000); // 拨十分钟，够触发十次
  await flush();
  expect(delivered).toHaveLength(0);
});
