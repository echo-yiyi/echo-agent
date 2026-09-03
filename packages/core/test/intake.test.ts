// §14 RunIntakeGate：steer / followUp 的原子裁决与显式 rejected。
// 反例优先：每条都先写「上一版会怎么错」。
// （AgentEvent 进 canonical journal 的顺序保证在 observability-runtime.test.ts：sourceSeq 随 seq 单调。）

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, errorTurn, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { LifecycleEvent } from "../src/events.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { RunIntakeGate } from "../src/loop/intake.ts";
import { defaultConvertToLlm, userMessage } from "../src/messages.ts";
import { runAgentLoop } from "../src/loop/run-loop.ts";
import type { AgentLoopConfig } from "../src/loop/types.ts";
import { DEFAULT_RETRY_POLICY } from "../src/provider/dialect.ts";
import { EMPTY_COMPACTION } from "../src/compaction/types.ts";

function tool(name: string, execute: ModelTool["execute"]): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute };
}

function lifecycle(agent: Agent): LifecycleEvent[] {
  const seen: LifecycleEvent[] = [];
  agent.subscribeLifecycle((e) => {
    seen.push(e);
  });
  return seen;
}

function transcript(agent: Agent): string[] {
  return agent.state.messages.map((m) => {
    if (m.role === "user") {
      const text = m.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
      return `user(${m.source ?? "?"}):${text}`;
    }
    return m.role;
  });
}

/* ─────────────── 裁决：没有 run / turn 就 rejected，不入队、不抛 ─────────────── */

test("idle：steer 是 rejected(no-active-turn)、followUp 是 rejected(no-active-run)；不入队，下一次 prompt 看不到它们", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok")]),
  });
  expect(await agent.steer("插话")).toEqual({ kind: "rejected", reason: "no-active-turn" });
  expect(await agent.followUp("跟进")).toEqual({ kind: "rejected", reason: "no-active-run" });
  await agent.prompt("go");
  // 上一版：两条都进了队列，prompt 起来的循环轮末把「插话」捞进这次 run——静默转入了下一个 run
  expect(transcript(agent)).toEqual(["user(human):go", "assistant"]);
});

test("run 里 followUp accepted（带 runId / agentInstanceId），同一 run 内消费；run 关门后 accepted 的不会漏", async () => {
  let agent!: Agent;
  let result: Awaited<ReturnType<Agent["followUp"]>> | undefined;
  const t = tool("t", async () => {
    result = await agent.followUp("跟进");
    return toolOk("ok");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok"), textTurn("ok2")]),
    tools: [t],
  });
  await agent.prompt("go");
  expect(result).toMatchObject({ kind: "accepted", runId: expect.stringMatching(/^run:/), agentInstanceId: expect.stringMatching(/^default@/) });
  expect(transcript(agent)).toEqual(["user(human):go", "assistant", "toolResult", "assistant", "user(human):跟进", "assistant"]);
});

test("steer 在 tool 里 accepted（带 turnId）：本 turn 关门时并入，工具结果之后、下一轮模型调用之前", async () => {
  let agent!: Agent;
  let result: Awaited<ReturnType<Agent["steer"]>> | undefined;
  const t = tool("t", async () => {
    result = await agent.steer("插话");
    return toolOk("ok");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [t],
  });
  await agent.prompt("go");
  expect(result).toMatchObject({ kind: "accepted", turnId: expect.stringMatching(/^run:.*#1$/) });
  // 上一版：tool_use 的轮不捞 steering，「插话」要攒到某个收尾的轮才进 transcript（这里直到 run 结束都没进）
  expect(transcript(agent)).toEqual(["user(human):go", "assistant", "toolResult", "user(steer):插话", "assistant"]);
});

test("turn 关门之后、run 还开着：steer 是 rejected(no-active-turn)，followUp 仍 accepted（stop hook 期间）", async () => {
  const hooks = new HookRuntime();
  let agent!: Agent;
  const steerResults: string[] = [];
  const followUpResults: string[] = [];
  let asked = false;
  hooks.on("stop", async () => {
    if (asked) return undefined;
    asked = true;
    // 走到 stop hook = 内层已收尾、turn 已关门、run 还开着
    const s = await agent.steer("插话");
    steerResults.push(s.kind === "accepted" ? "accepted" : s.reason);
    followUpResults.push((await agent.followUp("跟进")).kind);
    return undefined; // 不 block
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok"), textTurn("ok2")]),
    hooks,
  });
  await agent.prompt("go");
  expect(steerResults).toEqual(["no-active-turn"]);
  expect(followUpResults).toEqual(["accepted"]);
  // 上一版：followUp 在 stop hook 之后到达——队列已经捞过、循环随即 break，这条 accepted 的消息静默消失
  expect(transcript(agent)).toEqual(["user(human):go", "assistant", "user(human):跟进", "assistant"]);
});

test("run 关门与 agent_end 的顺序：agent_end 的订阅者再 followUp 已是 rejected(no-active-run)", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok")]),
  });
  const results: string[] = [];
  agent.subscribe(async (e) => {
    if (e.type === "agent_end") results.push((await agent.followUp("晚到")).kind);
  });
  await agent.prompt("go");
  expect(results).toEqual(["rejected"]);
  expect(transcript(agent)).toEqual(["user(human):go", "assistant"]);
});

