import { test, expect, afterEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, resolveModel, resolveStateDir } from "../src/create-agent.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { kimiProvider, deepseekProvider } from "../src/provider/openai.ts";
import { createTasks } from "../src/task/harness.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { scriptedDialect, scriptedStreamFn, textTurn } from "../src/testing.ts";
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
  expect(resolveStateDir({ stateDir: "/explicit", agentId: "a" })).toBe("/explicit");
});

test("D6 ECHO_HOME 次之", () => {
  process.env.ECHO_HOME = "/tmp/echo-home";
  expect(resolveStateDir({ agentId: "a" })).toBe("/tmp/echo-home/agents/a");
});

test("D6 最后落项目内 $PWD/.echo —— 不是 ~/.echo", () => {
  delete process.env.ECHO_HOME;
  const got = resolveStateDir({ agentId: "default" });
  expect(got).toBe(join(process.cwd(), ".echo", "agents", "default"));
  // 显式锁住「不共用用户主目录」：那会让两个不相干的项目静默共用同一份记忆
  expect(got.startsWith(process.cwd())).toBe(true);
});

test("D6 agentId 进路径 —— 两个 agent 不共用状态根", () => {
  delete process.env.ECHO_HOME;
  expect(resolveStateDir({ agentId: "a" })).not.toBe(resolveStateDir({ agentId: "b" }));
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
  expect(agent.state.sessionId).toBe("main"); // D5 默认会话身份
});

test("start() create-or-resume，stop() 之后换个实例能读回来", async () => {
  const store = new InMemoryDir();
  const provider = fakeProvider({ id: "t", models: ["only"] });

  const first = await createAgent({ provider, store, lock: new InMemoryStateLock(), allowNetwork: false });
  await first.start();
  await first.prompt("你好");
  await first.stop();

  const second = await createAgent({ provider, store, lock: new InMemoryStateLock(), allowNetwork: false });
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
  // 让 createOrResume 炸：meta.json 是坏的
  const store = new InMemoryDir();
  await store.write("sessions/main/meta.json", "不是 json");

  const a = await createAgent({ provider, store, lock, allowNetwork: false });
  await expect(a.start()).rejects.toThrow(/meta\.json 解不开/);

  // lease 被还回去了，所以另一个 agent 还能启动
  const b = await createAgent({ provider, store: new InMemoryDir(), lock, allowNetwork: false });
  await b.start();
  await b.stop();
});

test("丢锁 → 停止持久化 + 拒绝新工作（§13.12.3 的 ①③）", async () => {
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
  expect(existsSync(join(dir, "sessions", "main", "meta.json"))).toBe(true);
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

/* ───────────── OSS-1c：skill_create 的默认落盘 + start() 发现（§5A.4c / §13.6） ───────────── */

const toolCtx = () => ({ toolCallId: "t1", cwd: "/", workspaceRoot: "/", sessionId: null, iteration: 0 });

async function execTool(agent: Awaited<ReturnType<typeof createAgent>>, name: string, params: unknown) {
  const tool = [...agent.tools.values()].find((t) => t.name === name);
  expect(tool, `工具 ${name} 不在面上`).toBeDefined();
  return (tool!.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }>)(params, toolCtx());
}

test("skill_create 落盘 → 第二次装配 start() 发现回来，activate 可用（跨装配：同进程换实例；真跨进程见 resident-v0）", async () => {
  const dir = new InMemoryDir();
  // 工具面由 `echo:*` builtin Extension 装（§14）：`createAgent` 只是内部装配函数，
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
  // 落盘形态是目录式入口（§5A.4c 原话「文件实现写 SKILL.md」）
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
  expect(out.content, "没说清进程内已建").toContain("已经在当前进程里创建");
  expect(out.content, "没拦住重试").toContain("不要重试");
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
