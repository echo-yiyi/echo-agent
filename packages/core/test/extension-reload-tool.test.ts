// `extension_reload`：模型自己触发的热部署（2026-09-14）。判据：`docs/decisions/implemented/2026-09-14-model-triggered-reload.md` 的验收表。
//
// 全部走 `createEcho()`。要证明的是**整条链**：工具登记 → run 收尾后重载 → 报告投进自己的 inbox → 下一个 run 自动开始、
// 模型在里面用上新工具。只断言「工具返回了 scheduled」不够——那证明不了后面三步有一步真的发生。

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOf, createEcho, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, FAKE_MODEL, scriptedStreamFn, type ScriptedTurn } from "../src/testing.ts";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { EXTENSION_RELOAD_NAME, renderReloadReport } from "../src/extension/reload-tool.ts";
import { toolOk } from "../src/tools/types.ts";
import type { Provider } from "../src/provider/types.ts";

process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

const ABI_PATH = join(import.meta.dir, "..", "src", "extension", "public.ts");
const TOOLS_PATH = join(import.meta.dir, "..", "src", "tools", "types.ts");

const temps: string[] = [];
const running: Echo[] = [];
afterEach(async () => {
  for (const echo of running.splice(0)) await echo.stop().catch(() => {});
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "echo-reload-tool-"));
  temps.push(dir);
  return dir;
}

function extensionSource(name: string, value: string): string {
  return [
    `import { defineExtension, AgentTools } from ${JSON.stringify(ABI_PATH)};`,
    `import { toolOk } from ${JSON.stringify(TOOLS_PATH)};`,
    "export default defineExtension({",
    `  name: ${JSON.stringify(name)},`,
    "  hostAbiVersion: 1,",
    '  reload: "run",',
    "  inject: { tools: { service: AgentTools, required: true } },",
    "  apply(ctx) {",
    "    const tools = ctx.get(AgentTools);",
    `    void ctx.effect({ boundary: "turn", start: () => ({ value: ${JSON.stringify(name)}, dispose: tools.register({ kind: "model", name: ${JSON.stringify(name)}, label: "t", description: "t", parameters: { type: "object", properties: {} }, execute: async () => toolOk(${JSON.stringify(value)}) }) }) });`,
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

async function echoAt(dir: string, turns: ScriptedTurn[]): Promise<Echo> {
  const echo = await createEcho({
    provider: scripted(turns),
    allowNetwork: false,
    withoutMemory: true, // 提取子循环会吃脚本（extension-reload.test.ts 同款）
    stateDir: join(await tmp(), "state"),
    extensionDirs: [dir],
  });
  running.push(echo);
  return echo;
}

/** 等一个条件成立（run 2 是自主起的，`send()` 返回时它还没开始）。 */
async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等了 ${ms}ms 还没等到：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ───────────── ① 整条链 ───────────── */

test("模型调 extension_reload → 本 run 收尾后重载 → 报告投进自己的 inbox → run 2 自动开始，模型用上新版工具", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  const file = join(dir, "hello.ts");
  await writeFile(file, extensionSource("hello", "v1"));
  const echo = await echoAt(dir, [
    toolTurn("c1", EXTENSION_RELOAD_NAME, {}), // run 1：模型登记重载
    textTurn("scheduled; finishing this reply"),
    toolTurn("c2", "hello", {}), // run 2（inbox 起的）：模型拿着报告去调新工具
    textTurn("saw v2"),
  ]);
  await echo.start();
  expect(echo.extensions.map((e) => e.name)).toContain("echo:reload");

  await writeFile(file, extensionSource("hello", "v2"));
  const r1 = await echo.send("我改好了 hello.ts，重载一下");
  expect(r1.outcome.kind).toBe("completed");
  const scheduled = agentOf(echo).messages.find((m) => m.role === "toolResult");
  expect(scheduled?.isError).not.toBe(true);
  expect(JSON.stringify(scheduled?.content)).toContain("Scheduled");

  // run 2 是系统自己起的：等它跑完（第二条 toolResult 落进 transcript）
  await waitFor(() => agentOf(echo).messages.filter((m) => m.role === "toolResult").length === 2, "run 2 的工具调用");
  const report = agentOf(echo).messages.find((m) => m.role === "environment" && m.source === "echo:reload");
  expect(report).toBeDefined();
  const text = JSON.stringify(report!.content);
  expect(text).toContain("replaced");
  expect(text).toContain("hello.ts");
  expect(text).toContain("Tools now available");
  expect(text).toContain("hello");
  const second = agentOf(echo).messages.filter((m) => m.role === "toolResult")[1]!;
  expect(second.isError).not.toBe(true);
  expect(JSON.stringify(second.content)).toContain("v2");
  expect(echo.diagnostics).toEqual([]);
});

/* ───────────── ② 同一 run 里登记两次 ───────────── */

test("同一 run 里调两次 → 第二次 toolError「已经登记过」；重载仍只做一次", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  await writeFile(join(dir, "hello.ts"), extensionSource("hello", "v1"));
  const echo = await echoAt(dir, [
    toolTurn("c1", EXTENSION_RELOAD_NAME, {}),
    toolTurn("c2", EXTENSION_RELOAD_NAME, {}),
    textTurn("done"),
    textTurn("run 2: nothing to do"), // 报告到达后起的 run 2
  ]);
  await echo.start();
  const r = await echo.send("重载两次");
  expect(r.outcome.kind).toBe("completed");
  const results = agentOf(echo).messages.filter((m) => m.role === "toolResult");
  expect(results.length).toBe(2);
  expect(results[0]!.isError).not.toBe(true);
  expect(results[1]!.isError).toBe(true);
  expect(JSON.stringify(results[1]!.content)).toContain("已经登记过");
  await waitFor(() => agentOf(echo).messages.some((m) => m.role === "environment" && m.source === "echo:reload"), "报告");
  expect(agentOf(echo).messages.filter((m) => m.role === "environment" && m.source === "echo:reload").length).toBe(1);
});

