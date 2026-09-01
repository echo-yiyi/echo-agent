import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { createAgent } from "../src/create-agent.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { SessionService } from "../src/session/service.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { userMessage } from "../src/messages.ts";
import { scriptedDialect, scriptedStreamFn, textTurn } from "../src/testing.ts";
import type { Provider } from "../src/provider/types.ts";
import type { StorageDir } from "../src/storage/types.ts";

// 2026-08-18 review 捅出来的一批：**单写与持久化的核心契约可复现破坏**。
// 每条都对应一个实测过的破坏路径，不是假想。

function provider(): Provider {
  return createProvider({
    id: "t",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "scripted" }],
    api: createProviderStreams(scriptedDialect([textTurn("ok"), textTurn("ok"), textTurn("ok")])),
  });
}

function opts(store: StorageDir, extra: Record<string, unknown> = {}): never {
  // sessionId 显式给 "main"：下面有测试直接操作 `sessions/main/…` 路径；缺省 id 现在按 workspace 派生
  return { provider: provider(), store, lock: new InMemoryStateLock(), allowNetwork: false, sessionId: "main", ...extra } as never;
}

/* ───────────── P1：stop() 之后不能再干活 ───────────── */

test("stop() 之后再 prompt → 拒绝（否则旧 Agent 会绕过锁继续落盘）", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();
  await agent.prompt("干活");
  await agent.stop();

  // 实测过的破坏：stop() 之后另一个 holder 拿到锁，旧 Agent 仍写进两条 session message
  await expect(agent.prompt("我还想写")).rejects.toThrow(/不接受新工作/);
});

test("stop() 是终态：不能再 start()", async () => {
  const agent = await createAgent(opts(new InMemoryDir()));
  await agent.start();
  await agent.stop();
  await expect(agent.start()).rejects.toThrow(/已经 stop\(\) 过了/);
});

test("stop() 幂等；start() 幂等", async () => {
  const agent = await createAgent(opts(new InMemoryDir()));
  await agent.start();
  await agent.start(); // 不抛
  await agent.stop();
  await agent.stop(); // 不抛
});

test("没 start() 就 prompt → 拒绝（带持久化装配时）", async () => {
  const agent = await createAgent(opts(new InMemoryDir()));
  await expect(agent.prompt("先干为敬")).rejects.toThrow(/不接受新工作/);
  await agent.stop();
});

test("丢锁之后 phase 变 lost，不能再 start()", async () => {
  const lock = new InMemoryStateLock();
  const agent = await createAgent(opts(new InMemoryDir(), { lock }));
  await agent.start();
  lock.simulateLost("租约过期");
  await new Promise((r) => setTimeout(r, 0));
  await expect(agent.start()).rejects.toThrow(/丢失 single-writer 租约/);
});

/* ───────────── P1：stop() 失败不泄漏 Lease ───────────── */

test("收摊途中抛错 → 错误照抛，但 Lease 必须还回去", async () => {
  const lock = new InMemoryStateLock();
  const agent = await createAgent(
    opts(new InMemoryDir(), {
      lock,
      agent: {
        disposables: [
          {
            dispose: async () => {
              throw new Error("收摊时炸了");
            },
          },
        ],
      },
    }),
  );
  await agent.start();
  await expect(agent.stop()).rejects.toThrow(/收摊时炸了/); // 原始错误不被吞

  // 实测过的破坏：释放不在 finally 里，于是第二次 acquire 永远拿不到
  const another = await lock.acquire({ holder: "接班的" });
  expect(another).not.toBeNull();
  await another!.release();
});

/* ───────────── P1：写失败 fail-loud ───────────── */

test("Store 写失败 → settle() 抛，不是静默 resolve", async () => {
  const broken: StorageDir = {
    read: async () => null,
    write: async () => {
      throw new Error("disk-down");
    },
    remove: async () => true,
    list: async () => [],
  };
  const s = new SessionService(broken);
  // createOrResume 自己会因为写 meta 失败而抛
  await expect(s.createOrResume("main")).rejects.toThrow(/disk-down/);
});

