// 行为不变量的门：设计上点名要逐条配测试的那几条都在这里。
//
// 这些不是「覆盖率」测试，是**契约的执行点**：任何一条红了，都意味着某个设计承诺
// 已经不成立，而不是某段代码写歪了。

import { test, expect } from "bun:test";
import { registerTool, unregisterTool, listTools } from "../src/tools/harness.ts";
import { Agent } from "../src/agent.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { defaultConvertToLlm, userMessage, toolResultMessage, assistantMessage } from "../src/messages.ts";
import type { AgentEvent } from "../src/events.ts";
import type { Context } from "../src/messages.ts";
import type { Model, StreamOptions } from "../src/provider/types.ts";
import {
  FAKE_MODEL,
  bareDoneTurn,
  errorTurn,
  scriptedStreamFn,
  textTurn,
  toolTurn,
} from "../src/testing.ts";

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
  });
  return events;
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

/* ═══════════ 不变量 1：每个定稿消息必有成对的 message_start / message_end ═══════════ */

test("规范后端：start 在前、end 在后，成对", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("你好")]) });
  const events = collect(agent);
  await agent.prompt("在吗");

  const t = types(events);
  expect(t.filter((x) => x === "message_start").length).toBe(1);
  // 用户消息也走 message_end（单一 append 路径），所以这里是 2 条
  expect(t.filter((x) => x === "message_end").length).toBe(2);
  expect(t.indexOf("message_start")).toBeLessThan(t.lastIndexOf("message_end"));
});

test("退化后端（只发 done，无流式）：补发 start，成对仍成立", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([bareDoneTurn("直出")]) });
  const events = collect(agent);
  await agent.prompt("问");

  const t = types(events);
  expect(t.filter((x) => x === "message_start").length).toBe(1); // ← 补发的那一个
  expect(agent.messages.at(-1)?.role).toBe("assistant");
});

/* ═══════════ 不变量 2：一次只跑一个 run ═══════════ */

test("跑的中途再 prompt 直接 throw，不排队也不并发", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("一"), textTurn("二")]) });
  const first = agent.prompt("第一件");
  await expect(agent.prompt("第二件")).rejects.toThrow(/正在处理/);
  await first;
  expect(agent.status).toBe("idle");
});

test("跑的中途换装备直接 throw（上下文与工具面不能撕裂）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("一")]) });
  const run = agent.prompt("做事");
  expect(() => {
    agent.thinkingLevel = "high";
  }).toThrow(/正在运行/);
  await run;
  agent.thinkingLevel = "high"; // idle 了就行
  expect(agent.thinkingLevel).toBe("high");
});

/* ═══════════ 不变量 3：跑完终值归零（进行中区回到初始，transcript 留下） ═══════════ */

test("跑完回 idle，进行中区归零，transcript 留下", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("答")]) });
  await agent.prompt("问");

  expect(agent.status).toBe("idle");
  expect(agent.state.streamingMessage).toBeUndefined();
  expect(agent.state.pendingToolCalls.size).toBe(0);
  expect(agent.state.startedAt).toBeNull();
  expect(agent.messages.length).toBe(2); // user + assistant
});

test("流式过程中 streamingMessage 是活的（逐字流式的落点）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("逐字")]) });
  let sawStreaming = false;
  agent.subscribe((e) => {
    if (e.type === "message_update" && agent.state.streamingMessage !== undefined) sawStreaming = true;
  });
  await agent.prompt("问");
  expect(sawStreaming).toBe(true);
  expect(agent.state.streamingMessage).toBeUndefined(); // 定稿后清空
});

/* ═══════════ 不变量 4：内层继续的两条路（tool_use / max_tokens） ═══════════ */

test("模型要工具 → 继续内层，工具结果入账", async () => {
  const echo: ModelTool = {
    kind: "model",
    name: "echo",
    label: "回声",
    description: "把输入原样返回",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    execute: async (params) => toolOk(`echo:${String((params as { text: string }).text)}`),
  };
  const agent = new Agent({
    model: FAKE_MODEL,
    tools: [echo],
    streamFunction: scriptedStreamFn([toolTurn("c1", "echo", { text: "hi" }), textTurn("完成")]),
  });
  const events = collect(agent);
  await agent.prompt("用工具");

  const t = types(events);
  expect(t).toContain("tool_execution_start");
  expect(t).toContain("tool_execution_end");
  expect(t.filter((x) => x === "turn_start").length).toBe(2); // 工具一轮 + 收尾一轮
  const toolMsg = agent.messages.find((m) => m.role === "toolResult");
  expect(toolMsg).toBeDefined();
  expect((toolMsg as { content: string }).content).toBe("echo:hi");
});

