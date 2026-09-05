// AgentAssembly adoption：assembly 状态机、三态租约、唯一 dispose owner、原子转移、零副作用 factory。
//
// 判据尽量用「**第二次 dispose 会抛错**」的合法 fixture 立——契约里 `StorageDir.close()` 没有要求幂等，
// 所以「关两次」不是洁癖问题，而是注入一个守规矩的实现就会当场炸。计数断言只能证明「至少一次」，
// 抛错 fixture 才能证明「恰好一次」。
//
// 每条都写清**上一版会怎么错**：删掉对应实现应当变红。

import { test, expect } from "bun:test";
import { AgentAssembly } from "../src/assembly/ledger.ts";
import {
  FactoryPurityError,
  assertPureFactory,
  runFactoryProbe,
  trapStateLock,
  trapStorageDir,
} from "../src/assembly/probe.ts";
import { Agent } from "../src/agent.ts";
import { createAgent } from "../src/create-agent.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { createAgentMemories } from "../src/memory/harness.ts";
import { createAgentSchedule } from "../src/schedule/harness.ts";
import { InboxStore } from "../src/inbox/store.ts";
import { SessionService } from "../src/session/service.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { attachStateHost } from "../src/state/host-wiring.ts";
import { scriptedDialect, scriptedStreamFn, textTurn } from "../src/testing.ts";
import type { Provider } from "../src/provider/types.ts";
import type { StorageDir } from "../src/storage/types.ts";

/** 只肯被 dispose 一次的资源：第二次直接抛。**这是本文件全部「恰好一次」判据的立足点**。 */
function onceOnly(label: string): { dispose: () => void; count: () => number } {
  let n = 0;
  return {
    dispose: (): void => {
      n += 1;
      if (n > 1) throw new Error(`${label} 被 dispose 了第 ${n} 次`);
    },
    count: () => n,
  };
}

/* ─────────────── 三态与唯一 owner ─────────────── */

test("adoption 之前失败：provider 侧 unwind 收掉 offered 的 slot，且只收一次", async () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  const root = onceOnly("root-store");
  const owned = onceOnly("agent-scope");
  assembly.borrow("root-store", { v: 1 }, { dispose: root.dispose });
  assembly.adopt("echo:memory", () => ({ v: 2 }), { dispose: owned.dispose });
  assembly.seal();

  // 「值造好了、Agent 还没构造成功」那个窗口
  await assembly.abort();
  expect(assembly.state).toBe("aborted");
  expect(root.count()).toBe(1);
  expect(owned.count()).toBe(1);
  expect(assembly.inspect().every((s) => s.phase === "disposed")).toBe(true);

  // 重复 unwind 是空操作：**先落终态再跑 disposer**，抛错的那次也不留第二次机会
  await assembly.abort();
  await assembly.disposeProcessScope();
  expect(root.count()).toBe(1);
});

test("adoptInto 之后 provider 不再是 owner：abort 当场判红，drain 收且恰好一次", async () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  const owned = onceOnly("agent-scope");
  assembly.adopt("echo:memory", () => ({ v: 1 }), { dispose: owned.dispose });
  assembly.seal();
  const ledger = assembly.adoptInto("echo:agent");
  expect(assembly.state).toBe("adopted");

  // 上一版的写法是「provider 和 Agent 各登记一份保险 disposer」：正常路径下这里就会关第二次。
  // 现在连入口都封了——adoption 之后 provider 侧不是 owner，收摊只能走账本。
  expect(() => assembly.abort()).toThrow(/不再是 dispose owner/);
  expect(owned.count()).toBe(0);

  await ledger.drain();
  expect(owned.count()).toBe(1);
  await ledger.drain(); // 排空之后再排是空操作
  expect(owned.count()).toBe(1);
});

test("borrow slot 永远不进账本：drain 不碰它，进程域收摊才关，且只关一次", async () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  const root = onceOnly("root-store");
  assembly.borrow("root-store", { v: 1 }, { dispose: root.dispose });
  assembly.adopt("echo:inbox", () => ({ v: 2 }));
  assembly.seal();
  const ledger = assembly.adoptInto("echo:agent");

  expect(ledger.owns("root-store")).toBe(false);
  expect(ledger.owns("echo:inbox")).toBe(true);
  await ledger.drain();
  expect(root.count()).toBe(0); // Agent 收不到进程域的东西——它拿的是不带 close 的视图

  await assembly.disposeProcessScope();
  expect(root.count()).toBe(1);
  await assembly.disposeProcessScope();
  expect(root.count()).toBe(1);
});

