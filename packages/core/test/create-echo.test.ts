import { test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEcho,
  discoverExtensionFiles,
  loadExtensionFile,
  resolveExtensionDirs,
  ExtensionLoadError,
  EXTENSIONS_DIR,
  type Echo,
} from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn } from "../src/testing.ts";
import { defineExtension } from "../src/extension/abi.ts";
import { AgentTools } from "../src/extension/registries.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { InMemoryStateLock } from "../src/storage/lock.ts";
import type { StorageDir } from "../src/storage/types.ts";
import type { Provider } from "../src/provider/types.ts";
import type { ScriptedTurn } from "../src/testing.ts";

// `createEcho` 的契约：**唯一 composition root** = `createAgent()` + 扫 `extensions/` + mount。
//
// 这里最要紧的一条判据是「**装上了 ≠ 用得上**」：只断言工具名出现在某张表里是不够的
//（一个只把名字塞进列表、execute 永远不被调的实现照样能过）。所以有一条真跑一轮工具循环、
// 检查 toolResult 内容的测试——那才是「扩展里写的 tool 真的被加载了」。

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures/extensions");

/** §14 owner 表里本批搬进来的四条，顺序即 `builtinEntries()` 的顺序。 */
const BUILTIN_NAMES = ["echo:agent", "echo:tasks", "echo:skills", "echo:memory", "echo:scheduler", "echo:compaction"] as const;

const temps: string[] = [];
const running: Echo[] = [];

/** 生成到 tmp 的 fixture 引 ABI 用的绝对路径：tmp 在 workspace 外，包名解析不了（实测），与包内 fixture 的相对引法等价。 */
const ABI_PATH = join(import.meta.dir, "..", "src", "extension", "public.ts");

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "echo-echo-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const echo of running.splice(0)) await echo.stop().catch(() => {});
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

function scripted(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

/** 起一个真 Echo（真 FileDir + 真文件锁），afterEach 统一收摊。 */
async function echoAt(opts: { stateDir: string; dirs?: readonly string[]; turns?: ScriptedTurn[] }): Promise<Echo> {
  const echo = await createEcho({
    provider: scripted(opts.turns ?? [textTurn("ok")]),
    allowNetwork: false,
    stateDir: opts.stateDir,
    extensionDirs: opts.dirs ?? [FIXTURES],
  });
  running.push(echo);
  return echo;
}

/* ───────────── 目录解析 ───────────── */

test("缺省扫 `<cwd>/extensions`", () => {
  expect(resolveExtensionDirs({ cwd: "/w" })).toEqual([join("/w", EXTENSIONS_DIR)]);
});

test("给了 extensionDirs 就只用给的，相对路径按 cwd 解析（不再叠加约定目录）", () => {
  expect(resolveExtensionDirs({ cwd: "/w", extensionDirs: ["plugins", "/abs/x"] })).toEqual([
    join("/w", "plugins"),
    "/abs/x",
  ]);
  // 空数组 = 彻底关掉自动发现，不能被当成「没给」而回落到约定目录
  expect(resolveExtensionDirs({ cwd: "/w", extensionDirs: [] })).toEqual([]);
});

/* ───────────── 发现规则 ───────────── */

test("目录不存在 = 没有扩展，不是错", async () => {
  expect(await discoverExtensionFiles(join(await tmp(), "nope"))).toEqual([]);
});

test("一层发现：直接文件 + 子目录 index；不认非模块后缀，不递归第二层", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(join(dir, "sub/deeper"), { recursive: true });
  await writeFile(join(dir, "b.ts"), "export default 1;");
  await writeFile(join(dir, "a.js"), "export default 1;");
  await writeFile(join(dir, "notes.md"), "not code");
  await writeFile(join(dir, "data.json"), "{}");
  await writeFile(join(dir, "sub/index.ts"), "export default 1;");
  await writeFile(join(dir, "sub/helper.ts"), "export default 1;"); // 子目录里的非 index 不算
  await writeFile(join(dir, "sub/deeper/index.ts"), "export default 1;"); // 第二层不找

  expect(await discoverExtensionFiles(dir)).toEqual([
    join(dir, "a.js"),
    join(dir, "b.ts"),
    join(dir, "sub/index.ts"),
  ]);
});