test("max_tokens 按可续跑：截断不是失败，模型接着写", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("前半", "max_tokens"), textTurn("后半")]),
  });
  const events = collect(agent);
  const result = await agent.prompt("写长文");

  expect(types(events).filter((x) => x === "turn_start").length).toBe(2);
  expect(result.outcome.kind).toBe("completed");
});

/* ═══════════ 不变量 5：错误沿数据流返回，不抛 ═══════════ */

test("不可重试的失败 → agent_end 带结构化 outcome，prompt 不 reject", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([errorTurn("auth", "凭据无效", false)]),
  });
  const result = await agent.prompt("问");

  expect(result.outcome.kind).toBe("error");
  if (result.outcome.kind === "error") {
    expect(result.outcome.error.code).toBe("auth");
    expect(result.outcome.error.retryable).toBe(false);
  }
  expect(agent.state.lastError?.code).toBe("auth");
  expect(agent.status).toBe("idle");
});

test("可重试的失败 → 循环自己重试；outcome=error 意味着真的没救了", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    retryPolicy: { maxAttempts: 2, backoffMs: () => 0 },
    streamFunction: scriptedStreamFn([errorTurn("rate_limit", "限流", true), textTurn("重试后成功")]),
  });
  const events = collect(agent);
  const result = await agent.prompt("问");

  expect(types(events)).toContain("retry_scheduled");
  expect(result.outcome.kind).toBe("completed");
});

/* ═══════════ 不变量 6：steering 圈内消费、followUp 圈外消费 ═══════════ */

test("steering 在内层轮末被并入，同一次 run 里继续", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("第一轮"), textTurn("第二轮")]),
  });
  agent.subscribe((e) => {
    // 在 turn 还开着时插话（assistant 定稿入账那一刻）：turn_end 发出时 turn intake 已经关了（closeTurn 在前），那时再 steer 是 rejected
    if (e.type === "message_end" && e.message.role === "assistant" && agent.state.iteration === 1) agent.steer("补充一句");
  });
  const events = collect(agent);
  await agent.prompt("开始");

  expect(types(events).filter((x) => x === "turn_start").length).toBe(2);
  const steered = agent.messages.find((m) => m.role === "user" && m.source === "steer");
  expect(steered).toBeDefined();
});

test("followUp 在内层收尾后被捞起，同一次 run 里再开一轮", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("第一件完成"), textTurn("第二件完成")]),
  });
  let queued = false;
  agent.subscribe((e) => {
    if (e.type === "turn_end" && !queued) {
      queued = true;
      agent.followUp("再做一件");
    }
  });
  const events = collect(agent);
  await agent.prompt("做第一件");

  expect(types(events).filter((x) => x === "turn_start").length).toBe(2);
  expect(types(events).filter((x) => x === "agent_end").length).toBe(1); // 同一次 run
});

/* ═══════════ 投影：AgentMessage → 线上形状 ═══════════ */

test("投影剥壳：at/source/usage/metadata 不出门", async () => {
  const out = await defaultConvertToLlm([
    userMessage("你好", "steer"),
    assistantMessage([{ type: "text", text: "回答" }], "end_turn", { inputTokens: 5, outputTokens: 3 }),
  ]);
  const json = JSON.stringify(out);
  expect(json).not.toContain("source");
  expect(json).not.toContain("usage");
  expect(json).not.toContain('"at"');
});

test("投影：toolResult 包回 user 角色的 tool_result 块，相邻的合并成一条", async () => {
  const out = await defaultConvertToLlm([
    toolResultMessage("c1", "t", "结果1", false, { secret: "不该出门" }),
    toolResultMessage("c2", "t", "结果2", false),
  ]);
  expect(out.length).toBe(1);
  expect(out[0]?.role).toBe("user");
  expect(out[0]?.content.length).toBe(2);
  expect(JSON.stringify(out)).not.toContain("secret");
});

test("投影：空 content 的 assistant 消息整条隐形（空消息是协议违规）", async () => {
  const out = await defaultConvertToLlm([assistantMessage([], "error")]);
  expect(out.length).toBe(0);
});

/* ═══════════ 工具注册面（ToolHarness） ═══════════ */