test("append 期间写失败 → settle() 抛出第一个错误", async () => {
  const inner = new InMemoryDir();
  let failFrom = Number.POSITIVE_INFINITY;
  let n = 0;
  const flaky: StorageDir = {
    read: (p) => inner.read(p),
    write: async (p, c) => {
      if (++n >= failFrom) throw new Error("disk-down");
      await inner.write(p, c);
    },
    remove: (p) => inner.remove(p),
    list: (prefix) => inner.list(prefix),
  };
  const s = new SessionService(flaky);
  await s.createOrResume("main");
  failFrom = n + 1; // 从下一次写开始失败
  await s.append("main", [{ kind: "message", message: userMessage("会写失败") }]);

  await expect(s.settle()).rejects.toThrow(/disk-down/);
});

/* ───────────── P1：恢复时的完整性 ───────────── */

test("entry 序号断链 → 拒载（否则续号会覆盖历史）", async () => {
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [
    { kind: "message", message: userMessage("一") },
    { kind: "message", message: userMessage("二") },
    { kind: "message", message: userMessage("三") },
  ]);
  await a.settle();

  // 删掉中间那条：实测过的破坏是恢复后续号从 e3 开始，下一次 append 覆盖原来的 000003.json
  await dir.remove("sessions/main/entries/000002.json");
  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/序号断链/);
});

test("parent 链断了 → 拒载", async () => {
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [
    { kind: "message", message: userMessage("一") },
    { kind: "message", message: userMessage("二") },
  ]);
  await a.settle();

  const raw = JSON.parse((await dir.read("sessions/main/entries/000002.json"))!) as Record<string, unknown>;
  raw["parentId"] = "main-e99"; // 指向不存在的前一条
  await dir.write("sessions/main/entries/000002.json", JSON.stringify(raw));

  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/parentId/);
});

test("meta.id 与目录名对不上 → 拒载", async () => {
  const dir = new InMemoryDir();
  await new SessionService(dir).createOrResume("main");
  const meta = JSON.parse((await dir.read("sessions/main/meta.json"))!) as Record<string, unknown>;
  meta["id"] = "别的会话";
  await dir.write("sessions/main/meta.json", JSON.stringify(meta));

  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/与目录名对不上/);
});

test("kind 不认识 / payload 缺件 → 拒载（判别联合逐个验）", async () => {
  const dir = new InMemoryDir();
  const a = new SessionService(dir);
  await a.createOrResume("main");
  await a.append("main", [{ kind: "message", message: userMessage("一") }]);
  await a.settle();

  const raw = JSON.parse((await dir.read("sessions/main/entries/000001.json"))!) as Record<string, unknown>;
  delete raw["message"]; // kind 还是 message，但 payload 没了
  await dir.write("sessions/main/entries/000001.json", JSON.stringify(raw));
  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/message 不是对象/);

  raw["kind"] = "未来版本的新类型";
  raw["message"] = { role: "user" };
  await dir.write("sessions/main/entries/000001.json", JSON.stringify(raw));
  await expect(new SessionService(dir).createOrResume("main")).rejects.toThrow(/kind 不认识/);
});

/* ───────────── P1：路径不能逃出状态根 ───────────── */

test("sessionId 里的 ../ → 判红，不写到状态根外", async () => {
  const s = new SessionService(new InMemoryDir());
  await expect(s.createOrResume("../../escaped")).rejects.toThrow(/会话 id 不合法/);
  await expect(s.createOrResume("..")).rejects.toThrow(/会话 id 不合法/);
  await expect(s.createOrResume("a/b")).rejects.toThrow(/会话 id 不合法/);
});

test("FileDir 自己也设防——不指望调用方都记得校验", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-jail-"));
  const dir = new FileDir(root);
  await expect(dir.write("../escaped.json", "x")).rejects.toThrow(/逃出了状态根/);
  await expect(dir.read("../../etc/passwd")).rejects.toThrow(/逃出了状态根/);
  await expect(dir.remove("../x")).rejects.toThrow(/逃出了状态根/);
  // 前缀陷阱：`<root>-sibling` 不是 root 的子路径
  await expect(dir.write("../" + join(root).split("/").pop() + "-sibling/x", "x")).rejects.toThrow(/逃出了状态根/);
});

/* ───────────── P1：store 与 lock 必须成对 ───────────── */

test("只给 store 不给 lock → fail-loud（远程 Store 配本机锁 = single-writer 失效）", async () => {
  await expect(
    createAgent({ provider: provider(), store: new InMemoryDir(), allowNetwork: false } as never),
  ).rejects.toThrow(/必须同时给 lock/);
});