/* ───────────── 单文件加载：三种坏形状都 fail-loud 且指名道姓 ───────────── */

test("没有默认导出 → ExtensionLoadError，报文里带文件名与该怎么写", async () => {
  const dir = await tmp();
  const file = join(dir, "bad.ts");
  await writeFile(file, "export const notDefault = 1;\n");
  const err = await loadExtensionFile(file).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExtensionLoadError);
  expect((err as ExtensionLoadError).message).toContain("bad.ts");
  expect((err as ExtensionLoadError).message).toContain("export default defineExtension");
});

test("默认导出形状不对（hostAbiVersion 不是 1）→ ExtensionLoadError，理由来自 ABI 本身", async () => {
  const dir = await tmp();
  const file = join(dir, "wrong-abi.ts");
  await writeFile(file, `export default { name: "x", hostAbiVersion: 2, apply() {} };\n`);
  const err = await loadExtensionFile(file).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExtensionLoadError);
  expect((err as ExtensionLoadError).message).toContain("hostAbiVersion 必须是 1");
});

test("模块求值就抛（语法错 / 顶层 throw）→ 包成 ExtensionLoadError 且保留 cause", async () => {
  const dir = await tmp();
  const file = join(dir, "boom.ts");
  await writeFile(file, `throw new Error("顶层炸了");\n`);
  const err = await loadExtensionFile(file).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExtensionLoadError);
  expect((err as ExtensionLoadError).file).toBe(file);
  expect(((err as ExtensionLoadError).cause as Error).message).toContain("顶层炸了");
});

/* ───────────── 端到端 ───────────── */

test("扫 extensions/ → 两个 Extension 都 mount，工具真的进了 agent 的工具表", async () => {
  const echo = await echoAt({ stateDir: join(await tmp(), "state") });

  // **清单里内建在前、外部在后**——这正是「内部 extension 先、外部 extension 后」那条顺序的可见面。
  // 内建四条恒在（§14 owner 表），所以断言要连它们一起写：清单是「这个 agent 会什么」的完整答案。
  expect(echo.extensions.map((e) => e.name)).toEqual([...BUILTIN_NAMES, "adds-tool", "nested"]);
  // 盘上发现的那两条带 file；内建来自内置模块表，没有文件
  expect(echo.extensions.filter((e) => e.file !== undefined).map((e) => e.entryId)).toEqual([
    resolve(FIXTURES, "adds-tool.ts"),
    resolve(FIXTURES, "nested/index.ts"),
  ]);
  expect(echo.extensions.filter((e) => e.file === undefined).map((e) => e.entryId)).toEqual([...BUILTIN_NAMES]);

  const names = [...echo.agent.tools.keys()];
  expect(names).toContain("fixture_year");
  expect(names).toContain("fixture_nested");
});

test("**装上了 ≠ 用得上**：模型点名调扩展里的工具，execute 真的被执行、结果回到会话里", async () => {
  const echo = await echoAt({
    stateDir: join(await tmp(), "state"),
    turns: [toolTurn("c1", "fixture_year", {}), textTurn("2026")],
  });
  await echo.agent.start();

  const result = await echo.agent.prompt("今年几几年？");
  expect(result.outcome.kind).toBe("completed");

  const toolResults = echo.agent.messages.filter((m) => m.role === "toolResult");
  expect(toolResults.length).toBe(1);
  // 工具不存在时**也会有**一条 toolResult（内容是「没这个工具」）——所以要看内容，不能只数条数
  expect(toolResults[0]!.isError).not.toBe(true);
  expect(JSON.stringify(toolResults[0]!.content)).toContain("2026");
});

