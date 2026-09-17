// 这道门守的是**工具集/prompt 的静默漂移**:`codingAgentIdentity()` 里那份手写清单,必须等于
// **真装出来的 agent** 身上的东西。抓到过的真事——工具集从 10 件漂到 15 件而清单纹丝不动。
// 本测试从真 agent 取真相(不是照抄清单),identity 与之不符即红。
//
// `codingAgentIdentity()` 不在公共面(见 `src/agent.ts`),所以这里从 `../src/agent.ts` 直接取。
//
// 2026-08-31:装配从 `createCodingAgent()` 换成 `createEcho({ ...codingPreset() })`
// （产品层只出配置，装配只有一处）。**判据一条没减**——恰恰因为装配路径换了，
// 「identity 说的和真装出来的一样吗」这个问题更需要有人守着。

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, createProvider, createProviderStreams, type Dialect, type Echo, type Provider } from "@echo-agent/core";
import { textTurn, toolTurn, type ScriptedTurn } from "@echo-agent/core/testing";
import { codingPreset } from "../src/index.ts";
import { codingAgentIdentity } from "../src/agent.ts";

// **user 层要隔离**（2026-09-03）：`stateDir` 只管这一段 session 的目录，记忆与技能在 ECHO_HOME 下，
// 不设它就会读到开发机上真的 `~/.echo/skills`——实测过 skill 池莫名多出一条。
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

const dirs: string[] = [];
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** 模型一次被调时收到的全部输入：system、消息、工具菜单。 */
type ModelInput = Parameters<Dialect["request"]>[1];

/**
 * 假 provider（2026-09-17）：**真相从模型收到的输入里取**——`Agent` 收进 core 内部之后，工具池、装配出的 system、
 * 执行预算都不在公共面上，第三方能观察的就是 provider 这一头。每次被调先记下输入，再按顺序吐 `script`
 * （可以边跑边往里追加），吐完就一句 "ok" 收场（后台作业结束唤醒的那一轮也落在这里）。
 */
function scriptedProvider(script: ScriptedTurn[], seen: ModelInput[]): Provider {
  let next = 0;
  const dialect: Dialect = {
    api: "fake",
    async *request(_model, context) {
      seen.push({ systemPrompt: context.systemPrompt, messages: [...context.messages], tools: context.tools.map((t) => ({ ...t })) });
      const turn = next < script.length ? script[next++]! : textTurn("ok");
      for (const ev of turn) yield structuredClone(ev);
    },
  };
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(dialect),
  });
}

type Harness = { echo: Echo; script: ScriptedTurn[]; seen: ModelInput[] };

/** 起一个真 Echo：真 FileDir、真文件锁，只有模型是假的。**装完就 start**——见下方注释。 */
async function echoFor(opts: { workspace: string; stateDir: string }): Promise<Harness> {
  const script: ScriptedTurn[] = [];
  const seen: ModelInput[] = [];
  const echo = await createEcho({
    provider: scriptedProvider(script, seen),
    allowNetwork: false,
    stateDir: opts.stateDir,
    withoutMemory: true,
    extensionDirs: [], // 不扫盘：`<cwd>/extensions` 会让判据随运行目录漂
    workspace: opts.workspace, // session 级事实，宿主给（2026-09-01）
    ...codingPreset({ permission: false }),
  });
  // **必须 `start()`**：`createEcho()` 的 Agent 是 lifecycle-managed——只有 running 才接活，
  // 而**任务清单的恢复也在这一步**。下面那条「仓库预置的 tasks 进不来」的判据，不 start 就会恒绿——两边都是 0。
  await echo.start();
  return { echo, script, seen };
}

/**
 * 模型能用到的全部工具 = 菜单（`context.tools`）∪ 延迟层。延迟层的名字列在 `tool_search` 的 description 里
 * （每轮现算，`makeToolSearchTool`）。
 */
function offeredTools(input: ModelInput): string[] {
  const menu = input.tools.map((t) => t.name);
  const search = input.tools.find((t) => t.name === "tool_search");
  expect(search, "菜单上没有 tool_search：延迟层看不到").toBeDefined();
  const listed = /Deferred tools: (.*)\.$/s.exec(search!.description)?.[1] ?? "";
  const deferred = listed === "" ? [] : listed.split(", ").map((n) => n.replace(/ \(loaded\)$/, ""));
  return [...menu, ...deferred];
}

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

