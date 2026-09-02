// coding-agent 的契约门:工具真动盘、权限真拦、装配整链真跑通。

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "@echo-agent/core/testing";
import { createEcho, createProvider, createProviderStreams, type Echo, type ModelTool, type Provider, type ToolExecutionContext } from "@echo-agent/core";
import { makeFsTools } from "../src/tools/fs.ts";
import { makeBashTool } from "../src/tools/bash.ts";
import { makeSearchTools } from "../src/tools/search.ts";
import { codingPreset } from "../src/agent.ts";
import { loadSkills } from "@echo-agent/core";
import type { PermissionPolicy } from "../src/permission.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "echo-ca-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 假 provider：`createEcho()` 要一个来解析模型。形状照 core 测试里的同名助手，不另造一套。 */
function scriptedProvider(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

/**
 * 整链装配：**走唯一那个 composition root**（2026-08-31）。
 *
 * 状态根放在 `root` 之外——被测仓库不该能通过预置文件影响 agent 状态
 * （判据本身在 `identity.test.ts`，这里只是照那条规矩接线）。
 */
async function echoWith(opts: {
  turns?: ScriptedTurn[];
  permission?: PermissionPolicy | false;
  skillDirs?: readonly string[];
}): Promise<Echo> {
  const skills = opts.skillDirs === undefined ? undefined : (await loadSkills([...opts.skillDirs])).skills;
  const echo = await createEcho({
    provider: scriptedProvider(opts.turns ?? []),
    allowNetwork: false,
    stateDir: await mkdtemp(join(tmpdir(), "echo-ca-state-")),
    withoutMemory: true,
    extensionDirs: [], // 不扫盘：`<cwd>/extensions` 会让判据随运行目录漂
    workspace: root, // session 级事实，宿主给（2026-09-01）；不再经 preset
    ...codingPreset({
      ...(opts.permission !== undefined ? { permission: opts.permission } : {}),
      ...(skills !== undefined ? { skills } : {}),
    }),
  });
  // **必须 `start()`**：`createEcho()` 的 Agent 是 lifecycle-managed——只有 running 才接活，
  // 状态恢复（任务清单、会话）也在 `start()` 里。低层 `new Agent()` 不需要这一步，
  // 换装配路径时最容易漏的就是它（实测：不 start 直接 prompt → 「当前状态是 new，不接受新工作」）。
  await echo.agent.start();
  return echo;
}

const ctx = (): ToolExecutionContext => ({
  toolCallId: "t1",
  workspace: root,
  sessionId: null,
  iteration: 0,
});

function tool(list: ModelTool[], name: string): ModelTool {
  return list.find((t) => t.name === name)!;
}

/* ══════════ 文件三件套 ══════════ */

test("read/write/edit 整套:写 → 读(带行号)→ 精确替换", async () => {
  const fs = makeFsTools();
  const w = await tool(fs, "write_file").execute({ path: "a.ts", content: "const a = 1;\nconst b = 2;" }, ctx());
  expect(w.isError).toBe(false);

  const r = await tool(fs, "read_file").execute({ path: "a.ts" }, ctx());
  expect(r.content).toContain("1\tconst a = 1;");

  const e = await tool(fs, "edit_file").execute({ path: "a.ts", old_string: "const b = 2;", new_string: "const b = 3;" }, ctx());
  expect(e.isError).toBe(false);
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;");
});

test("edit_file:匹配 0 处 / 多处都拒,replace_all 放行", async () => {
  const fs = makeFsTools();
  await writeFile(join(root, "x.txt"), "aa aa", "utf8");
  await tool(fs, "read_file").execute({ path: "x.txt" }, ctx()); // 改前必读（2026-09-02 起是门，见下一条）
  const zero = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "zzz", new_string: "y" }, ctx());
  expect(zero.isError).toBe(true);
  const multi = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "aa", new_string: "b" }, ctx());
  expect(multi.isError).toBe(true);
  expect(multi.content).toContain("2 matches");
  const all = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "aa", new_string: "b", replace_all: true }, ctx());
  expect(all.isError).toBe(false);
  expect(await readFile(join(root, "x.txt"), "utf8")).toBe("b b");
});

