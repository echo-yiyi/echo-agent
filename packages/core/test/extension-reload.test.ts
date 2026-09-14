// 热部署（2026-09-14 用户拍板）的端到端判据：决策记录 `docs/decisions/implemented/2026-09-14-extension-hot-reload.md` 的验收表。
//
// 全部走 `createEcho()`（唯一 composition root），扩展是写进临时目录的真文件、真 import。
// **「换上了 ≠ 用得上」**（沿用 create-echo.test.ts 的口径）：只看清单里名字变了不够，
// 要让模型真的调一次那件工具、看 toolResult 里是新值。

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, discoverExtensionFiles, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { Provider } from "../src/provider/types.ts";
import type { ReloadReport } from "../src/extension/reload.ts";

process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

/** tmp 在 workspace 外，包名解析不了（create-echo.test.ts 实测），fixture 走绝对路径引 ABI。 */
const ABI_PATH = join(import.meta.dir, "..", "src", "extension", "public.ts");
const TOOLS_PATH = join(import.meta.dir, "..", "src", "tools", "types.ts");

const temps: string[] = [];
const running: Echo[] = [];
afterEach(async () => {
  for (const echo of running.splice(0)) await echo.stop().catch(() => {});
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "echo-reload-"));
  temps.push(dir);
  return dir;
}

/**
 * 一条只注册一件工具的扩展；工具返回 `value`。`valueExpr` 给的话直接当表达式（子目录 fixture 用它引 helper）。
 * 缺省声明 `reload: "run"`——不声明就是 ABI 的缺省 `agent`，在 run 边界会被拒（下面单独有一条测这个）；`reload: null` = 不写这一行。
 */
function extensionSource(name: string, value: string, opts: { reload?: string | null; valueExpr?: string; imports?: string } = {}): string {
  const reload = opts.reload === undefined ? "run" : opts.reload;
  return [
    `import { defineExtension, AgentTools } from ${JSON.stringify(ABI_PATH)};`,
    `import { toolOk } from ${JSON.stringify(TOOLS_PATH)};`,
    opts.imports ?? "",
    "export default defineExtension({",
    `  name: ${JSON.stringify(name)},`,
    "  hostAbiVersion: 1,",
    reload === null ? "" : `  reload: ${JSON.stringify(reload)},`,
    "  inject: { tools: { service: AgentTools, required: true } },",
    "  apply(ctx) {",
    "    const tools = ctx.get(AgentTools);",
    "    void ctx.effect({",
    '      boundary: "turn",',
    `      start: () => ({ value: ${JSON.stringify(name)}, dispose: tools.register({ kind: "model", name: ${JSON.stringify(name)}, label: "t", description: "t", parameters: { type: "object", properties: {} }, execute: async () => toolOk(${opts.valueExpr ?? JSON.stringify(value)}) }) }),`,
    "    });",
    "  },",
    "});",
    "",
  ].join("\n");
}

function scripted(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

async function echoAt(opts: { dir: string; turns?: ScriptedTurn[]; tools?: ModelTool[] }): Promise<Echo> {
  const echo = await createEcho({
    provider: scripted(opts.turns ?? [textTurn("ok")]),
    allowNetwork: false,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [opts.dir],
    // 记忆提取的子循环在每条 reply 结束后自己调模型，会把脚本里留给下一次 send 的回复吃掉（实测：第二次 send 报「脚本用尽」）。
    // 这里不测记忆，关掉；要连记忆一起测的走 fixtures/resident-host.ts 那种按 EXTRACT_PROMPT_OPENING 单独作答的 provider。
    withoutMemory: true,
    ...(opts.tools === undefined ? {} : { agent: { tools: opts.tools } }),
  });
  running.push(echo);
  return echo;
}

/** 模型调一次 `toolName`，回它的 toolResult 文本。 */
async function callTool(echo: Echo): Promise<string> {
  const before = echo.agent.messages.length;
  const result = await echo.send("调一下");
  expect(result.outcome.kind).toBe("completed");
  const toolResults = echo.agent.messages.slice(before).filter((m) => m.role === "toolResult");
  expect(toolResults.length).toBe(1);
  expect(toolResults[0]!.isError).not.toBe(true);
  return JSON.stringify(toolResults[0]!.content);
}

function kinds(report: ReloadReport): Record<string, string> {
  return Object.fromEntries(report.changes.map((c) => [c.file, c.kind]));
}

async function snapshotsIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n.startsWith(".") && n.includes(".echo-")).sort();
}