test("stop() 真的 unmount 了 Extension，而且发生在 Agent 收摊之前", async () => {
  // **不能拿「工具没了」当判据**：`agent.stop()` 自己就会 `tools.clear()`，
  // 于是一个根本不调 `host.unmount()` 的实现照样能过（写这条时实测如此）。
  // 判据必须落在 Fiber 自己的 disposer 上。
  let disposed = false;
  let toolsWhenDisposed = -1;

  const tool: ModelTool = {
    kind: "model",
    name: "dispose_probe",
    label: "探针",
    description: "证明 disposer 真的跑了",
    parameters: { type: "object", properties: {} },
    execute: async () => toolOk("x"),
  };
  const definition = defineExtension({
    name: "probe",
    hostAbiVersion: 1,
    inject: { tools: { service: AgentTools, required: true } },
    apply(ctx) {
      const tools = ctx.get(AgentTools);
      void ctx.effect({
        boundary: "turn",
        start: () => {
          const off = tools.register(tool);
          return {
            value: tool.name,
            dispose: () => {
              disposed = true;
              // 顺序探针：Agent 收摊时会清空工具表，所以这里**还看得见工具** = 卸载发生在收摊之前
              toolsWhenDisposed = echo.agent.tools.size;
              off();
            },
          };
        },
      });
    },
  });

  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [],
    extensions: [{ entryId: "probe", definition }],
  });
  running.push(echo);
  expect(echo.agent.tools.has("dispose_probe")).toBe(true);

  await echo.stop();
  expect(disposed).toBe(true);
  expect(toolsWhenDisposed).toBeGreaterThan(0);
  // Agent 也真的停了：停过的 Agent 不许再起（相位是私有的，这是它唯一的可观察面）
  await expect(echo.agent.start()).rejects.toThrow("已经 stop() 过了");

  await echo.stop(); // 幂等
});

test("providers 多注册（P3b-a）：换到另一家的模型，请求真的派发到那一家", async () => {
  // 判据不是「setModel 返回 accepted」——是**另一家的脚本被消费**：B 家应答的正文出现在会话里。
  const b = createProvider({
    id: "scripted-b",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "b-only",
    models: [{ id: "b-only", api: "fake" }],
    api: createProviderStreams(scriptedDialect([textTurn("我是 B 家")])),
  });
  const echo = await createEcho({
    provider: scripted([textTurn("我是 A 家")]),
    providers: [b],
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [],
  });
  try {
    await echo.agent.start();
    echo.agent.model = { id: "b-only", api: "fake", provider: "scripted-b" }; // 装备 setter（P3a 协议底下同一条路）
    const result = await echo.agent.prompt("你是谁");
    expect(result.outcome.kind).toBe("completed");
    const texts = echo.agent.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
      .map((c) => c.text);
    expect(texts.join("")).toContain("我是 B 家");
  } finally {
    await echo.stop();
  }
});

test("盘上的坏扩展**不阻塞启动**：跳过 + 诊断带路径，好的照装，agent 起得来（D6）", async () => {
  const root = await tmp();
  const dir = join(root, "extensions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "broken.ts"), "export const x = 1;\n"); // 没有默认导出
  await writeFile(
    join(dir, "good.ts"),
    `import { defineExtension } from ${JSON.stringify(ABI_PATH)};\n` +
      `export default defineExtension({ name: "good", hostAbiVersion: 1, apply() {} });\n`,
  );

  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(root, "state"),
    extensionDirs: [dir],
  });
  try {
    // 好的装上了、坏的不在清单里
    expect(echo.extensions.map((e) => e.name)).toContain("good");
    expect(echo.extensions.map((e) => e.name)).not.toContain("broken");
    // 诊断一条、指名道姓——跳过而不上报就是静默失败
    expect(echo.diagnostics.length).toBe(1);
    expect(echo.diagnostics[0]!.code).toBe("extension_load_failed");
    expect(echo.diagnostics[0]!.path).toBe(join(dir, "broken.ts"));
    // agent 真的能起、能跑
    await echo.agent.start();
    const result = await echo.agent.prompt("在吗");
    expect(result.outcome.kind).toBe("completed");
  } finally {
    await echo.stop();
  }
});

test("盘上扩展 `apply()` 抛：只废它自己那代——跳过 + mount 诊断，后面的显式 Extension 照装（D6）", async () => {
  const root = await tmp();
  const dir = join(root, "extensions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "explodes.ts"),
    `import { defineExtension } from ${JSON.stringify(ABI_PATH)};\n` +
      `export default defineExtension({ name: "explodes", hostAbiVersion: 1, apply() { throw new Error("apply 炸了"); } });\n`,
  );

  let probeMounted = 0;
  const probe = defineExtension({
    name: "after-broken",
    hostAbiVersion: 1,
    apply() {
      probeMounted += 1;
    },
  });

  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(root, "state"),
    extensionDirs: [dir],
    extensions: [{ entryId: "probe", definition: probe as never }],
  });
  try {
    expect(probeMounted, "坏扩展把后面的显式 Extension（壳就在这个位置）拖死了").toBe(1);
    expect(echo.extensions.map((e) => e.name)).toContain("after-broken");
    expect(echo.extensions.map((e) => e.name)).not.toContain("explodes");
    expect(echo.diagnostics.length).toBe(1);
    expect(echo.diagnostics[0]!.code).toBe("extension_mount_failed");
    expect(echo.diagnostics[0]!.message).toContain("apply 炸了");
  } finally {
    await echo.stop();
  }
});

