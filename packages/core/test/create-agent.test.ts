import { test, expect, afterEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, resolveModel, resolveSessionsRoot, resolveSharedDir, resolveStateDir } from "../src/create-agent.ts";
import { SessionService, listSessions } from "../src/session/service.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { kimiProvider, deepseekProvider } from "../src/provider/openai.ts";
import { createTasks } from "../src/task/harness.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { scriptedDialect, scriptedStreamFn, textTurn } from "../src/testing.ts";
import { environmentMessage } from "../src/messages.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import type { Model, Provider } from "../src/provider/types.ts";

// createAgent 的契约：D17（模型选择）· D6（状态根）· D5（默认身份）。
//
// **D17 的存在理由**：`Provider.getModels()` 返回一组模型，「用哪个」必须有明确答案。
// 静默选错模型意味着成本与能力全变而无人察觉——所以四级解析每一级都 fail-loud，不猜。

function fakeProvider(opts: { id: string; models: string[]; defaultModelId?: string }): Provider {
  return createProvider({
    id: opts.id,
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: opts.defaultModelId,
    models: opts.models.map((id) => ({ id, api: "scripted" })),
    api: createProviderStreams(scriptedDialect([textTurn("ok")])),
  });
}

const modelsOf = (p: Provider): readonly Model[] => p.getModels();

/* ───────────── D17：四级解析 ───────────── */

test("D17-1 显式 model 命中", () => {
  const p = fakeProvider({ id: "t", models: ["a", "b"] });
  expect(resolveModel(p, modelsOf(p), "b").id).toBe("b");
});

test("D17-1 显式 model 不存在 → fail-loud 并列出候选", () => {
  const p = fakeProvider({ id: "t", models: ["a", "b"] });
  expect(() => resolveModel(p, modelsOf(p), "zzz")).toThrow(/没有模型 'zzz'；可选：a、b/);
});

test("D17-2 未指定时用 provider 声明的 defaultModelId", () => {
  const p = fakeProvider({ id: "t", models: ["a", "b"], defaultModelId: "b" });
  expect(resolveModel(p, modelsOf(p)).id).toBe("b");
});

test("D17-2 声明的 default 不在目录里 → fail-loud（provider 自己的 bug，不吞）", () => {
  const p = fakeProvider({ id: "t", models: ["a"], defaultModelId: "nope" });
  expect(() => resolveModel(p, modelsOf(p))).toThrow(/defaultModelId='nope' 不在可用目录里/);
});

test("D17-3 目录里恰好一个 → 自动选（一行启动的另一条路）", () => {
  const p = fakeProvider({ id: "t", models: ["only"] });
  expect(resolveModel(p, modelsOf(p)).id).toBe("only");
});

test("D17-4 多个且未指定 → fail-loud 并列出候选，不默认拿第 0 个", () => {
  const p = fakeProvider({ id: "t", models: ["a", "b", "c"] });
  expect(() => resolveModel(p, modelsOf(p))).toThrow(/有多个模型且未指定用哪个：a、b、c/);
});

test("零模型 → fail-loud", () => {
  const p = fakeProvider({ id: "t", models: [] });
  expect(() => resolveModel(p, modelsOf(p))).toThrow(/没有可用模型/);
});

test("官方两个 provider 都声明了 defaultModelId —— 否则一行启动对它们不成立", () => {
  // 实测过：kimi 有 kimi-k3 / kimi-k2.7-code / …，deepseek 有 v4-flash / v4-pro / v4-flash-vision-exp，
  // 都不止一个。不声明缺省的话 `createAgent({ provider })` 会走到 D17-4 判红。
  const kimi = kimiProvider();
  const ds = deepseekProvider();
  expect(kimi.getModels().length).toBeGreaterThan(1);
  expect(ds.getModels().length).toBeGreaterThan(1);
  expect(resolveModel(kimi, kimi.getModels()).id).toBe("kimi-k3");
  expect(resolveModel(ds, ds.getModels()).id).toBe("deepseek-v4-flash");
});

/* ───────────── D6：状态根 ───────────── */

