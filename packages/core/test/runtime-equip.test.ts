// `AgentRuntime` 装备面（P3a，2026-09-01 拍板）的判据：setModel / setThinkingLevel / reset。
//
// 测的是**收窄层**（`agentRuntimeOf`），不是 Agent 的 setter 本身——壳子拿到的就是这一层。
// 三条硬语义：
//   · 忙时 `rejected` 带原因，**不抛不排队**（与 steer / followUp 的显式结果同款）；
//   · 形状不合格（`normalizeModelSnapshot` 判红）也是 `rejected`，装备原样不动；
//   · 绿灯 = 下一轮生效——本轮不撕裂由 admission 冻结 binding 保证（那头有自己的 conformance）。

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { agentRuntimeOf } from "../src/extension/builtin.ts";
import { scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";

function agentWith(turns: ReturnType<typeof textTurn>[] = [textTurn("好")]): Agent {
  return new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn(turns),
  });
}

test("idle：setModel accepted，状态换过去；setThinkingLevel 同理", async () => {
  const agent = agentWith();
  const rt = agentRuntimeOf(agent);

  expect(await rt.setModel({ provider: "t", id: "other", api: "scripted" })).toEqual({ kind: "accepted" });
  expect(rt.state.model.id).toBe("other");

  expect(await rt.setThinkingLevel("high")).toEqual({ kind: "accepted" });
  expect(rt.state.thinkingLevel).toBe("high");
});

test("忙时（prompt 刚发出、permit 还没落位）：rejected 带原因，装备原样不动，**不抛**", async () => {
  const agent = agentWith();
  const rt = agentRuntimeOf(agent);

  const running = rt.prompt("跑一轮"); // 不 await：同一 tick 里 userRunPending 已置上
  const result = await rt.setModel({ provider: "t", id: "other", api: "scripted" });

  expect(result.kind).toBe("rejected");
  expect(result.kind === "rejected" && result.reason).toContain("正在运行");
  expect(rt.state.model.id, "拒了却把装备换了").toBe("only");

  await running;
  // 跑完了就能换——「仅 idle」是时机不是禁令
  expect(await rt.setModel({ provider: "t", id: "other", api: "scripted" })).toEqual({ kind: "accepted" });
});

test("形状不合格：rejected（normalizeModelSnapshot 判红），不抛、装备不动", async () => {
  const agent = agentWith();
  const rt = agentRuntimeOf(agent);

  // `params` 里塞一个函数：JSON-like 判红——admission 冻结时才发现就晚了，装备期就得拦
  const bad = { provider: "t", id: "bad", api: "scripted", params: { f: () => 1 } } as never;
  const result = await rt.setModel(bad);

  expect(result.kind).toBe("rejected");
  expect(rt.state.model.id).toBe("only");
});

test("reset：清 transcript 与运行态（usage 归零），装备不动；忙时同样 rejected", async () => {
  const agent = agentWith([textTurn("第一句")]);
  const rt = agentRuntimeOf(agent);
  await rt.setThinkingLevel("high");
  await rt.prompt("说一句");
  expect(rt.state.messages.length).toBeGreaterThan(0);

  expect(await rt.reset()).toEqual({ kind: "accepted" });
  expect(rt.state.messages).toEqual([]);
  expect(rt.state.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  expect(rt.state.thinkingLevel, "reset 把装备也清了——它只该清对话与运行态").toBe("high");

  const agent2 = agentWith();
  const rt2 = agentRuntimeOf(agent2);
  const running = rt2.prompt("在跑");
  expect((await rt2.reset()).kind).toBe("rejected");
  await running;
});

/* ─────────────── usage 的缓存累计（与状态栏那格同一条数据线） ─────────────── */

import type { ProviderEvent } from "../src/events.ts";

/** 带 usage 的一轮（textTurn 的 usage 是 null，测账就得自己带）。 */
function turnWithUsage(text: string, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }): ProviderEvent[] {
  return [
    {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn", usage },
    },
  ];
}

test("缓存命中逐轮累计；报过一次之后即使后面某轮没报，累计值也不丢；reset 归零回缺席", async () => {
  const agent = agentWith([
    turnWithUsage("一", { inputTokens: 100, outputTokens: 5, cachedInputTokens: 60 }) as never,
    turnWithUsage("二", { inputTokens: 40, outputTokens: 5 }) as never,
  ]);
  const rt = agentRuntimeOf(agent);

  await rt.prompt("1");
  expect(rt.state.usage).toEqual({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 60 });

  await rt.prompt("2");
  expect(rt.state.usage).toEqual({ inputTokens: 140, outputTokens: 10, cachedInputTokens: 60 });

  await rt.reset();
  expect(rt.state.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  expect(Object.hasOwn(rt.state.usage, "cachedInputTokens"), "reset 之后不该还挂着缓存字段").toBe(false);
});

test("从没报过缓存：字段全程缺席（没报 ≠ 0）", async () => {
  const agent = agentWith([turnWithUsage("好", { inputTokens: 10, outputTokens: 2 }) as never]);
  const rt = agentRuntimeOf(agent);
  await rt.prompt("hi");
  expect(Object.hasOwn(rt.state.usage, "cachedInputTokens")).toBe(false);
});

test("setWorkspace（2026-09-03 worktree 隔离）：跑着也能换；同一轮里下一个工具就看到新目录；空串 rejected", async () => {
  let rt!: ReturnType<typeof agentRuntimeOf>;
  const seen: string[] = [];
  const switchTool: ModelTool = {
    kind: "model",
    name: "switch",
    label: "switch",
    description: "switch workspace",
    parameters: { type: "object", properties: {} },
    execute: async (_p, ctx) => {
      seen.push(ctx.workspace);
      const r = await rt.setWorkspace("/repo/.echo/worktrees/a");
      return toolOk(r.kind);
    },
  };
  const whereTool: ModelTool = {
    kind: "model",
    name: "where",
    label: "where",
    description: "report workspace",
    parameters: { type: "object", properties: {} },
    execute: async (_p, ctx) => {
      seen.push(ctx.workspace);
      return toolOk(ctx.workspace);
    },
  };
  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn([toolTurn("t1", "switch", {}), toolTurn("t2", "where", {}), textTurn("好")]),
    tools: [switchTool, whereTool],
    workspace: "/repo",
  });
  rt = agentRuntimeOf(agent);
  const r = await rt.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  // 第一件工具在 /repo 起，它切了目录；第二件（同一轮）已经在新目录
  expect(seen).toEqual(["/repo", "/repo/.echo/worktrees/a"]);
  expect(rt.state.workspace).toBe("/repo/.echo/worktrees/a");

  expect(await rt.setWorkspace("")).toEqual({ kind: "rejected", reason: expect.stringContaining("非空") });
  expect(rt.state.workspace).toBe("/repo/.echo/worktrees/a");
});
