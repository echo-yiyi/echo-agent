// `echo:tui` 作为 Extension 的生命周期判据（2026-08-31 review 二轮 P1）。
//
// 核心那条：**「Fiber 被卸载」不等于「用户要退出」**。上一版把两者并进同一个 stopper，
// 于是任何 unmount 都会让 `shell.exited` resolve，CLI 接着 `echo.stop()`——
// 将来一次 agent-boundary reload 就会直接关掉整个 Runtime。换代应当只是换一份界面。
//
// 壳怎么装就怎么测：交给 `createEcho({ extensions })` mount，`AgentRuntimeService` 由 `echo:agent` 那条内建给，
// 与产品的交互形态（`packages/base/src/cli.ts` 的 `runInteractive`）同一条路。

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, createProvider, type Echo, type Provider } from "@echo-agent/core";
import { scriptedStreams, textTurn } from "@echo-agent/core/testing";
import { tuiShell, type TuiShell } from "../src/extension.ts";
import { fakeTui } from "../src/testing.ts";

// 记忆与技能在 ECHO_HOME 下，`stateDir` 管不到：不隔离就会读到开发机上真的 `~/.echo`
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-tui-ext-home-"));
const stateRoot = mkdtempSync(join(tmpdir(), "echo-tui-ext-state-"));
afterAll(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

function scriptedProvider(): Provider {
  return createProvider({
    id: "t",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "scripted" }],
    api: scriptedStreams([textTurn("好")]),
  });
}

/** 产品怎么装壳就怎么装：壳是 `extensions` 里的一条，装完 `start()`。 */
async function echoWithShell(shell: TuiShell): Promise<Echo> {
  const echo = await createEcho({
    provider: scriptedProvider(),
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
    stateDir: await mkdtemp(join(stateRoot, "s-")),
    extensions: [{ entryId: "echo:tui", definition: shell.definition }],
  });
  await echo.start();
  return echo;
}

test("unmount 只是换代：界面停下来，但**不结算** exited（不该拖垮整个 Runtime）", async () => {
  const ui = fakeTui();
  const shell = tuiShell({ ui });

  let settled = false;
  void shell.exited.then(() => {
    settled = true;
  });

  const echo = await echoWithShell(shell);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  // 壳真的经 extension 挂上、拿到了装配出来的那份协议：界面起来了，欢迎头报的是这条装配的模型
  expect(echo.extensions.map((e) => e.entryId)).toContain("echo:tui");
  expect(ui.screen()).toContain("模型 only");

  await echo.stop(); // 先卸 Extension（含壳）再停 Agent——壳这一代被 unmount
  for (let i = 0; i < 50; i++) await Promise.resolve();

  // 上一版这里 `settled === true`：CLI 会据此 `echo.stop()`，把整个 Runtime 关掉
  expect(settled).toBe(false);
});

test("进程信号才结算 exited——那是「真要退出」", async () => {
  const controller = new AbortController();
  const shell = tuiShell({ ui: fakeTui(), signal: controller.signal });

  const echo = await echoWithShell(shell);
  for (let i = 0; i < 50; i++) await Promise.resolve();

  controller.abort();
  expect(await shell.exited).toEqual({ code: 0 }); // 没有 `resume`：这是「退出」不是「换段」
  await echo.stop();
});

test("**已经 abort 过**的进程信号：不许挂着——注册监听器等不到一个已经过去的事件", async () => {
  // `addEventListener` 只等**将来**的 abort。SIGINT 落在 `createEcho()` 或 Fiber 启动期间时，
  // 等 Extension 装上、监听器注册好，那次 abort 早就过去了：`runTui()` 收到的是一个全新的、
  // 没 abort 过的 `stopper.signal`，于是 `exited` 永远挂着，进程也就永远不退。
  //
  // 同一个坑 `stdin.ts` 修过一次（那边是 readline 永久等下一行）——**经验没跟着搬进包装层**。
  const controller = new AbortController();
  controller.abort(); // 先 abort，再装
  const shell = tuiShell({ ui: fakeTui(), signal: controller.signal });

  const echo = await echoWithShell(shell);

  // 判据是**它会结算**，不是「结算成某个码」：挂住的那一版在这里永久等待。
  // 用超时兜底，否则测试自己也会挂——那样反倒看不出是它在挂。
  const settled = await Promise.race([
    shell.exited.then(() => "settled" as const),
    new Promise<"hung">((r) => setTimeout(() => r("hung"), 2000)),
  ]);
  expect(settled).toBe("settled");
  await echo.stop();
});

test("换代不累积 listener：每代 unmount 都把挂在进程信号上的那个摘掉", async () => {
  // `opts.signal` 是**跨代活着**的进程信号。每代挂一个匿名监听器而不摘，
  // 换代多了就是一串泄漏——而且它们还都指着已经死掉的那一代。
  // 三代照 `/resume` 换段的形状走：同一个进程信号，每段开一份壳、装一个 Echo、收摊。
  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    value: (...args: Parameters<typeof realAdd>) => {
      added += 1;
      return realAdd(...args);
    },
    configurable: true,
  });
  Object.defineProperty(signal, "removeEventListener", {
    value: (...args: Parameters<typeof realRemove>) => {
      removed += 1;
      return realRemove(...args);
    },
    configurable: true,
  });

  for (let generation = 0; generation < 3; generation++) {
    const echo = await echoWithShell(tuiShell({ ui: fakeTui(), signal }));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await echo.stop();
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  // 挂几个就得摘几个。上一版 `removed === 0`——三代之后进程信号上挂着三个死监听器
  expect(added).toBeGreaterThan(0); // 真挂过（不然下面那条是空判据）
  expect([added, removed]).toEqual([added, added]);
});