const savedHome = process.env.ECHO_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.ECHO_HOME;
  else process.env.ECHO_HOME = savedHome;
});

test("D6 stateDir 最高优先", () => {
  process.env.ECHO_HOME = "/tmp/echo-home";
  expect(resolveStateDir({ stateDir: "/explicit", sessionId: "s1" })).toBe("/explicit");
});

test("D6 ECHO_HOME 次之", () => {
  process.env.ECHO_HOME = "/tmp/echo-home";
  expect(resolveStateDir({ sessionId: "s1" })).toBe("/tmp/echo-home/sessions/s1");
});

test("D6 最后落用户级 ~/.echo —— 不是项目内 $PWD（workspace 归 session，状态根跨项目）", () => {
  delete process.env.ECHO_HOME;
  const got = resolveStateDir({ sessionId: "s1" });
  expect(got).toBe(join(homedir(), ".echo", "sessions", "s1"));
  // 显式锁住「不按启动目录走」：目录差异由 session 的 workspace 承担，不由状态根承担
  expect(got.startsWith(process.cwd())).toBe(false);
});

test("D6 状态根 = session 目录：两段不共用；agentId 不再进路径（2026-09-03）", () => {
  // 没有这条时：两段 echo-coding 会共用一把 `.lock`，第二个 `start()` 直接 fail-loud——
  // 「同一台机器上一个做前端一个做后端」在旧布局下起不来。
  delete process.env.ECHO_HOME;
  expect(resolveStateDir({ sessionId: "a" })).not.toBe(resolveStateDir({ sessionId: "b" }));
  // agentId 只剩 lease 的 holder 标识：一段 session 是谁，记在它自己的 meta.json 里
  expect(resolveStateDir({ sessionId: "s1" })).toBe(join(homedir(), ".echo", "sessions", "s1"));
});

test("三层作用域：user 层（记忆 / 技能）与 session 目录是两个根，且清单扫的是上一层", () => {
  process.env.ECHO_HOME = "/tmp/echo-home";
  expect(resolveSharedDir()).toBe("/tmp/echo-home");
  expect(resolveSessionsRoot()).toBe("/tmp/echo-home/sessions");
  // 没有这条时：记忆跟着状态根下沉到 session 目录，每开一段就换一套记忆
  expect(resolveStateDir({ sessionId: "s1" }).startsWith(resolveSharedDir())).toBe(true);
  expect(resolveSharedDir().startsWith(resolveStateDir({ sessionId: "s1" }))).toBe(false);
});

/* ───────────── 装配 + 生命周期 ───────────── */

test("createAgent 装出的就是同一个 Agent 类（D16），且 model 已解析", async () => {
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: new InMemoryDir(),
    lock: new InMemoryStateLock(),
    allowNetwork: false,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  expect(agent.state.model.id).toBe("only"); // 非空 Model，构造时就位
  expect(agent.state.sessionId).toMatch(/^s-/); // 会话 id 在装配期就定——状态根就是它的目录
});