test("abort 时 accepted 却没消费的 followUp：显式报出 [queue_dropped]、队列清空，下一次 prompt 不会捡到", async () => {
  let agent!: Agent;
  const t = tool("t", async () => {
    await agent.followUp("跟进");
    agent.abort("测试");
    return toolOk("ok");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok"), textTurn("ok2")]),
    tools: [t],
  });
  const seen = lifecycle(agent);
  const first = await agent.prompt("go");
  expect(first.outcome.kind).toBe("aborted");
  const dropped = seen.filter((e) => e.type === "notification" && e.message.includes("[queue_dropped]"));
  expect(dropped).toHaveLength(1);
  expect((dropped[0] as { message: string }).message).toContain("followUp 1 条");
  await agent.prompt("again");
  // 上一版：「跟进」留在队列里，下一次 run 的收尾把它捞走
  expect(transcript(agent).filter((x) => x.includes("跟进"))).toEqual([]);
});

test("dispose 之后：steer / followUp 都是 rejected(runtime-disposed)", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok")]),
  });
  await agent.dispose();
  expect(await agent.steer("x")).toEqual({ kind: "rejected", reason: "runtime-disposed" });
  expect(await agent.followUp("x")).toEqual({ kind: "rejected", reason: "runtime-disposed" });
});

test("continue()：末条是 assistant 直接抛（idle 时队列必空，没有「捞队列当新一轮」这条路）", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok")]),
  });
  await agent.prompt("go");
  await expect(agent.continue()).rejects.toThrow("无从续跑");
});

/* ─────────────── gate 本体：同步原子 ─────────────── */

test("RunIntakeGate：裁决与入队同一同步步；关门那一刻队列里的全部交出，之后的一律 rejected", () => {
  const gate = new RunIntakeGate("a@1");
  const m = (t: string) => userMessage(t, "human");
  expect(gate.followUp(m("1"))).toEqual({ kind: "rejected", reason: "no-active-run" });
  gate.openRun("run:1");
  expect(gate.steer(m("s"))).toEqual({ kind: "rejected", reason: "no-active-turn" });
  expect(gate.followUp(m("f1"))).toEqual({ kind: "accepted", agentInstanceId: "a@1", runId: "run:1" });
  gate.openTurn("run:1#1");
  expect(gate.steer(m("s1"))).toEqual({ kind: "accepted", agentInstanceId: "a@1", runId: "run:1", turnId: "run:1#1" });
  expect(gate.closeTurn().map((x) => x.content)).toEqual([m("s1").content]);
  expect(gate.steer(m("s2")).kind).toBe("rejected"); // turn 已关
  // 关 run：有货 → 交出、门仍开
  expect(gate.tryCloseRun()?.length).toBe(1);
  expect(gate.followUp(m("f2")).kind).toBe("accepted"); // 门还开着
  expect(gate.tryCloseRun()?.length).toBe(1);
  // 队列空 → 关门
  expect(gate.tryCloseRun()).toBeNull();
  expect(gate.followUp(m("f3"))).toEqual({ kind: "rejected", reason: "no-active-run" });
  // 重复 openRun 是编程错误
  gate.openRun("run:2");
  expect(() => gate.openRun("run:3")).toThrow("还没关门");
  // 强制关门交还未消费的
  gate.openTurn("run:2#1");
  gate.steer(m("s"));
  gate.followUp(m("f"));
  expect(gate.closeRun()).toMatchObject({ steers: [expect.anything()], followUps: [expect.anything()] });
  expect(gate.closeRun()).toEqual({ steers: [], followUps: [] });
  gate.dispose();
  expect(gate.followUp(m("x"))).toEqual({ kind: "rejected", reason: "runtime-disposed" });
});

test("RunIntakeGate：turn 没关就开下一轮（重试路径）→ accepted 的 steer 顺延到新 turn，不丢", () => {
  const gate = new RunIntakeGate("a@1");
  gate.openRun("run:1");
  gate.openTurn("run:1#1");
  gate.steer(userMessage("s", "steer"));
  gate.openTurn("run:1#1"); // 同一 iteration 重跑
  expect(gate.closeTurn()).toHaveLength(1);
});

