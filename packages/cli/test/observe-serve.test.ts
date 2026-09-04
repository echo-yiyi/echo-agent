// `echo-agent observe serve`：本地只读面板。判据：页面自足（token + 术语表内联）、三条 JSON 路由出的是 reader 的真数据、
// 服务停得下来、`runObserve serve` 打 URL 并在 signal 之后以 0 退出。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, createProvider, createProviderStreams, openObservationReader, type Echo, type Provider } from "@echo-agent/core";
import { scriptedDialect, textTurn, type ScriptedTurn } from "@echo-agent/core/testing";
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

async function echoAt(turns: ScriptedTurn[], identity: { agentName?: string; workspace?: string } = {}): Promise<Echo> {
  const echo = await createEcho({ provider: scripted(turns), stateDir: dir, allowNetwork: false, withoutMemory: true, extensionDirs: [], ...identity });
  running.push(echo);
  await echo.agent.start();
  return echo;
}

test("/api/runs 顺带给会话摘要：产品名与 workspace 按 sessionId 反查，两个产品共用一个状态根也分得开", async () => {
  const coding = await echoAt([textTurn("coding 说")], { agentName: "echo-coding", workspace: "/tmp/ws-coding" });
  const a = await coding.send("x");
  await coding.stop();
  const general = await echoAt([textTurn("agent 说")], { agentName: "echo-agent", workspace: "/tmp/ws-general" });
  const b = await general.send("y");
  const reader = await openObservationReader({ stateRoot: dir });
  const server = startObserveServer({ reader, stateRoot: dir, port: 0 });
  try {
    const page = (await (await fetch(`${server.url}/api/runs?limit=10`)).json()) as {
      items: { runId: string; sessionId: string | null }[];
      sessions: Record<string, { agent: string; workspace: string; name: string }>;
    };
    const runA = page.items.find((h) => h.runId === a.runId)!;
    const runB = page.items.find((h) => h.runId === b.runId)!;
    expect(runA.sessionId).not.toBeNull();
    expect(runB.sessionId).not.toBeNull();
    expect(runA.sessionId).not.toBe(runB.sessionId);
    expect(page.sessions[runA.sessionId!]).toMatchObject({ agent: "echo-coding", workspace: "/tmp/ws-coding" });
    expect(page.sessions[runB.sessionId!]).toMatchObject({ agent: "echo-agent", workspace: "/tmp/ws-general" });
    // 只带这页用到的会话，不把整个状态根的会话表都吐出去
    expect(Object.keys(page.sessions).sort()).toEqual([runA.sessionId!, runB.sessionId!].sort());
  } finally {
    await server.stop();
    await reader.close();
  }
});

test("parseObserveArgs：serve 缺省端口与地址；--port 校验；--port / --host 只对 serve 有意义", () => {
  expect(parseObserveArgs(["serve"], "x")).toEqual({ command: { kind: "serve", port: OBSERVE_DEFAULT_PORT, host: "127.0.0.1" } });
  expect(parseObserveArgs(["serve", "--port", "0", "--host", "0.0.0.0", "--state-dir", "/s"], "x")).toEqual({ stateDir: "/s", command: { kind: "serve", port: 0, host: "0.0.0.0" } });
  expect(() => parseObserveArgs(["serve", "--port", "abc"], "x")).toThrow("--port 要");
  expect(() => parseObserveArgs(["serve", "--port", "70000"], "x")).toThrow("--port 要");
  expect(() => parseObserveArgs(["last", "--port", "1"], "x")).toThrow("只对 serve 有意义");
  expect(() => parseObserveArgs(["serve", "--format", "json"], "x")).toThrow("serve 没有");
});

test("术语表：每条四字段齐全，hint 不是同义反复（设计系统 §7）", () => {
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
  const reader = await openObservationReader({ stateRoot: dir });
  const server = startObserveServer({ reader, stateRoot: dir, port: 0 });
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
    expect(health.stateRoot).toBe(dir);
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