test("撞名 fail-loud；覆盖必须显式声明", () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const t = (name: string): ModelTool => ({
    kind: "model",
    name,
    label: name,
    description: "",
    parameters: {},
    execute: async () => toolOk("ok"),
  });
  registerTool(agent.tools, t("a"));
  expect(() => registerTool(agent.tools, t("a"))).toThrow(/replace/);
  registerTool(agent.tools, t("a"), { replace: true }); // 显式覆盖才行
  // 判据对准「同名只剩一份」，**不是工具总数**——Agent 自带 Task 那几件（2026-08-23 起），
  // 用总数当判据会把「默认给几个工具」这件无关的事绑进这条不变量。
  expect(listTools(agent.tools).filter((x) => x.name === "a").length).toBe(1);
});

test("构造时给的工具也经 harness（否则 inventory 与 requiredTools 校验会说谎）", () => {
  const echo: ModelTool = {
    kind: "model",
    name: "echo",
    label: "回声",
    description: "",
    parameters: {},
    execute: async () => toolOk("ok"),
  };
  const agent = new Agent({ model: FAKE_MODEL, tools: [echo], streamFunction: scriptedStreamFn([]) });
  // 同上：验的是「构造时给的那件真的进了 harness」，不是「工具面只有它」
  expect(listTools(agent.tools).map((t) => t.name)).toContain("echo");
  expect(agent.state.tools.map((t) => t.name)).toContain("echo");
});

test("跑的中途注册：本轮菜单不变，下一轮才出现（工具每轮重取）", async () => {
  const seen: number[] = [];
  const late: ModelTool = {
    kind: "model",
    name: "late",
    label: "迟到的",
    description: "",
    parameters: {},
    execute: async () => toolOk("ok"),
  };
  const scripted = scriptedStreamFn([textTurn("一"), textTurn("二")]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: (m: Model, ctx: Context, o?: StreamOptions) => {
      seen.push(ctx.tools.length); // 本轮模型看到几个工具
      return scripted(m, ctx, o);
    },
  });
  agent.subscribe((e) => {
    // turn 还开着时（assistant 定稿入账那一刻）注册 + 插话：turn_end 发出时 turn intake 已关，那时 steer 是 rejected
    if (e.type === "message_end" && e.message.role === "assistant" && agent.state.iteration === 1) {
      registerTool(agent.tools, late);
      agent.steer("继续"); // 逼出第二轮
    }
  });
  await agent.prompt("开始");

  // 判据是**增量**：第二轮比第一轮恰好多一个（`late`）。
  // 绝对条数会随「默认装几个工具」漂移，那不是这条不变量要守的东西。
  expect(seen).toHaveLength(2);
  expect(seen[1]! - seen[0]!).toBe(1); // 第一轮看不见，第二轮才有
});

test("卸载不撕裂进行中的这一轮：本轮仍可执行，下一轮消失", async () => {
  const doomed: ModelTool = {
    kind: "model",
    name: "doomed",
    label: "将被卸掉的",
    description: "",
    parameters: {},
    execute: async () => toolOk("跑了"),
  };
  const agent = new Agent({
    model: FAKE_MODEL,
    tools: [doomed],
    streamFunction: scriptedStreamFn([toolTurn("c1", "doomed", {}), textTurn("完成")]),
  });
  // 一进入 acting 就卸掉它——本轮的调用必须仍然跑通
  agent.subscribe((e) => {
    if (e.type === "tool_execution_start") unregisterTool(agent.tools, "doomed");
  });
  await agent.prompt("用它");

  const toolMsg = agent.messages.find((m) => m.role === "toolResult");
  expect((toolMsg as { content: string }).content).toBe("跑了"); // 没被撕裂
  expect(agent.tools.get("doomed")).toBeUndefined(); // 下一轮边界真删了
});

test("hook 查池，模型查工作集", () => {
  const internal = {
    kind: "internal" as const,
    name: "fmt",
    label: "格式化",
    execute: async () => toolOk("ok"),
  };
  const agent = new Agent({ model: FAKE_MODEL, tools: [internal], streamFunction: scriptedStreamFn([]) });
  // InternalTool 在池里、也在工作集里，但它不上模型菜单——由 toolSchemas 过滤
  expect(agent.tools.get("fmt")).toBeDefined();
  expect(agent.state.tools.some((t) => t.name === "fmt")).toBe(true);
});
