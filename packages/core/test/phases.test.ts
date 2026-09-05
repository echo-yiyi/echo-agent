// 生命周期相位：`start({activation:"deferred"})` → `restored(deferred-start)` → `activate()` → running；
// `pauseManagedWork({reason:"handoff"})` → `restored(paused)` → `resumeManagedWork()` → running；
// 以及 restored 的方法矩阵（prompt 拒、consumeInbox 禁、Dream 禁、ingress 仍 accepted 但不自动消费）。
//
// 判据都落在**可观察行为**上：恢复回来了没、有没有自己动、盘上那条被吃掉没有。

import { test, expect } from "bun:test";
import { createAgent } from "../src/create-agent.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import type { StateLock } from "../src/storage/lock.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import { environmentMessage } from "../src/messages.ts";
import { InboxStore } from "../src/inbox/store.ts";
import { addSchedule, listSchedules } from "../src/schedule/harness.ts";
import { startBackground } from "../src/background/harness.ts";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedDialect, scriptedStreamFn, textTurn } from "../src/testing.ts";
import type { Provider } from "../src/provider/types.ts";
import type { StorageDir } from "../src/storage/types.ts";

function provider(): Provider {
  return createProvider({
    id: "t",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "scripted" }],
    api: createProviderStreams(scriptedDialect([textTurn("收到"), textTurn("再来"), textTurn("还有")])),
  });
}

function opts(store: StorageDir, extra: Record<string, unknown> = {}): never {
  return { provider: provider(), store, lock: new InMemoryStateLock(), clock: new FakeClock(0), allowNetwork: false, ...extra } as never;
}

/** 往盘上先放一条未消费的入站事实（模拟崩溃前投进来的）。 */
async function seedPendingInbox(store: StorageDir, text: string, ref: string): Promise<void> {
  const ledger = new InboxStore(store);
  await ledger.restore();
  const r = await ledger.accept({ message: environmentMessage(text, "bg", ref), dedupeKey: `env:2:bg:${ref.length}:${ref}` });
  if (r.kind !== "accepted") throw new Error("seed 失败");
}

test("start({activation:\"deferred\"})：恢复做完但一件自己动的事都没做——prompt 拒、consumeInbox 禁、pending 不被吃", async () => {
  const store = new InMemoryDir();
  await seedPendingInbox(store, "崩溃前的事", "b1");

  const agent = await createAgent(opts(store));
  await agent.start({ activation: "deferred" });

  // 恢复真的做完了：盘上那条回到账本里
  const ledger = (agent as unknown as { inbox: InboxStore }).inbox;
  expect(ledger.pendingCount).toBe(1);
  // 但一件自己动的事都没做
  expect(agent.autoConsumeInbox).toBe(false);
  expect(agent.autoDream).toBe(false);
  await expect(agent.prompt("干活")).rejects.toThrow(/restored\(deferred-start\)/);
  expect(await agent.consumeInbox()).toBeNull(); // 禁止消费
  await new Promise((r) => setTimeout(r, 10));
  expect(ledger.pendingCount).toBe(1); // 没被偷偷吃掉

  await agent.stop();
});

test("activate()：切到 running 之后才开始自己动——恢复出来的那条被吃掉、prompt 能跑", async () => {
  const store = new InMemoryDir();
  await seedPendingInbox(store, "崩溃前的事", "b1");
  const agent = await createAgent(opts(store));
  await agent.start({ activation: "deferred" });
  const ledger = (agent as unknown as { inbox: InboxStore }).inbox;

  await agent.activate();
  expect(agent.autoConsumeInbox).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(ledger.pendingCount).toBe(0); // activate 之后它自己醒了
  expect((await agent.prompt("干活")).outcome.kind).toBe("completed");
  await agent.stop();
});