test("drain：LIFO、全尝试、错误聚合——中间一条抛错不能让其余的被跳过", async () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  const order: string[] = [];
  assembly.adopt("a", () => 1, { dispose: () => void order.push("a") });
  assembly.adopt("b", () => 2, {
    dispose: () => {
      order.push("b");
      throw new Error("b 收摊失败");
    },
  });
  assembly.adopt("c", () => 3, {
    dispose: () => {
      order.push("c");
      throw new Error("c 收摊失败");
    },
  });
  assembly.seal();
  const ledger = assembly.adoptInto("echo:agent");

  await expect(ledger.drain()).rejects.toThrow(/2 处失败/);
  expect(order).toEqual(["c", "b", "a"]); // 后建的先收
});

test("形状与所有权的 fail-loud：seal 之后不能再 offer、slot 不能重名、未 seal 不能 adoptInto、只能接管一次", () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  assembly.adopt("dup", () => 1);
  expect(() => assembly.adopt("dup", () => 2)).toThrow(/重复登记/);
  expect(() => assembly.adoptInto("echo:agent")).toThrow(/必须先 seal/);
  assembly.seal();
  expect(() => assembly.adopt("late", () => 3)).toThrow(/不能再登记 slot/);
  assembly.adoptInto("echo:agent");
  expect(() => assembly.adoptInto("echo:agent-2")).toThrow(/已经被 'echo:agent' 接管过/);
});

test("observation：adopt 之后来源 owner 不丢、disposeOwner 换人（不能据 provider 身份推断谁负责收）", async () => {
  const assembly = new AgentAssembly({ provider: "echo:persistence-local" });
  assembly.adopt("echo:session", () => ({ v: 1 }));
  assembly.borrow("root-store", { v: 2 }, { dispose: () => undefined });
  assembly.seal();

  const before = assembly.inspect();
  expect(before.map((s) => s.phase)).toEqual(["offered", "offered"]);
  expect(before.every((s) => s.disposeOwner === "echo:persistence-local")).toBe(true);

  const ledger = assembly.adoptInto("echo:agent");
  const session = assembly.inspect().find((s) => s.slotId === "echo:session")!;
  expect(session).toMatchObject({
    mode: "adopt",
    phase: "adopted",
    provider: "echo:persistence-local", // 来源不因为被接管而丢
    disposeOwner: "echo:agent", // 但现在是 Agent 负责收
  });
  const root = assembly.inspect().find((s) => s.slotId === "root-store")!;
  expect(root).toMatchObject({ mode: "borrow", phase: "offered", disposeOwner: "echo:persistence-local" });
  await ledger.drain();
  expect(assembly.inspect().find((s) => s.slotId === "echo:session")!.phase).toBe("disposed");
});

/* ─────────────── 状态机：abort 与 adoptInto 的竞争 ─────────────── */

test("abort 卡在慢 disposer 上时 adoptInto 必须拒——否则接管到的是一份残缺账本", async () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  const first = onceOnly("first");
  const second = onceOnly("second");
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  assembly.adopt("first", () => 1, { dispose: first.dispose });
  assembly.adopt("second", () => 2, {
    dispose: async () => {
      second.dispose();
      await blocked; // LIFO：这条先收，卡在这里
    },
  });
  assembly.seal();

  const aborting = assembly.abort(); // **同步**进入 aborting
  expect(assembly.state).toBe("aborting");
  await Promise.resolve(); // 让 unwind 真的跑到第二个 slot 的 disposer
  expect(second.count()).toBe(1);
  expect(first.count()).toBe(0); // 还没轮到——上一版这时接管，first 会被当成完好 slot 交出去

  expect(() => assembly.adoptInto("echo:agent")).toThrow(/残缺账本/);

  release();
  await aborting;
  expect(assembly.state).toBe("aborted");
  expect(first.count()).toBe(1);
  expect(second.count()).toBe(1);
  // 收摊结束之后同样不能接管
  expect(() => assembly.adoptInto("echo:agent")).toThrow(/残缺账本/);
});