test("盘上扩展分代之后，`stop()` 仍要把**每一代**都卸掉：它的 disposer 必须真的跑（D6）", async () => {
  // D6 把盘上扩展拆成每个一代——收摊清单要是漏了这些代，Fiber 的 disposer 一次都不跑，
  // watcher / 连接 / 子进程就是真泄漏。全局计数器是 tmp 生成的 fixture 与测试之间唯一的通道。
  const g = globalThis as { __d6_disposed?: number };
  g.__d6_disposed = 0;
  const root = await tmp();
  const dir = join(root, "extensions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "tracks-dispose.ts"),
    `import { defineExtension } from ${JSON.stringify(ABI_PATH)};\n` +
      `export default defineExtension({ name: "tracks-dispose", hostAbiVersion: 1, apply(ctx) {\n` +
      `  void ctx.effect({ boundary: "agent", start: () => ({ value: 1, dispose: () => {\n` +
      `    (globalThis).__d6_disposed = ((globalThis).__d6_disposed ?? 0) + 1;\n` +
      `  } }) });\n` +
      `} });\n`,
  );

  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(root, "state"),
    extensionDirs: [dir],
  });
  expect(echo.extensions.map((e) => e.name)).toContain("tracks-dispose");
  expect(g.__d6_disposed).toBe(0);

  await echo.stop();
  expect(g.__d6_disposed, "盘上扩展那一代没被卸——disposer 一次都没跑").toBe(1);
});

test("**显式传入的**坏 Extension 照旧整体不起（fail-loud）：那是代码 bug 不是运行态配置", async () => {
  const bad = defineExtension({
    name: "explicit-bad",
    hostAbiVersion: 1,
    apply() {
      throw new Error("显式的炸了");
    },
  });
  await expect(
    createEcho({
      provider: scripted([textTurn("ok")]),
      allowNetwork: false,
      stateDir: join(await tmp(), "state"),
      extensionDirs: [],
      extensions: [{ entryId: "bad", definition: bad as never }],
    }),
  ).rejects.toThrow("显式的炸了");
});

test("全部装上时 diagnostics 恒空；坏的被跳过后 stop() 照样把 store 恰好关一次（不泄漏）", async () => {
  const root = await tmp();
  const dir = join(root, "extensions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "broken.ts"), "export const x = 1;\n");

  let closes = 0;
  const inner = new InMemoryDir();
  const store: StorageDir = {
    read: (p) => inner.read(p),
    write: (p, c) => inner.write(p, c),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    close: async () => void closes++,
  };
  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(root, "state"),
    extensionDirs: [dir],
    store,
    lock: new InMemoryStateLock(),
  });
  await echo.stop();
  expect(closes).toBe(1);

  const clean = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(root, "state2"),
    extensionDirs: [],
  });
  expect(clean.diagnostics).toEqual([]);
  await clean.stop();
});

test("两个目录指到同一个文件只装一次（按解析后的绝对路径去重）", async () => {
  const echo = await echoAt({
    stateDir: join(await tmp(), "state"),
    dirs: [FIXTURES, join(FIXTURES, "..", "extensions")],
  });
  expect(echo.extensions.map((e) => e.name)).toEqual([...BUILTIN_NAMES, "adds-tool", "nested"]);
});

