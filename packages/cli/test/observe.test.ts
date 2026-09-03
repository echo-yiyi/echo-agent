// `echo-agent observe`（§15.6 CLI 最小面）：四条子命令只走 `openObservationReader()`。
// 判据：真 createEcho 跑一轮落盘 → 进程内调 `runObserve()` 读回来；活 writer 旁边也能读；没库时诚实报错。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, createProvider, createProviderStreams, observationDatabasePath, type Echo, type Provider } from "@echo-agent/core";
import { scriptedDialect, textTurn, type ScriptedTurn } from "@echo-agent/core/testing";
import { parseObserveArgs, runObserve, type ObserveIo } from "../src/observe.ts";
import { mainFor } from "../src/cli.ts";
import { ECHO_AGENT } from "../src/product.ts";
import { run, type Sink } from "../src/run.ts";

let dir: string;
const running: Echo[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-observe-"));
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

function io(): ObserveIo & { out: ReturnType<typeof sink>; err: ReturnType<typeof sink> } {
  return { out: sink(), err: sink() };
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

async function echoAt(turns: ScriptedTurn[]): Promise<Echo> {
  const echo = await createEcho({ provider: scripted(turns), stateDir: dir, allowNetwork: false, withoutMemory: true, extensionDirs: [] });
  running.push(echo);
  await echo.agent.start();
  return echo;
}

test("parseObserveArgs：四条子命令、选项、帮助；不认识的一律 throw", () => {
  expect(parseObserveArgs([], "x")).toBeNull();
  expect(parseObserveArgs(["--help"], "x")).toBeNull();
  expect(parseObserveArgs(["last"], "x")).toEqual({ command: { kind: "last", format: "text", body: false } });
  expect(parseObserveArgs(["show", "run:1", "--body", "--state-dir", "/s", "--agent-id", "a"], "x")).toEqual({
    stateDir: "/s",
    agentId: "a",
    command: { kind: "show", runId: "run:1", format: "text", body: true },
  });
  expect(parseObserveArgs(["export", "run:1"], "x")).toEqual({ command: { kind: "export", runId: "run:1", format: "json" } });
  expect(parseObserveArgs(["export", "run:1", "--format", "text"], "x")).toEqual({ command: { kind: "export", runId: "run:1", format: "text" } });
  expect(parseObserveArgs(["health"], "x")).toEqual({ command: { kind: "health" } });
  expect(() => parseObserveArgs(["bogus"], "x")).toThrow("不认识的子命令");
  expect(() => parseObserveArgs(["show"], "x")).toThrow("需要 1 个参数");
  expect(() => parseObserveArgs(["last", "--format", "yaml"], "x")).toThrow("只认 text | json");
  expect(() => parseObserveArgs(["last", "--nope"], "x")).toThrow("不认识的选项");
  expect(() => parseObserveArgs(["health", "--format", "json"], "x")).toThrow("health 没有");
});

test("没有库：退出码 1，说清库在哪、为什么没有；不建库", async () => {
  const o = io();
  expect(await runObserve(["last", "--state-dir", dir], "echo-agent", o)).toBe(1);
  expect(o.err.text).toContain("还没有任何 run");
  expect(o.err.text).toContain(observationDatabasePath(dir));
  expect(existsSync(observationDatabasePath(dir))).toBe(false);
});

test("last / show / export / health：跑一轮落盘后都读得到；stop 之后也读得到", async () => {
  const echo = await echoAt([textTurn("你好")]);
  const result = await echo.send("hi");
  expect(result.observationPersistence).toBe("stored");

  // 活 writer 旁边读（agent 还没 stop）
  const last = io();
  expect(await runObserve(["last", "--state-dir", dir], "echo-agent", last)).toBe(0);
  expect(last.out.text.startsWith(`Run ${result.runId} · completed · observation complete · `)).toBe(true);
  expect(last.out.text).toContain("Observation Health");
  expect(last.err.text).toBe("");

  const show = io();
  expect(await runObserve(["show", result.runId, "--state-dir", dir, "--body"], "echo-agent", show)).toBe(0);
  expect(show.out.text).toContain("body {");

  const exported = io();
  expect(await runObserve(["export", result.runId, "--state-dir", dir], "echo-agent", exported)).toBe(0);
  const json = JSON.parse(exported.out.text) as { header: { runId: string }; rendererVersion: number };
  expect(json.header.runId).toBe(result.runId);
  expect(json.rendererVersion).toBe(1);

  const health = io();
  expect(await runObserve(["health", "--state-dir", dir], "echo-agent", health)).toBe(0);
  expect(health.out.text).toContain(`observation database  ${observationDatabasePath(dir)}`);
  expect(health.out.text).toContain("runs                  1 ·");
  expect(health.out.text).toContain(`last run              ${result.runId} · completed`);
  expect(health.out.text).toContain("not persisted yet");

  const missing = io();
  expect(await runObserve(["show", "run:nope", "--state-dir", dir], "echo-agent", missing)).toBe(1);
  expect(missing.err.text).toContain("没有这条 run");

  await echo.stop();
  const after = io();
  expect(await runObserve(["show", result.runId, "--state-dir", dir], "echo-agent", after)).toBe(0);
  expect(after.out.text).toContain(result.runId);
});

test("main：`observe` 在一切启动逻辑之前分走——不装配、不取锁、不看凭据", async () => {
  const echo = await echoAt([textTurn("一句")]);
  const r = await echo.send("x");
  await echo.stop();
  // 主命令的形态判断、凭据检查都不该被触发：这里没有 provider 凭据，非交互形态本该以 1 退出并抱怨凭据
  const code = await mainFor(ECHO_AGENT)(["observe", "show", r.runId, "--state-dir", dir], false);
  expect(code).toBe(0);
  expect(existsSync(join(dir, ".lock")), "observe 不许取锁").toBe(false);
  expect(await mainFor(ECHO_AGENT)(["observe", "bogus"], false)).toBe(2);
});

test("管道形态：每轮结束在 err 打 `[run] <run-id> …`，正文不受影响", async () => {
  const echo = await createEcho({ provider: scripted([textTurn("正文")]), stateDir: dir, allowNetwork: false, withoutMemory: true, extensionDirs: [] });
  const out = sink();
  const err = sink();
  expect(await run({ echo, input: ["hi"], out, err })).toBe(0);
  expect(out.text).toContain("正文");
  expect(out.text).not.toContain("[run]");
  const line = err.text.split("\n").find((l) => l.startsWith("[run] run:"));
  expect(line).toBeDefined();
  expect(line).toContain("· observation complete · stored");
  // 打出来的 runId 拿去 observe show 就能看
  const runId = line!.slice("[run] ".length).split(" ")[0]!;
  const o = io();
  expect(await runObserve(["show", runId, "--state-dir", dir], "echo-agent", o)).toBe(0);
});