test("只给 lock 不给 store → fail-loud（多半是漏传）", async () => {
  await expect(
    createAgent({ provider: provider(), lock: new InMemoryStateLock(), allowNetwork: false } as never),
  ).rejects.toThrow(/必须同时给 store/);
});

test("两个都不给 → 用 first-party 默认件（这条路仍然通）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-pair-"));
  const agent = await createAgent({ provider: provider(), stateDir: dir, allowNetwork: false } as never);
  await agent.start();
  await agent.stop();
});

/* ══════════ 2026-08-19 review 的第二批 ══════════ */

/* ───────────── P1：生命周期闸不能只看锁 ───────────── */

test("只装 sessionService、不装锁的 Agent，stop() 之后同样不许再写", async () => {
  // `AgentOptions` 明确允许只给 sessionService（单进程用法）。闸此前只判 stateLock，
  // 于是这种 Agent stop() 之后仍能 prompt 并写进两条 entry——实测过。
  const store = new InMemoryDir();
  const sessions = new SessionService(store);
  // model 必须是真 Model（O2b 起构造期就验 JSON-like：provider 是字符串 id，不是 Provider 对象）
  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn([textTurn("ok"), textTurn("ok")]),
    sessionService: sessions,
  });

  await agent.start();
  await agent.prompt("干活");
  const before = (await store.list("sessions/main/entries/")).length;
  await agent.stop();

  await expect(agent.prompt("我还想写")).rejects.toThrow(/不接受新工作/);
  expect((await store.list("sessions/main/entries/")).length).toBe(before);
});

/* ───────────── P1：启动途中丢锁，start() 不许返回成功 ───────────── */

/** 一取到就立刻宣告丢失的锁——把「启动途中丢锁」这个窄窗口变成确定事件。 */
class LosesImmediatelyLock extends InMemoryStateLock {
  override async acquire(o: { holder: string }): Promise<{ release(): Promise<void>; lost: Promise<Error> } | null> {
    const lease = await super.acquire(o);
    if (lease === null) return null;
    return { release: lease.release, lost: Promise.resolve(new Error("lost-during-start")) };
  }
}

test("启动途中丢锁 → start() 判红，且相位停在 lost 不被盖回 running", async () => {
  // 实测过的破坏：watchLease 先把 phase 置成 lost，start() 随后一行 `phase = "running"`
  // 把它盖了回去并返回成功——调用方拿到一个自以为持有状态根的 Agent。
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store, { lock: new LosesImmediatelyLock() }));

  await expect(agent.start()).rejects.toThrow();
  // lost 是终态：既不能干活，也不能重启
  await expect(agent.prompt("写点什么")).rejects.toThrow();
  await expect(agent.start()).rejects.toThrow(/已丢失 single-writer 租约|启动途中/);
});

/* ───────────── P1：stop() 不许吞掉释放失败 ───────────── */

test("释放 lease 失败 → stop() 必须抛（否则调用方以为安全收摊，锁还在）", async () => {
  const store = new InMemoryDir();
  const lock = new InMemoryStateLock();
  const original = lock.acquire.bind(lock);
  lock.acquire = async (o) => {
    const lease = await original(o);
    if (lease === null) return null;
    return {
      release: async () => {
        throw new Error("release-failed");
      },
      lost: lease.lost,
    };
  };

  const agent = await createAgent(opts(store, { lock }));
  await agent.start();
  await expect(agent.stop()).rejects.toThrow(/没释放掉|release-failed/);
});

test("收摊本身出错时，报的是根因，不是释放错误", async () => {
  const store = new InMemoryDir();
  const lock = new InMemoryStateLock();
  const original = lock.acquire.bind(lock);
  lock.acquire = async (o) => {
    const lease = await original(o);
    if (lease === null) return null;
    return {
      release: async () => {
        throw new Error("release-failed");
      },
      lost: lease.lost,
    };
  };

  const agent = await createAgent(
    opts(store, {
      lock,
      agent: { disposables: [{ dispose: async () => { throw new Error("dispose-failed"); } }] },
    }),
  );
  await agent.start();
  // 两处都失败：**都要报出来**（O2d-1 起 stop() 收齐收摊 / lifecycle fence / 释放三类错误），
  // 但**根因排在第一个**——上一版只抛 dispose 那条，释放失败被吞；反过来只抛释放失败则盖掉根因。
  const err = await agent.stop().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AggregateError);
  const errors = (err as AggregateError).errors as Error[];
  expect(errors[0]?.message).toContain("dispose-failed");
  expect(errors.some((e) => e.message.includes("release-failed"))).toBe(true);
});