test("改前必读、读后未变：没读过拒、盘上被别人改过拒、自己写过的算读过；新建文件不用读", async () => {
  // 2026-09-02 用户拍板（照 Claude Code 的 Edit / Write 门）：此前只是 description 里一句「先读」，
  // 模型没读就改、或按旧内容盖掉用户刚在编辑器里改的文件，都拦不住
  const fs = makeFsTools();
  await writeFile(join(root, "g.txt"), "one\n", "utf8");

  const blind = await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "one", new_string: "two" }, ctx());
  expect([blind.isError, blind.content]).toEqual([true, "Read g.txt with read_file before changing it"]);
  const blindWrite = await tool(fs, "write_file").execute({ path: "g.txt", content: "x" }, ctx());
  expect(blindWrite.isError).toBe(true);
  expect(await readFile(join(root, "g.txt"), "utf8")).toBe("one\n"); // 一个字没动

  await tool(fs, "read_file").execute({ path: "g.txt" }, ctx());
  const ok = await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "one", new_string: "two" }, ctx());
  expect(ok.isError).toBe(false);
  // 自己刚写过的算读过：连续两次 edit 不用中间重读
  const again = await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "two", new_string: "three" }, ctx());
  expect(again.isError).toBe(false);

  // 别人（编辑器、另一个进程）改了盘上的文件：mtime 变了 → 拒，读一遍才能再改
  await new Promise((r) => setTimeout(r, 15)); // mtime 至少差 1ms
  await writeFile(join(root, "g.txt"), "three\nuser edit\n", "utf8");
  const stale = await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "three", new_string: "four" }, ctx());
  expect([stale.isError, stale.content]).toEqual([true, "g.txt changed on disk since you read it; read it again before changing it"]);
  expect(await readFile(join(root, "g.txt"), "utf8")).toBe("three\nuser edit\n"); // 用户的改动没被盖
  await tool(fs, "read_file").execute({ path: "g.txt" }, ctx());
  expect((await tool(fs, "edit_file").execute({ path: "g.txt", old_string: "three", new_string: "four" }, ctx())).isError).toBe(false);

  // 新建不用先读
  const fresh = await tool(fs, "write_file").execute({ path: "new/n.txt", content: "hi" }, ctx());
  expect(fresh.isError).toBe(false);
});

test("edit_file 的替换文本里带 `$` 原样落盘（不解释 $& / $$ 这类模式）", async () => {
  const fs = makeFsTools();
  await writeFile(join(root, "d.ts"), "const price = COST;\n", "utf8");
  await tool(fs, "read_file").execute({ path: "d.ts" }, ctx());
  const r = await tool(fs, "edit_file").execute({ path: "d.ts", old_string: "COST", new_string: "`$${n}` + $& + $$" }, ctx());
  expect(r.isError).toBe(false);
  expect(await readFile(join(root, "d.ts"), "utf8")).toBe("const price = `$${n}` + $& + $$;\n");
});