/* ─────────────── 退出路径：六类都在 agent_end 之前关门 ─────────────── */

/** agent_end 的订阅者再 steer / followUp：两个都必须是 rejected——run 已经结束，不能给假 accepted。 */
function assertClosedAtAgentEnd(agent: Agent): () => Promise<void> {
  const seen: string[] = [];
  agent.subscribe(async (e) => {
    if (e.type !== "agent_end") return;
    const f = await agent.followUp("晚到");
    const s = await agent.steer("晚到");
    seen.push(f.kind === "rejected" ? f.reason : "accepted", s.kind === "rejected" ? s.reason : "accepted");
  });
  return async () => {
    expect(seen).toEqual(["no-active-run", "no-active-turn"]);
  };
}

test("退出路径 completed：agent_end 时 intake 已关", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("ok")]) });
  const check = assertClosedAtAgentEnd(agent);
  expect((await agent.prompt("go")).outcome.kind).toBe("completed");
  await check();
});

test("退出路径 aborted：agent_end 时 intake 已关；tool 里 accepted 的 followUp 以 [queue_dropped] 报出，不是假 accepted 之后静默", async () => {
  let agent!: Agent;
  const t = tool("t", async () => {
    await agent.followUp("跟进");
    agent.abort("测试");
    return toolOk("ok");
  });
  agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]), tools: [t] });
  const seen = lifecycle(agent);
  const check = assertClosedAtAgentEnd(agent);
  expect((await agent.prompt("go")).outcome.kind).toBe("aborted");
  await check();
  expect(seen.filter((e) => e.type === "notification" && e.message.includes("[queue_dropped]"))).toHaveLength(1);
});

test("退出路径 error（provider 不可重试错误）：agent_end 时 intake 已关", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([errorTurn("provider_error", "boom", false)]) });
  const check = assertClosedAtAgentEnd(agent);
  expect((await agent.prompt("go")).outcome.kind).toBe("error");
  await check();
});

test("退出路径 timeout：agent_end 时 intake 已关", async () => {
  const t = tool("t", async () => {
    await new Promise((r) => setTimeout(r, 40));
    return toolOk("ok");
  });
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [t],
    timeoutMs: 15,
  });
  const check = assertClosedAtAgentEnd(agent);
  const result = await agent.prompt("go");
  expect(result.outcome).toMatchObject({ kind: "error", error: { code: "timeout" } });
  await check();
});

test("退出路径 max-iterations：agent_end 时 intake 已关", async () => {
  const t = tool("t", async () => toolOk("ok"));
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [t],
    maxIterations: 1,
  });
  const check = assertClosedAtAgentEnd(agent);
  const result = await agent.prompt("go");
  expect(result.outcome).toMatchObject({ kind: "error", error: { code: "max_iterations" } });
  await check();
});

test("退出路径 shouldStopAfterTurn（loop 级决策点，Agent 不暴露）：agent_end 时 intake 已关", async () => {
  const gate = new RunIntakeGate("a@1");
  gate.openRun("run:x");
  const seen: string[] = [];
  const config: AgentLoopConfig = {
    model: FAKE_MODEL,
    runId: "run:x",
    convertToLlm: defaultConvertToLlm,
    getTools: () => [],
    knownToolNames: () => [],
    resolveTool: () => ({ ok: false, reason: "not_found" }),
    hooks: new HookRuntime(),
    hookContext: { origin: "model", depth: 0, hookId: "test" },
    permission: {
      authorize: () => ({ kind: "allow" }),
      ask: () => {
        throw new Error("不该 ask");
      },
    },
    maxIterations: 5,
    retryPolicy: DEFAULT_RETRY_POLICY,
    compaction: { getStages: () => [] },
    workspace: process.cwd(),
    shouldStopAfterTurn: () => true,
    intake: {
      openTurn: (id) => gate.openTurn(id),
      closeTurn: async () => gate.closeTurn(),
      drainFollowUps: async () => gate.drainFollowUps(),
      tryCloseRun: async () => gate.tryCloseRun(),
      closeRun: () => void gate.closeRun(),
    },
  };
  const result = await runAgentLoop(
    [userMessage("go", "human")],
    { systemPrompt: null, messages: [], compaction: EMPTY_COMPACTION },
    config,
    async (e) => {
      if (e.type === "agent_end") seen.push(gate.followUp(userMessage("晚到", "human")).kind, gate.steer(userMessage("晚到", "steer")).kind);
    },
    new AbortController().signal,
    scriptedStreamFn([textTurn("ok")]),
  );
  expect(result.outcome.kind).toBe("completed");
  // 上一版：shouldStopAfterTurn 直接 break outer → agent_end，这时 gate 还开着，两个都是 accepted
  expect(seen).toEqual(["rejected", "rejected"]);
});