test("缺省每次启动新建会话，各占一个目录；显式 sessionId 才续；一句话没说的段不进清单", async () => {
  // 2026-09-01：**续上次是显式动作**。2026-09-03：每段一个状态根——所以「再起一次」不再是
  // 「同一个目录里多一段」，而是**多一个目录、多一把锁**，这正是两段能同时活着的原因。
  const home = await mkdtemp(join(tmpdir(), "echo-scope-"));
  process.env.ECHO_HOME = home;
  const provider = fakeProvider({ id: "t", models: ["only"] });
  const sessionsRoot = new FileDir(resolveSessionsRoot());

  const a = await createAgent({ provider, allowNetwork: false, workspace: "/repo/a", agentName: "echo-coding" });
  await a.start();
  expect(a.state.sessionId).toMatch(/^s-/);
  expect(a.state.workspace).toBe("/repo/a");

  const a2 = await createAgent({ provider, allowNetwork: false, workspace: "/repo/a", agentName: "echo-coding" });
  await a2.start(); // **同一台机器、同一个 workspace、同一个产品，两段同时活着**
  expect(a2.state.sessionId).not.toBe(a.state.sessionId); // 同 workspace、同产品 → 仍是新的一段
  // 各占各的目录、各持各的锁。旧布局（状态根 = agents/<agentId>）下这里是同一把，第二个 start() 直接 fail-loud
  expect(existsSync(join(home, "sessions", a.state.sessionId!, ".lock"))).toBe(true);
  expect(existsSync(join(home, "sessions", a2.state.sessionId!, ".lock"))).toBe(true);

  await a.prompt("你好"); // 说一句才落盘：空会话不留目录
  await a.stop();
  await a2.stop(); // a2 一句话没说

  const explicit = await createAgent({ provider, allowNetwork: false, workspace: "/elsewhere", sessionId: a.state.sessionId! });
  await explicit.start();
  expect(explicit.state.sessionId).toBe(a.state.sessionId); // 给了 id 才 create-or-resume 那一段
  expect(explicit.state.workspace).toBe("/repo/a"); // resume 以盘上为准
  await explicit.stop();

  // 清单扫的是 session 目录的上一层。**a2 一句话没说，收摊时把 meta 撤了**，所以不在清单里；
  // 但它**活着的时候是在的**——下面那条判据盯的就是这一点（活着找不到 = 别人没法给它带话）。
  const listed = await listSessions(sessionsRoot);
  expect(listed.map((s) => [s.id, s.workspace, s.agent, s.main, s.status])).toEqual([
    [a.state.sessionId!, "/repo/a", "echo-coding", true, "active"],
  ]);
  // 没给 agentName 的低层用户：与 agentId 同名
  expect((await new SessionService(new InMemoryDir()).createOrResume("x", { workspace: "/w" })).info.agent).toBe("default");
});

test("记忆与技能在 user 层，不跟着状态根下沉到 session 目录", async () => {
  // 没有这条时：状态根成了 session 目录之后记忆也跟着一段一份——每开一段就失忆一次。
  const home = await mkdtemp(join(tmpdir(), "echo-scope-"));
  process.env.ECHO_HOME = home;
  const provider = fakeProvider({ id: "t", models: ["only"] });
  const agent = await createAgent({ provider, allowNetwork: false });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start();
  const memoryTool = agent.tools.get("memory");
  expect(memoryTool).toBeDefined();
  await memoryTool!.execute(
    { command: "create", path: "memory/fact.md", file_text: "bun test 跑测试" },
    { toolCallId: "c1", workspace: "/w", sessionId: agent.state.sessionId, iteration: 0 },
  );
  await agent.stop();
  expect(existsSync(join(home, "memory", "memory", "fact.md"))).toBe(true);
  expect(existsSync(join(home, "sessions", agent.state.sessionId!, "memory"))).toBe(false);
});

test("resume 时 workspace 以盘上为准：换个目录打开同一个 session，workspace 不跟着进程走", async () => {
  const store = new InMemoryDir();
  const provider = fakeProvider({ id: "t", models: ["only"] });
  const first = await createAgent({ provider, store, lock: new InMemoryStateLock(), allowNetwork: false, workspace: "/repo/a", sessionId: "s" });
  await first.start();
  await first.prompt("说一句"); // 一句话没说的段不落 meta（空会话不留痕），也就没有「盘上的 workspace」
  await first.stop();
  const second = await createAgent({ provider, store, lock: new InMemoryStateLock(), allowNetwork: false, workspace: "/elsewhere", sessionId: "s" });
  await second.start();
  expect(second.state.workspace).toBe("/repo/a");
  await second.stop();
});

test("start() create-or-resume：stop() 之后换个实例、**显式给同一个 sessionId** 能读回来", async () => {
  const store = new InMemoryDir();
  const provider = fakeProvider({ id: "t", models: ["only"] });

  const first = await createAgent({ provider, store, lock: new InMemoryStateLock(), allowNetwork: false });
  await first.start();
  const sessionId = first.state.sessionId!;
  await first.prompt("你好");
  await first.stop();

  // 缺省不续（2026-09-01）：给了 id 才是「续这一段」
  const second = await createAgent({ provider, store, lock: new InMemoryStateLock(), allowNetwork: false, sessionId });
  await second.start();
  expect(second.messages.length).toBeGreaterThan(0); // 上一轮的对话回来了
  await second.stop();
});