test("extensionDirs: [] 关掉自动发现；opts.extensions 仍然照装（file 为 undefined）", async () => {
  const tool: ModelTool = {
    kind: "model",
    name: "inline_tool",
    label: "内联",
    description: "显式传进来的",
    parameters: { type: "object", properties: {} },
    execute: async () => toolOk("inline"),
  };
  const definition = defineExtension({
    name: "inline",
    hostAbiVersion: 1,
    inject: { tools: { service: AgentTools, required: true } },
    apply(ctx) {
      const tools = ctx.get(AgentTools);
      void ctx.effect({ boundary: "turn", start: () => ({ value: tool.name, dispose: tools.register(tool) }) });
    },
  });

  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [],
    extensions: [{ entryId: "inline", definition }],
  });
  running.push(echo);

  expect(echo.extensions.map((e) => e.name)).toEqual([...BUILTIN_NAMES, "inline"]);
  expect(echo.extensions.at(-1)).toEqual({ entryId: "inline", name: "inline", file: undefined });
  expect(echo.agent.tools.has("inline_tool")).toBe(true);
  expect(echo.agent.tools.has("fixture_year")).toBe(false); // 自动发现确实被关掉了
});

/* ───────────── 收摊是 single-flight 事务（review 二轮） ───────────── */

/** 造一个 disposer 卡住的 Echo：用它把「第二次 stop 会不会提前返回」逼出来。 */
async function echoWithBlockingDisposer(release: Promise<void>): Promise<Echo> {
  const definition = defineExtension({
    name: "blocking",
    hostAbiVersion: 1,
    inject: { tools: { service: AgentTools, required: true } },
    apply(ctx) {
      void ctx.effect({ boundary: "turn", start: () => ({ value: 1, dispose: () => release }) });
    },
  });
  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [],
    extensions: [{ entryId: "blocking", definition }],
  });
  running.push(echo);
  return echo;
}

test("并发 stop()：第二次**不许**先于第一次 settle（幂等 = 拿到同一个结果，不是直接放行）", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const echo = await echoWithBlockingDisposer(gate);

  const order: string[] = [];
  const first = echo.stop().then(() => order.push("first"));
  const second = echo.stop().then(() => order.push("second"));

  // 让微任务跑够：上一版这里 second 已经 resolve 了（`stopped` 布尔在进 disposer 前就置上），
  // 于是调用方以为收摊完了，而第一次还卡在 disposer 里——review 实测 secondSettledBeforeFirst: true
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(order).toEqual([]);

  release();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "second"]); // 共享同一个 promise，先后由 then 的注册序决定
});

test("unmount 与 agent.stop 同时失败：**两个错都要给出去**，不许后者顶掉前者", async () => {
  const definition = defineExtension({
    name: "bad-disposer",
    hostAbiVersion: 1,
    inject: { tools: { service: AgentTools, required: true } },
    apply(ctx) {
      void ctx.effect({
        boundary: "turn",
        start: () => ({
          value: 1,
          dispose: () => {
            throw new Error("extension-unmount-failed");
          },
        }),
      });
    },
  });

  const inner = new InMemoryDir();
  const store: StorageDir = {
    read: (p) => inner.read(p),
    write: (p, c) => inner.write(p, c),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    close: () => {
      throw new Error("agent-stop-failed");
    },
  };
  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [],
    extensions: [{ entryId: "bad", definition }],
    store,
    lock: new InMemoryStateLock(),
  });

  const err = await echo.stop().catch((e: unknown) => e);
  // 上一版 `finally { agent.stop() }` 的抛会把 unmount 那个整个顶掉，实测只剩 agent-stop-failed。
  // **展平要递归**：Host 的 unmount 自己就会把多个 disposer 失败包成一层 AggregateError，
  // 只看顶层消息（"unmount generation 'boot'：1 处清理失败"）是看不见真正原因的。
  const flatten = (e: unknown): string[] =>
    e instanceof AggregateError ? [String(e.message), ...e.errors.flatMap(flatten)] : [String(e)];
  const text = flatten(err).join("|");
  expect(text).toContain("extension-unmount-failed");
  expect(text).toContain("agent-stop-failed");
});

test("子目录读不动**照抛**，不冒充成「这里没有扩展」", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(join(dir, "locked"), { recursive: true });
  await chmod(join(dir, "locked"), 0o000); // 读不进去
  try {
    // 上一版 `.catch(() => [])` 会把它当空目录跳过——用户以为扩展装上了，其实一个都没装
    await expect(discoverExtensionFiles(dir)).rejects.toThrow();
  } finally {
    await chmod(join(dir, "locked"), 0o755); // 还原，否则 afterEach 的 rm 也删不掉
  }
});

