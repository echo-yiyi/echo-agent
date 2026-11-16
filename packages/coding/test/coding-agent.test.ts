// coding-agent 的契约门:权限真拦、装配整链真跑通。单件工具自己的行为（读写改、bash、搜索、web）
// 在 `@echo-agent/tools` 的测试里；这里只验它们经 `codingPreset()` 装上之后的整链。

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { textTurn, toolTurn, type ScriptedTurn } from "@echo-agent/core/testing";
import { createEcho, createProvider, createProviderStreams, type Dialect, type Echo, type Provider } from "@echo-agent/core";
import { AgentRuntimeService, defineExtension, type ExtensionEntry } from "@echo-agent/core/extension";
import { detectSandbox } from "@echo-agent/tools";
import { codingPreset } from "../src/agent.ts";
import { loadSkills } from "@echo-agent/core";
import type { PermissionPolicy } from "../src/permission.ts";
import { mkdtempSync } from "node:fs";

// **user 层要隔离**（2026-09-03）：`stateDir` 只管这一段 session 的目录，记忆与技能在 ECHO_HOME 下，
// 不设它就会读到开发机上真的 `~/.echo/skills`——实测过 skill 池莫名多出一条。
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "echo-ca-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 模型一次被调时收到的全部输入：system、消息、工具菜单。 */
type ModelInput = Parameters<Dialect["request"]>[1];
type ToolCallRequest = { name: string; input: Record<string, unknown> };

/**
 * 假模型（2026-09-17）：**从外面看 agent 只能看模型收到了什么**——`Agent` 收进 core 内部之后，
 * 工具池、skill 池、装配出的 system 都不在公共面上，第三方产品能观察的就是 provider 这一头。
 * 所以这里是一个真 `Dialect`（第三方写 provider 用的同一个接口），每次被调先把输入记下来，再决定怎么答：
 *
 *   1. 最近一条 `<<call:ID>>` 记号还没答过 → 发出 `call()` 登记的那次工具调用；
 *   2. 否则按顺序吐 `turns`；
 *   3. 都没有 → 一句 "ok" 收场。后台作业结束会投 inbox、唤醒一轮，按剧本顺序答会被它吃掉一格——按记号答就不怕。
 */
function fakeModel(turns: ScriptedTurn[], seen: ModelInput[], requests: ReadonlyMap<string, ToolCallRequest>): Dialect {
  const served = new Set<string>();
  let next = 0;
  return {
    api: "fake",
    async *request(_model, context) {
      seen.push({ systemPrompt: context.systemPrompt, messages: [...context.messages], tools: context.tools.map((t) => ({ ...t })) });
      const id = [...JSON.stringify(context.messages).matchAll(/<<call:(c\d+)>>/g)].at(-1)?.[1];
      let turn: ScriptedTurn;
      if (id !== undefined && !served.has(id)) {
        served.add(id);
        const r = requests.get(id)!;
        turn = toolTurn(id, r.name, r.input);
      } else if (next < turns.length) {
        turn = turns[next++]!;
      } else {
        turn = textTurn("ok");
      }
      for (const ev of turn) yield structuredClone(ev);
    },
  };
}

/** 假 provider：`createEcho()` 要一个来解析模型；流走上面那个会记账的方言。 */
function scriptedProvider(dialect: Dialect): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(dialect),
  });
}

type ToolOutcome = { isError: boolean; content: string };

