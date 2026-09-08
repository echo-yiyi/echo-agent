import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { bindMemoryScopes, createAgentMemories, memoryCreate, shouldDream, type AgentMemories, type MemoryHarnessOptions } from "../src/memory/harness.ts";
import { memoryScopeTable, type MemoryScopeDef } from "../src/memory/scope.ts";
import { agentMemory, notesMemory, userMemory, type MemoryDir } from "../src/memory/types.ts";
import { readDreamState } from "../src/memory/dream.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { errorTurn, FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { toolOk } from "../src/tools/types.ts";

// Dream 自调度（C6 / D7）：**触发、互斥、预算、中断、提交都在 core**。
//
// C6 的原话是「memory 设计把 Dream 调度交给装配方」——那意味着每个接入方都要自己写
// timer 与 subagent glue，而「什么时候该整理」是记忆语义的一部分，不是装配细节。
// 这批把它收进 Agent：回到 idle 时自查门控，满足就跑，跑完提交。
//
// D7 拍定：**Dream 只整理记忆，不许自建 Task / Schedule**——所以它只拿到 memory 工具。

/** 造一个门槛全部满足的记忆面：写过若干次、有足够文件、从没整理过。 */
async function readyMemory(): Promise<AgentMemories> {
  // 用内建三层（agent/user 常驻 + memory 索引模块），只把门调到测试量级——
  // 判据本身不变，只是不必真写 10 个文件、等 24 小时
  const mem = memories(new InMemoryDir(), { dream: { minWritesSinceLast: 2, minFiles: 2 } });
  await memoryCreate(mem, "session/memory/a.md", "---\ndescription: 第一条\n---\n\n甲");
  await memoryCreate(mem, "session/memory/b.md", "---\ndescription: 第二条\n---\n\n乙");
  return mem;
}


/* 作用域由产品声明、session 加载完才绑定：测试里只要一层，名字沿用 "session"。 */
const ONE_LAYER: readonly MemoryScopeDef[] = [
  { name: "session", order: 1, describe: "only this session", anchor: { kind: "home" }, prefix: "" },
];

function memories(dir: MemoryDir, opts?: MemoryHarnessOptions): AgentMemories {
  // 内建三个现在由 `echo:memory` 经 registry 注册；不经 mount 的纯 harness 测试要显式带上
  const h = createAgentMemories({ memories: [agentMemory, userMemory, notesMemory], ...opts });
  // 那一层落在 `session/` 前缀下——盘上的路径与从前完全一致（`session/.dream/state.json` 等）
  const scoped: MemoryDir = {
    read: (path) => dir.read("session/" + path),
    write: (path, content) => dir.write("session/" + path, content),
    remove: (path) => dir.remove("session/" + path),
    list: async (p) => (await dir.list("session/" + p)).map((k) => k.slice("session/".length)),
  };
  bindMemoryScopes(h, memoryScopeTable(ONE_LAYER.map((def) => ({ def, dir: scoped }))));
  return h;
}

function agentWith(memory: AgentMemories, turns: ReturnType<typeof textTurn>[]): Agent {
  return new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn(turns),
    memory,
    autoDream: true,
  });
}

