// `echo-agent observe serve`：本地只读面板。判据：页面自足（token + 术语表内联）、三条 JSON 路由出的是 reader 的真数据、
// 服务停得下来、`runObserve serve` 打 URL 并在 signal 之后以 0 退出。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, createProvider, createProviderStreams, openObservationReader, toolError, type Echo, type ModelTool, type Provider } from "@echo-agent/core";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "@echo-agent/core/testing";
import { OBSERVE_DEFAULT_PORT, parseObserveArgs, runObserve } from "../src/observe.ts";
import { observePageHtml, startObserveServer } from "../src/observe/server.ts";
import { lexicon } from "../src/observe/lexicon.ts";
import type { Sink } from "../src/run.ts";

let dir: string;
const running: Echo[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-observe-serve-"));
});
afterEach(async () => {
  for (const e of running.splice(0)) await e.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

function sink(): Sink & { text: string } {
  const box = {
    text: "",
    write(s: string) {
      box.text += s;
    },
  };
  return box;
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

async function echoAt(turns: ScriptedTurn[], extra: Partial<Parameters<typeof createEcho>[0]> = {}): Promise<Echo> {
  // `dir` 是**会话目录的上一层**（2026-09-03）：每段 session 一个状态根，观测库也跟着一段一份。
  const echo = await createEcho({ provider: scripted(turns), sessionsRoot: dir, allowNetwork: false, withoutMemory: true, extensionDirs: [], ...extra });
  running.push(echo);
  await echo.agent.start();
  return echo;
}

test("/api/runs 顺带给会话摘要：产品名与 workspace 按 sessionId 反查", async () => {
  // **观测库一段一份**（2026-09-03：状态根 = session 目录），所以一个 reader 只看得到那一段的 run。
  // 这条盯的仍是「反查得到」：会话摘要从 session 目录的**上一层**扫，所以面板里出现的
  // 任何 sessionId 都认得出产品名与 workspace——哪怕那一段不是本库这一段。
  const coding = await echoAt([textTurn("coding 说")], { agentName: "echo-coding", workspace: "/tmp/ws-coding" });
  const a = await coding.send("x");
  const codingId = coding.agent.state.sessionId!;
  await coding.stop();
  const general = await echoAt([textTurn("agent 说")], { agentName: "echo-agent", workspace: "/tmp/ws-general" });
  await general.send("y");
  const generalId = general.agent.state.sessionId!;

  const stateRoot = join(dir, codingId);
  const reader = await openObservationReader({ stateRoot });
  const server = startObserveServer({ reader, stateRoot, port: 0 });
  try {
    const page = (await (await fetch(`${server.url}/api/runs?limit=10`)).json()) as {
      items: { runId: string; sessionId: string | null }[];
      sessions: Record<string, { agent: string; workspace: string; name: string }>;
    };
    const runA = page.items.find((h) => h.runId === a.runId)!;
    expect(runA.sessionId).toBe(codingId);
    expect(page.sessions[codingId]).toMatchObject({ agent: "echo-coding", workspace: "/tmp/ws-coding" });
    // 只带这页用到的会话，不把整层的会话表都吐出去——另一段在盘上，但这页没用到它
    expect(Object.keys(page.sessions)).toEqual([codingId]);
    expect(generalId).not.toBe(codingId);
  } finally {
    await server.stop();
    await reader.close();
  }
});

test("content 档：/api/runs/<id> 的时间线带工具 params 与结果正文，页面有对应的分段渲染", async () => {
  const grep: ModelTool = {
    kind: "model",
    name: "grep",
    label: "grep",
    description: "搜",
    parameters: { type: "object", properties: { pattern: { type: "string" } } },
    execute: async () => toolError("grep: no matches for observationTap"),
  };
  const echo = await echoAt([toolTurn("c1", "grep", { pattern: "observationTap" }), textTurn("没搜到。")], { observation: { capture: "content" }, agent: { tools: [grep] } });
  const r = await echo.send("搜一下");
  const stateRoot = join(dir, echo.agent.state.sessionId!); // 观测库一段一份
  const reader = await openObservationReader({ stateRoot });
  const server = startObserveServer({ reader, stateRoot, port: 0 });
  try {
    const vm = (await (await fetch(`${server.url}/api/runs/${r.runId}`)).json()) as {
      header: { capturePolicy: string };
      timeline: { kind: string; name: string; body?: Record<string, unknown> }[];
    };
    expect(vm.header.capturePolicy).toBe("content");
    const start = vm.timeline.find((t) => t.kind === "span_start" && t.name === "tool.execute");
    const end = vm.timeline.find((t) => t.kind === "span_end" && t.name === "tool.execute");
    expect(start?.body?.params).toEqual({ pattern: "observationTap" });
    expect(end?.body).toMatchObject({ isError: true, content: "grep: no matches for observationTap" });
    expect(vm.timeline.some((t) => t.name === "model.generate.delta")).toBe(true);
  } finally {
    await server.stop();
    await reader.close();
  }
  // 页面侧：正文分段、delta 折叠、参数预览三件都在（渲染逻辑在浏览器里跑，这里只验它们没被删）
  const html = observePageHtml();
  for (const marker of ["contentSections", "FOLDED_INTO", "argPreview", "--observe content"]) expect(html).toContain(marker);
});

test("parseObserveArgs：serve 缺省端口与地址；--port 校验；--port / --host 只对 serve 有意义", () => {
  expect(parseObserveArgs(["serve"], "x")).toEqual({ command: { kind: "serve", port: OBSERVE_DEFAULT_PORT, host: "127.0.0.1" } });
  expect(parseObserveArgs(["serve", "--port", "0", "--host", "0.0.0.0", "--state-dir", "/s"], "x")).toEqual({ stateDir: "/s", command: { kind: "serve", port: 0, host: "0.0.0.0" } });
  expect(() => parseObserveArgs(["serve", "--port", "abc"], "x")).toThrow("--port 要");
  expect(() => parseObserveArgs(["serve", "--port", "70000"], "x")).toThrow("--port 要");
  expect(() => parseObserveArgs(["last", "--port", "1"], "x")).toThrow("只对 serve 有意义");
  expect(() => parseObserveArgs(["serve", "--format", "json"], "x")).toThrow("serve 没有");
});

test("术语表：每条四字段齐全，hint 不是同义反复", () => {
  const lex = lexicon();
  for (const group of [lex.runStatus, lex.runSource, lex.integrity, lex.persistence, lex.records]) {
    for (const [key, term] of Object.entries(group)) {
      expect(term.zh.length, key).toBeGreaterThan(0);
      expect(term.en.length, key).toBeGreaterThan(0);
      expect(["neutral", "accent", "positive", "caution", "critical", "info"], key).toContain(term.tone);
      expect(term.hint.length, key).toBeGreaterThan(6);
      expect(term.hint, key).not.toBe(term.zh);
    }
  }
  // 终态五值 + running 都有；截停与完成是两个词
  expect(lex.runStatus.completed!.zh).not.toBe(lex.runStatus.truncated!.zh);
  expect(Object.keys(lex.runStatus).sort()).toEqual(["aborted", "completed", "error", "interrupted", "running", "truncated"]);
});

test("页面自足：token CSS 与术语表内联，不引外部资源", () => {
  const html = observePageHtml();
  expect(html).toContain("<title>Echo · observe</title>");
  expect(html).toContain("--accent:"); // vendor 的 token 变量已注入
  expect(html).toContain('"runStatus"'); // 术语表已注入
  expect(html).not.toContain("/*__TOKENS__*/");
  expect(html).not.toContain("/*__LEXICON__*/");
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/); // 零外部资源
  // 页面自己的样式只用 token 变量：去掉注入的 token 段之后，不该再有裸 hex / 裸 oklch
  const own = html.replace(/\/\* Echo 编程[\s\S]*?\n}\n(?:[\s\S]*?\n}\n)*/, "");
  expect(own.split("<style>")[1]?.split("</style>")[0] ?? "").not.toMatch(/#[0-9a-fA-F]{3,6}\b|oklch\(/);
});

test("serve：/ 出页面，/api/runs、/api/runs/<id>、/api/health 出 reader 的真数据；未知 run 404；能停", async () => {
  const echo = await echoAt([textTurn("你好")]);
  const r = await echo.send("hi");
  const stateRoot = join(dir, echo.agent.state.sessionId!); // 观测库一段一份
  const reader = await openObservationReader({ stateRoot });
  const server = startObserveServer({ reader, stateRoot, port: 0 });
  try {
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
    const page = await fetch(`${server.url}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Echo · observe");

    const runs = (await (await fetch(`${server.url}/api/runs?limit=5`)).json()) as { items: { runId: string; status: string }[]; nextCursor: string | null };
    expect(runs.items.map((h) => h.runId)).toEqual([r.runId]);
    expect(runs.items[0]!.status).toBe("completed");

    const vm = (await (await fetch(`${server.url}/api/runs/${encodeURIComponent(r.runId)}`)).json()) as { header: { runId: string }; timeline: unknown[]; rendererVersion: number };
    expect(vm.header.runId).toBe(r.runId);
    expect(vm.rendererVersion).toBe(1);
    expect(vm.timeline.length).toBeGreaterThan(3);

    expect((await fetch(`${server.url}/api/runs/run:nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/runs`, { method: "POST" })).status).toBe(405);

    const health = (await (await fetch(`${server.url}/api/health`)).json()) as { stateRoot: string; counts: { runs: number }; heads: unknown[] };
    expect(health.stateRoot).toBe(stateRoot);
    expect(health.counts.runs).toBe(1);
    expect(health.heads.length).toBe(1);
  } finally {
    await server.stop();
    await reader.close();
  }
  // 停了就连不上
  await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
});

test("runObserve serve：打印 URL；signal abort 后关服务、关 reader，退出码 0", async () => {
  const echo = await echoAt([textTurn("一句")]);
  await echo.send("x");
  const controller = new AbortController();
  const out = sink();
  const err = sink();
  const exit = runObserve(["serve", "--port", "0", "--state-dir", dir], "echo-agent", { out, err, signal: controller.signal });
  for (let i = 0; i < 200 && !out.text.includes("observe 面板"); i++) await new Promise((r) => setTimeout(r, 10));
  const url = /http:\/\/[^\s（]+/.exec(out.text)?.[0];
  expect(url).toBeDefined();
  expect((await fetch(`${url}/api/health`)).status).toBe(200);
  controller.abort();
  expect(await exit).toBe(0);
  expect(err.text).toBe("");
  await expect(fetch(`${url}/api/health`)).rejects.toThrow();
});