test("restored 期间 ingress 仍 accepted（持有租约、target 开着），只是不自动消费；activate 之后才吃", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start({ activation: "deferred" });
  const ledger = (agent as unknown as { inbox: InboxStore }).inbox;

  const result = await agent.ingress.deliverDurable({ message: environmentMessage("handoff 期间发生的事", "bg", "b9"), dedupeKey: "env:2:bg:2:b9" });
  // 上一版的闸只认 running：restored 期间对外一律 runtime-not-ready，等于把「外面发生的事」丢了
  expect(result).toMatchObject({ kind: "accepted", deduplicated: false });
  expect(ledger.pendingCount).toBe(1);
  await new Promise((r) => setTimeout(r, 10));
  expect(ledger.pendingCount).toBe(1); // 不自动 consume

  await agent.activate();
  await new Promise((r) => setTimeout(r, 20));
  expect(ledger.pendingCount).toBe(0);
  await agent.stop();
});

test("deferred start 不做 catch-up：错过窗口的闹钟要等 activate() 才被清算", async () => {
  const store = new InMemoryDir();
  const clock = new FakeClock(0);
  const first = await createAgent(opts(store, { clock }));
  await first.start();
  await addSchedule(first.schedule!, { kind: "at", id: "s1", prompt: "到点了", createdAt: 0, at: 60_000 });
  await first.stop();

  // 停机期间错过了整个补跑窗口：catch-up 的裁决是「删掉并留痕」（这条路径不依赖 timer，确定性可判）
  clock.advance(60_000 + 10 * 60_000);
  const agent = await createAgent(opts(store, { clock }));
  const notes: string[] = [];
  agent.subscribeLifecycle((e) => {
    if (e.type === "notification") notes.push(e.message);
  });

  await agent.start({ activation: "deferred" });
  // **deferred 只恢复规则**：条目原样还在，一次清算都没做
  expect((await listSchedules(agent.schedule!)).map((e) => e.schedule.id)).toEqual(["s1"]);
  expect(notes.some((m) => m.includes("schedule_expired"))).toBe(false);

  await agent.activate();
  // activate 才在 managed-activation lane 上做 catch-up
  expect(await listSchedules(agent.schedule!)).toEqual([]);
  expect(notes.some((m) => m.includes("schedule_expired"))).toBe(true);
  await agent.stop();
});

test("pauseManagedWork(handoff)：停自己动、business gate 关到 closed，但**不释放租约**——resume 之后照常跑", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();
  await agent.prompt("干活");

  await agent.pauseManagedWork({ reason: "handoff" });
  expect(agent.autoConsumeInbox).toBe(false);
  expect(agent.autoDream).toBe(false);
  await expect(agent.prompt("还想干活")).rejects.toThrow(/restored\(paused\)/);
  // 租约还在手上：ingress 照收（handoff 期间外面发生的事一件都不该丢）
  const accepted = await agent.ingress.deliverDurable({ message: environmentMessage("暂停期间的事", "bg", "p1"), dedupeKey: "env:2:bg:2:p1" });
  expect(accepted.kind).toBe("accepted");

  await agent.resumeManagedWork();
  expect(agent.autoConsumeInbox).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
  expect((agent as unknown as { inbox: InboxStore }).inbox.pendingCount).toBe(0); // 恢复之后被吃掉
  await agent.stop();
});

test("两种 restored reason 各有各的消费者：调错接缝 fail-loud", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start({ activation: "deferred" });
  // deferred-start 只能 activate()
  await expect(agent.resumeManagedWork()).rejects.toThrow(/只消费 restored\(paused\)/);
  await agent.activate();

  await agent.pauseManagedWork({ reason: "handoff" });
  // paused 只能 resumeManagedWork()
  await expect(agent.activate()).rejects.toThrow(/只消费 restored\(deferred-start\)/);
  await agent.resumeManagedWork();
  await agent.stop();
});