/* ───────────── P2：start() 真幂等 ───────────── */

test("并发两个 start() 共享同一次启动，都成功", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  const [a, b] = await Promise.allSettled([agent.start(), agent.start()]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
  await agent.stop();
});

/* ══════════ 2026-08-19 第三轮 review ══════════ */

/** `acquire()` 慢半拍的锁——把「start 还没拿到锁」这个窄窗口变成确定事件。 */
class SlowAcquireLock extends InMemoryStateLock {
  released = false;
  private release!: () => void;
  readonly acquiring = new Promise<void>((r) => {
    this.release = r;
  });
  private gate: Promise<void>;
  private open!: () => void;

  constructor() {
    super();
    this.gate = new Promise<void>((r) => {
      this.open = r;
    });
  }

  /** 让卡住的 acquire 继续往下走。 */
  proceed(): void {
    this.open();
  }

  override async acquire(o: { holder: string }): Promise<{ release(): Promise<void>; lost: Promise<Error> } | null> {
    this.release(); // 通知测试：已经进到 acquire 了
    await this.gate; // 卡住
    const lease = await super.acquire(o);
    if (lease === null) return null;
    return {
      release: async () => {
        this.released = true;
        await lease.release();
      },
      lost: lease.lost,
    };
  }
}

test("stop() 不许在 start() 还没拿到锁时就返回（否则进程退出后锁留在盘上）", async () => {
  // 实测破坏：start() 卡在 acquire，stop() 已经 resolved——此刻 lease 尚未取得、
  // 更未释放；调用方据此退出进程，而 start() 随后才拿到锁。
  const store = new InMemoryDir();
  const lock = new SlowAcquireLock();
  const agent = await createAgent(opts(store, { lock }));

  const starting = agent.start();
  await lock.acquiring; // start 确实卡在 acquire 里了

  const stopping = agent.stop();
  let stopDone = false;
  void stopping.then(
    () => (stopDone = true),
    () => (stopDone = true),
  );

  // **等一个宏任务**，不是几拍微任务：收摊里 `dispose()` 本身要好几拍，
  // 微任务数太少的话破坏版也「还没结束」，那条断言就是空的（第一版反证正是这么漏的）。
  await new Promise((r) => setTimeout(r, 20));
  expect(stopDone, "stop() 在 start() 还没拿到锁时就返回了").toBe(false);

  lock.proceed();
  await starting.catch(() => undefined);
  await stopping.catch(() => undefined);

  // 而且 stop() 返回时，锁必须已经还回去了
  expect(lock.released).toBe(true);
});

test("并发两个 stop() 共享同一次收摊", async () => {
  const store = new InMemoryDir();
  const agent = await createAgent(opts(store));
  await agent.start();
  const [a, b] = await Promise.allSettled([agent.stop(), agent.stop()]);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
});

test("第二个 stop() 也要等到锁真的还回去——不许在释放途中提前返回", async () => {
  // 与上面那条 P1 同一个形状：`stop()` 里若先看 `phase === "stopped"` 再看在飞的收摊，
  // 那么 phase 已翻成 stopped、而 `release()` 还在飞的那一刻，第二个 stop() 会提前返回。
  const store = new InMemoryDir();
  const lock = new InMemoryStateLock();
  const original = lock.acquire.bind(lock);
  let releaseDone = false;
  lock.acquire = async (o) => {
    const lease = await original(o);
    if (lease === null) return null;
    return {
      release: async () => {
        await new Promise((r) => setTimeout(r, 20)); // 释放很慢
        releaseDone = true;
        await lease.release();
      },
      lost: lease.lost,
    };
  };

  const agent = await createAgent(opts(store, { lock }));
  await agent.start();

  const first = agent.stop();
  await new Promise((r) => setTimeout(r, 5)); // 让 first 走到「已置 stopped、正在释放」
  await agent.stop(); // 第二个：返回时锁必须已经还回去了
  expect(releaseDone).toBe(true);
  await first;
});
