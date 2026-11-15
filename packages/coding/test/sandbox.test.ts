// bash 的执行后端与操作系统沙箱（2026-11-15）：沙箱里只能写工作区、临时目录与缓存，读不到 echo 的凭据文件；
// `sandbox: false` 那一条直接起；没有可用沙箱时不悄悄直接起，拒跑并说明怎么办。
// 真跑沙箱的几条只在这台机器有可用沙箱时跑（macOS 恒有；Linux 要 bubblewrap 且允许用户命名空间）。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@echo-agent/core";
import { makeBashTool } from "../src/tools/bash.ts";
import { DIRECT_BACKEND, detectSandbox, macProfile, writableRoots, type ShellBackend } from "../src/tools/sandbox.ts";
import { shellToolsSection } from "../src/prompt.ts";
import { codingPreset } from "../src/agent.ts";
import { REVIEW_SYSTEM } from "../src/permission.ts";

let root: string;
let echoHomeDir: string;
let prevEchoHome: string | undefined;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "echo-sbx-")));
  echoHomeDir = join(root, "echo-home");
  await mkdir(echoHomeDir, { recursive: true });
  await writeFile(join(echoHomeDir, "credentials.json"), '{"moonshot":{"type":"api_key","key":"sk-secret"}}');
  prevEchoHome = process.env.ECHO_HOME;
  process.env.ECHO_HOME = echoHomeDir;
});
afterEach(async () => {
  if (prevEchoHome === undefined) delete process.env.ECHO_HOME;
  else process.env.ECHO_HOME = prevEchoHome;
  await rm(root, { recursive: true, force: true });
});

const ctx = (workspace: string): ToolExecutionContext => ({ toolCallId: "t1", workspace, sessionId: null, iteration: 0 });
const SANDBOX = detectSandbox();
const realSandbox = SANDBOX.name !== "unavailable";
const unavailable: ShellBackend = { name: "unavailable", sandboxed: true, argv: () => ({ ok: false, reason: "no sandbox here (test)" }) };

/* ══════════ 可写目录 ══════════ */