test("pauseManagedWork 只服务 handoff；只允许从 running 进入", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start({ activation: "deferred" });
  await expect(agent.pauseManagedWork({ reason: "stop" as never })).rejects.toThrow(/只服务 handoff/);
  await expect(agent.pauseManagedWork({ reason: "handoff" })).rejects.toThrow(/只允许从 running 进入/);
  await agent.stop();
});

test("幂等且串行：并发 activate 只切一次；重复 pause / resume 不抛", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start({ activation: "deferred" });
  const [a, b] = await Promise.allSettled([agent.activate(), agent.activate()]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");

  await agent.pauseManagedWork({ reason: "handoff" });
  await agent.pauseManagedWork({ reason: "handoff" }); // 幂等
  await agent.resumeManagedWork();
  await agent.resumeManagedWork(); // 幂等（已经 running）
  await agent.stop();
});

test("丢锁之后：activate / pause / resume 一律 fail-loud", async () => {
  const store = new InMemoryDir();
  const lock = new InMemoryStateLock();
  const agent = await createAgent(opts(store, { lock }));
  await agent.start({ activation: "deferred" });
  lock.simulateLost("租约过期");
  await new Promise((r) => setTimeout(r, 10));

  await expect(agent.activate()).rejects.toThrow(/丢失 single-writer 租约/);
  await expect(agent.pauseManagedWork({ reason: "handoff" })).rejects.toThrow(/丢失 single-writer 租约|只允许从 running/);
  await expect(agent.resumeManagedWork()).rejects.toThrow(/丢失 single-writer 租约/);
});

test("缺省 start() 语义不变：恢复 + 立刻自己动（既有调用面一个字都不用改）", async () => {
  const store = new InMemoryDir();
  await seedPendingInbox(store, "崩溃前的事", "b1");
  const agent = await createAgent(opts(store));
  await agent.start();
  expect(agent.autoConsumeInbox).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
  expect((agent as unknown as { inbox: InboxStore }).inbox.pendingCount).toBe(0);
  await agent.stop();
});

test("restored 也能直接 stop()：不要求先 activate", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start({ activation: "deferred" });
  await agent.stop(); // 不抛
  await expect(agent.start()).rejects.toThrow(/已经 stop\(\) 过了/);
});

/* ─────────────── review 反例：lifecycle actor / 吸收态 / barrier / drain ─────────────── */

/**
 * 造一个 catch-up 会卡住的状态根：盘上留一条过期的一次性闹钟，
 * catch-up 删它时要写 schedules.json——把那次写卡住，activation 就停在半路。
 */
async function seedSlowCatchUp(store: InMemoryDir, clock: FakeClock): Promise<{ store: StorageDir; release: () => void; written: () => boolean }> {
  const first = await createAgent(opts(store, { clock }));
  await first.start();
  await addSchedule(first.schedule!, { kind: "at", id: "s1", prompt: "到点了", createdAt: 0, at: 60_000 });
  await first.stop();
  clock.advance(60_000 + 10 * 60_000); // 错过整个补跑窗口 → catch-up 会删它并写盘

  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let done = false;
  const slow: StorageDir = {
    read: (p) => store.read(p),
    list: (p) => store.list(p),
    remove: (p) => store.remove(p),
    write: async (p, c) => {
      if (p === "schedules.json") {
        await gate;
        done = true;
      }
      return store.write(p, c);
    },
  };
  return { store: slow, release, written: () => done };
}

test("**P0**：activate() 卡在 catch-up 时 stop() 进来——两者排同一条 lifecycle actor，不会把已停的 Agent 写回 running", async () => {
  const raw = new InMemoryDir();
  const clock = new FakeClock(0);
  const { store, release } = await seedSlowCatchUp(raw, clock);
  const agent = await createAgent(opts(store, { clock }));
  await agent.start({ activation: "deferred" });

  const activating = agent.activate();
  await new Promise((r) => setTimeout(r, 5)); // 确实卡在 catch-up 的那次写上
  const stopping = agent.stop();
  release();
  await Promise.allSettled([activating, stopping]);

  // 上一版：stop() 从 activate 旁边插进去先 release Lease，activation 接着起 timer 并把 phase 写回 running
  await expect(agent.prompt("还想干活")).rejects.toThrow(/已经 stop\(\) 过了|不接受新工作/);
  await expect(agent.activate()).rejects.toThrow(/收摊或已停|已经 stop/);
});

