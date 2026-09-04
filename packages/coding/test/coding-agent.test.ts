// coding-agent 的契约门:工具真动盘、权限真拦、装配整链真跑通。

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "@echo-agent/core/testing";
import { createEcho, createProvider, createProviderStreams, type Echo, type ModelTool, type Provider, type ToolExecutionContext } from "@echo-agent/core";
import { makeFsTools } from "../src/tools/fs.ts";
import { makeBashTool } from "../src/tools/bash.ts";
import { makeSearchTools } from "../src/tools/search.ts";
import { htmlToText, makeWebTools } from "../src/tools/web.ts";
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

test("bash 工作目录跨调用保留：cd 之后下一次从那里起；cd 失败不动；目录被删退回 workspace 并说明；exit 也保留退出码", async () => {
  // 2026-09-03 补：此前每次都是全新 shell，模型得每条命令都带 `cd sub && …`，多走一步就忘。变量仍不保留（照 Claude Code）。
  await mkdir(join(root, "sub"), { recursive: true });
  const bash = makeBashTool();
  const first = await bash.execute({ command: "cd sub && pwd" }, ctx());
  expect([first.isError, first.content]).toEqual([false, expect.stringContaining("(working directory is now ")]);
  expect(first.content.startsWith(await realpath(join(root, "sub")))).toBe(true);
  // 下一次从 sub 起；标记不漏进正文
  const second = await bash.execute({ command: "basename \"$PWD\"; X=1" }, ctx());
  expect([second.isError, second.content.trimEnd()]).toEqual([false, "sub"]);
  // 变量不保留
  const third = await bash.execute({ command: "echo \"[$X]\"" }, ctx());
  expect(third.content.trimEnd()).toBe("[]");
  // cd 失败：目录不动，退出码照实回
  const bad = await bash.execute({ command: "cd nope-not-here" }, ctx());
  expect([bad.isError, bad.content]).toEqual([true, expect.stringContaining("exit code 1")]);
  expect(bad.content).not.toContain("working directory is now");
  expect((await bash.execute({ command: "basename \"$PWD\"" }, ctx())).content.trimEnd()).toBe("sub");
  // 命令自己 exit：退出码保留（包了一层不能把它吞成 0）
  const exited = await bash.execute({ command: "exit 7" }, ctx());
  expect([exited.isError, exited.content]).toEqual([true, "exit code 7\n"]);
  // 目录被删：退回 workspace，并把这件事说出来
  await rm(join(root, "sub"), { recursive: true, force: true });
  const back = await bash.execute({ command: "basename \"$PWD\"" }, ctx());
  expect(back.isError).toBe(false);
  expect(back.content).toContain("no longer exists; back in the workspace root");
  expect(back.content.startsWith(basename(root))).toBe(true);
  // 输出超长也截不掉标记：cd 仍然记住
  await mkdir(join(root, "sub2"), { recursive: true });
  const huge = await bash.execute({ command: "cd sub2 && head -c 100000 /dev/zero | tr '\\0' 'x'" }, ctx());
  expect([huge.isError, huge.content.includes("output truncated")]).toEqual([false, true]);
  expect((await bash.execute({ command: "basename \"$PWD\"" }, ctx())).content.trimEnd()).toBe("sub2");
});

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
  for (const n of ["read_file", "write_file", "edit_file", "bash", "glob", "grep", "TaskCreate", "TaskList", "worktree_enter", "worktree_exit", "web_fetch", "web_search"]) {
    expect(names).toContain(n);
  }
  // 2026-09-03：worktree_exit / web_fetch / web_search 是延迟工具——在池里、不在菜单上，经 tool_search 取过才上
  for (const n of ["worktree_exit", "web_fetch", "web_search"]) expect(echo.agent.tools.get(n)?.deferred).toBe(true);
  expect(echo.agent.tools.get("worktree_enter")?.deferred).toBeUndefined();
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

/* ══════════ worktree 隔离 ══════════ */

