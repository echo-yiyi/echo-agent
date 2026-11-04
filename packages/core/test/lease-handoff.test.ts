// 「人优先，后台让位」的判据（2026-09-07 用户拍板，docs/design/sessions.md §5）。
//
// 由来：`send` 给没在跑的段会把它叫起来（虚拟 actor），于是多了一种冲突——
// 后台把某段叫醒之后，**人**在另一个终端 `--resume` 同一段会被挡在门外。
// 锁本来就保证不会两个写者同时在，问题只在**谁输**：人的显式动作输给一次隐式唤醒不能接受。
//
// 定的规矩：持有者可以自称「可让位」；拿不到锁的人先问一句「能让吗」，
// 只有自称可让位的才让。**锁绝不从谁手里夺走**——让不让是持有者自己决定的，
// 所以 `StateLock` 那句「core 不抢占、不猜对面死没死」一个字没变。
//
// 两种实现（内存锁 / 文件锁）走同一份语义，所以下面每条都对两边成立。

import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStateLock, type StateLock } from "../src/storage/lock.ts";
import { fileStateLock, inspectStateLock } from "../src/storage/file-lock.ts";
import { createAgent } from "../src/create-agent.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { scriptedDialect, textTurn } from "../src/testing.ts";
import type { Provider } from "../src/provider/types.ts";

function provider(): Provider {
  return createProvider({
    id: "t",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect([textTurn("好"), textTurn("好")])),
  });
}

async function fileLockAt(): Promise<{ lock: StateLock; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "echo-handoff-"));
  const path = join(dir, ".lock");
  return { lock: fileStateLock(path), path };
}

test("文件锁：可让位的持有者 release 之后不再盯 `.handoff`——否则每把租约留下一条每 50ms 读盘、永不回收的轮询链（review 2026-09-07）", async () => {
  const { lock, path } = await fileLockAt();
  const held = await lock.acquire({ holder: "后台", preemptible: true });
  expect(held).not.toBeNull();
  let asked = false;
  void held!.handoffRequested?.then(() => (asked = true));
  await held!.release();

  // release 之后才有人来请：轮询已停，这把已经到头的租约不该再收到信号
  await writeFile(`${path}.handoff`, JSON.stringify({ by: "人", at: Date.now() }));
  await new Promise((r) => setTimeout(r, 150)); // 三个轮询周期
  expect(asked).toBe(false);
});

test("文件锁：拿不到锁的 acquire 不许删别人的 `.handoff`——人的让位请求不能被第三方的失败尝试抹掉（review 2026-09-07）", async () => {
  const { lock, path } = await fileLockAt();
  const held = await lock.acquire({ holder: "后台", preemptible: true });
  expect(held).not.toBeNull();
  await writeFile(`${path}.handoff`, JSON.stringify({ by: "人", at: Date.now() }));
  const third = await lock.acquire({ holder: "第三方" });
  expect(third).toBeNull();
  expect(existsSync(`${path}.handoff`)).toBe(true); // 此前：acquire 一进门就 rm，请求被静默抹掉
  await held!.release();
});

/* ───────────── 端口层：两种实现同一份语义 ───────────── */