test("**P0**：activate() 中途丢锁 → activate() 明确失败，不覆盖 lost 吸收态", async () => {
  const raw = new InMemoryDir();
  const clock = new FakeClock(0);
  const { store, release } = await seedSlowCatchUp(raw, clock);
  const lock = new InMemoryStateLock();
  const agent = await createAgent(opts(store, { clock, lock }));
  await agent.start({ activation: "deferred" });

  const activating = agent.activate();
  await new Promise((r) => setTimeout(r, 5));
  lock.simulateLost("租约过期");
  release();

  // 上一版：activate() 照样 resolve，并把 lost 覆盖成 running
  await expect(activating).rejects.toThrow(/丢失 single-writer 租约/);
  await expect(agent.prompt("还想干活")).rejects.toThrow(/租约/);
  expect(agent.autoConsumeInbox).toBe(false);
});

test("**P1**：restored(paused) 上调 start() → fail-loud 且状态不变，resumeManagedWork() 仍能恢复", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();
  await agent.pauseManagedWork({ reason: "handoff" });

  // 上一版：start() 会重新 acquire 自己已经持有的锁，失败后 catch 把 phase 打回 new，resume 也救不回来
  await expect(agent.start()).rejects.toThrow(/resumeManagedWork/);
  await agent.resumeManagedWork();
  expect(agent.autoConsumeInbox).toBe(true);
  expect((await agent.prompt("干活")).outcome.kind).toBe("completed");
  await agent.stop();
});

test("**P1**：并发 start 的 activation 参数不同 → fail-loud，不静默采用先到者", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  const deferred = agent.start({ activation: "deferred" });
  const immediate = agent.start({ activation: "immediate" });
  await expect(immediate).rejects.toThrow(/不能同时按/);
  await deferred;
  // 先到的那次说了算：停在 restored，没有被静默 activate
  await expect(agent.prompt("干活")).rejects.toThrow(/restored\(deferred-start\)/);
  await agent.stop();
});

test("**P1**：pause 立起 reconfiguration barrier——drain 期间新的 followUp / steer 一律 rejected(reconfiguring)", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();

  const gate = new RunIntakeProbe(agent);
  const pausing = agent.pauseManagedWork({ reason: "handoff" });
  // barrier 是同步立起来的：pause 还没 settle 时就已经生效
  expect((await agent.followUp("插一件")).kind).toBe("rejected");
  expect(await gate.followUpReason()).toBe("reconfiguring");
  expect(await gate.steerReason()).toBe("reconfiguring");
  await pausing;
  expect((await agent.followUp("再插")).kind).toBe("rejected");

  // resume 之后重新开放（没有 run 时是 no-active-run，不再是 reconfiguring）
  await agent.resumeManagedWork();
  expect(await gate.followUpReason()).toBe("no-active-run");
  await agent.stop();
});

/** 只取 rejected 的 reason，读起来短一点。 */
class RunIntakeProbe {
  constructor(private readonly agent: Awaited<ReturnType<typeof createAgent>>) {}
  async followUpReason(): Promise<string> {
    const r = await this.agent.followUp("探针");
    return r.kind === "rejected" ? r.reason : "accepted";
  }
  async steerReason(): Promise<string> {
    const r = await this.agent.steer("探针");
    return r.kind === "rejected" ? r.reason : "accepted";
  }
}

