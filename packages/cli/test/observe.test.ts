// `echo-agent observe`（CLI 最小面）：四条子命令只走 `openObservationReader()`。
// 判据：真 createEcho 跑一轮落盘 → 进程内调 `runObserve()` 读回来；活 writer 旁边也能读；没库时诚实报错。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, createProvider, createProviderStreams, observationDatabasePath, type Echo, type Provider } from "@echo-agent/core";
import { scriptedDialect, textTurn, type ScriptedTurn } from "@echo-agent/core/testing";
import { parseObserveArgs, runObserve, type ObserveIo } from "@echo-agent/base";
import { mainFor } from "@echo-agent/base";
import { terminalShell } from "@echo-agent/tui";
import { ECHO_AGENT } from "../src/product.ts";
import { run, type Sink } from "@echo-agent/base";

// **user 层要隔离**（2026-09-03）：`stateDir` 只管这一段 session 的目录，记忆与技能在 ECHO_HOME 下，
// 不设它就会读到开发机上真的 `~/.echo/skills`——实测过 skill 池莫名多出一条。
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

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

// `dir` 是**会话目录的上一层**（2026-09-03）：观测库归 session，所以 `observe --state-dir <上一层>`
// 不点名时看的是最近更新的那一段。
async function echoAt(turns: ScriptedTurn[]): Promise<Echo> {
  const echo = await createEcho({ provider: scripted(turns), sessionsRoot: dir, allowNetwork: false, withoutMemory: true, extensionDirs: [] });
  running.push(echo);
  await echo.agent.start();
  return echo;
}

