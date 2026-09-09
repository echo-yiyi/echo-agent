// agent 级选项的声明口（2026-09-09 用户拍板）：扩展经 `AgentPolicies` 声明权限策略、迭代预算、提问策略。
//
// **它解决什么**：在它之前这三样只有产品能给，于是「把工具与角色文件放进 `<cwd>/extensions/`，
// echo-agent 就长成另一个 agent」这条路永远差一截——能加工具、能换段，却改不了预算，
// 在仓库里 grep、read 几下就撞上 core 缺省的 20。判据落在**真 Agent 与真 ExtensionHost** 上：
// 声明之后 `agent.maxIterations` 真的变了，卸载之后真的回到产品给的初值。

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { AgentPolicies, agentRegistries } from "../src/extension/registries.ts";
import { defineExtension } from "../src/extension/abi.ts";
import { ExtensionHost } from "../src/extension/host.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn } from "../src/testing.ts";
import type { DeclaredPolicies } from "../src/policies.ts";

/** 一条只做一件事的扩展：把 config 里那几项声明上去。 */
const DECLARING = defineExtension({
  name: "test:policies",
  hostAbiVersion: 1,
  inject: { policies: { service: AgentPolicies, required: true } },
  config: (input: unknown): DeclaredPolicies => input as DeclaredPolicies,
  apply(ctx, config) {
    void ctx.effect({
      boundary: "agent",
      start: () => {
        const off = ctx.get(AgentPolicies).declare(config);
        return { value: null, dispose: () => void off() };
      },
    });
  },
});

function setup(opts: { maxIterations?: number } = {}): { agent: Agent; host: ExtensionHost } {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("好")]),
    ...(opts.maxIterations === undefined ? {} : { maxIterations: opts.maxIterations }),
  });
  const host = new ExtensionHost({
    services: agentRegistries({ tools: agent.tools, hooks: agent.hooks, policies: agent.policySlots }),
  });
  return { agent, host };
}

const mount = (host: ExtensionHost, gen: string, config: DeclaredPolicies): Promise<unknown> =>
  host.mount(gen, [{ entryId: "test:policies", definition: DECLARING as never, config }]);

test("扩展声明迭代预算：Agent 现读到新值；卸载回到产品给的初值", async () => {
  const { agent, host } = setup({ maxIterations: 20 });
  expect(agent.maxIterations).toBe(20);

  await mount(host, "g1", { maxIterations: 200 });
  expect(agent.maxIterations).toBe(200);

  await host.unmount("g1");
  expect(agent.maxIterations).toBe(20); // 回到初值，不是回到 core 缺省
});

test("权限与提问策略同理：声明之后 run 入口那道「没人回答就别开 run」的判据按新策略走", async () => {
  const { agent, host } = setup();
  // 缺省：没给 permission = 全放行，`acceptsWork` 与订阅者无关
  expect(agent.acceptsWork).toBe(true);
  await agent.start();

  // 声明一条「等人不超时、宿主会答」的策略，但没有任何 subscribeLifecycle 订阅者 → run 入口拒绝
  await mount(host, "g1", {
    permission: { askTimeoutMs: null, responder: "host", authorize: () => ({ kind: "ask", reason: "要人批" }) },
  });
  await expect(agent.prompt("跑一轮")).rejects.toThrow(/无人回答/);

  await host.unmount("g1");
  const r = await agent.prompt("跑一轮"); // 策略撤了，照跑
  expect(r.outcome.kind).toBe("completed");
  await agent.stop();
});

test("一项只能有一个声明者：第二个扩展撞上同一项 fail-loud，先来的那份不受影响", async () => {
  const { agent, host } = setup({ maxIterations: 20 });
  await mount(host, "g1", { maxIterations: 200 });
  await expect(mount(host, "g2", { maxIterations: 50 })).rejects.toThrow(/maxIterations.*只能有一个声明者/);
  expect(agent.maxIterations).toBe(200); // 先来的仍然生效
});

test("整组原子：一组里有一项撞了，同组已生效的那几项一起回滚", async () => {
  const { agent, host } = setup({ maxIterations: 20 });
  await mount(host, "g1", { maxIterations: 200 });
  const before = agent.policySlots.values.questions.responder;

  // 这一组先给 questions（能过）、再给 maxIterations（撞）——questions 不许留下
  await expect(mount(host, "g2", { questions: { responder: "host" }, maxIterations: 50 })).rejects.toThrow(/只能有一个声明者/);
  expect(agent.policySlots.values.questions.responder).toBe(before);
  expect(agent.maxIterations).toBe(200);
});

test("验形与构造期同一套：预算要正整数，权限 / 提问策略走原来那两个验形函数", async () => {
  const { host } = setup();
  await expect(mount(host, "g1", { maxIterations: 0 })).rejects.toThrow(/正整数/);
  await expect(mount(host, "g2", { maxIterations: 1.5 })).rejects.toThrow(/正整数/);
  await expect(mount(host, "g3", { questions: { responder: "bogus" } as never })).rejects.toThrow(/responder/);
  await expect(
    mount(host, "g4", { permission: { askTimeoutMs: null, authorize: () => ({ kind: "allow" }) } as never }),
  ).rejects.toThrow(/responder/); // 等人不超时却没声明谁答：构造期那条判据在这里同样成立
});

test("Host 没接上持有者（假 Host）：declare 抛，不静默装上不生效", () => {
  const [, registry] = agentRegistries({ tools: new Map(), hooks: new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) }).hooks })
    .find(([key]) => key === (AgentPolicies as unknown))!;
  expect(() => (registry as { declare: (p: DeclaredPolicies) => unknown }).declare({ maxIterations: 200 })).toThrow(/没接上/);
});