test("**P1**：pause 要等 barrier 之前已登记的 Background 任务 settle（不 abort——那是 shutdown 的事）", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();

  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let finished = false;
  await startBackground(agent.background, {
    kind: "test",
    label: "慢活",
    run: async () => {
      await gate;
      finished = true;
    },
  });
  await new Promise((r) => setTimeout(r, 5));
  expect(finished).toBe(false);

  let paused = false;
  const pausing = agent.pauseManagedWork({ reason: "handoff" }).then(() => {
    paused = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  // 上一版：pause 直接返回，后台活还在跑（PR 描述说会等，代码没等）
  expect(paused).toBe(false);
  expect(finished).toBe(false); // 而且**不 abort**：drain 是「等它做完」，不是「掐掉」

  release();
  await pausing;
  expect(finished).toBe(true);
  await agent.stop();
});

/* ─────────────── review 反例 2：同 tick 竞争 / 在飞 tick ─────────────── */

test("**P0**：pause 之后同一 tick 调 resume——相位判断在 actor 内，最终必须回到 running", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();

  // 不 await pause，同一 tick 直接 resume：上一版 resume 在**入队之前**读到还没改写的 running，
  // 于是「幂等」地提前返回，最终 Agent 停在 restored(paused)（实测）
  const pausing = agent.pauseManagedWork({ reason: "handoff" });
  const resuming = agent.resumeManagedWork();
  await Promise.all([pausing, resuming]);

  expect(agent.autoConsumeInbox).toBe(true); // 真的回到 running 了
  expect((await agent.prompt("干活")).outcome.kind).toBe("completed");
  await agent.stop();
});

test("**P0**：stop 之后同一 tick 调 start——start 不许「看到旧的 running」就成功返回", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();

  const stopping = agent.stop();
  const starting = agent.start();
  await stopping;
  // 上一版：start 在入队前读到还没改写的 running，直接 resolve；随后 stop 把 Agent 停掉，
  // 调用方却以为自己刚刚成功启动了一个能干活的 Agent
  await expect(starting).rejects.toThrow(/已经 stop\(\) 过了|stop\(\) 正在进行中/);
  await expect(agent.prompt("干活")).rejects.toThrow(/不接受新工作|已经 stop/);
});

/** 排空微任务：**不用真实时间**推进断言点（真 sleep 只是「大概率够了」，不是判据）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("**P1**：pause 要等已经开始的那一拍真的收完——clock.advance 进到被卡住的 schedules.json 写（纯确定性，无 sleep）", async () => {
  const raw = new InMemoryDir();
  const clock = new FakeClock(0);
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let enteredTick = (): void => {};
  const tickEntered = new Promise<void>((r) => {
    enteredTick = r;
  });
  let gateOn = false;
  let tickWrote = false;
  const slow: StorageDir = {
    read: (p) => raw.read(p),
    list: (p) => raw.list(p),
    remove: (p) => raw.remove(p),
    write: async (p, c) => {
      if (gateOn && p === "schedules.json") {
        enteredTick(); // 那一拍确实进到这次写了——判据是这个信号，不是「睡够了」
        await gate;
        tickWrote = true;
      }
      return raw.write(p, c);
    },
  };
  const agent = await createAgent(opts(slow, { clock }));
  await agent.start();
  agent.autoConsumeInbox = false; // 别让消费把证据吃掉
  // **闹钟要落在第一拍上**：`advance()` 是同步连发的，第一拍（未到期）会占住 tick 的重入守卫，
  // 把后面那些到期的拍全吞掉——闹钟设在 60s 后就永远等不到那一拍（实测 60 次 fire、零投递）。
  await addSchedule(agent.schedule!, { kind: "at", id: "a1", prompt: "到点了", createdAt: 0, at: 1_000 });

  // 从这里起卡住 schedules.json 的写；advance 让 timer 那一拍**已经开始**并停在那次写上
  gateOn = true;
  clock.advance(1_000);
  await tickEntered; // 确定性：那一拍已经进到被卡住的写里
  expect(tickWrote).toBe(false);

  let paused = false;
  const pausing = agent.pauseManagedWork({ reason: "handoff" }).then(() => {
    paused = true;
  });
  await flushMicrotasks();
  // barrier 是同步立起来的：pause 还没完成时就已经生效
  expect((await agent.followUp("插一件")).kind).toBe("rejected");
  // 上一版只 stopSchedule()：pause 已经返回，而那一拍还在往 schedules.json 里写
  expect(paused).toBe(false);

  release();
  await pausing;
  expect(tickWrote).toBe(true);
  await agent.stop();
});

test("**P0**：start（卡在 acquire）→ stop → start——第二次 start 不许复用第一次的 in-flight promise", async () => {
  const store = new InMemoryDir();
  let releaseAcquire = (): void => {};
  const acquireGate = new Promise<void>((r) => {
    releaseAcquire = r;
  });
  const inner = new InMemoryStateLock();
  const slowLock: StateLock = {
    acquire: async (o) => {
      await acquireGate;
      return inner.acquire(o);
    },
  };
  const agent = await createAgent(opts(store, { lock: slowLock }));

  const firstStart = agent.start(); // 卡在 acquire
  const stopping = agent.stop(); // 排在 start 后面
  const secondStart = agent.start(); // **中间隔了一个 stop**：不能复用 firstStart
  releaseAcquire();

  await firstStart;
  await stopping;
  // 上一版：secondStart 复用了 firstStart 的 promise 直接成功，调用方拿到一个「start 成功但已 stopped」的 Agent
  await expect(secondStart).rejects.toThrow(/已经 stop\(\) 过了|stop\(\) 正在进行中/);
  await expect(agent.prompt("干活")).rejects.toThrow(/不接受新工作|已经 stop/);
});

/* ─────────── acceptsWork 与 prompt() 同真同假：低层 Agent 也要成立（review 六轮 P1） ─────────── */