test("identity 的工具集与 prompt 与真装出来的 coding agent 一致(漂移即红)", async () => {
  const root = freshDir("ca-identity-");
  const { echo, script, seen } = await echoFor({ workspace: root, stateDir: freshDir("ca-identity-state-") });
  const identity = codingAgentIdentity();

  // 真相取自模型第一次被调时收到的东西
  await echo.agent.prompt("看看");
  const first = seen[0]!;

  // **完全相等**(不是子集):Agent 新增/删除任何工具都必须红——子集断言漏掉过 Task 四件(review 五轮 #3)
  expect(identity.toolNames).toEqual(offeredTools(first).sort());
  expect(identity.toolNames).toContain("bash");        // 产品层的 `echo:shell`
  expect(identity.toolNames).toContain("TaskCreate");  // core 的 `echo:tasks`

  // 产品自己出的四段逐字进 digest 材料，并且**真的在**模型收到的 system 里、按 order 排
  expect(identity.sections.map((s) => s.name)).toEqual(["identity", "conduct:coding", "tool:workspace", "tool:shell"]);
  const sys = first.systemPrompt ?? "";
  let cursor = -1;
  for (const s of identity.sections) {
    expect(s.text.length).toBeGreaterThan(50);
    const at = sys.indexOf(s.text);
    expect(at, `段 '${s.name}' 没进 system`).toBeGreaterThan(cursor);
    cursor = at;
  }

  // 执行预算同样决定成绩(review 六轮 P1):identity 必须等于真 agent 的生效值——
  // core 改 DEFAULT_MAX_ITERATIONS 而 digest 不变的话,这里立刻红。
  // 生效值从外面量：模型每轮都要工具，数 run 在第几次调模型之后以 max_iterations 收场。
  for (let i = 0; i < identity.maxIterations + 5; i++) script.push(toolTurn(`it${i}`, "list_dir", {}));
  const callsBefore = seen.length;
  const { outcome } = await echo.agent.prompt("一直看目录");
  expect(outcome).toEqual({ kind: "error", error: expect.objectContaining({ code: "max_iterations" }) });
  expect(seen.length - callsBefore).toBe(identity.maxIterations);

  await echo.stop();
});

test("bash 真的接上了后台队列(能力端口装上没有)", async () => {
  // `echo:shell` 从 `AgentBackgroundService` 拿 `agent.background`（2026-08-31 新增的能力端口）。
  // **没有这条判据，端口没接上也看不出来**：bash 照样注册、照样能前台跑，只有
  // `background: true` 那条路会悄悄退化成一句「本 agent 未接后台队列」。
  // 走模型点工具那条路：模型要 `background: true` 跑一条命令，看 agent 交回的 toolResult。
  const root = freshDir("ca-bg-");
  const { echo, script } = await echoFor({ workspace: root, stateDir: freshDir("ca-bg-state-") });
  script.push(toolTurn("bg1", "bash", { command: "sleep 0.05", background: true }), textTurn("started"));
  await echo.agent.prompt("后台跑一下");
  const result = echo.agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === "bg1") as
    | { isError: boolean; content: string }
    | undefined;
  expect(result).toBeDefined();
  // 端口没接上时这里是 `isError:true` + 「本 agent 未接后台队列」
  expect([result!.isError, result!.content.includes("no background queue")]).toEqual([false, false]);
  expect(result!.content).toContain("Started in the background");

  await echo.stop();
});

test("identity 稳定:同一份代码两次调用完全相等(digest 才可复现)", () => {
  expect(codingAgentIdentity()).toEqual(codingAgentIdentity());
});

test("状态根不在被测仓库里 → 仓库预置的 tasks 进不来(review 八轮 P1:仓库不能悄悄改被测行为)", async () => {
  // 被测仓库里埋一条任务:它会被逐轮注入模型,而 identity/digest 纹丝不动。
  //
  // 2026-08-31 判据换了形态：原先靠 `createCodingAgent({ tasksFile: false })` 关掉加载，
  // 现在靠**状态根选在哪**——`createEcho()` 的任务清单落在 `stateDir` 下，
  // 只要它不是被测仓库里的路径，仓库预置的文件就进不来。
  // 下面两半合起来才是判据：**反证证明这道门真的在守东西**，不是恒绿。
  const root = freshDir("ca-tasks-");
  const repoEcho = join(root, ".echo");
  mkdirSync(repoEcho, { recursive: true });
  writeFileSync(join(repoEcho, "tasks.json"), JSON.stringify([
    { id: "1", title: "隐藏任务:偷偷改被测行为", status: "pending", order: 1, createdAt: 1, updatedAt: 1, links: [] },
  ]));

  // ① 反证：状态根**就是**仓库那个目录 → 预置任务确实会被读进来
  const { echo: leaky } = await echoFor({ workspace: root, stateDir: repoEcho });
  expect(leaky.agent.state.tasks.total).toBeGreaterThan(0);
  await leaky.stop();

  // ② 正例：状态根在仓库外（评测就是这么接的）→ 一条都进不来
  const { echo: isolated } = await echoFor({ workspace: root, stateDir: freshDir("ca-tasks-state-") });
  expect(isolated.agent.state.tasks.total).toBe(0);
  await isolated.stop();
});