test("start() 拿不到 lease → fail-loud（不是等、也不是降级）", async () => {
  const lock = new InMemoryStateLock();
  const provider = fakeProvider({ id: "t", models: ["only"] });
  const a = await createAgent({ provider, store: new InMemoryDir(), lock, allowNetwork: false });
  await a.start();

  const b = await createAgent({ provider, store: new InMemoryDir(), lock, allowNetwork: false });
  await expect(b.start()).rejects.toThrow(/已被另一个写者持有/);
  await a.stop();
});

test("start() 中途失败必须释放已取得的 lease（否则状态根被死进程占住）", async () => {
  const lock = new InMemoryStateLock();
  const provider = fakeProvider({ id: "t", models: ["only"] });
  // 让 createOrResume 炸：meta.json 是坏的。缺省会话现在每次新建（id 随机），要撞上坏档得显式点名那一段
  const store = new InMemoryDir();
  await store.write("meta.json", "不是 json"); // store 就是那一段的目录（2026-09-03）

  const a = await createAgent({ provider, store, lock, allowNetwork: false, sessionId: "bad" });
  await expect(a.start()).rejects.toThrow(/meta\.json 解不开/);

  // lease 被还回去了，所以另一个 agent 还能启动
  const b = await createAgent({ provider, store: new InMemoryDir(), lock, allowNetwork: false });
  await b.start();
  await b.stop();
});

test("丢锁 → 停止持久化 + 拒绝新工作（丢锁善后的 ①③）", async () => {
  const lock = new InMemoryStateLock();
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: new InMemoryDir(),
    lock,
    allowNetwork: false,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start();

  lock.simulateLost("租约过期");
  await Promise.resolve(); // 让 watchLease 的 then 跑起来
  await new Promise((r) => setTimeout(r, 0));

  await expect(agent.prompt("还能干活吗")).rejects.toThrow(/已丢失 single-writer 租约/);
});

test("stop() 释放 lease —— 之后同一把锁能再被拿到", async () => {
  const lock = new InMemoryStateLock();
  const provider = fakeProvider({ id: "t", models: ["only"] });
  const a = await createAgent({ provider, store: new InMemoryDir(), lock, allowNetwork: false });
  await a.start();
  await a.stop();

  const b = await createAgent({ provider, store: new InMemoryDir(), lock, allowNetwork: false });
  await b.start(); // 不抛就说明锁真的还回去了
  await b.stop();
});

test("不传 store / lock 时用 first-party 默认件（真落盘）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-agent-"));
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    stateDir: dir,
    allowNetwork: false,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start();
  expect(existsSync(join(dir, ".lock"))).toBe(true); // 文件锁真的建了
  await agent.prompt("落个盘");
  await agent.stop();
  expect(existsSync(join(dir, ".lock"))).toBe(false); // stop 还锁
  expect(existsSync(join(dir, "meta.json"))).toBe(true); // stateDir 就是这一段的目录
});