test("parseObserveArgs：四条子命令、选项、帮助；不认识的一律 throw", () => {
  expect(parseObserveArgs([], "x")).toBeNull();
  expect(parseObserveArgs(["--help"], "x")).toBeNull();
  expect(parseObserveArgs(["last"], "x")).toEqual({ command: { kind: "last", format: "text", body: false } });
  expect(parseObserveArgs(["show", "run:1", "--body", "--state-dir", "/s", "--session", "s-1"], "x")).toEqual({
    stateDir: "/s",
    sessionId: "s-1",
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

test("一段会话都没有：退出码 1，说清看的是哪儿；不建库", async () => {
  // 观测库归 session（2026-09-03），所以「没有库」之前先有一问：看哪一段。一段都没有时
  // 要诚实说没有会话，而不是打开一个空目录再报「没有记录」——那两句话指的不是同一件事。
  const o = io();
  expect(await runObserve(["last", "--state-dir", dir], "echo-agent", o)).toBe(1);
  expect(o.err.text).toContain("还没有任何会话");
  expect(o.err.text).toContain(dir);
  expect(existsSync(observationDatabasePath(dir))).toBe(false);
});

test("点名一段不存在的会话：退出码 1，说清库在哪、为什么没有；不建库", async () => {
  const o = io();
  expect(await runObserve(["last", "--state-dir", dir, "--session", "s-nope"], "echo-agent", o)).toBe(1);
  expect(o.err.text).toContain("还没有任何 run");
  expect(o.err.text).toContain(observationDatabasePath(join(dir, "s-nope")));
  expect(existsSync(observationDatabasePath(join(dir, "s-nope")))).toBe(false);
});

test("一段的观测库打不开：health 跳过它并报原因，其余会话照看、退出 0（review 2026-09-07：此前整个 observe 对全部会话失败，已开的 reader 也没人关）", async () => {
  const echo = await echoAt([textTurn("你好")]);
  await echo.send("hi");
  const good = echo.agent.state.sessionId!;
  await echo.stop();
  // 一段登记在案（meta 照抄好的那段、只换 id）、但观测库是一坨坏字节的会话
  const badRoot = join(dir, "bad-session");
  mkdirSync(join(badRoot, "observability"), { recursive: true });
  const meta = JSON.parse(readFileSync(join(dir, good, "meta.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(badRoot, "meta.json"), JSON.stringify({ ...meta, id: "bad-session" }));
  writeFileSync(observationDatabasePath(badRoot), "not a database");
  const h = io();
  expect(await runObserve(["health", "--state-dir", dir], "echo-agent", h)).toBe(0);
  expect(h.out.text).toContain(good);
  expect(h.err.text).toContain("bad-session");
  expect(h.err.text).toContain("跳过");
  // 点名那一段看的时候照旧如实报错
  const only = io();
  expect(await runObserve(["health", "--state-dir", dir, "--session", "bad-session"], "echo-agent", only)).toBe(1);
  expect(only.err.text).toContain("打不开观测库");
});

test("last / show / export / health：跑一轮落盘后都读得到；stop 之后也读得到", async () => {
  const echo = await echoAt([textTurn("你好")]);
  const result = await echo.send("hi");
  expect(result.observationPersistence).toBe("stored");
  const sid = echo.agent.state.sessionId!;

  // 活 writer 旁边读（agent 还没 stop）。**不点名也行**：meta 在 start() 那一刻就写了（2026-09-04），
  // 所以「最近更新的那一段」立刻就找得到。
  const last = io();
  expect(await runObserve(["last", "--state-dir", dir], "echo-agent", last)).toBe(0);
  expect(last.out.text.startsWith(`Run ${result.runId} · completed · observation complete · `)).toBe(true);
  expect(last.out.text).toContain("Observation Health");
  expect(last.err.text).toBe("");

  const show = io();
  expect(await runObserve(["show", result.runId, "--state-dir", dir, "--session", sid, "--body"], "echo-agent", show)).toBe(0);
  expect(show.out.text).toContain("body {");

  const exported = io();
  expect(await runObserve(["export", result.runId, "--state-dir", dir, "--session", sid], "echo-agent", exported)).toBe(0);
  const json = JSON.parse(exported.out.text) as { header: { runId: string }; rendererVersion: number };
  expect(json.header.runId).toBe(result.runId);
  expect(json.rendererVersion).toBe(1);

  const health = io();
  expect(await runObserve(["health", "--state-dir", dir, "--session", sid], "echo-agent", health)).toBe(0);
  expect(health.out.text).toContain(`observation database  ${observationDatabasePath(join(dir, sid))}`);
  expect(health.out.text).toContain("runs                  1 ·");
  expect(health.out.text).toContain(`last run              ${result.runId} · completed`);
  expect(health.out.text).toContain("not persisted yet");

  const missing = io();
  expect(await runObserve(["show", "run:nope", "--state-dir", dir, "--session", sid], "echo-agent", missing)).toBe(1);
  expect(missing.err.text).toContain("没有这条 run");

  await echo.stop();
  // stop 之后不点名也读得到：**缺省看最近更新的那一段**，落盘已经 settle
  const after = io();
  expect(await runObserve(["show", result.runId, "--state-dir", dir], "echo-agent", after)).toBe(0);
  expect(after.out.text).toContain(result.runId);
});

test("不点名 --session：show 按 run-id 跨会话找到，last 是全部会话里最近的一条，health 每段一块", async () => {
  const first = await echoAt([textTurn("一")]);
  const r1 = await first.send("1");
  const id1 = first.agent.state.sessionId!;
  await first.stop();
  const second = await echoAt([textTurn("二")]);
  const r2 = await second.send("2");
  const id2 = second.agent.state.sessionId!;
  expect(id1).not.toBe(id2);

  const show = io();
  expect(await runObserve(["show", r1.runId, "--state-dir", dir], "echo-agent", show)).toBe(0);
  expect(show.out.text).toContain(r1.runId);
  const last = io();
  expect(await runObserve(["last", "--state-dir", dir], "echo-agent", last)).toBe(0);
  expect(last.out.text.startsWith(`Run ${r2.runId} ·`)).toBe(true);
  const health = io();
  expect(await runObserve(["health", "--state-dir", dir], "echo-agent", health)).toBe(0);
  expect(health.out.text).toContain(`session               ${id1}`);
  expect(health.out.text).toContain(`session               ${id2}`);
  expect(health.out.text.split("observation database  ").length).toBe(3);
  // 点名就只看那一段：另一段的 run 找不到
  const other = io();
  expect(await runObserve(["show", r1.runId, "--state-dir", dir, "--session", id2], "echo-agent", other)).toBe(1);
  expect(other.err.text).toContain("没有这条 run");
});

test("main：`observe` 在一切启动逻辑之前分走——不装配、不取锁、不看凭据", async () => {
  const echo = await echoAt([textTurn("一句")]);
  const r = await echo.send("x");
  await echo.stop();
  // 锁目录在 stop() 放锁之后仍留着（当前代不删）；observe 若取过锁，里面会多出一代认领
  const lockDir = join(dir, echo.agent.state.sessionId!, ".lock");
  const before = readdirSync(lockDir).sort();
  // 主命令的形态判断、凭据检查都不该被触发：这里没有 provider 凭据，非交互形态本该以 1 退出并抱怨凭据
  const code = await mainFor(ECHO_AGENT, terminalShell)(["observe", "show", r.runId, "--state-dir", dir], false);
  expect(code).toBe(0);
  expect(readdirSync(lockDir).sort(), "observe 不许取锁").toEqual(before);
  expect(await mainFor(ECHO_AGENT, terminalShell)(["observe", "bogus"], false)).toBe(2);
});

test("管道形态：每轮结束在 err 打 `[run] <run-id> …`，正文不受影响", async () => {
  const echo = await createEcho({ provider: scripted([textTurn("正文")]), sessionsRoot: dir, allowNetwork: false, withoutMemory: true, extensionDirs: [] });
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