test("路径越界一律拒(../ 逃逸、绝对路径出工作区)", async () => {
  const fs = makeFsTools();
  for (const path of ["../outside.txt", "/etc/passwd", "a/../../b.txt"]) {
    const r = await tool(fs, "write_file").execute({ path, content: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("outside the workspace");
  }
});

/* ══════════ bash ══════════ */

test("bash:stdout+stderr 合并;非零退出是结果不是异常", async () => {
  const bash = makeBashTool();
  const ok = await bash.execute({ command: "echo out; echo err >&2" }, ctx());
  expect(ok.isError).toBe(false);
  expect(ok.content).toContain("out");
  expect(ok.content).toContain("err");

  const fail = await bash.execute({ command: "echo boom; exit 3" }, ctx());
  expect(fail.isError).toBe(true);
  expect(fail.content).toContain("exit code 3");
  expect(fail.content).toContain("boom"); // 模型要看到输出来决定下一步
});

test("bash 超时:杀掉并说清,不挂死", async () => {
  const bash = makeBashTool();
  const r = await bash.execute({ command: "sleep 10", timeout_ms: 100 }, ctx());
  expect(r.isError).toBe(true);
  expect(r.content).toContain("Timed out");
}, 10_000);

test("后台作业：bash background 起 → job_output 看得到状态与最近输出 → job_stop 杀掉 → 再看是 killed；丢了 id 也找得回", async () => {
  // 2026-09-02 补的两件：此前 background: true 之后模型中途看不到输出、也停不掉——「跑起来看日志再改」走不通。
  // 走真装配：`echo:shell` 从 `AgentBackgroundService` 拿的就是 agent.background，三件工具共用同一张表。
  const echo = await echoWith({ permission: false });
  const run = (name: string, params: unknown): Promise<{ isError: boolean; content: string }> =>
    (echo.agent.tools.get(name) as unknown as { execute: (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }> }).execute(params, ctx());
  const started = await run("bash", { command: "echo started; sleep 30", background: true });
  expect(started.isError).toBe(false);
  const id = /Started in the background: (\S+)/.exec(started.content)![1]!;

  // 等 echo 的输出进缓冲，再看：running + 最近输出
  const deadline = Date.now() + 5000;
  let seen = await run("job_output", { id });
  while (!seen.content.includes("started") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    seen = await run("job_output", { id });
  }
  expect([seen.isError, seen.content.startsWith(`${id} [running]`), seen.content.includes("started")]).toEqual([false, true, true]);

  const stopped = await run("job_stop", { id });
  expect([stopped.isError, stopped.content]).toEqual([false, expect.stringContaining(`Stopped ${id}`)]);
  // 杀了之后状态吸收成 killed（终态），再停一次不报错、如实说已结束
  const after = await run("job_output", { id });
  expect(after.content.startsWith(`${id} [killed]`)).toBe(true);
  expect((await run("job_stop", { id })).content).toContain("already ended (killed)");

  // 丢了 id（压缩之后常见）：错误里列出已知作业，不用第三件 job_list
  const lost = await run("job_output", { id: "nope" });
  expect([lost.isError, lost.content]).toEqual([true, expect.stringContaining(id)]);
  await echo.stop();
}, 15_000);

/* ══════════ 搜索 ══════════ */

test("glob 找文件(排除 node_modules);grep 找内容带 文件:行号", async () => {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "export const hit = 1;\n", "utf8");
  await writeFile(join(root, "node_modules/pkg/b.ts"), "export const hit = 2;\n", "utf8");

  const s = makeSearchTools();
  const g = await tool(s, "glob").execute({ pattern: "**/*.ts" }, ctx());
  expect(g.content).toContain("src/a.ts");
  expect(g.content).not.toContain("node_modules");

  const gr = await tool(s, "grep").execute({ pattern: "hit" }, ctx());
  expect(gr.content).toContain("src/a.ts:1:");
  expect(gr.content).not.toContain("node_modules");

  const bad = await tool(s, "grep").execute({ pattern: "[unclosed" }, ctx());
  expect(bad.isError).toBe(true);
});

test("grep 的 path 指到单个文件就只搜它（相对、绝对都行）；结果路径一律相对工作区；glob 拿到文件明说要目录", async () => {
  // 实测 bug（2026-09-01）：模型把 grep 当 `grep <pattern> <file>` 用，此前拿到的是一句 `ENOTDIR: not a directory`
  await mkdir(join(root, "src/deep"), { recursive: true });
  await writeFile(join(root, "src/deep/a.ts"), "const x = 1;\nconst hit = 2;\n", "utf8");
  await writeFile(join(root, "src/b.ts"), "const hit = 3;\n", "utf8");

  const s = makeSearchTools();
  for (const path of ["src/deep/a.ts", join(root, "src/deep/a.ts")]) {
    const r = await tool(s, "grep").execute({ pattern: "hit", path }, ctx());
    expect([path, r.isError, r.content]).toEqual([path, false, "src/deep/a.ts:2:const hit = 2;"]);
  }
  // 子目录里搜，报的仍是工作区相对路径——read_file / edit_file 收的就是它，不是 `a.ts` 这种相对 path 的
  const inDir = await tool(s, "grep").execute({ pattern: "hit", path: "src/deep" }, ctx());
  expect(inDir.content).toBe("src/deep/a.ts:2:const hit = 2;");
  const globbed = await tool(s, "glob").execute({ pattern: "*.ts", path: "src/deep" }, ctx());
  expect(globbed.content).toBe("src/deep/a.ts");

  // glob 的 path 是文件：不静默返回 0 个，明说要目录、指回 grep
  const fileGlob = await tool(s, "glob").execute({ pattern: "*.ts", path: "src/b.ts" }, ctx());
  expect([fileGlob.isError, fileGlob.content]).toEqual([true, expect.stringContaining("use grep")]);
  // 不存在：说是哪个 path，不是 ENOTDIR / ENOENT 原文
  const missing = await tool(s, "grep").execute({ pattern: "hit", path: "src/nope" }, ctx());
  expect([missing.isError, missing.content]).toEqual([true, "path not found: src/nope"]);
});

test("list_dir：一层目录，子目录在前带 /；缺省工作区根；拿到文件明说要目录", async () => {
  // 2026-09-02 补：glob 只出文件，模型看不到目录结构，只能 bash ls
  await mkdir(join(root, "src/deep"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "", "utf8");
  await writeFile(join(root, "README.md"), "", "utf8");

  const s = makeSearchTools();
  const top = await tool(s, "list_dir").execute({}, ctx());
  expect([top.isError, top.content]).toEqual([false, "node_modules/\nsrc/\nREADME.md"]); // 目录真相：node_modules 也列
  const sub = await tool(s, "list_dir").execute({ path: "src" }, ctx());
  expect(sub.content).toBe("deep/\na.ts");
  expect((await tool(s, "list_dir").execute({ path: "src/deep" }, ctx())).content).toBe("(empty directory)");
  const file = await tool(s, "list_dir").execute({ path: "src/a.ts" }, ctx());
  expect([file.isError, file.content]).toEqual([true, expect.stringContaining("needs a directory")]);
});

/* ══════════ 整链装配 ══════════ */

const writeTurns = (): ScriptedTurn[] => [
  toolTurn("c1", "write_file", { path: "out.txt", content: "hi" }),
  textTurn("写完了"),
];

test("整链:模型点 write_file,缺省权限拒(没人答);permission:false 放行", async () => {
  // 缺省权限:动手要问,而这里没有宿主会答（`responder` 缺省 "none"）→ core 在 authorize 阶段折成拒
  const denied = await echoWith({ turns: writeTurns() });
  await denied.agent.prompt("写个文件");
  const deniedResult = denied.agent.messages.find((m) => m.role === "toolResult");
  expect((deniedResult as { isError: boolean }).isError).toBe(true);
  expect((deniedResult as { content: string }).content).toContain("was not authorized");
  await denied.stop();

  // 显式放行:文件真的落盘
  const open = await echoWith({ turns: writeTurns(), permission: false });
  await open.agent.prompt("写个文件");
  expect(await readFile(join(root, "out.txt"), "utf8")).toBe("hi");
  await open.stop();
});

test("responder:'host' → 真发出 permissionRequest,宿主答 allow 就落盘", async () => {
  // 2026-08-31：**裁决人不再由本包接**。原先 `installPermission()` 在这一层订阅
  // `permissionRequest` 去问一个回调——那和壳做的是同一件事，而仓库里从没有调用方给过回调。
  // 删掉之后本层只剩「策略翻译对不对」：`responder:"host"` 必须让 core **发出 ask**
  // 而不是就地折成 deny。谁来答是壳的事（`@echo/tui` 的 `echo:tui` 在做，判据在那边）。
  //
  // 这里由测试扮演宿主，走的是**和壳完全相同**的那条通路：订阅 lifecycle → answerPermission。
  const echo = await echoWith({
    turns: [toolTurn("c1", "write_file", { path: "asked.txt", content: "ok" }), textTurn("写完了")],
    permission: { rules: { write_file: "ask" }, responder: "host" },
  });
  const asked: string[] = [];
  const off = echo.agent.subscribeLifecycle((e) => {
    if (e.type !== "permissionRequest") return;
    asked.push(e.toolName);
    void echo.agent.answerPermission({ permissionId: e.permissionId, decision: "allow" });
  });

  await echo.agent.prompt("写个文件");
  expect(asked).toEqual(["write_file"]); // 没发出 ask 的话这里是空数组
  expect(await readFile(join(root, "asked.txt"), "utf8")).toBe("ok");

  off();
  await echo.stop();
});

test("装配面:四类工具都在(fs/bash/搜索/任务清单);skill 目录空则不装 skill 工具", async () => {
  const echo = await echoWith({ permission: false });
  const names = [...echo.agent.tools.keys()];
  for (const n of ["read_file", "write_file", "edit_file", "bash", "glob", "grep", "TaskCreate", "TaskList"]) {
    expect(names).toContain(n);
  }
  // **2026-08-31：skill 工具现在恒在**。原判据是「零 skill 别装——空可选集白占 token」，
  // 那是低层 `new Agent()` 不给 skillStore 时的行为。走 `createEcho()` 拿到的是完整 Runtime，
  // 它按状态根装了 skillStore ⇒ 支持**创建** skill ⇒ 两件工具都装（池空也装，因为 create 用得上）。
  // 用户拍板接受这个变化，所以这里改成断言现状，而不是给评测另留一条装配路径。
  expect(names).toContain("skill_create");
  expect(echo.agent.skills.size).toBe(0); // 池确实是空的——工具在不等于有 skill
  // 产品层那三条真的进了清单（不是只把工具塞进 Map）——「清单 = Host 实际挂上的那一份」
  expect(echo.extensions.map((e) => e.entryId)).toContain("echo:coding");
  expect(echo.extensions.map((e) => e.entryId)).toContain("echo:workspace");
  expect(echo.extensions.map((e) => e.entryId)).toContain("echo:shell");
  // 段跟着 extension 进了 system：产品身份在最前，工具习惯段在环境段之前，工具目录一个字不进 system
  const sys = (await echo.agent.assemblePrompt()) ?? "";
  expect(sys.startsWith("You are Echo Coding")).toBe(true);
  expect(sys).toContain("# Working in code");
  expect(sys).toContain("# Files");
  expect(sys).toContain("# Shell");
  expect(sys.indexOf("# Shell")).toBeLessThan(sys.indexOf("# Environment"));
  expect(sys).toContain(`Workspace: ${root}`);
  expect(sys).not.toMatch(/Available tools|^- (read_file|bash|glob):/m);
  await echo.stop();
});

test("skill 目录有货:加载进池 + 装 skill 工具", async () => {
  await mkdir(join(root, ".echo/skills/fmt"), { recursive: true });
  await writeFile(join(root, ".echo/skills/fmt/SKILL.md"), "---\ndescription: 格式化流程\n---\n跑 prettier", "utf8");
  // **扫盘归调用方**（2026-08-31）：`codingPreset()` 是同步的一份配置，不读盘。
  const echo = await echoWith({ permission: false, skillDirs: [join(root, ".echo/skills")] });
  expect(echo.agent.skills.has("fmt")).toBe(true);
  expect(echo.agent.tools.has("skill_activate")).toBe(true);
  await echo.stop();
});

test("`stop()` 先卸 Extension 再停 Agent：产品层那两条的 disposer 真的跑过", async () => {
  // 判据**不能**看工具 Map 的最终状态——`agent.stop()` 顺手 `tools.clear()`，
  // disposer 一次没跑也是空的（上一版就是被这一点掩盖了整整一批）。
  // 要看的是「工具在 Agent 收摊**之前**就已经被撤掉了」，那只有 disposer 真跑过才做得到。
  //
  // 2026-08-31：收摊逻辑本身归 `createEcho()`（判据在 core 的 `create-echo.test.ts` 与
  // `extension-cleanup.test.ts`）。这里守的是**产品层这两条 Extension 接进去之后仍然被卸**——
  // 换句话说 `codingPreset()` 交出去的 Entry 真的落在了那套所有权账本里，没有游离在外。
  const echo = await echoWith({ turns: [textTurn("好")], permission: false });
  expect(echo.agent.tools.has("read_file")).toBe(true); // echo:workspace
  expect(echo.agent.tools.has("bash")).toBe(true); // echo:shell

  let toolsWhenDisposed = -1;
  const realStop = echo.agent.stop.bind(echo.agent);
  echo.agent.stop = async (): Promise<void> => {
    // Agent 收摊那一刻：产品层与 builtin 两代都该已经卸完，工具表因此已经空了
    toolsWhenDisposed = echo.agent.tools.size;
    return realStop();
  };

  await echo.stop();
  expect(toolsWhenDisposed).toBe(0); // disposer 没跑过的话，这里是「工具还都在」
  await echo.stop(); // 幂等
});