test("本函数装配的件不许从 `agent` 透传口再塞一次——**判据是 tsc**", () => {
  // 「接受配置后又静默覆盖」是最坏的一种参数：写了没生效。
  // 判据落在类型上，所以这里用 `@ts-expect-error`——**omit 少一个，那条指令就变成
  // 「未使用」，tsc 当场判红**（`bun test` 不查类型，光靠运行时断言盯不住这条）。
  const base = { provider: fakeProvider({ id: "t", models: ["only"] }), allowNetwork: false };
  // 只验类型，**运行时什么都不做**——真调 createAgent 会在 $PWD/.echo 下建出状态根来
  const check = (_: Parameters<typeof createAgent>[0]): void => {};
  // 这里显式给一个 `streamFunction`：**2026-08-23 之前它是必填的**，于是下面每一行都会
  // 因为「缺 streamFunction」而报错，`@ts-expect-error` 永远算「已使用」，这道门**恒绿**
  // （实测过）。现在透传口已把它放宽成可选（`createAgent` 本来就有默认值），
  // 留着这一行是为了让判据只对着「该不该 omit」这一件事，不掺别的必填项。
  const sf = scriptedStreamFn([textTurn("ok")]);
  // 每条**单独一个语句**：写成一个数组字面量时，TS 不会把其中「已经没错」的那几条
  // 报成未使用指令（同一语句里只要有一处错就都算用上了），门就失效了——实测。
  // @ts-expect-error memory 由 createAgent 按状态根装配
  check({ ...base, agent: { streamFunction: sf, memory: undefined as never } });
  // @ts-expect-error taskStore 同上
  check({ ...base, agent: { streamFunction: sf, taskStore: undefined as never } });
  // @ts-expect-error schedule 同上（实测：传进去的不是返回的那个实例）
  check({ ...base, agent: { streamFunction: sf, schedule: undefined as never } });
  // @ts-expect-error inboxStore 同上
  check({ ...base, agent: { streamFunction: sf, inboxStore: undefined as never } });
  // @ts-expect-error skillStore 同上（本函数给的是状态根 skills/ 的视图；要自己的存法走 new Agent）
  check({ ...base, agent: { streamFunction: sf, skillStore: undefined as never } });
  // @ts-expect-error sessionId 顶层收，嵌套里给会被默认值盖掉
  check({ ...base, agent: { streamFunction: sf, sessionId: "x" } });
  expect(true).toBe(true); // 运行时无判据：这条测试的门是 tsc
});

/* ───────────── 任务落盘也归单写者管（2026-08-24 第二轮 review 的第 1 条） ───────────── */

// **判据落在 createAgent 自己装的那个 taskStore 上**——不是我另塞一个。
// `taskStore` 在 `agent` 的 Omit 列表里，塞进去会被静默覆盖，那样的测试是假绿
// （第一版就这么写的：`writes` 恒空，"没写"那条永远通过）。
// 状态根是 `InMemoryDir`，直接读 `tasks.json` 就知道到底写没写。