for (const [name, make] of [
  ["内存锁", async (): Promise<StateLock> => new InMemoryStateLock()],
  ["文件锁", async (): Promise<StateLock> => (await fileLockAt()).lock],
] as const) {
  test(`${name}：不可让位的持有者一律不让——人开的会话不会被后台顶掉`, async () => {
    const lock = await make();
    const held = await lock.acquire({ holder: "人" }); // 缺省就是不可让位
    expect(held).not.toBeNull();
    expect(await lock.requestHandoff?.({ by: "后台", timeoutMs: 200 })).toBe(false);
    expect(await lock.acquire({ holder: "后台" })).toBeNull(); // 还占着，谁也拿不走
    await held!.release();
  });

  test(`${name}：可让位的持有者收到信号、自己 release，请的人随后拿得到`, async () => {
    const lock = await make();
    const held = await lock.acquire({ holder: "后台", preemptible: true });
    expect(held).not.toBeNull();

    // 持有者这一侧：收到「有人在等」就让开。真实里这段是 `Agent.watchHandoff`
    const asked: string[] = [];
    void held!.handoffRequested?.then(async (who) => {
      asked.push(who.by);
      await held!.release();
    });

    expect(await lock.requestHandoff?.({ by: "人", timeoutMs: 3_000 })).toBe(true);
    expect(asked).toEqual(["人"]);
    const mine = await lock.acquire({ holder: "人" });
    expect(mine).not.toBeNull(); // 空出来了
    await mine!.release();
  });

  test(`${name}：没人占着时，请一下等于「已经空着」`, async () => {
    const lock = await make();
    expect(await lock.requestHandoff?.({ by: "人", timeoutMs: 100 })).toBe(true);
  });

  test(`${name}：持有者不理会，超时如实返回 false，锁还在它手里`, async () => {
    // **不夺锁**：请不动就是请不动，调用方按老规矩 fail-loud。
    const lock = await make();
    const held = await lock.acquire({ holder: "装死的后台", preemptible: true });
    expect(await lock.requestHandoff?.({ by: "人", timeoutMs: 150 })).toBe(false);
    expect(await lock.acquire({ holder: "人" })).toBeNull();
    await held!.release();
  });
}

test("文件锁：请求写在锁旁边，让完就清掉——不许留给下一个持有者", async () => {
  // 请求方自己清（持有者那边一律不删）；就算没清掉，下一个持有者也只认认领之后的请求，不会转身让给一个早就走了的人。
  const { lock, path } = await fileLockAt();
  const held = await lock.acquire({ holder: "后台", preemptible: true });
  void held!.handoffRequested?.then(async () => held!.release());
  expect(await lock.requestHandoff?.({ by: "人", timeoutMs: 3_000 })).toBe(true);
  expect(existsSync(`${path}.handoff`), "请求文件没清掉").toBe(false);

  const next = await lock.acquire({ holder: "人", preemptible: true });
  expect(next).not.toBeNull();
  // 新持有者不该立刻被「上一轮的请求」叫走
  const woke = await Promise.race([
    next!.handoffRequested?.then(() => "被叫走了"),
    new Promise((r) => setTimeout(() => r("没人叫"), 200)),
  ]);
  expect(woke).toBe("没人叫");
  await next!.release();
});

/* ── 2026-11-03：serve.test 偶红的根因——acquire 在「锁已上盘」之后才删旧请求，人恰好在这中间发来的请求被当成旧的擦掉，干等到超时 ── */

/** 等 `handoffRequested`，等不到就算「没人叫」。 */
async function wokeWithin(held: { handoffRequested?: Promise<{ by: string }> }, ms: number): Promise<string> {
  return Promise.race([
    held.handoffRequested!.then((who) => `被 ${who.by} 叫走了`),
    new Promise<string>((r) => setTimeout(() => r("没人叫"), ms)),
  ]);
}

test("文件锁：认领之后才发出的请求，哪怕在 acquire 返回之前就落了盘，也照样算", async () => {
  // 真实的时序是「claimGeneration 写下记录 → 人看到 valid、写请求 → acquire 才往下走」，单进程里排不出来；
  // 用晚于现在的 `at` 模拟「这条请求是认领之后发的」，它在 acquire 返回前就已经在盘上
  const { lock, path } = await fileLockAt();
  await writeFile(`${path}.handoff`, JSON.stringify({ by: "人", at: Date.now() + 60_000 }));
  const held = await lock.acquire({ holder: "后台", preemptible: true });
  expect(held).not.toBeNull();
  expect(await wokeWithin(held!, 1_000)).toBe("被 人 叫走了"); // 此前：acquire 认领之后 rm，这条请求被擦掉，永远等不到
  await held!.release();
});

