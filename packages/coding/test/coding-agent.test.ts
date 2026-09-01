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
  const zero = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "zzz", new_string: "y" }, ctx());
  expect(zero.isError).toBe(true);
  const multi = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "aa", new_string: "b" }, ctx());
  expect(multi.isError).toBe(true);
  expect(multi.content).toContain("2 matches");
  const all = await tool(fs, "edit_file").execute({ path: "x.txt", old_string: "aa", new_string: "b", replace_all: true }, ctx());
  expect(all.isError).toBe(false);
  expect(await readFile(join(root, "x.txt"), "utf8")).toBe("b b");
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
