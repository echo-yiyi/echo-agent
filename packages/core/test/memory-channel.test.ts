import { test, expect } from "bun:test";
import { MemoryChannel } from "../src/memory/channel.ts";

// 记忆后台通道的折叠语义：在跑的时候又排进来几次，跑完只再跑**最后排进来的那一次**。
// 回调捕获的是排它那一刻的材料（提取的 transcript 在闭包里），重跑第一个回调等于把旧材料再提取一遍——
// 2026-09-14 之前就是这样：只记一个 bit，跑完 `start(run)` 用的还是第一次的 run。

async function idle(channel: MemoryChannel, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (channel.busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

test("在跑时排进来的几次折叠成一次：跑的是最后排进来的那个，不是重跑第一个", async () => {
  let release = (): void => {};
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const calls: string[] = [];
  const channel = new MemoryChannel("probe");
  channel.schedule(async () => {
    calls.push("first");
    await barrier;
  });
  channel.schedule(async () => {
    calls.push("middle");
  });
  channel.schedule(async () => {
    calls.push("latest");
  });
  release();
  await idle(channel);
  expect(calls).toEqual(["first", "latest"]);
});

test("settle() 中断在跑的，并丢掉还没开始的下一次", async () => {
  const calls: string[] = [];
  const channel = new MemoryChannel("probe");
  channel.schedule(async (signal) => {
    calls.push("first");
    await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
  });
  channel.schedule(async () => {
    calls.push("next");
  });
  await channel.settle();
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toEqual(["first"]);
  expect(channel.busy).toBe(false);
});