/** dream 是回到 idle 后异步起的——给它跑完的机会。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

test("门满足 → 回到 idle 自动整理并提交（装配方不写 timer 也不派 subagent）", async () => {
  const mem = await readyMemory();
  expect(await shouldDream(mem, "session")).toBe(true);

  // 两轮脚本：第一轮给前台的 prompt，第二轮给 dream 自己
  const agent = agentWith(mem, [textTurn("前台答完"), textTurn("整理完了")]);
  await agent.prompt("干点活");
  await settle();

  const state = await readDreamState(mem.dir, "session");
  expect(state.lastAt).not.toBeNull(); // 提交了
  expect(state.startedAt).toBeNull(); // 锁放了
  expect(await shouldDream(mem, "session")).toBe(false); // 计数清零，短期内不会再跑
});

test("门不满足 → 不跑（写入数没到）", async () => {
  const mem = memories(new InMemoryDir(), { dream: { minWritesSinceLast: 99, minFiles: 1 } });
  await memoryCreate(mem, "session/memory/a.md", "---\ndescription: 只有一条\n---\n\n甲");
  expect(await shouldDream(mem, "session")).toBe(false);

  const agent = agentWith(mem, [textTurn("前台答完")]);
  await agent.prompt("干点活");
  await settle();

  expect((await readDreamState(mem.dir, "session")).lastAt).toBeNull(); // 没跑过
});

test("autoDream 关着 → 不跑（缺省就是关的，`start()` 才打开）", async () => {
  const mem = await readyMemory();
  // 默认构造：不传 autoDream
  const plain = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("答完")]), memory: mem });
  expect(plain.autoDream).toBe(false);
  await plain.prompt("干点活");
  await settle();
  expect((await readDreamState(mem.dir, "session")).lastAt).toBeNull();
});

test("D7：整理那一轮**摆给模型的工具面**只有 memory 工具", async () => {
  // 判据是**模型实际收到的 `context.tools`**，不是「工具抛没抛错」。
  // 旧版让 dream 去点一个会抛的工具，再断言「整理照样提交」——那个断言没有区分力：
  // 循环会把工具抛错转成 error result 接着跑，**把整个主工具面给 dream 它也照样绿**（实测）。
  const mem = await readyMemory();
  const offered: string[][] = [];
  const scripted = scriptedStreamFn([textTurn("前台答完"), textTurn("整理完")]);

  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: (model, context, options) => {
      offered.push(context.tools.map((t) => t.name).sort());
      return scripted(model, context, options);
    },
    memory: mem,
    autoDream: true,
    tools: [
      {
        kind: "model",
        name: "schedule_create",
        label: "建定时任务",
        description: "本该拿不到",
        parameters: { type: "object", properties: {} },
        execute: async () => toolOk("不该被调用"),
      },
    ],
  });
  await mountBuiltinTools(agent); // memory 工具经 `echo:memory` builtin Extension 注册

  await agent.prompt("干点活");
  await settle();

  expect(offered).toHaveLength(2); // 前台一轮 + dream 一轮
  // 前台**看得见** schedule_create（否则下面那条断言证明不了任何事）
  expect(offered[0]).toContain("schedule_create");
  expect(offered[0]).toContain("memory");
  // dream 那一轮：**只有** memory
  expect(offered[1]).toEqual(["memory"]);
});

test("整理不再抢前台：dream 挂着的时候前台照样跑完（它在独立通道上，不进 admission）", async () => {
  // **这条判据 2026-09-08 翻了向**：从前 dream 走 admission 的 maintenance 许可，前台一来就
  // 抢占、而且前台要等它真的停。现在两件记忆后台活各走一条独立通道——它们与前台没有共享
  // 可变状态（独立 context、事件不外发、只碰记忆文件），唯一的交叉是记忆文件本身，那归文件锁。
  // 挡在 admission 上的代价是致命的：用户连着说十句话，提取十次全被抢占、实际 0 次。
  const mem = await readyMemory();

  let releaseDream = (): void => {};
  const dreamHanging = new Promise<void>((r) => {
    releaseDream = r;
  });
  let dreamStarted = (): void => {};
  const dreamReached = new Promise<void>((r) => {
    dreamStarted = r;
  });

  const scripted = scriptedStreamFn([textTurn("第一次答完"), textTurn("整理"), textTurn("第二次答完")]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: async (model, context, options) => {
      // 按内容认出整理那一轮（并发之后调用序号不再稳定）
      const isDream = JSON.stringify(context.messages).includes("Consolidate");
      if (isDream) {
        dreamStarted();
        await dreamHanging;
      }
      return scripted(model, context, options);
    },
    memory: mem,
    autoDream: true,
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册

  await agent.prompt("第一次");
  await dreamReached; // dream 确实起来了、并且卡在模型调用上

  // 整理进行中：锁已经上了
  expect((await readDreamState(mem.dir, "session")).startedAt).not.toBeNull();

  // **前台不等它**：dream 还挂着，第二次 prompt 照样跑完
  await agent.prompt("第二次立刻来");
  expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(2);

  releaseDream();
  await settle();
});


test("整理不进主 transcript（它是 agent 对自己记忆的操作，不是这次任务的一部分）", async () => {
  const mem = await readyMemory();
  const agent = agentWith(mem, [textTurn("前台答完"), textTurn("整理完了")]);
  await agent.prompt("干点活");
  const before = agent.messages.length;
  await settle();

  expect(agent.messages.length).toBe(before); // 一条都没多
  expect(agent.messages.some((m) => m.role === "user" && `${JSON.stringify(m)}`.includes("整理"))).toBe(false);
});

test("进程重启：dream 状态在盘上，新实例接着算（不是每次起来都重新攒）", async () => {
  const dir = new InMemoryDir();
  const first = memories(dir, { dream: { minWritesSinceLast: 2, minFiles: 2 } });
  await memoryCreate(first, "session/memory/a.md", "---\ndescription: 甲\n---\n\n一");
  await memoryCreate(first, "session/memory/b.md", "---\ndescription: 乙\n---\n\n二");
  const a = agentWith(first, [textTurn("答完"), textTurn("整理完")]);
  await a.prompt("干活");
  await settle();
  expect((await readDreamState(dir, "session")).lastAt).not.toBeNull();

  // 换个进程：同一个盘，新的 memories 实例（内存计数从零开始）
  const second = memories(dir, { dream: { minWritesSinceLast: 2, minFiles: 2 } });
  // 刚整理过 → 距上次时间太近，门不该放行。**这条正是「状态在盘上」的判据**：
  // 如果 dream 状态只活在内存里，新实例会以为从没整理过、立刻又跑一次。
  expect(await shouldDream(second, "session")).toBe(false);
});

test("锁陈尸：上次整理没提交（进程崩了），锁过期后能重新触发", async () => {
  const dir = new InMemoryDir();
  const mem = memories(dir, { dream: { minWritesSinceLast: 1, minFiles: 1 } });
  await memoryCreate(mem, "session/memory/a.md", "---\ndescription: 甲\n---\n\n一");

  // 伪造一把两小时前的锁——DREAM_LOCK_STALE_MS 是 1 小时。
  // **写计数也要带上**：计数现在住在同一个文件里（盘上是真相源），手写整份会把它抹掉。
  await dir.write(
    "session/.dream/state.json",
    JSON.stringify({ lastAt: null, startedAt: Date.now() - 2 * 3600_000, writes: 1, turns: 0 }),
  );
  expect(await shouldDream(mem, "session")).toBe(true); // 陈尸锁不该永久堵住

  // 新鲜的锁则挡住
  await dir.write("session/.dream/state.json", JSON.stringify({ lastAt: null, startedAt: Date.now(), writes: 1, turns: 0 }));
  expect(await shouldDream(mem, "session")).toBe(false);
});

/* ══════════ 2026-08-19 review：Dream 与生命周期 / 单写者 ══════════ */