test("writableRoots：工作区与临时目录取真实路径；git worktree 加上主仓库的 .git（提交写在那里）；不存在的缓存目录不放开", async () => {
  const ws = join(root, "ws");
  await mkdir(ws);
  const roots = writableRoots(ws, join(root, "no-home"));
  expect(roots).toContain(ws);
  expect(roots).toContain(await realpath(tmpdir()));
  expect(roots.some((r) => r.includes("no-home"))).toBe(false);

  const main = join(root, "main");
  await mkdir(join(main, ".git", "worktrees", "feat"), { recursive: true });
  const wt = join(root, "wt");
  await mkdir(wt);
  await writeFile(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feat")}\n`);
  expect(writableRoots(wt)).toContain(join(main, ".git"));
});

test("macProfile：缺省放行、收掉写、只放开参数给的目录与几个设备文件；有凭据文件才挡它的读；路径不进规则文本", () => {
  const p = macProfile(2, 1);
  expect(p).toContain("(allow default)");
  expect(p).toContain("(deny file-write*)");
  expect(p).toContain('(subpath (param "W0"))');
  expect(p).toContain('(subpath (param "W1"))');
  expect(p).toContain('(deny file-read* (literal (param "S0")))');
  expect(macProfile(1, 0)).not.toContain("file-read");
});

test("没有可用沙箱的平台如实说：后端名 unavailable、每次起都给原因", () => {
  const b = detectSandbox("win32" as NodeJS.Platform);
  expect([b.name, b.sandboxed]).toEqual(["unavailable", true]);
  const r = b.argv(["bash", "-c", "true"], { cwd: root, workspace: root });
  expect(r.ok).toBe(false);
  expect(!r.ok && r.reason).toContain("win32");
});

/* ══════════ bash 接上后端 ══════════ */

test("直接起的后端没有 sandbox 参数；沙箱后端才有（没有沙箱时摆出来只会让模型以为有）", () => {
  const props = (b: ShellBackend) => Object.keys((makeBashTool({ backend: b }).parameters as { properties: object }).properties);
  expect(props(DIRECT_BACKEND)).not.toContain("sandbox");
  expect(props(unavailable)).toContain("sandbox");
});

test("沙箱不可用：bash 不悄悄直接起——拒跑、说明原因与怎么办；带 sandbox: false 的那条照常跑", async () => {
  const bash = makeBashTool({ backend: unavailable });
  const marker = join(root, "ran.txt");
  const refused = await bash.execute({ command: `touch ${marker}` }, ctx(root));
  expect([refused.isError, refused.content]).toEqual([true, expect.stringContaining("no sandbox here (test)")]);
  expect(refused.content).toContain("sandbox: false");
  expect(existsSync(marker)).toBe(false);
  const direct = await bash.execute({ command: `touch ${marker} && echo done`, sandbox: false }, ctx(root));
  expect([direct.isError, direct.content.split("\n")[0]]).toEqual([false, "done"]);
  expect(existsSync(marker)).toBe(true);
});

test.skipIf(!realSandbox)("真沙箱：工作区、临时目录能写；家目录写不进；echo 的凭据文件读不到；sandbox: false 那条读得到", async () => {
  const bash = makeBashTool({ backend: SANDBOX });
  const ws = join(root, "ws");
  await mkdir(ws);
  const inside = await bash.execute({ command: "echo hi > a.txt && cat a.txt" }, ctx(ws));
  expect([inside.isError, inside.content.split("\n")[0]]).toEqual([false, "hi"]);
  const tmp = await bash.execute({ command: `echo t > ${join(tmpdir(), `echo-sbx-${process.pid}.txt`)} && echo ok` }, ctx(ws));
  expect([tmp.isError, tmp.content.split("\n")[0]]).toEqual([false, "ok"]);

  const outside = join(homedir(), `echo-sbx-should-not-exist-${process.pid}.txt`);
  const denied = await bash.execute({ command: `echo x > ${outside}` }, ctx(ws));
  expect(denied.isError).toBe(true);
  expect(denied.content).toMatch(/Operation not permitted|Read-only file system/);
  expect(existsSync(outside)).toBe(false);

  const secret = join(echoHomeDir, "credentials.json");
  const hidden = await bash.execute({ command: `cat ${secret}` }, ctx(ws));
  expect(hidden.content).not.toContain("sk-secret");
  const escalated = await bash.execute({ command: `cat ${secret}`, sandbox: false }, ctx(ws));
  expect(escalated.content).toContain("sk-secret");
});

test.skipIf(!realSandbox)("真沙箱：命令自己再起的子进程也在沙箱里（后台作业走真装配的判据在 coding-agent.test.ts）", async () => {
  const ws = join(root, "ws");
  await mkdir(ws);
  const bash = makeBashTool({ backend: SANDBOX });
  const outside = join(homedir(), `echo-sbx-child-${process.pid}.txt`);
  const r = await bash.execute({ command: `bash -c 'echo x > ${outside}' || echo child-denied` }, ctx(ws));
  expect(r.content).toContain("child-denied");
  expect(existsSync(outside)).toBe(false);
});

/* ══════════ 段、preset、审查 ══════════ */

test("tool:shell 段：沙箱后端才多一句沙箱（能写哪、读不到什么、撞上了怎么办）；不可用时说每条都要 sandbox: false", () => {
  const env = { platform: "darwin" as const, bashVersion: "5.2" };
  const render = (b?: ShellBackend) => shellToolsSection(env, b).render({} as never) as string;
  expect(render()).not.toContain("sandbox");
  expect(render(DIRECT_BACKEND)).not.toContain("sandbox");
  const on = render({ name: "macOS sandbox-exec", sandboxed: true, argv: () => ({ ok: false, reason: "" }) });
  expect(on).toContain("Commands run in a sandbox (macOS sandbox-exec)");
  expect(on).toContain("cannot read echo's credential file");
  expect(on).toContain("run the command again with sandbox: false");
  expect(render(unavailable)).toContain("pass sandbox: false on every call");
});

test("codingPreset：sandbox: true 才给 echo:shell 配沙箱，缺省不配；审查规则说清 sandbox: false 是在沙箱外跑", () => {
  const shell = (p: ReturnType<typeof codingPreset>) => p.extensions.find((e) => e.entryId === "echo:shell")!;
  expect(shell(codingPreset({ permission: false })).config).toBeUndefined();
  expect(shell(codingPreset({ permission: false, sandbox: true })).config).toEqual({ sandbox: true });
  expect(REVIEW_SYSTEM).toContain('"sandbox": false runs outside the sandbox');
});