/* ───────────── ① 改了 → replaced → 下一个 run 用新值，会话不断 ───────────── */

test("改 extensions/hello.ts → reloadExtensions 报 replaced → 模型调 hello 拿到新值；session id 不变；清单里仍只有一条", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "hello.ts");
  await writeFile(file, extensionSource("hello", "v1"));
  const echo = await echoAt({ dir, turns: [toolTurn("c1", "hello", {}), textTurn("ok")] });
  await echo.start();
  const sessionBefore = echo.agent.state.sessionId;
  expect(echo.extensions.filter((e) => e.file !== undefined).map((e) => e.name)).toEqual(["hello"]);

  await writeFile(file, extensionSource("hello", "v2"));
  const r = await echo.reloadExtensions();
  expect(r.kind).toBe("done");
  expect(kinds((r as { report: ReloadReport }).report)).toEqual({ [file]: "replaced" });

  expect(await callTool(echo)).toContain("v2");
  expect(echo.agent.state.sessionId).toBe(sessionBefore);
  expect(echo.extensions.filter((e) => e.file !== undefined)).toEqual([{ entryId: file, name: "hello", file }]);
  expect(echo.diagnostics).toEqual([]);
});

test("内容没变 → unchanged，**不重新加载**（同一份代码不求值第二次）", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "hello.ts");
  await writeFile(file, extensionSource("hello", "v1"));
  const echo = await echoAt({ dir });
  await echo.start();

  const r = await echo.reloadExtensions();
  expect(kinds((r as { report: ReloadReport }).report)).toEqual({ [file]: "unchanged" });
  // 没重新加载的证据：目录里没有快照副本（重新加载一定会复制一份）
  expect(await snapshotsIn(dir)).toEqual([]);
});

/* ───────────── ② 改坏了 → rolled_back，旧版仍在，诊断多一条 ───────────── */

test("改成语法错 → rolled_back，旧版工具照用；诊断里有它一条；修好后再 reload → replaced、诊断清掉", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "hello.ts");
  await writeFile(file, extensionSource("hello", "v1"));
  const echo = await echoAt({ dir, turns: [toolTurn("c1", "hello", {}), textTurn("ok"), toolTurn("c2", "hello", {}), textTurn("ok")] });
  await echo.start();

  await writeFile(file, "export default defineExtension({ this is not ts\n");
  const bad = await echo.reloadExtensions();
  expect(bad.kind).toBe("done");
  const change = (bad as { report: ReloadReport }).report.changes[0]!;
  expect(change.kind).toBe("rolled_back");
  expect(await callTool(echo)).toContain("v1");
  expect(echo.diagnostics.map((d) => [d.code, d.path])).toEqual([["extension_load_failed", file]]);
  // 坏那次的快照副本已经清掉，只留……什么都不留：boot 代是从原路径加载的
  expect(await snapshotsIn(dir)).toEqual([]);

  await writeFile(file, extensionSource("hello", "v3"));
  const good = await echo.reloadExtensions();
  expect(kinds((good as { report: ReloadReport }).report)).toEqual({ [file]: "replaced" });
  expect(await callTool(echo)).toContain("v3");
  expect(echo.diagnostics).toEqual([]);
});

test("apply 抛（mount 失败）→ rolled_back：旧版**卸了再装回来**，工具还在", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "hello.ts");
  await writeFile(file, extensionSource("hello", "v1"));
  const echo = await echoAt({ dir });
  await echo.start();

  await writeFile(
    file,
    `import { defineExtension } from ${JSON.stringify(ABI_PATH)};\nexport default defineExtension({ name: "hello", hostAbiVersion: 1, apply() { throw new Error("v2 apply 炸了"); } });\n`,
  );
  const r = await echo.reloadExtensions();
  const change = (r as { report: ReloadReport }).report.changes[0]!;
  expect(change.kind).toBe("rolled_back");
  expect((change as { reason: string }).reason).toContain("v2 apply 炸了");
  expect(echo.agent.tools.has("hello")).toBe(true);
  expect(echo.diagnostics.map((d) => d.code)).toEqual(["extension_mount_failed"]);
});