/** 造一个「卡在模型调用上」的 dream：返回放行钩子与「已经卡住了」的信号。 */
async function hangingDreamAgent(
  mem: AgentMemories,
  extra: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Promise<{ agent: Agent; reached: Promise<void>; release: () => void }> {
  let release = (): void => {};
  const hanging = new Promise<void>((r) => {
    release = r;
  });
  let started = (): void => {};
  const reached = new Promise<void>((r) => {
    started = r;
  });
  let call = 0;
  const scripted = scriptedStreamFn([textTurn("前台答完"), toolTurn("d1", "memory", { command: "view", path: "session/memory/" }), textTurn("整理完")]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: async (model, context, options) => {
      call += 1;
      if (call === 2) {
        started();
        await hanging;
      }
      return scripted(model, context, options);
    },
    memory: mem,
    autoDream: true,
    ...extra,
  } as ConstructorParameters<typeof Agent>[0]);
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
  return { agent, reached, release };
}

test("**P0**：stop() 返回之后，旧 Agent 的整理不能再写 memory", async () => {
  // 实测破坏：stop() 返回并释放 lease、新 holder 已拿到锁，而旧 Agent 的 dream 仍在写——
  // 单写者当场破。两处修：stop() 要**等** dream 收完；dream 提交前重问一次生命周期。
  const mem = await readyMemory();
  const { agent, reached, release } = await hangingDreamAgent(mem);

  await agent.prompt("干点活");
  await reached; // dream 起来了，卡在模型调用上

  const stopping = agent.stop();
  let stopDone = false;
  void stopping.then(() => (stopDone = true));

  // stop() 不许在 dream 还挂着的时候就返回
  await new Promise((r) => setTimeout(r, 20));
  expect(stopDone, "stop() 没等 dream 收完就返回了").toBe(false);

  release();
  await stopping;

  // 收摊完成时：整理没有提交（被中断），也没有留下「正在整理」之外的新写入
  expect((await readDreamState(mem.dir, "session")).lastAt).toBeNull();
});

