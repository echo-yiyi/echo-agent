// `echo:tui` 作为 Extension 的生命周期判据（2026-08-31 review 二轮 P1）。
//
// 核心那条：**「Fiber 被卸载」不等于「用户要退出」**。上一版把两者并进同一个 stopper，
// 于是任何 unmount 都会让 `shell.exited` resolve，CLI 接着 `echo.stop()`——
// 将来一次 agent-boundary reload 就会直接关掉整个 Runtime。换代应当只是换一份界面。

import { test, expect } from "bun:test";
import { Agent } from "@echo-agent/core";
import { scriptedStreamFn, textTurn, FAKE_MODEL } from "@echo-agent/core/testing";
import { ExtensionHost, agentRegistries, agentRuntimeOf, AgentRuntimeService, defineExtension } from "@echo-agent/core/extension";
import { HookRuntime } from "@echo-agent/core";
import { tuiShell } from "../src/extension.ts";
import { fakeTui } from "./fake-tui.ts";

function hostWith(agent: Agent): ExtensionHost {
  const host = new ExtensionHost({
    services: agentRegistries({
      tools: agent.tools,
      hooks: agent.hooks,
      prompt: { sections: agent.promptSections, variables: agent.promptVariables }, // 壳注册 surface 段要它
    }),
  });
  return host;
}

/** 把 runtime 作为 Service 提供出去——真实里这是 `echo:agent` 干的。 */
function runtimeProvider(agent: Agent) {
  return defineExtension({
    name: "echo:agent",
    hostAbiVersion: 1,
    provide: [AgentRuntimeService as never],
    apply(ctx) {
      ctx.provide(AgentRuntimeService, agentRuntimeOf(agent));
    },
  });
}

const agentWith = (): Agent => new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("好")]) });

test("unmount 只是换代：界面停下来，但**不结算** exited（不该拖垮整个 Runtime）", async () => {
  const agent = agentWith();
  const host = hostWith(agent);
  const ui = fakeTui();
  const shell = tuiShell({ ui });

  let settled = false;
  void shell.exited.then(() => {
    settled = true;
  });

  await host.mount("g1", [
    { entryId: "echo:agent", definition: runtimeProvider(agent) as never },
    { entryId: "echo:tui", definition: shell.definition as never },
  ]);
  for (let i = 0; i < 50; i++) await Promise.resolve();

  await host.unmount("g1");
  for (let i = 0; i < 50; i++) await Promise.resolve();

  // 上一版这里 `settled === true`：CLI 会据此 `echo.stop()`，把整个 Runtime 关掉
  expect(settled).toBe(false);
  expect(host.mountedGenerations).toEqual([]);
});

test("进程信号才结算 exited——那是「真要退出」", async () => {
  const agent = agentWith();
  const host = hostWith(agent);
  const controller = new AbortController();
  const shell = tuiShell({ ui: fakeTui(), signal: controller.signal });

  await host.mount("g1", [
    { entryId: "echo:agent", definition: runtimeProvider(agent) as never },
    { entryId: "echo:tui", definition: shell.definition as never },
  ]);
  for (let i = 0; i < 50; i++) await Promise.resolve();

  controller.abort();
  expect(await shell.exited).toBe(0);
});

test("**已经 abort 过**的进程信号：不许挂着——注册监听器等不到一个已经过去的事件", async () => {
  // `addEventListener` 只等**将来**的 abort。SIGINT 落在 `createEcho()` 或 Fiber 启动期间时，
  // 等 Extension 装上、监听器注册好，那次 abort 早就过去了：`runTui()` 收到的是一个全新的、
  // 没 abort 过的 `stopper.signal`，于是 `exited` 永远挂着，进程也就永远不退。
  //
  // 同一个坑 `stdin.ts` 修过一次（那边是 readline 永久等下一行）——**经验没跟着搬进包装层**。
  const controller = new AbortController();
  controller.abort(); // 先 abort，再装
  const agent = agentWith();
  const host = hostWith(agent);
  const shell = tuiShell({ ui: fakeTui(), signal: controller.signal });

  await host.mount("g1", [
    { entryId: "echo:agent", definition: runtimeProvider(agent) as never },
    { entryId: "echo:tui", definition: shell.definition as never },
  ]);

  // 判据是**它会结算**，不是「结算成某个码」：挂住的那一版在这里永久等待。
  // 用超时兜底，否则测试自己也会挂——那样反倒看不出是它在挂。
  const settled = await Promise.race([
    shell.exited.then(() => "settled" as const),
    new Promise<"hung">((r) => setTimeout(() => r("hung"), 2000)),
  ]);
  expect(settled).toBe("settled");
});

test("换代不累积 listener：每代 unmount 都把挂在进程信号上的那个摘掉", async () => {
  // `opts.signal` 是**跨代活着**的进程信号。每代挂一个匿名监听器而不摘，
  // 换代多了就是一串泄漏——而且它们还都指着已经死掉的那一代。
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

  const agent = agentWith();
  const host = hostWith(agent);
  const shell = tuiShell({ ui: fakeTui(), signal });

  for (const generation of ["g1", "g2", "g3"]) {
    await host.mount(generation, [
      { entryId: "echo:agent", definition: runtimeProvider(agent) as never },
      { entryId: "echo:tui", definition: shell.definition as never },
    ]);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await host.unmount(generation);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  // 挂几个就得摘几个。上一版 `removed === 0`——三代之后进程信号上挂着三个死监听器
  expect([added, removed]).toEqual([added, added]);
});