type Harness = {
  echo: Echo;
  /** 模型每次被调收到的输入，按调用顺序。 */
  seen: ModelInput[];
  /** 让模型点一次这件工具、跑完这一轮，交回它的 toolResult——和真用户一句话让模型去调是同一条路。 */
  call(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
};

/** 名字：本轮菜单上的工具。 */
const menuOf = (input: ModelInput): string[] => input.tools.map((t) => t.name);

/**
 * 延迟层的名字：`tool_search` 的 description 每轮现算列出池里所有延迟工具（`makeToolSearchTool`）。
 * 菜单 ∪ 这份 = 模型能用到的全部工具。
 */
function deferredOf(input: ModelInput): string[] {
  const search = input.tools.find((t) => t.name === "tool_search");
  if (search === undefined) return [];
  const listed = /Deferred tools: (.*)\.$/s.exec(search.description)?.[1] ?? "";
  return listed === "" ? [] : listed.split(", ").map((n) => n.replace(/ \(loaded\)$/, ""));
}

/** 等 agent 空下来（后台作业结束会唤醒一轮）。 */
async function idle(echo: Echo): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!echo.agent.acceptsWork && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
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
  sandbox?: boolean;
  skillDirs?: readonly string[];
  /** 排在产品那几条**之前**的额外 extension（同一代里卸载是 LIFO，所以它们晚于产品的卸）。 */
  extensionsBefore?: readonly ExtensionEntry[];
}): Promise<Harness> {
  const skills = opts.skillDirs === undefined ? undefined : (await loadSkills([...opts.skillDirs])).skills;
  const seen: ModelInput[] = [];
  const requests = new Map<string, ToolCallRequest>();
  const preset = codingPreset({
    ...(opts.permission !== undefined ? { permission: opts.permission } : {}),
    ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
    ...(skills !== undefined ? { skills } : {}),
  });
  const echo = await createEcho({
    provider: scriptedProvider(fakeModel(opts.turns ?? [], seen, requests)),
    allowNetwork: false,
    stateDir: await mkdtemp(join(tmpdir(), "echo-ca-state-")),
    withoutMemory: true,
    extensionDirs: [], // 不扫盘：`<cwd>/extensions` 会让判据随运行目录漂
    workspace: root, // session 级事实，宿主给（2026-09-01）；不再经 preset
    ...preset,
    extensions: [...(opts.extensionsBefore ?? []), ...preset.extensions],
  });
  // **必须 `start()`**：`createEcho()` 的 Agent 是 lifecycle-managed——只有 running 才接活，
  // 状态恢复（任务清单、会话）也在 `start()` 里（实测：不 start 直接 prompt → 「当前状态是 new，不接受新工作」）。
  await echo.start();
  let seq = 0;
  const call = async (name: string, input: Record<string, unknown>): Promise<ToolOutcome> => {
    const id = `c${++seq}`;
    requests.set(id, { name, input });
    await idle(echo);
    const { outcome } = await echo.agent.prompt(`<<call:${id}>>`);
    expect(outcome).toEqual({ kind: "completed" });
    const result = echo.agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === id);
    expect(result, `模型点了 ${name}，却没有对应的 toolResult`).toBeDefined();
    const { isError, content } = result as ToolOutcome;
    return { isError, content };
  };
  return { echo, seen, call };
}

/* ══════════ shell：沙箱与后台作业走真装配 ══════════ */

test.skipIf(detectSandbox().name === "unavailable")("沙箱走真装配：echo:shell 配了 sandbox，前台与后台命令都写不进家目录；工作区照写（2026-11-15）", async () => {
  const { call: run } = await echoWith({ permission: false, sandbox: true });
  const outside = join(homedir(), `echo-ca-sbx-${process.pid}.txt`);
  const fg = await run("bash", { command: `echo x > ${outside}` });
  expect([fg.isError, existsSync(outside)]).toEqual([true, false]);
  const bg = await run("bash", { command: `echo x > ${outside}.bg; echo finished`, background: true });
  const id = /Started in the background: (\S+)/.exec(bg.content)![1]!;
  // 等作业结束再看输出（看状态，不看输出里的字：作业的标签就是命令本身，命令里的字恒在）
  const deadline = Date.now() + 5000;
  let seen = await run("job_output", { id });
  while (seen.content.startsWith(`${id} [running]`) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    seen = await run("job_output", { id });
  }
  expect(seen.content).toMatch(/Operation not permitted|Read-only file system/);
  expect(existsSync(`${outside}.bg`)).toBe(false);
  const inside = await run("bash", { command: "echo ok > sbx-inside.txt && cat sbx-inside.txt" });
  expect([inside.isError, inside.content.split("\n")[0]]).toEqual([false, "ok"]);
});