test("能力不在就不出条目：`withoutMemory` 的 agent 清单里**没有** echo:memory（review 二轮 P2）", async () => {
  // `echo.extensions` 的全部价值是「这个 agent 会什么」的可信答案。
  // 上一版无条件列四条，于是 memory harness 压根没造、工具也不存在，清单里却写着 `echo:memory`
  //——那是在**报告一个不存在的能力**。
  const withMemory = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "s1"),
    extensionDirs: [],
  });
  running.push(withMemory);
  expect(withMemory.extensions.map((e) => e.name)).toContain("echo:memory");

  const without = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "s2"),
    extensionDirs: [],
    withoutMemory: true,
  });
  running.push(without);
  expect(without.extensions.map((e) => e.name)).not.toContain("echo:memory");
  // 别的能力照在——判据要能区分「这一条没了」和「整张表塌了」
  expect(without.extensions.map((e) => e.name)).toEqual(["echo:agent", "echo:tasks", "echo:skills", "echo:scheduler", "echo:compaction"]);
});

test("构造失败：**已 mount 的 builtin 那一代也要卸**（review 三轮：上一版是假判据）", async () => {
  // **上一版这条测试证明不了任何事**（review 三轮指出，属实）：它用一个没有默认导出的 `bad.ts`
  // 制造失败，而 `loadExtensionFile()` 发生在 **builtin mount 之前**——第一步就抛了，
  // builtin 从来没 mount 上。最后那句 `disposed === 0` 更是自欺：探针压根没装过，当然是 0。
  //
  // 正确的造法：`extensionDirs: []` 关掉磁盘那一步，用一个**在 `apply()` 里抛**的显式 Extension，
  // 让失败真实发生在 builtin 那代 mount 成功**之后**。
  // **失败的造法本身就是「builtin 已经装上了」的证据**：这条 Extension 去注册一个叫
  // `TaskCreate` 的工具——那个名字是 `echo:tasks` builtin 占的。撞上了才会抛，
  // 也就是说这个异常**只可能在 builtin mount 成功之后发生**。比「随便抛一个」强，
  // 因为后者证明不了顺序（上一版的假判据正是栽在这里）。
  let rolledBack = 0;
  const collide = defineExtension({
    name: "collides-with-builtin",
    hostAbiVersion: 1,
    inject: { tools: { service: AgentTools, required: true } },
    apply(ctx) {
      const registry = ctx.get(AgentTools);
      registry.register({
        kind: "model",
        name: "TaskCreate", // ← 与 `echo:tasks` 撞名
        label: "冒名顶替",
        description: "撞名",
        parameters: { type: "object", properties: {} },
        execute: async () => toolOk("x"),
      });
    },
  });
  const probe = defineExtension({
    name: "boot-probe",
    hostAbiVersion: 1,
    apply(ctx) {
      void ctx.effect({ boundary: "turn", start: () => ({ value: 1, dispose: () => void rolledBack++ }) });
    },
  });

  const inner = new InMemoryDir();
  let closes = 0;
  const store: StorageDir = {
    read: (p) => inner.read(p),
    write: (p, c) => inner.write(p, c),
    remove: (p) => inner.remove(p),
    list: (p) => inner.list(p),
    close: async () => void closes++,
  };

  const err = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [], // 关掉磁盘发现：失败必须发生在 mount 阶段，不是 import 阶段
    // 前一条进 builtin 之后的那一代（boot）并把它炸掉；counter 也在 boot 代，用来观察它有没有被卸
    extensions: [
      { entryId: "probe", definition: probe },
      { entryId: "boom", definition: collide },
    ],
    store,
    lock: new InMemoryStateLock(),
  }).catch((e: unknown) => e);

  // ① **失败确实发生在 builtin mount 之后**，两条一起才钉得住：
  //    · 撞的是 `TaskCreate`——那个名字只有 `echo:tasks` builtin 会占，所以 builtin 已经在了；
  //    · 失败的是 **boot 代的 `boom`**，不是 builtin 代。
  //      少了第二条就分不清顺序：builtin 若排在 boot 之后，同样会撞名，只是变成 builtin 代失败
  //      （写这条时实测过——只断言撞名，把 mount 顺序调反测试照样绿）。
  expect(String(err)).toMatch(/TaskCreate/);
  expect(String(err)).toContain("generation 'boot'");
  expect(String(err)).toContain("'boom'");
  // ② Host 的 mount 事务把同一代里已 ACTIVE 的 Fiber 回滚：probe 的 disposer 跑过一次
  expect(rolledBack).toBe(1);
  // ③ Agent 收摊了：注入的 store 恰好关一次
  expect(closes).toBe(1);

  // ④ **「按什么顺序卸、失败了怎么继续、错怎么聚」不由本条守**——本条守的是端到端行为
  //    （失败发生在 builtin 之后、Agent 收摊了）。清理逻辑本身的判据在
  //    `test/extension-cleanup.test.ts`：那里用假 Host 把顺序 / 跳过未挂载 / 一代失败不影响后面 /
  //    错误全收集逐条钉住，两个调用方（`createEcho` 与 `createCodingAgent`）共用同一个
  //    `unmountGenerations()`，所以只需在一处证明。
  //    **本条不冒充守着那些**（review 三轮：删掉 catch 里的 unmount 本条照样绿，属实）。
});