/* ───────────── ③ run 进行中 → rejected，不排队 ───────────── */

test("run 进行中调 reloadExtensions → rejected（仅 idle 可换，不排队）；run 结束后能换", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "hello.ts");
  await writeFile(file, extensionSource("hello", "v1"));

  let release: () => void = () => {};
  let entered: () => void = () => {};
  const enteredTool = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const block: ModelTool = {
    kind: "model",
    name: "block",
    label: "block",
    description: "卡住直到测试放行",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      entered();
      await gate;
      return toolOk("released");
    },
  };
  const echo = await echoAt({ dir, turns: [toolTurn("c1", "block", {}), textTurn("ok")], tools: [block] });
  await echo.start();

  const inFlight = echo.send("卡住");
  await enteredTool;
  await writeFile(file, extensionSource("hello", "v2"));
  const busy = await echo.reloadExtensions();
  expect(busy.kind).toBe("rejected");
  expect((busy as { reason: string }).reason).toContain("正在处理");
  // 没动：旧代还在，也没留下快照
  expect(await snapshotsIn(dir)).toEqual([]);

  release();
  await inFlight;
  const r = await echo.reloadExtensions();
  expect(kinds((r as { report: ReloadReport }).report)).toEqual({ [file]: "replaced" });
});

/* ───────────── ④ 删了 → removed；新加 → added；上次坏着这次修好 → added ───────────── */

test("删掉文件 → removed，工具没了、清单里没了；新加文件 → added，工具有了", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const hello = join(dir, "hello.ts");
  await writeFile(hello, extensionSource("hello", "v1"));
  const echo = await echoAt({ dir });
  await echo.start();
  expect(echo.agent.tools.has("hello")).toBe(true);

  await rm(hello);
  const bye = join(dir, "bye.ts");
  await writeFile(bye, extensionSource("bye", "b1"));
  const r = await echo.reloadExtensions();
  expect(kinds((r as { report: ReloadReport }).report)).toEqual({ [bye]: "added", [hello]: "removed" });
  expect(echo.agent.tools.has("hello")).toBe(false);
  expect(echo.agent.tools.has("bye")).toBe(true);
  expect(echo.extensions.filter((e) => e.file !== undefined).map((e) => e.name)).toEqual(["bye"]);
});

test("启动时就坏着的文件（诊断里有）修好后 reload → added，诊断清掉；还坏着 → failed", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "hello.ts");
  await writeFile(file, 'throw new Error("启动时就坏");\n');
  const echo = await echoAt({ dir });
  await echo.start();
  expect(echo.diagnostics.map((d) => d.code)).toEqual(["extension_load_failed"]);
  expect(echo.extensions.filter((e) => e.file !== undefined)).toEqual([]);

  await writeFile(file, 'throw new Error("还是坏的");\n');
  const still = await echo.reloadExtensions();
  const change = (still as { report: ReloadReport }).report.changes[0]!;
  expect(change.kind).toBe("failed");
  expect((change as { reason: string }).reason).toContain("还是坏的");
  expect(echo.diagnostics.length).toBe(1); // 按路径替换，不累加

  await writeFile(file, extensionSource("hello", "v1"));
  const fixed = await echo.reloadExtensions();
  expect(kinds((fixed as { report: ReloadReport }).report)).toEqual({ [file]: "added" });
  expect(echo.agent.tools.has("hello")).toBe(true);
  expect(echo.diagnostics).toEqual([]);
});

/* ───────────── ⑤ 子目录扩展：改的是 helper，入口没动 → 也算变了、新值生效 ───────────── */