test("后台作业：bash background 起 → job_output 看得到状态与最近输出 → job_stop 杀掉 → 再看是 killed；丢了 id 也找得回", async () => {
  // 2026-09-02 补的两件：此前 background: true 之后模型中途看不到输出、也停不掉——「跑起来看日志再改」走不通。
  // 走真装配：`echo:shell` 从 `AgentBackgroundService` 拿的就是 agent.background，三件工具共用同一张表。
  // 每一步都是模型点工具、agent 跑那一轮（`call`），不从外面直接拿工具对象调。
  const { echo, call: run } = await echoWith({ permission: false });
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

/* ══════════ 整链装配 ══════════ */

const writeTurns = (): ScriptedTurn[] => [
  toolTurn("c1", "write_file", { path: "out.txt", content: "hi" }),
  textTurn("写完了"),
];

test("整链:模型点 write_file,缺省权限拒(没人答);permission:false 放行", async () => {
  // 缺省权限:动手要问,而这里没有宿主会答（`responder` 缺省 "none"）→ core 在 authorize 阶段折成拒
  const { echo: denied } = await echoWith({ turns: writeTurns() });
  await denied.agent.prompt("写个文件");
  const deniedResult = denied.agent.state.messages.find((m) => m.role === "toolResult");
  expect((deniedResult as { isError: boolean }).isError).toBe(true);
  expect((deniedResult as { content: string }).content).toContain("was not authorized");
  await denied.stop();

  // 显式放行:文件真的落盘
  const { echo: open } = await echoWith({ turns: writeTurns(), permission: false });
  await open.agent.prompt("写个文件");
  expect(await readFile(join(root, "out.txt"), "utf8")).toBe("hi");
  await open.stop();
});

test("responder:'host' → 真发出 permissionRequest,宿主答 allow 就落盘", async () => {
  // 2026-08-31：**裁决人不再由本包接**。原先 `installPermission()` 在这一层订阅
  // `permissionRequest` 去问一个回调——那和壳做的是同一件事，而仓库里从没有调用方给过回调。
  // 删掉之后本层只剩「策略翻译对不对」：`responder:"host"` 必须让 core **发出 ask**
  // 而不是就地折成 deny。谁来答是壳的事（`echo-agent` 的 `echo:tui` 在做，判据在那边）。
  //
  // 这里由测试扮演宿主，走的是**和壳完全相同**的那条通路：订阅 lifecycle → answerPermission。
  const { echo } = await echoWith({
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
  // 判据看**模型实际收到的**：菜单（`context.tools`）与延迟层（`tool_search` 的 description），
  // 不看池——池里有不等于上了模型的菜单。
  const { echo, seen } = await echoWith({ permission: false });
  await echo.agent.prompt("看看");
  const first = seen[0]!;
  const menu = menuOf(first);
  const deferred = deferredOf(first);
  const offered = [...menu, ...deferred];
  for (const n of ["read_file", "write_file", "edit_file", "bash", "glob", "grep", "TaskCreate", "TaskList", "worktree_enter", "worktree_exit", "web_fetch", "web_search"]) {
    expect(offered).toContain(n);
  }
  // 2026-09-03：worktree_exit / web_fetch / web_search 是延迟工具——不在菜单上，列在 tool_search 里，取过才上
  for (const n of ["worktree_exit", "web_fetch", "web_search"]) {
    expect(menu).not.toContain(n);
    expect(deferred).toContain(n);
  }
  expect(menu).toContain("worktree_enter");
  expect(deferred).not.toContain("worktree_enter");
  // **2026-08-31：skill 工具现在恒在**。原判据是「零 skill 别装——空可选集白占 token」，
  // 那是低层 `new Agent()` 不给 skillStore 时的行为。走 `createEcho()` 拿到的是完整 Runtime，
  // 它按状态根装了 skillStore ⇒ 支持**创建** skill ⇒ 两件工具都装（池空也装，因为 create 用得上）。
  // 用户拍板接受这个变化，所以这里改成断言现状，而不是给评测另留一条装配路径。
  expect(offered).toContain("skill_create");
  // 池确实是空的——工具在不等于有 skill：skill_activate 在菜单上（目录段的门开着），system 里却没有目录段
  expect(menu).toContain("skill_activate");
  const sys = first.systemPrompt ?? "";
  expect(sys).not.toContain("# Skills");
  // 产品层那几条真的进了清单（不是只把工具塞进 Map）——「清单 = Host 实际挂上的那一份」
  expect(echo.extensions.map((e) => e.entryId)).toContain("echo:coding");
  expect(echo.extensions.map((e) => e.entryId)).toContain("echo:workspace");
  expect(echo.extensions.map((e) => e.entryId)).toContain("echo:shell");
  // 段跟着 extension 进了 system：产品身份在最前，工具习惯段在环境段之前，工具目录一个字不进 system
  expect(sys.startsWith("You are Echo Coding")).toBe(true);
  expect(sys).toContain("# Working in code");
  expect(sys).toContain("# Files");
  expect(sys).toContain("# Shell");
  expect(sys.indexOf("# Shell")).toBeLessThan(sys.indexOf("# Environment"));
  expect(sys).toContain(`Workspace: ${root}`);
  expect(sys).not.toMatch(/Available tools|^- (read_file|bash|glob):/m);
  await echo.stop();
});

test("两件 worktree 工具交不给子 agent（2026-09-14：切工作目录改的是父 agent 的状态）；bash 与取过的延迟工具照常交", async () => {
  // 看子 agent 的模型实际收到的菜单：fork 模式与父逐项相同（2026-11-03，前缀缓存接得上），
  // 交不出去的两件 worktree 工具摆的是同名同 schema 的替身、点名就被拒（替身的判据在 core 的 subagent.test.ts）。
  // 先 tool_search 把 worktree_exit / web_fetch 取上菜单，证明「取过的延迟工具」这条路本身是通的。
  const { echo, seen } = await echoWith({
    permission: false,
    turns: [
      toolTurn("s1", "tool_search", { names: ["worktree_exit", "web_fetch"] }),
      toolTurn("s2", "subagent", { prompt: "look around", mode: "fork" }),
      textTurn("child done"), // 子 agent 那一轮
      textTurn("parent done"),
    ],
  });
  await echo.agent.prompt("派个子 agent");
  const parentMenus = seen.filter((s) => !menuOf(s).includes("report")).map(menuOf);
  const childMenus = seen.filter((s) => menuOf(s).includes("report")).map(menuOf);
  // 父派出子的那一轮：两件 worktree 工具都在父自己的菜单上
  expect(parentMenus[1]).toEqual(expect.arrayContaining(["worktree_enter", "worktree_exit", "web_fetch", "subagent"]));
  expect(childMenus.length).toBe(1);
  const child = childMenus[0]!;
  expect(child).toEqual(expect.arrayContaining(["bash", "read_file", "web_fetch", "worktree_enter", "worktree_exit"]));
  expect(child).toEqual([...parentMenus[1]!, "report"]);
  await echo.stop();
});

test("skill 目录有货:加载进池 + 装 skill 工具", async () => {
  await mkdir(join(root, ".echo/skills/fmt"), { recursive: true });
  await writeFile(join(root, ".echo/skills/fmt/SKILL.md"), "---\ndescription: 格式化流程\n---\n跑 prettier", "utf8");
  // **扫盘归调用方**（2026-08-31）：`codingPreset()` 是同步的一份配置，不读盘。
  const { echo, seen } = await echoWith({ permission: false, skillDirs: [join(root, ".echo/skills")] });
  await echo.agent.prompt("看看");
  // 进了池 = 模型在 system 的目录段里看得到它，且手里有激活它的工具
  expect(seen[0]!.systemPrompt ?? "").toContain("- fmt: 格式化流程");
  expect(menuOf(seen[0]!)).toContain("skill_activate");
  await echo.stop();
});

test("`stop()` 先卸 Extension 再停 Agent：产品层那几条的 disposer 真的跑过", async () => {
  // 判据**不能**看工具的最终状态——Agent 收摊时会清空工具池，disposer 一次没跑也是空的
  // （上一版就是被这一点掩盖了整整一批）。要看的是「工具在 Agent 收摊**之前**就已经被撤掉了」。
  //
  // 2026-08-31：收摊逻辑本身归 `createEcho()`（判据在 core 的 `create-echo.test.ts` 与
  // `extension-cleanup.test.ts`）。这里守的是**产品层这几条 Extension 接进去之后仍然被卸**——
  // 换句话说 `codingPreset()` 交出去的 Entry 真的落在了那套所有权账本里，没有游离在外。
  //
  // 观察点是一条探针 extension，排在产品那几条之前（同一代卸载是 LIFO，所以它在产品那几条之后卸）：
  // 它卸的那一刻读运行协议的 `state.tools`。产品工具已撤、而 builtin 的 TaskCreate 还在
  // = 产品 disposer 真跑过，且 Agent 还没收摊（收摊会清空整个池）。
  let toolsWhenProbeDisposed: string[] | null = null;
  const probe = defineExtension({
    name: "probe:stop-order",
    hostAbiVersion: 1,
    inject: { runtime: { service: AgentRuntimeService, required: true } },
    apply(ctx) {
      const runtime = ctx.get(AgentRuntimeService);
      void ctx.effect({
        boundary: "turn",
        start: () => ({
          value: null,
          dispose: () => {
            toolsWhenProbeDisposed = runtime.state.tools.map((t) => t.name);
          },
        }),
      });
    },
  });
  const { echo } = await echoWith({ permission: false, extensionsBefore: [{ entryId: "probe:stop-order", definition: probe }] });
  const before = echo.agent.state.tools.map((t) => t.name);
  expect(before).toContain("read_file"); // echo:workspace
  expect(before).toContain("bash"); // echo:shell

  await echo.stop();
  expect(toolsWhenProbeDisposed).not.toBeNull();
  const atDispose: string[] = toolsWhenProbeDisposed!;
  for (const n of ["read_file", "glob", "bash", "job_output", "worktree_enter", "web_fetch"]) {
    expect(atDispose, `${n} 在探针卸载时还在：产品 disposer 没跑`).not.toContain(n);
  }
  expect(atDispose).toContain("TaskCreate"); // Agent 还没收摊
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
  // 每一步都是模型点工具、agent 跑那一轮：工具拿到的 workspace 是 agent 自己的 `state.workspace`，不是测试手塞的
  const { echo, call: run } = await echoWith({ permission: false });
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
  const pwd = await run("bash", { command: "pwd" });
  expect(await realpath(pwd.content.trim())).toBe(await realpath(wt));
  // 已经在 worktree 里：再进拒绝
  expect((await run("worktree_enter", { name: "t2" })).isError).toBe(true);

  // worktree_exit 是延迟工具：模型先取 schema，下一轮才能点
  expect((await run("tool_search", { names: ["worktree_exit"] })).isError).toBe(false);
  const left = await run("worktree_exit", { remove: true });
  expect([left.isError, left.content]).toEqual([false, expect.stringContaining("removed")]);
  expect(echo.agent.state.workspace).toBe(root);
  expect(existsSync(wt)).toBe(false);
  expect(sh(root, ["git", "branch", "--list", "t1"])).toContain("t1"); // 分支留着
  await echo.stop();
});

test("worktree_enter：不是 git 仓库、名字不合法都是 error，不动工作区", async () => {
  const { echo, call: run } = await echoWith({ permission: false });
  const notRepo = await run("worktree_enter", { name: "x" });
  expect([notRepo.isError, notRepo.content]).toEqual([true, expect.stringContaining("Not a git repository")]);
  sh(root, ["git", "init", "-q"]);
  const badName = await run("worktree_enter", { name: "../x" });
  expect([badName.isError, badName.content]).toEqual([true, expect.stringContaining("Invalid worktree name")]);
  expect(echo.agent.state.workspace).toBe(root);
  await echo.stop();
});