test("文件锁：上一轮留下的请求（早于认领）不叫醒新持有者，acquire 也不删它；之后来的新请求照样让", async () => {
  const { lock, path } = await fileLockAt();
  await writeFile(`${path}.handoff`, JSON.stringify({ by: "早走了的人", at: Date.now() - 60_000 }));
  const held = await lock.acquire({ holder: "后台", preemptible: true });
  expect(held).not.toBeNull();
  expect(existsSync(`${path}.handoff`), "持有者那边一律不删请求文件").toBe(true);
  expect(await wokeWithin(held!, 200)).toBe("没人叫"); // 四个轮询周期

  void held!.handoffRequested!.then(async () => held!.release());
  expect(await lock.requestHandoff?.({ by: "人", timeoutMs: 3_000 })).toBe(true);
});

test("文件锁：读不出 `at` 的请求文件（写坏了）这一次不算：不让，也不卡死后面的真请求", async () => {
  const { lock, path } = await fileLockAt();
  await writeFile(`${path}.handoff`, "{坏");
  const held = await lock.acquire({ holder: "后台", preemptible: true });
  expect(held).not.toBeNull();
  expect(await wokeWithin(held!, 200)).toBe("没人叫");

  void held!.handoffRequested!.then(async () => held!.release());
  expect(await lock.requestHandoff?.({ by: "人", timeoutMs: 3_000 })).toBe(true);
});

test("文件锁：可让位这件事写进认领记录——请它走的人在另一个进程里，只能从盘上看出来", async () => {
  const { lock, path } = await fileLockAt();
  const held = await lock.acquire({ holder: "后台", preemptible: true });
  const a = await inspectStateLock(path);
  expect(a.state === "valid" && a.record.preemptible).toBe(true);
  await held!.release();

  const plain = await lock.acquire({ holder: "人" });
  const b = await inspectStateLock(path);
  expect(b.state === "valid" && b.record.preemptible).toBeUndefined(); // 缺省不写
  await plain!.release();
});

/* ───────────── Agent 层：人来了，后台那段自己收摊 ───────────── */

test("人 start() 时后台那段让开：它自己 stop（drain 完、落完盘），不是被丢锁", async () => {
  // 没有这条时：后台把某段叫醒之后，人在另一个终端 `--resume` 同一段会被挡在门外——
  // 人的显式动作输给一次隐式唤醒。
  const lock = new InMemoryStateLock();
  const store = new InMemoryDir();
  const shared = new InMemoryDir();
  const common = {
    provider: provider(),
    allowNetwork: false,
    store,
    sharedStore: shared,
    lock,
    sessionId: "s1",
    withoutMemory: true,
  } as const;

  const background = await createAgent({ ...common, preemptible: true });
  await background.start();
  await background.prompt("后台先干点活"); // 有内容，才验得到「落完盘才让」

  const human = await createAgent(common); // 缺省不可让位
  await human.start(); // 人来了：后台应当自己让开
  expect(human.messages.length).toBeGreaterThan(0); // 续上了后台落下的那段对话

  // 后台那段是**正常收摊**，不是丢锁：丢锁会把 lastError 立成 lease-lost
  expect(background.state.lastError).toBeNull();
  await human.stop();
});

test("两个后台互相不请：谁先拿到谁跑，第二个如实拒绝（不 ping-pong）", async () => {
  const lock = new InMemoryStateLock();
  const store = new InMemoryDir();
  const shared = new InMemoryDir();
  const common = {
    provider: provider(),
    allowNetwork: false,
    store,
    sharedStore: shared,
    lock,
    sessionId: "s1",
    withoutMemory: true,
    preemptible: true,
  } as const;

  const first = await createAgent(common);
  await first.start();
  const second = await createAgent(common);
  await expect(second.start()).rejects.toThrow(/已被另一个写者持有/);
  await first.stop();
});