function sh(cwd: string, cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

test("worktree 隔离（2026-09-03 拍板 B）：worktree_enter 开 worktree、切工作区、会话不断 → bash 从新目录起 → worktree_exit 回主检出并删掉", async () => {
  sh(root, ["git", "init", "-q"]);
  sh(root, ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const echo = await echoWith({ permission: false });
  const run = (name: string, params: unknown, c: ToolExecutionContext = ctx()): Promise<{ isError: boolean; content: string }> =>
    (echo.agent.tools.get(name) as unknown as { execute: (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }> }).execute(params, c);
  const before = echo.agent.state.sessionId;

  const entered = await run("worktree_enter", { name: "t1" });
  expect([entered.isError, entered.content]).toEqual([false, expect.stringContaining("on new branch t1")]);
  const wt = echo.agent.state.workspace;
  expect(wt).toBe(join(await realpath(root), ".echo", "worktrees", "t1"));
  expect(existsSync(join(wt, ".git"))).toBe(true);
  expect(sh(wt, ["git", "rev-parse", "--abbrev-ref", "HEAD"])).toBe("t1");
  expect(echo.agent.state.sessionId).toBe(before); // 会话不断
  // 主检出的 git status 不把 worktree 目录当未跟踪文件
  expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toContain(".echo/worktrees/");
  expect(sh(root, ["git", "status", "--porcelain"])).toBe("");

  // 工具从新目录起：bash 的 cwd 状态按 workspace 重置
  const inWt = { ...ctx(), workspace: wt };
  const pwd = await run("bash", { command: "pwd" }, inWt);
  expect(await realpath(pwd.content.trim())).toBe(await realpath(wt));
  // 已经在 worktree 里：再进拒绝
  expect((await run("worktree_enter", { name: "t2" }, inWt)).isError).toBe(true);

  const left = await run("worktree_exit", { remove: true }, inWt);
  expect([left.isError, left.content]).toEqual([false, expect.stringContaining("removed")]);
  expect(echo.agent.state.workspace).toBe(root);
  expect(existsSync(wt)).toBe(false);
  expect(sh(root, ["git", "branch", "--list", "t1"])).toContain("t1"); // 分支留着
  await echo.stop();
});

test("worktree_enter：不是 git 仓库、名字不合法都是 error，不动工作区", async () => {
  const echo = await echoWith({ permission: false });
  const enter = echo.agent.tools.get("worktree_enter") as unknown as { execute: (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }> };
  const notRepo = await enter.execute({ name: "x" }, ctx());
  expect([notRepo.isError, notRepo.content]).toEqual([true, expect.stringContaining("Not a git repository")]);
  sh(root, ["git", "init", "-q"]);
  const badName = await enter.execute({ name: "../x" }, ctx());
  expect([badName.isError, badName.content]).toEqual([true, expect.stringContaining("Invalid worktree name")]);
  expect(echo.agent.state.workspace).toBe(root);
  await echo.stop();
});

/* ══════════ web_fetch ══════════ */

test("web_fetch：HTML 剥成文本（标题、标题级、链接、列表）；JSON 原样；非 2xx 与二进制是 error；max_chars 截断", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/page") {
        return new Response(
          '<html><head><title>Hi &amp; bye</title><style>x{}</style></head><body><h1>Top</h1><p>Hello <a href="https://x.test/a">link</a> world</p><script>bad()</script><ul><li>one</li><li>two</li></ul></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (p === "/json") return Response.json({ a: 1 });
      if (p === "/bin") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });
      return new Response("nope", { status: 404 });
    },
  });
  try {
    const [fetchTool] = makeWebTools() as [ModelTool<{ url: string; max_chars?: number }>];
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetchTool.execute({ url: `${base}/page` }, ctx());
    expect([page.isError, page.content]).toEqual([false, "Hi & bye\n\n# Top\nHello [link](https://x.test/a) world\n- one\n- two"]);
    const json = await fetchTool.execute({ url: `${base}/json` }, ctx());
    expect([json.isError, json.content]).toEqual([false, '{"a":1}']);
    const missing = await fetchTool.execute({ url: `${base}/missing` }, ctx());
    expect([missing.isError, missing.content]).toEqual([true, expect.stringContaining("HTTP 404")]);
    const bin = await fetchTool.execute({ url: `${base}/bin` }, ctx());
    expect([bin.isError, bin.content]).toEqual([true, expect.stringContaining("Unsupported content type")]);
    const short = await fetchTool.execute({ url: `${base}/page`, max_chars: 8 }, ctx());
    expect([short.isError, short.content.startsWith("Hi & bye\n…[truncated")]).toEqual([false, true]);
    const bad = await fetchTool.execute({ url: "ftp://x" }, ctx());
    expect(bad.isError).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("htmlToText：实体、注释、noscript、相对链接只留文字、多余空行折叠", () => {
  const out = htmlToText(
    "<!-- c --><div>A&nbsp;&lt;b&gt;&#39;q&#x27;</div><noscript>no</noscript>\n\n\n<p><a href='/rel'>rel</a> <a href='https://h.test'>https://h.test</a></p><table><tr><td>1</td><td>2</td></tr></table>",
  );
  expect(out).toBe("A <b>'q'\n\nrel https://h.test\n1 2"); // 源码里的连续空行折成一个段落空行
});

test("web_search（Brave）：没配 key 如实报没配；环境变量优先于凭据 store；结果剥标签成「标题 / 链接 / 摘要」；401 说 key 被拒且不泄露 key", async () => {
  const seen: Record<string, string>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const token = req.headers.get("x-subscription-token") ?? "";
      seen.push({ q: u.searchParams.get("q") ?? "", count: u.searchParams.get("count") ?? "", freshness: u.searchParams.get("freshness") ?? "", token });
      if (token === "bad") return new Response("{}", { status: 401 });
      return Response.json({
        web: {
          results: [
            { title: "<strong>Bun</strong> docs", url: "https://bun.sh/docs", description: "Bun &amp; TypeScript <b>guide</b>", age: "2 days ago" },
            { title: "Other", url: "https://x.test" },
          ],
        },
      });
    },
  });
  const search = (tools: ModelTool[]): ModelTool<{ query: string; count?: number; freshness?: string }> =>
    tools.find((t) => t.name === "web_search") as ModelTool<{ query: string; count?: number; freshness?: string }>;
  const prev = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  try {
    const endpoint = `http://127.0.0.1:${server.port}/search`;
    const none = search(makeWebTools({ searchEndpoint: endpoint }));
    const r0 = await none.execute({ query: "bun" }, ctx());
    expect([r0.isError, r0.content]).toEqual([true, expect.stringContaining("No search service configured")]);
    expect(seen.length).toBe(0); // 没 key 不出网

    const store = { read: async (id: string) => (id === "brave" ? ({ type: "api_key", key: "from-store" } as const) : undefined) };
    const withStore = search(makeWebTools({ credentials: store, searchEndpoint: endpoint }));
    const r1 = await withStore.execute({ query: "bun workspace", count: 2, freshness: "week" }, ctx());
    expect([r1.isError, r1.content]).toEqual([
      false,
      'Results for "bun workspace":\n1. Bun docs (2 days ago)\n   https://bun.sh/docs\n   Bun & TypeScript guide\n2. Other\n   https://x.test',
    ]);
    expect(seen.at(-1)).toEqual({ q: "bun workspace", count: "2", freshness: "pw", token: "from-store" });

    process.env.BRAVE_API_KEY = "bad"; // 环境变量赢过 store
    const r2 = await withStore.execute({ query: "x" }, ctx());
    expect([r2.isError, r2.content, seen.at(-1)?.token]).toEqual([true, expect.stringContaining("rejected the API key"), "bad"]);
    expect(r2.content).not.toContain("from-store");
    expect(r2.content).not.toContain("bad\n");
  } finally {
    if (prev === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = prev;
    server.stop(true);
  }
});