test("进程域收摊之后不能再登记、也不能接管（否则 Agent 底下是一个已经关掉的存储）", async () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  assembly.borrow("root-store", { v: 1 }, { dispose: () => undefined });
  await assembly.disposeProcessScope();
  expect(() => assembly.adopt("echo:memory", () => ({ v: 2 }))).toThrow(/进程域已经收摊过了/);
  assembly.seal();
  expect(() => assembly.adoptInto("echo:agent")).toThrow(/进程域已经收摊过了/);
});

/* ─────────────── factory 抛错 ─────────────── */

test("adopt factory 抛错：整份 assembly 置 failed，之前的 borrow / adopt 全部 LIFO unwind", async () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  const order: string[] = [];
  assembly.borrow("root-store", { v: 1 }, { dispose: () => void order.push("root") });
  assembly.adopt("echo:memory", () => ({ v: 2 }), { dispose: () => void order.push("memory") });
  expect(() =>
    assembly.adopt("echo:schedule", () => {
      throw new Error("闹钟装不出来");
    }),
  ).toThrow(/闹钟装不出来/);

  expect(assembly.state).toBe("failed");
  expect(() => assembly.adopt("echo:inbox", () => ({ v: 3 }))).toThrow(/处于 'failed'/);
  expect(() => assembly.seal()).toThrow(/处于 'failed'/);
  expect(() => assembly.adoptInto("echo:agent")).toThrow(/处于 'failed'/);

  await assembly.abort(); // 失败之后唯一的出路
  expect(order).toEqual(["memory", "root"]);
});

test("slotId 在跑 factory 之前就占住：factory 里重入登记同名 slot 判红（上一版会留下两个同名 slot）", () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  expect(() =>
    assembly.adopt("echo:memory", () => {
      assembly.adopt("echo:memory", () => ({ inner: true }));
      return { outer: true };
    }),
  ).toThrow(/重复登记/);
  expect(assembly.inspect().filter((s) => s.slotId === "echo:memory")).toHaveLength(0);
});

/* ─────────────── 零副作用 factory ─────────────── */

test("first-party 的五个 adopt factory 零外部副作用：陷阱端口一次都没被碰，也没起 timer / 连网络 / 注册监听器", () => {
  const trap = trapStorageDir("state-root");
  // 碰一下就抛，所以「没抛」本身就是判据；探针再管住进程级那几类。
  const { violations, covered } = runFactoryProbe(() => ({
    memory: createAgentMemories(trap),
    schedule: createAgentSchedule(trap),
    inbox: new InboxStore(trap),
    session: new SessionService(trap),
    // `createAgent` 里 Task 也是一个 adopt slot：字节视图，同样不许在这一步碰盘
    task: { read: () => trap.read("tasks.json"), write: (t: string) => trap.write("tasks.json", t) },
  }));
  expect(violations).toEqual([]);
  // **零违约只有在入口真被接管时才算数**：接管不上的入口不会进 `covered`，缺一条这里就红，
  // 不会退化成「探针没盖住，所以什么都没报」的假绿（`Bun.spawnSync` 不可配置只可写，正是踩过的那条）。
  for (const entry of [
    "setTimeout",
    "setInterval",
    "fetch",
    "globalThis.addEventListener",
    "Bun.spawn",
    "Bun.spawnSync",
    "process.on",
    "process.once",
    "process.addListener",
    "process.prependListener",
    "process.prependOnceListener",
  ]) {
    expect(covered, entry).toContain(entry);
  }
  // StateLock 同理：单写者资格只能由 start() 取
  expect(() => trapStateLock("state-root").acquire({ holder: "x" })).toThrow(FactoryPurityError);
});

test("探针的反例：读盘 / 取锁 / 起 timer / 连网络 / 子进程 / global listener / async factory 逐条被抓", () => {
  const trap = trapStorageDir("state-root");
  // 写成语句体（返回 void）不是风格问题：`assertPureFactory` 的类型层拒绝返回 Promise 的 factory，
  // 而这两个陷阱端口的签名是 async——它们其实同步抛，但类型上仍是 `Promise<…>`。
  expect(() =>
    assertPureFactory(() => {
      trap.read("x.json");
    }, "读盘"),
  ).toThrow(/durable restore 只能发生在 Agent.start/);
  expect(() =>
    assertPureFactory(() => {
      trapStateLock().acquire({ holder: "x" });
    }, "取锁"),
  ).toThrow(/StateLock 只能由 Agent.start\(\) 取/);
  expect(() => assertPureFactory(() => setInterval(() => undefined, 1_000), "起 timer")).toThrow(
    /timer 只能由 Agent.activate\(\) 起/,
  );
  expect(() => assertPureFactory(() => Bun.spawnSync(["true"]), "起子进程")).toThrow(/不许起子进程/);
  expect(() =>
    assertPureFactory(() => {
      (globalThis as unknown as { addEventListener: (t: string, l: () => void) => void }).addEventListener(
        "x",
        () => undefined,
      );
    }, "注册监听器"),
  ).toThrow(/addEventListener/);
  // async factory：**一次都不调**（类型层已经判红，这里转成 JS 调用方的形状测运行期那道）
  expect(() => assertPureFactory(asJsCaller(async () => ({ v: 1 })), "异步 factory")).toThrow(/探针拒绝调用它/);
});