test("低层 Agent（无锁无 session）start → stop 之后：acceptsWork 与 prompt() 一起为假", async () => {
  // 上一版这条判据整段挂在 `lifecycleManaged` 下面，低层 Agent 于是绕过去了：
  // 实测 start 前 true、**stop 后仍然 true**，而 `prompt()` 早已被 admission 拒
  //（`run 被 admission 拒绝：stopping`）——`acceptsWork` 承诺的「同真同假」当场破。
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("好")]) });
  expect(agent.acceptsWork).toBe(true); // new：低层 Agent 在这个阶段能干活，是**保留**的既有语义

  await agent.start();
  expect(agent.acceptsWork).toBe(true); // running

  await agent.stop();
  expect(agent.acceptsWork).toBe(false);
  await expect(agent.prompt("停了还能干活吗")).rejects.toThrow(); // 同真同假：它拒，getter 也说拒
});

test("低层 Agent 直接 dispose()（没 start 过）：acceptsWork 与 prompt() 一起为假", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("好")]) });
  expect(agent.acceptsWork).toBe(true);

  await agent.dispose(); // 没 start 过，phase 仍是 "new"——只能靠 disposeInFlight 认出来
  expect(agent.acceptsWork).toBe(false);
  await expect(agent.prompt("收摊了还能干活吗")).rejects.toThrow(/已收摊/);
});

test("restored（deferred-start / paused）：acceptsWork 为假，且与 prompt() 的拒绝一致", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));

  await agent.start({ activation: "deferred" }); // → restored(deferred-start)
  expect(agent.acceptsWork).toBe(false);
  await expect(agent.prompt("干活")).rejects.toThrow(/restored\(deferred-start\)/);

  await agent.activate();
  expect(agent.acceptsWork).toBe(true); // running

  await agent.pauseManagedWork({ reason: "handoff" }); // → restored(paused)
  expect(agent.acceptsWork).toBe(false);
  await expect(agent.prompt("干活")).rejects.toThrow(/restored\(paused\)/);

  await agent.resumeManagedWork();
  expect(agent.acceptsWork).toBe(true);
  await agent.stop();
  expect(agent.acceptsWork).toBe(false);
});