test("子目录扩展只改 helper.ts（入口没动）→ replaced，新值生效——子目录整棵复制，相对依赖跟着刷", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(join(dir, "pack"), { recursive: true });
  const entry = join(dir, "pack", "index.ts");
  await writeFile(join(dir, "pack", "helper.ts"), 'export const VALUE = "h1";\n');
  await writeFile(entry, extensionSource("pack", "", { valueExpr: "VALUE", imports: 'import { VALUE } from "./helper.ts";' }));
  const echo = await echoAt({ dir, turns: [toolTurn("c1", "pack", {}), textTurn("ok")] });
  await echo.start();

  await writeFile(join(dir, "pack", "helper.ts"), 'export const VALUE = "h2";\n');
  const r = await echo.reloadExtensions();
  expect(kinds((r as { report: ReloadReport }).report)).toEqual({ [entry]: "replaced" });
  expect(await callTool(echo)).toContain("h2");
  // 快照是整个子目录的副本：`.pack.echo-<pid>-<n>/`
  const snaps = await snapshotsIn(dir);
  expect(snaps.length).toBe(1);
  expect(snaps[0]).toMatch(/^\.pack\.echo-\d+-\d+$/);
});

/* ───────────── ⑥ 声明 reload: "agent" → refused，要重启 ───────────── */

test('声明 reload: "agent" 的扩展 → refused（要换只能重启 Agent），旧版照用', async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "sticky.ts");
  await writeFile(file, extensionSource("sticky", "v1", { reload: "agent" }));
  const echo = await echoAt({ dir, turns: [toolTurn("c1", "sticky", {}), textTurn("ok")] });
  await echo.start();

  await writeFile(file, extensionSource("sticky", "v2", { reload: "agent" }));
  const r = await echo.reloadExtensions();
  const change = (r as { report: ReloadReport }).report.changes[0]!;
  expect(change.kind).toBe("refused");
  expect((change as { reason: string }).reason).toContain("重启 Agent");
  expect(await callTool(echo)).toContain("v1");
  expect(await snapshotsIn(dir)).toEqual([]); // 拒绝之后新版的快照也清掉
});

test("没声明 reload 的扩展（ABI 缺省 agent）→ refused，报文告诉作者加哪一行", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "plain.ts");
  await writeFile(file, extensionSource("plain", "v1", { reload: null }));
  const echo = await echoAt({ dir });
  await echo.start();

  await writeFile(file, extensionSource("plain", "v2", { reload: null }));
  const r = await echo.reloadExtensions();
  const change = (r as { report: ReloadReport }).report.changes[0]!;
  expect(change.kind).toBe("refused");
  expect((change as { reason: string }).reason).toContain("没声明 reload（缺省 'agent'）");
  expect((change as { reason: string }).reason).toContain('声明 reload: "run"');
  expect(echo.agent.tools.has("plain")).toBe(true);
});

/* ───────────── 快照的账：换代后只留当前那份；收摊全清；发现时跳过 ───────────── */

test("快照：连换两次只留最新一份；stop() 之后目录里一个都不剩；发现规则跳过快照命名", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "hello.ts");
  await writeFile(file, extensionSource("hello", "v1"));
  const echo = await echoAt({ dir });
  await echo.start();

  await writeFile(file, extensionSource("hello", "v2"));
  await echo.reloadExtensions();
  await writeFile(file, extensionSource("hello", "v3"));
  await echo.reloadExtensions();
  const snaps = await snapshotsIn(dir);
  expect(snaps.length).toBe(1);
  expect(snaps[0]).toMatch(/^\.hello\.echo-\d+-\d+\.ts$/);
  // 快照不是第二个扩展：发现规则看不见它
  expect(await discoverExtensionFiles(dir)).toEqual([file]);

  await echo.stop();
  expect(await snapshotsIn(dir)).toEqual([]);
});

/* ───────────── 低层装配没有这项能力：如实 rejected ───────────── */

test("没有扩展目录的装配（extensionDirs: []）reload 照样能调：报告为空，不是错", async () => {
  const echo = await echoAt({ dir: join(await tmp(), "nope") });
  await echo.start();
  const r = await echo.reloadExtensions();
  expect(r).toEqual({ kind: "done", report: { changes: [] } });
});
