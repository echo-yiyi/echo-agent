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
import { createEcho, createProvider, createProviderStreams, type Echo, type Provider } from "@echo-agent/core";
import { scriptedDialect } from "@echo-agent/core/testing";
import { codingPreset } from "../src/index.ts";
import { codingAgentIdentity } from "../src/agent.ts";

// **user 层要隔离**（2026-09-03）：`stateDir` 只管这一段 session 的目录，记忆与技能在 ECHO_HOME 下，
// 不设它就会读到开发机上真的 `~/.echo/skills`——实测过 skill 池莫名多出一条。
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

const dirs: string[] = [];
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** 假 provider：`createEcho()` 要一个来解析模型。形状照 core 测试里的同名助手，不另造一套。 */
function scriptedProvider(): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect([])),
  });
}

/** 起一个真 Echo：真 FileDir、真文件锁，只有模型是假的。**装完就 start**——见下方注释。 */
async function echoFor(opts: { workspace: string; stateDir: string }): Promise<Echo> {
  const echo = await createEcho({
    provider: scriptedProvider(),
    allowNetwork: false,
    stateDir: opts.stateDir,
    withoutMemory: true,
    extensionDirs: [], // 不扫盘：`<cwd>/extensions` 会让判据随运行目录漂
    workspace: opts.workspace, // session 级事实，宿主给（2026-09-01）
    ...codingPreset({ permission: false }),
  });
  // **必须 `start()`**：`createEcho()` 的 Agent 是 lifecycle-managed——只有 running 才接活，
  // 而**任务清单的恢复也在这一步**（低层装配是显式 `loadTasks()`，这里归 `start()`）。
  // 下面那条「仓库预置的 tasks 进不来」的判据，不 start 就会恒绿——两边都是 0。
  await echo.agent.start();
  return echo;
}

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

test("identity 的工具集与 prompt 与真装出来的 coding agent 一致(漂移即红)", async () => {
  const root = freshDir("ca-identity-");
  const echo = await echoFor({ workspace: root, stateDir: freshDir("ca-identity-state-") });
  const agent = echo.agent;
  const identity = codingAgentIdentity();

  // **完全相等**(不是子集):Agent 新增/删除任何工具都必须红——子集断言漏掉过 Task 四件(review 五轮 #3)
  expect(identity.toolNames).toEqual([...agent.tools.keys()].sort());
  expect(identity.toolNames).toContain("bash");        // 产品层的 `echo:shell`
  expect(identity.toolNames).toContain("TaskCreate");  // core 的 `echo:tasks`

  // 产品自己出的四段逐字进 digest 材料，并且**真的在**装配出来的 system 里、按 order 排
  expect(identity.sections.map((s) => s.name)).toEqual(["identity", "conduct:coding", "tool:workspace", "tool:shell"]);
  const sys = (await agent.assemblePrompt()) ?? "";
  let cursor = -1;
  for (const s of identity.sections) {
    expect(s.text.length).toBeGreaterThan(50);
    const at = sys.indexOf(s.text);
    expect(at, `段 '${s.name}' 没进 system`).toBeGreaterThan(cursor);
    cursor = at;
  }

  // 执行预算同样决定成绩(review 六轮 P1):identity 必须等于真 agent 的生效值——
  // core 改 DEFAULT_MAX_ITERATIONS 而 digest 不变的话,这里立刻红
  expect(identity.maxIterations).toBe(agent.maxIterations);

  await echo.stop();
});

test("bash 真的接上了后台队列(能力端口装上没有)", async () => {
  // `echo:shell` 从 `AgentBackgroundService` 拿 `agent.background`（2026-08-31 新增的能力端口）。
  // **没有这条判据，端口没接上也看不出来**：bash 照样注册、照样能前台跑，只有
  // `background: true` 那条路会悄悄退化成一句「本 agent 未接后台队列」。
  const root = freshDir("ca-bg-");
  const echo = await echoFor({ workspace: root, stateDir: freshDir("ca-bg-state-") });
  const bash = echo.agent.tools.get("bash");
  expect(bash).toBeDefined();

  const run = bash as unknown as {
    execute: (p: unknown, c: unknown) => Promise<{ isError: boolean; content: string }>;
  };
  const result = await run.execute(
    { command: "sleep 0.05", background: true },
    { toolCallId: "t1", workspace: root, sessionId: null, iteration: 0 },
  );
  // 端口没接上时这里是 `isError:true` + 「本 agent 未接后台队列」
  expect([result.isError, result.content.includes("no background queue")]).toEqual([false, false]);
  expect(result.content).toContain("Started in the background");

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
  const leaky = await echoFor({ workspace: root, stateDir: repoEcho });
  expect(leaky.agent.tasks.size).toBeGreaterThan(0);
  await leaky.stop();

  // ② 正例：状态根在仓库外（评测就是这么接的）→ 一条都进不来
  const isolated = await echoFor({ workspace: root, stateDir: freshDir("ca-tasks-state-") });
  expect(isolated.agent.tasks.size).toBe(0);
  await isolated.stop();
});