/* ───────────── ③ ④ 边界 ───────────── */

test("run 外 afterRun() → rejected；低层 mountBuiltinTools() 路径没有 echo:reload（能力不在就不出条目）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const r = agent.afterRun(async () => {});
  expect(r.kind).toBe("rejected");
  expect((r as { reason: string }).reason).toContain("没有进行中的 run");

  const host = await mountBuiltinTools(agent);
  expect(host.inspect().map((f) => f.entryId)).not.toContain("echo:reload");
  expect(agent.tools.has(EXTENSION_RELOAD_NAME)).toBe(false);
  await agent.dispose();
});

/* ───────────── ⑤ 登记后立刻收摊 ───────────── */

test("登记之后、run 还没收尾就 stop() → 收尾时重载被拒、报告投不进：记一条诊断，不抛，没有 run 2", async () => {
  const dir = join(await tmp(), "extensions");
  await mkdir(dir);
  await writeFile(join(dir, "hello.ts"), extensionSource("hello", "v1"));
  // 用一件卡住的工具把 run 1 按在收尾之前：`send()` 一返回重载链就会去抢 permit，
  // 那时 stop() 谁先谁后没有保证——要的是「收尾发生在 stopping 里」这个确定的形状
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const enteredBlock = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const echo = await createEcho({
    provider: scripted([toolTurn("c1", EXTENSION_RELOAD_NAME, {}), toolTurn("c2", "block", {}), textTurn("done"), textTurn("must not run")]),
    allowNetwork: false,
    withoutMemory: true,
    stateDir: join(await tmp(), "state"),
    extensionDirs: [dir],
    agent: {
      tools: [
        {
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
        },
      ],
    },
  });
  running.push(echo);
  await echo.start();

  const inFlight = echo.send("重载");
  await enteredBlock; // extension_reload 已登记，run 1 卡在 block 里
  const stopping = echo.stop();
  release();
  await inFlight.catch(() => {});
  await stopping; // 不抛
  await new Promise((r) => setTimeout(r, 50));

  expect(agentOf(echo).messages.some((m) => m.role === "environment" && m.source === "echo:reload")).toBe(false); // 没有 run 2
  expect(echo.diagnostics.map((d) => d.code)).not.toContain("after_run_work_failed"); // 收尾的活自己兜住了
  expect(echo.diagnostics.map((d) => d.code)).toContain("extension_reload_report_undelivered"); // 报告投不进：如实记下
});

/* ───────────── 报告正文 ───────────── */

test("renderReloadReport：一行一个变了的，没变的只计数，末尾列此刻的工具；rejected 让模型再调一次", () => {
  const done = renderReloadReport(
    {
      kind: "done",
      report: {
        changes: [
          { kind: "unchanged", file: "/x/a.ts" },
          { kind: "replaced", file: "/x/b.ts" },
          { kind: "refused", file: "/x/c.ts", reason: "没声明 reload" },
        ],
      },
    },
    ["hello", "word_count"],
  );
  expect(done.split("\n")).toEqual([
    "Extension reload finished.",
    "- replaced /x/b.ts",
    "- refused /x/c.ts — 没声明 reload",
    "- 1 extension(s) unchanged",
    "Tools now available: hello, word_count.",
  ]);
  expect(renderReloadReport({ kind: "done", report: { changes: [{ kind: "unchanged", file: "/x/a.ts" }] } }, [])).toContain("nothing changed (1 extension(s) unchanged)");
  expect(renderReloadReport({ kind: "rejected", reason: "正在跑" }, [])).toBe("Extension reload did not run: 正在跑. Call extension_reload again when you are ready.");
});
