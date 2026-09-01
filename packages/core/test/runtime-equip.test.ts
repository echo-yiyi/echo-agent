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
import { scriptedStreamFn, textTurn } from "../src/testing.ts";

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