/** JS 调用方的视角：类型层拦不住的东西也要在运行期拦住，所以测试要能把类型绕过去。 */
function asJsCaller<T>(fn: () => T): () => never {
  return fn as unknown as () => never;
}

test("async factory 的副作用不许逃逸：探针在调用之前就拒，原实现一次都跑不到", async () => {
  // 上一版是「调完再看返回值是不是 thenable」：判红了，但续体在 finally 还原之后接着跑，
  // 那时全局入口已经是真的——实测 `fetch` 被调了一次（实测 calls === 1）。
  const realFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as { fetch: unknown }).fetch = async (): Promise<Response> => {
    calls += 1;
    return new Response("");
  };
  try {
    expect(() =>
      assertPureFactory(
        asJsCaller(async () => {
          await Promise.resolve();
          await fetch("https://example.invalid/escaped");
        }),
        "async escape",
      ),
    ).toThrow(/探针拒绝调用它/);

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }

  // **类型层的那道**：async factory 连编译都过不去。用 `@ts-expect-error` 锚住——
  // 哪天约束失效，这行会变成「未使用的 expect-error」，`bun run typecheck` 当场判红。
  // 只构造不调用，运行期什么都不做。
  void ((): unknown =>
    // @ts-expect-error adopt slot factory 不许返回 Promise
    assertPureFactory(async () => ({ v: 1 }), "类型层判据"));
});

test("同步函数动态造 thenable：只报告、不声称拦住（覆盖边界）", () => {
  // 这一类探针拦不住——判据是「它被报出来了」，不是「副作用没发生」。
  const { violations } = runFactoryProbe(() => ({ then: (cb: () => void): void => void cb() }) as unknown as object);
  expect(violations.map((v) => v.kind)).toContain("async-factory");
  expect(violations.find((v) => v.kind === "async-factory")!.detail).toMatch(/检出不是阻止/);
});

test("被禁的入口只记账不执行：fetch 没被真调、process 监听器没被真注册、globals 事后完好还原", () => {
  // 上一版是「记一笔再调 original」，于是探针自己把违约副作用做了一遍：请求真发出去、监听器真留下。
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as { fetch: unknown }).fetch = async (): Promise<Response> => {
    fetchCalls += 1;
    return new Response("");
  };
  const before = process.listenerCount("SIGUSR2");
  try {
    expect(() =>
      assertPureFactory(() => {
        void (globalThis as { fetch: (u: string) => unknown }).fetch("http://example.invalid/never");
      }, "连网络"),
    ).toThrow(/不许连网络/);
    expect(fetchCalls).toBe(0); // 原实现一次都没跑

    expect(() => assertPureFactory(() => process.on("SIGUSR2", () => undefined), "注册进程监听器")).toThrow(
      /不许注册进程级监听器/,
    );
    expect(process.listenerCount("SIGUSR2")).toBe(before); // 注册被拦下，不是事后去数差值
  } finally {
    globalThis.fetch = realFetch;
  }
  // 探针退出后全局入口必须还原
  expect(globalThis.fetch).toBe(realFetch);
  expect(typeof globalThis.setTimeout).toBe("function");
  const marker = setTimeout(() => undefined, 0);
  clearTimeout(marker);
});

test("未 start 的 candidate 被 dispose 只释放纯内存引用：陷阱端口在整个 unwind 期间一次都没被碰", async () => {
  const trap = trapStorageDir("state-root");
  const assembly = new AgentAssembly({ provider: "echo:persistence-local" });
  assembly.adopt("echo:memory", () => createAgentMemories(trap));
  assembly.adopt("echo:schedule", () => createAgentSchedule(trap));
  assembly.adopt("echo:inbox", () => new InboxStore(trap));
  assembly.adopt("echo:session", () => new SessionService(trap));
  assembly.seal();
  // 陷阱端口的每个方法都抛，所以「abort 不抛」= 收摊期零 I/O。
  // 反过来说：为了「对称」给纯内存 candidate 硬加一个 `dir.close()` 式 disposer，这条就红。
  await assembly.abort();
  expect(assembly.inspect().every((s) => s.phase === "disposed")).toBe(true);
});