test("start() 之前改任务不许落盘——那时还没拿锁", async () => {
  const dir = new InMemoryDir();
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: dir,
    lock: new InMemoryStateLock(),
    allowNetwork: false,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装

  // 还没 start()：没有单写者资格，动状态根就是越权
  createTasks(agent.tasks, [{ title: "抢在拿锁之前" }]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(await dir.read("tasks.json"), "没拿锁就写了 tasks.json").toBeNull();

  // start() 之后同样的改动就该落盘——判据不是「永远不写」，是「拿到锁才写」
  await agent.start();
  createTasks(agent.tasks, [{ title: "拿锁之后" }]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(await dir.read("tasks.json"), "拿了锁却不写了").toContain("拿锁之后");

  await agent.stop();
});

test("丢锁之后改任务不许落盘，而且是永久封死", async () => {
  const dir = new InMemoryDir();
  const lock = new InMemoryStateLock();
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: dir,
    lock,
    allowNetwork: false,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start();
  createTasks(agent.tasks, [{ title: "丢锁之前就有的" }]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const before = await dir.read("tasks.json");
  expect(before, "前置没成立：丢锁之前那次就没写进去").toContain("丢锁之前就有的");

  lock.simulateLost("租约过期");
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  createTasks(agent.tasks, [{ title: "租约都没了还写" }]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(await dir.read("tasks.json"), "丢锁后仍在写——新 holder 可能正写同一份文件").toBe(before);

  // 收摊那一笔也不许写：seal 是永久的
  await agent.stop().catch(() => undefined);
  expect(await dir.read("tasks.json"), "seal 之后收摊还是写了").toBe(before);
});

test("排队之后、真正落盘之前丢锁：那一笔也要撤回（执行点重检）", async () => {
  const dir = new InMemoryDir();
  const lock = new InMemoryStateLock();
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: dir,
    lock,
    allowNetwork: false,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start();
  const before = await dir.read("tasks.json");

  // 排队时租约还在（判据放行），紧接着同一拍里丢锁——只在排队时查就会写出去
  createTasks(agent.tasks, [{ title: "排队时合法，执行时已经不合法" }]);
  lock.simulateLost("排队期间过期");
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  expect(await dir.read("tasks.json"), "只在排队时查了一次，执行时没重查").toBe(before);
  await agent.stop().catch(() => undefined);
});

/* ───────────── OSS-1c：skill_create 的默认落盘 + start() 发现 ───────────── */

const toolCtx = () => ({ toolCallId: "t1", workspace: "/", sessionId: null, iteration: 0 });

async function execTool(agent: Awaited<ReturnType<typeof createAgent>>, name: string, params: unknown) {
  const tool = [...agent.tools.values()].find((t) => t.name === name);
  expect(tool, `工具 ${name} 不在面上`).toBeDefined();
  return (tool!.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }>)(params, toolCtx());
}

test("skill_create 落盘 → 第二次装配 start() 发现回来，activate 可用（跨装配：同进程换实例；真跨进程见 resident-v0）", async () => {
  const dir = new InMemoryDir();
  // 工具面由 `echo:*` builtin Extension 装：`createAgent` 只是内部装配函数，
  // 不 mount 扩展——真正的 composition root 是 `createEcho()`。这里手动挂同一张表。
  const mk = async () => {
    const a = await createAgent({
      provider: fakeProvider({ id: "t", models: ["only"] }),
      store: dir,
      lock: new InMemoryStateLock(),
      allowNetwork: false,
      withoutMemory: true,
    });
    await mountBuiltinTools(a);
    return a;
  };

  const a1 = await mk();
  await a1.start();
  const created = await execTool(a1, "skill_create", {
    name: "commit-msg",
    description: "写提交信息的规矩",
    content: "先说结论，末行带门禁读数。",
  });
  expect([created.isError, created.content]).toEqual([false, created.content]);
  // 落盘形态是目录式入口（原话「文件实现写 SKILL.md」）
  const onDisk = await dir.read("skills/commit-msg/SKILL.md");
  expect(onDisk, "工具说成功了，盘上却没有").toContain("写提交信息的规矩");
  expect(onDisk).toContain("先说结论");
  await a1.stop();

  // 「新进程」：同一状态根、全新装配
  const a2 = await mk();
  expect(a2.skills.has("commit-msg"), "start() 之前就有——发现不该发生在装配期").toBe(false);
  await a2.start();
  expect(a2.skills.get("commit-msg")?.description).toBe("写提交信息的规矩");
  const activated = await execTool(a2, "skill_activate", { name: "commit-msg" });
  expect([activated.isError, activated.content]).toEqual([false, activated.content]);
  await a2.stop();
});

test("skill 落盘失败：不说成功，且如实说明「进程内已建、别重试」", async () => {
  const dir = new InMemoryDir();
  const failing: typeof dir = Object.create(dir);
  failing.write = async (path: string, content: string) => {
    if (path.startsWith("skills/")) throw new Error("盘满了");
    return dir.write(path, content);
  };
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: failing,
    lock: new InMemoryStateLock(),
    allowNetwork: false,
    withoutMemory: true,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start();
  const out = await execTool(agent, "skill_create", { name: "doomed", description: "写不进去", content: "x" });
  expect(out.isError, "落盘失败却回执成功").toBe(true);
  expect(out.content).toContain("盘满了");
  expect(out.content, "没说清进程内已建").toContain("was created in this process");
  expect(out.content, "没拦住重试").toContain("Do not retry");
  // 与措辞一致：池里确实有、activate 真的可用
  const activated = await execTool(agent, "skill_activate", { name: "doomed" });
  expect(activated.isError).toBe(false);
  await agent.stop();
});

test("发现的坏 SKILL.md 跳过 + 诊断，agent 照常启动；构造期显式传的赢过发现的同名", async () => {
  const dir = new InMemoryDir();
  await dir.write("skills/broken/SKILL.md", "没有 frontmatter 也没有 description");
  await dir.write("skills/dup/SKILL.md", "---\ndescription: 盘上那份\n---\n盘上的正文");
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => void notices.push(e.message));
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: dir,
    lock: new InMemoryStateLock(),
    allowNetwork: false,
    withoutMemory: true,
    agent: {
      hooks,
      skills: [{ name: "dup", description: "显式传的那份", content: "x", files: [], requiredTools: [], modelInvocable: true, frontmatter: {} }],
    },
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start();
  // 坏的：跳过 + 诊断（与 loader 同姿态——skills/ 目录人也会手放文件）
  expect(agent.skills.has("broken")).toBe(false);
  expect(notices.join("\n"), "坏 skill 静默消失了").toContain("skill_missing_description");
  // 撞名：先到先得——构造期显式传的已在池里，发现的同名跳过 + 诊断
  expect(agent.skills.get("dup")?.description).toBe("显式传的那份");
  expect(notices.join("\n")).toContain("skill_name_clash");
  await agent.stop();
});

test("skill_create 归单写者管：没拿到租约就拒绝，**池里也不留**", async () => {
  // 与 Task 工具不同，这里能做到零副作用地拒绝——门在 inner 之前，所以没有「局部生效」。
  const dir = new InMemoryDir();
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: dir,
    lock: new InMemoryStateLock(),
    allowNetwork: false,
    withoutMemory: true,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装

  // 还没 start()：没有租约
  const before = await execTool(agent, "skill_create", { name: "early", description: "抢在拿锁之前", content: "x" });
  expect(before.isError, "没拿锁就创建成功了").toBe(true);
  expect(before.content).toContain("单写者租约");
  expect(before.content, "没说清这次根本没执行").toContain("没有执行");
  expect(agent.skills.has("early"), "拒绝了却还进了池").toBe(false);
  expect(await dir.list("skills/"), "拒绝了却写了盘").toEqual([]);

  // 拿到租约之后同样的调用就该成功——判据是「拿到锁才写」，不是「永远不写」
  await agent.start();
  const after = await execTool(agent, "skill_create", { name: "early", description: "拿锁之后", content: "x" });
  expect([after.isError, after.content]).toEqual([false, after.content]);
  expect(await dir.read("skills/early/SKILL.md")).toContain("拿锁之后");
  await agent.stop();
});

test("skill_create 归单写者管：丢锁之后拒绝", async () => {
  const dir = new InMemoryDir();
  const lock = new InMemoryStateLock();
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: dir,
    lock,
    allowNetwork: false,
    withoutMemory: true,
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start();
  lock.simulateLost("租约过期");
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  const out = await execTool(agent, "skill_create", { name: "late", description: "丢锁之后", content: "x" });
  expect(out.isError, "丢锁之后还创建成功了").toBe(true);
  expect(out.content).toContain("单写者租约");
  expect(await dir.read("skills/late/SKILL.md"), "丢锁之后还写了盘").toBeNull();
  await agent.stop().catch(() => undefined);
});

test("单个 SKILL.md 读失败：诊断 + 跳过，别的 skill 照常发现，agent 照常启动", async () => {
  const dir = new InMemoryDir();
  await dir.write("skills/good/SKILL.md", "---\ndescription: 好的\n---\n正文");
  await dir.write("skills/bad-io/SKILL.md", "---\ndescription: 读不出来\n---\n正文");
  const flaky: typeof dir = Object.create(dir);
  flaky.read = async (path: string) => {
    if (path === "skills/bad-io/SKILL.md") throw new Error("EIO 模拟");
    return dir.read(path);
  };
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => void notices.push(e.message));
  const agent = await createAgent({
    provider: fakeProvider({ id: "t", models: ["only"] }),
    store: flaky,
    lock: new InMemoryStateLock(),
    allowNetwork: false,
    withoutMemory: true,
    agent: { hooks },
  });
  await mountBuiltinTools(agent); // 工具面由 `echo:*` builtin Extension 装
  await agent.start(); // 一个坏文件不许拖垮启动
  expect(agent.skills.has("good"), "好的那个也没发现——整批被拖垮了").toBe(true);
  expect(agent.skills.has("bad-io")).toBe(false);
  expect(notices.join("\n"), "读失败静默消失了").toContain("skill_load_failed");
  expect(notices.join("\n")).toContain("EIO 模拟");
  await agent.stop();
});

test("活着就找得到：刚起来、一句话没说的那段也在清单里；收摊之后才撤（2026-09-04）", async () => {
  // 没有这条时实测过：meta 推迟到第一次入账才写，于是**刚打开的第二个终端在别人眼里根本不存在**
  // ——`listSessions` 里没有它，`session_send` 给它是 not-found。「会话之间能互发消息」当场断一半。
  const home = await mkdtemp(join(tmpdir(), "echo-visible-"));
  process.env.ECHO_HOME = home;
  const provider = fakeProvider({ id: "t", models: ["only"] });
  const sessionsRoot = new FileDir(resolveSessionsRoot());

  const silent = await createAgent({ provider, allowNetwork: false, workspace: "/repo/b" });
  await silent.start();
  const id = silent.state.sessionId!;
  expect((await listSessions(sessionsRoot)).map((s) => s.id), "开着却找不到它").toContain(id);

  await silent.stop(); // 一个字没说
  expect((await listSessions(sessionsRoot)).map((s) => s.id), "收摊后没撤干净").not.toContain(id);
});

test("留过话的空会话不撤：撤了那条留言就成了没人认领的孤儿（2026-09-04）", async () => {
  const home = await mkdtemp(join(tmpdir(), "echo-visible-"));
  process.env.ECHO_HOME = home;
  const provider = fakeProvider({ id: "t", models: ["only"] });
  const sessionsRoot = new FileDir(resolveSessionsRoot());

  const agent = await createAgent({ provider, allowNetwork: false, workspace: "/repo/b" });
  await agent.start();
  agent.autoConsumeInbox = false; // 留着不消费：模拟「刚投进来就退出」
  const id = agent.state.sessionId!;
  await agent.ingress.deliverDurable({ message: environmentMessage("有人给你留了话", "session", "s-x:1"), dedupeKey: "s-x:1" });
  await agent.stop();

  expect((await listSessions(sessionsRoot)).map((s) => s.id), "有人留了话，这段不该被撤").toContain(id);
});

test("起来就退的段连目录一起清掉——不只是撤 meta（2026-09-07）", async () => {
  // 没有这条时实测过：`discardIfUnused()` 只撤了 meta.json，目录与里面的观测库还留着，
  // 于是开发机上攒了 805 个这样的空壳、68 MB。
  const home = await mkdtemp(join(tmpdir(), "echo-empty-"));
  process.env.ECHO_HOME = home;
  const provider = fakeProvider({ id: "t", models: ["only"] });

  const silent = await createAgent({ provider, allowNetwork: false, workspace: "/repo" });
  await silent.start();
  const id = silent.state.sessionId!;
  expect(existsSync(join(home, "sessions", id)), "跑着的时候目录当然在").toBe(true);
  await silent.stop(); // 一个字没说
  expect(existsSync(join(home, "sessions", id)), "空段的目录没清掉").toBe(false);

  // 说过话的那一段一个字都不许动
  const spoke = await createAgent({ provider, allowNetwork: false, workspace: "/repo" });
  await spoke.start();
  const spokeId = spoke.state.sessionId!;
  await spoke.prompt("说一句");
  await spoke.stop();
  expect(existsSync(join(home, "sessions", spokeId, "meta.json"))).toBe(true);
});

test("留过话的空段也不清：目录里还有别的东西就原样留着", async () => {
  const home = await mkdtemp(join(tmpdir(), "echo-empty-"));
  process.env.ECHO_HOME = home;
  const provider = fakeProvider({ id: "t", models: ["only"] });
  const agent = await createAgent({ provider, allowNetwork: false, workspace: "/repo" });
  await agent.start();
  agent.autoConsumeInbox = false; // 留着不消费
  const id = agent.state.sessionId!;
  await agent.ingress.deliverDurable({ message: environmentMessage("有人给你留了话", "session", "s-x:1"), dedupeKey: "s-x:1" });
  await agent.stop();
  expect(existsSync(join(home, "sessions", id)), "有留言的段被清掉了").toBe(true);
});