test("并发写记忆不丢计数——「单写者」防的是跨进程，防不了进程内并发", async () => {
  // 实测破坏（barrier 确定性复现）：两次 memoryCreate() 都成功，但双双读到 writes = 0、
  // 双双写回 1，最终盘上是 1 而不是 2。计数少了，minWritesSinceLast 就迟迟不满足。
  const inner = new InMemoryDir();

  // barrier：两次写都读到状态之后才放行，把「同时读到旧值」变成确定事件
  let arrived = 0;
  let open = (): void => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });

  const mem = memories({
    read: async (p: string) => {
      const v = await inner.read(p);
      if (p === "session/.dream/state.json") {
        arrived += 1;
        if (arrived === 2) open();
        else await Promise.race([gate, new Promise((r) => setTimeout(r, 200))]);
      }
      return v;
    },
    write: (p: string, c: string) => inner.write(p, c),
    remove: (p: string) => inner.remove(p),
    list: (p: string) => inner.list(p),
  });

  await Promise.all([
    memoryCreate(mem, "session/memory/a.md", "---\ndescription: 甲\n---\n\n一"),
    memoryCreate(mem, "session/memory/b.md", "---\ndescription: 乙\n---\n\n二"),
  ]);

  // 两次写都得算上
  expect((await readDreamState(inner, "session")).writes).toBe(2);
  expect(mem.writesSinceDream).toBe(2);
});

test("还卡在门控里的整理也要被 stop() 收掉——不许在 stop() 返回之后写盘", async () => {
  // `maybeDream()` 必须**在 `shouldDream()` 之前**就把 dreamRun 占上，否则 `stop()` 的
  // `settleDream()` 看不见这次整理、直接返回；随后 `dreamTask()` 才去写 `.dream/state.json`
  // ——那已经是 stop() 之后的写盘了。
  const inner = new InMemoryDir();
  let stopped = false;
  const writesAfterStop: string[] = [];
  const mem = memories(
    {
      read: async (p: string) => {
        await new Promise((r) => setTimeout(r, 30)); // 把门控阶段撑开
        return inner.read(p);
      },
      write: async (p: string, c: string) => {
        if (stopped) writesAfterStop.push(p);
        await inner.write(p, c);
      },
      remove: (p: string) => inner.remove(p),
      list: (p: string) => inner.list(p),
    },
    { dream: { minWritesSinceLast: 1, minFiles: 1 } },
  );
  await memoryCreate(mem, "session/memory/a.md", "---\ndescription: 甲\n---\n\n一");

  const agent = agentWith(mem, [textTurn("答完"), textTurn("整理完")]);
  await agent.prompt("干点活"); // 触发 maybeDream，它正卡在 shouldDream 的 read 上
  await agent.stop();
  stopped = true;
  await settle();

  expect(writesAfterStop).toEqual([]);
});