/* ─────────────── 与 Agent / createAgent 的接线 ─────────────── */

test("Agent.stop() 是排空账本的唯一触发点，且恰好一次", async () => {
  const assembly = new AgentAssembly({ provider: "echo:test" });
  const owned = onceOnly("agent-scope");
  assembly.adopt("echo:memory", () => ({ v: 1 }), { dispose: owned.dispose });
  assembly.seal();
  const ledger = assembly.adoptInto("echo:agent");

  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn([textTurn("ok")]),
    stateLock: new InMemoryStateLock(),
  });
  attachStateHost(agent, { gate: ledger.writeGate, adoption: ledger });

  await agent.start();
  expect(owned.count()).toBe(0); // 活着的时候不许收
  await agent.stop();
  expect(owned.count()).toBe(1);
  await agent.stop(); // 幂等的 stop 不能收第二次
  expect(owned.count()).toBe(1);
});

function fakeProvider(): Provider {
  return createProvider({
    id: "t",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    models: [{ id: "only", api: "scripted" }],
    api: createProviderStreams(scriptedDialect([textTurn("ok")])),
  });
}

/** 只肯关一次的 root store：第二次 close 抛。**契约没要求 close 幂等，这是合法实现**。 */
function onceClosableStore(): { store: StorageDir; closes: () => number } {
  const inner = new InMemoryDir();
  let closed = 0;
  return {
    store: {
      read: (p) => inner.read(p),
      write: (p, c) => inner.write(p, c),
      remove: (p) => inner.remove(p),
      list: (p) => inner.list(p),
      close: async () => {
        closed += 1;
        if (closed > 1) throw new Error(`root store 被关了第 ${closed} 次`);
      },
    },
    closes: () => closed,
  };
}

test("createAgent：正常 start → stop，root store 恰好关一次", async () => {
  const root = onceClosableStore();
  const agent = await createAgent({
    provider: fakeProvider(),
    store: root.store,
    lock: new InMemoryStateLock(),
    allowNetwork: false,
  });
  await agent.start();
  expect(root.closes()).toBe(0);
  await agent.stop();
  expect(root.closes()).toBe(1);
  await agent.stop();
  expect(root.closes()).toBe(1);
});

test("createAgent：`new Agent()` 构造失败时 root store 也要被关掉（上一版：一次都没关）", async () => {
  const root = onceClosableStore();
  await expect(
    createAgent({
      provider: fakeProvider(),
      store: root.store,
      lock: new InMemoryStateLock(),
      allowNetwork: false,
      // 构造期判红的合法参数：askTimeoutMs 必须是正整数毫秒或 null
      agent: { permission: { askTimeoutMs: 0, authorize: () => ({ kind: "allow" }) } },
    }),
    // 原始失败原因必须原样传出去，不能被收摊过程盖掉
  ).rejects.toThrow(/askTimeoutMs 必须是正整数毫秒或 null/);
  expect(root.closes()).toBe(1);
});

test("createAgent：PREPARE 段（borrow 之后、构造之前）抛错，root store 同样要被关掉", async () => {
  const root = onceClosableStore();
  // PREPARE 段自己没有自然失败点（视图与 factory 都是纯的），所以把失败注进去：
  // 一个**不可枚举**的抛错 getter——`createAgent` 开头 `{ ...opts }` 展开时不会读到它（只读可枚举属性），
  // 等到 `prepareCapabilities` 真去取 `withoutMemory` 才炸，落点正好在 borrow 之后、`new Agent()` 之前。
  // 上一版的 try 从构造才起，这一段整个不在事务里：close 次数是 0。
  const opts = {
    provider: fakeProvider(),
    store: root.store,
    lock: new InMemoryStateLock(),
    allowNetwork: false,
  };
  Object.defineProperty(opts, "withoutMemory", {
    enumerable: false,
    get: (): boolean => {
      throw new Error("装配参数读不出来");
    },
  });

  await expect(createAgent(opts)).rejects.toThrow(/装配参数读不出来/);
  expect(root.closes()).toBe(1);
});