test("`stop()` 会让 builtin 的 Fiber disposer 真的跑（不是靠 agent.stop() 清 Map 掩盖）", async () => {
  // 与上一条互补：这条证明**正常收摊**路径上 disposer 确实被调用。
  let disposed = 0;
  const probe = defineExtension({
    name: "dispose-counter",
    hostAbiVersion: 1,
    apply(ctx) {
      void ctx.effect({ boundary: "turn", start: () => ({ value: 1, dispose: () => void disposed++ }) });
    },
  });
  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [],
    extensions: [{ entryId: "probe", definition: probe }],
  });
  expect(disposed).toBe(0);
  await echo.stop();
  expect(disposed).toBe(1); // 只调一次：single-flight 之下重复 stop 不会重复 dispose
  await echo.stop();
  expect(disposed).toBe(1);
});

test("`agent.tools` 走 inline Extension，不再绕过 ExtensionHost（review 二轮 P1）", async () => {
  // 上一版：`CreateEchoOptions` 继承 `CreateAgentOptions`，`agent: { tools }` 被 Agent 构造函数
  // **直接注册**——工具能被模型调用，却不经 ExtensionHost、不在 `echo.extensions` 里、
  // 没有 Fiber/Effect owner。那与本层「一份注册机制、一份所有权账本」直接冲突。
  const tool: ModelTool = {
    kind: "model",
    name: "inline_via_options",
    label: "内联",
    description: "经 agent.tools 传进来的",
    parameters: { type: "object", properties: {} },
    execute: async () => toolOk("ok"),
  };
  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [],
    agent: { tools: [tool] },
  });
  running.push(echo);

  // ① 工具真的在（易用性没丢）
  expect(echo.agent.tools.has("inline_via_options")).toBe(true);
  // ② **而且进了账本**：清单里看得见，说明它有 owner
  expect(echo.extensions.map((e) => e.name)).toContain("echo:inline-tools");
  // ③ 卸载时跟着下线——直接注册的做不到这一点
  await echo.stop();
  expect(echo.agent.tools.has("inline_via_options")).toBe(false);
});

test("公开清单 = Host 实际挂上的那一份（review 二轮 P1：上一版 `echo:agent` 装了却没进清单）", async () => {
  // 上一版 `createEcho()` 自己算一份**不带 runtime** 的 entries 当公开清单，
  // 而 `mountBuiltinTools()` 内部另算一份**带 runtime** 的拿去 mount——
  // 于是 `echo:agent` 真的装上了、`echo.extensions` 里却没有。
  // **清单与真相分家是最难查的一类假绿**：看清单的人以为它不在。
  const echo = await createEcho({
    provider: scripted([textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [],
  });
  running.push(echo);

  // ① `echo:agent` 必须在清单里——它是壳子 inject 的那个 Service 的 provider
  expect(echo.extensions.map((e) => e.name)).toContain("echo:agent");

  // ② **完全相等**：清单里的每一条都真在 Host 上，Host 上的每一条也都在清单里。
  //    只断言「包含 echo:agent」不够——那样反过来（Host 多挂了没进清单的）仍抓不到。
  expect(echo.extensions.map((e) => e.entryId).sort()).toEqual([...BUILTIN_NAMES].sort());
});