test("两次触发撞在 shouldDream 的 await 窗口里 → 只跑一次整理", async () => {
  // `maybeDream()` 的闸判断在 `shouldDream()` **之前**，而后者是异步的。
  // 不在判断之后**同步占位**的话，两次触发（前台 run 结束各来一次）会双双穿过闸，
  // 于是两个 dream 并发跑、`dreamTask()` 也被上了两次锁。
  const slow = new InMemoryDir();
  const mem = memories(
    {
      read: async (p: string) => {
        await new Promise((r) => setTimeout(r, 30)); // 把 await 窗口撑开
        return slow.read(p);
      },
      write: (p: string, c: string) => slow.write(p, c),
      remove: (p: string) => slow.remove(p),
      list: (p: string) => slow.list(p),
    },
    { dream: { minWritesSinceLast: 1, minFiles: 1 } },
  );
  await memoryCreate(mem, "session/memory/a.md", "---\ndescription: 甲\n---\n\n一");

  let dreamCalls = 0;
  const scripted = scriptedStreamFn([
    textTurn("一"),
    textTurn("二"),
    textTurn("整理"),
    textTurn("整理"),
  ]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: (model, context, options) => {
      // dream 那一轮的工具面只有 memory——用它来数「跑了几次整理」。
      // 之所以要给 agent 多注册一个工具：不然前台的工具面也恰好只有 memory，
      // 这个计数器会把前台一起数进去（第一版就是这么错的）。
      if (context.tools.length === 1 && context.tools[0]?.name === "memory") dreamCalls += 1;
      return scripted(model, context, options);
    },
    memory: mem,
    autoDream: true,
    tools: [
      {
        kind: "model",
        name: "前台专用",
        label: "前台专用",
        description: "只为把前台的工具面和 dream 的区分开",
        parameters: { type: "object", properties: {} },
        execute: async () => toolOk("ok"),
      },
    ],
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册

  await agent.prompt("第一次"); // 触发 maybeDream #1（卡在 shouldDream 的 read 上）
  await agent.prompt("第二次"); // 触发 maybeDream #2
  await settle();

  expect(dreamCalls).toBeLessThanOrEqual(1);
});

test("整理以 error outcome 收场 → **不记成成功**，锁留给下次", async () => {
  // 实测破坏：`runAgentLoop` 对这类失败**不抛**（它把结果放进 outcome），
  // 而旧代码无条件 markDreamed()——lastAt 被刷新、计数被清零，下一次要等满 minIntervalMs。
  //
  // 注意用 `errorTurn` 而不是「让 streamFunction 抛」：后者会直接穿出循环，
  // 走的是 catch 分支，**测不到 outcome 这条路**（第一版反证正是这么漏的）。
  const mem = await readyMemory();
  const agent = agentWith(mem, [textTurn("前台答完"), errorTurn("provider", "provider 挂了", false)]);

  await agent.prompt("干点活");
  await settle();

  const state = await readDreamState(mem.dir, "session");
  expect(state.lastAt).toBeNull(); // 没被记成成功
  expect(state.writes).toBeGreaterThan(0); // 计数也没被清掉
});

test("门控读盘失败 → 报诊断，不变成 unhandled rejection", async () => {
  // `finishRun()` 是同步的，调用点是 `void this.maybeDream()`——
  // `shouldDream()` / `dreamTask()` 抛出去就是未处理拒绝（Bun 测试直接红）。
  const dir = new InMemoryDir();
  const mem = memories(dir, { dream: { minWritesSinceLast: 0, minFiles: 0 } });
  mem.dir = {
    read: async () => {
      throw new Error("盘挂了");
    },
    write: (path, content) => dir.write(path, content),
    remove: (path) => dir.remove(path),
    list: (prefix) => dir.list(prefix),
  };

  // 诊断落成一条 notification 生命周期事件（`reportDiagnostic` → `hooks.notify`）
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("答完")]),
    memory: mem,
    autoDream: true,
    hooks,
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册

  await agent.prompt("干点活");
  await settle();

  expect(notices.some((m) => m.includes("dream_failed"))).toBe(true);
});

test("轮次门真的接上了：turn_end 会被计数（此前 observer 压根没订阅）", async () => {
  const dir = new InMemoryDir();
  const mem = memories(dir, { dream: { minTurnsSinceLast: 1 } });
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("答完")]),
    memory: mem,
    autoDream: false, // 只看计数，不让它真去整理
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册

  expect((await readDreamState(dir, "session")).turns).toBe(0);
  await agent.prompt("一轮");
  expect((await readDreamState(dir, "session")).turns).toBeGreaterThan(0);
});

test("计数落盘：换进程接着算，不从头攒", async () => {
  // 旧实现里 writes/turns 只在内存，重启归零——「攒够 N 次再整理」这道门
  // 对长期跑的 agent 反而更难满足，恰好和门的意图相反。
  const dir = new InMemoryDir();
  const first = memories(dir, { dream: { minWritesSinceLast: 2, minFiles: 1 } });
  await memoryCreate(first, "session/memory/a.md", "---\ndescription: 甲\n---\n\n一");
  expect(await shouldDream(first, "session")).toBe(false); // 才写了 1 次

  // 换进程：同一个盘、全新实例
  const second = memories(dir, { dream: { minWritesSinceLast: 2, minFiles: 1 } });
  await memoryCreate(second, "session/memory/b.md", "---\ndescription: 乙\n---\n\n二");
  expect(await shouldDream(second, "session")).toBe(true); // 1 + 1，计数接着算
  expect(second.writesSinceDream).toBe(2);
});
