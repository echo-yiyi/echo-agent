// 给远端客户端的投影（2026-09-20，一一的 MVP）。三件事各有判据：
//   ① 整份能进 JSON（函数、Set 一个都不许剩）
//   ② provider 的回放数据（signature / origin / partial）一个字节都不出去
//   ③ 快照 + 后续订阅：按 state.lastSeq 这条水位切，不重不漏

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { agentRuntimeOf } from "../src/extension/builtin.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { clientEvent, clientSnapshot, clientState, MESSAGE_CARRYING_EVENTS } from "../src/client-view.ts";
import type { AgentEvent } from "../src/events.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";

/** 一轮：先思考（带签名与来源）、再说一句。**定稿事件不能少**——少了这一轮是失败轮，定稿消息根本不产生。 */
const THINKING_TURN: ScriptedTurn = [
  { type: "start" },
  { type: "thinking_start" },
  { type: "thinking_delta", text: "先想一下" },
  { type: "thinking_end", signature: "reasoning_content" },
  { type: "text_start" },
  { type: "text_delta", text: "好了" },
  { type: "text_end" },
  {
    type: "done",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先想一下", signature: "reasoning_content", origin: { provider: "fake", api: "fake", model: "only" } },
        { type: "text", text: "好了" },
      ],
      stopReason: "end_turn",
      usage: null,
    },
  },
];

function echoTool(): ModelTool {
  return {
    kind: "model",
    name: "echo",
    label: "回声",
    description: "把参数回显",
    parameters: { type: "object", properties: {} },
    execute: async () => toolOk("echoed", { note: "给宿主看的" }),
  };
}

function agentWithThinking(): Agent {
  return new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([THINKING_TURN]), tools: [echoTool()] });
}

/** 全仓唯一的「它真能上线吗」判据：结构化克隆过得去 = 能进 JSON / postMessage / WebSocket。 */
function assertSerializable(value: unknown): void {
  expect(() => structuredClone(value)).not.toThrow();
}

function deepFind(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => deepFind(v, key));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([k, v]) => k === key || deepFind(v, key));
  }
  return false;
}

test("快照能直接进 JSON：工具只剩可显示面、pendingToolCalls 是数组，原始 state 进不去", async () => {
  const agent = agentWithThinking();
  await agent.prompt("go");
  const runtime = agentRuntimeOf(agent);

  // 原始 state 本身就是进不去的那一份——判据的对照组，不然「能序列化」是句空话
  expect(() => structuredClone(runtime.state)).toThrow();

  const snap = clientSnapshot(runtime);
  assertSerializable(snap);
  expect(snap.state.tools).toEqual([{ name: "echo", kind: "model", label: "回声", description: "把参数回显" }]);
  expect(Array.isArray(snap.state.pendingToolCalls)).toBe(true);
  expect(snap.acceptsWork).toBe(true);
  expect(snap.pendingPermissions).toEqual([]);
  expect(snap.pendingQuestions).toEqual([]);
});

test("provider 的回放数据不出门：快照与事件里都没有 signature / origin，思考正文与 redacted 照留", async () => {
  const agent = agentWithThinking();
  const raw: AgentEvent[] = [];
  agent.subscribe((e) => void raw.push(e));
  await agent.prompt("go");

  // 先证明原始那份确实带着签名——否则下面的「没有」是因为压根没产生过
  expect(deepFind(agent.state.messages, "signature")).toBe(true);
  expect(deepFind(raw, "signature")).toBe(true);

  const snap = clientSnapshot(agentRuntimeOf(agent));
  expect(deepFind(snap, "signature")).toBe(false);
  expect(deepFind(snap, "origin")).toBe(false);
  expect(JSON.stringify(snap)).toContain("先想一下"); // 思考正文是展示内容，留着

  const sent = raw.map(clientEvent);
  expect(deepFind(sent, "signature")).toBe(false);
  expect(deepFind(sent, "origin")).toBe(false);
  expect(deepFind(sent, "partial")).toBe(false); // 流里那份 runtime 附加物也不出门
  sent.forEach(assertSerializable);
});

test("带消息的事件一支不漏：穷举表说要洗的，洗完都没有签名", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([THINKING_TURN]), tools: [echoTool()] });
  const raw: AgentEvent[] = [];
  agent.subscribe((e) => void raw.push(e));
  await agent.prompt("go");

  const carrying = raw.filter((e) => MESSAGE_CARRYING_EVENTS.includes(e.type));
  // 这一轮确实把会带签名的那几支都跑到了（否则下面的「洗干净」是空判据）
  const withSignature = carrying.filter((e) => deepFind(e, "signature"));
  expect(new Set(withSignature.map((e) => e.type))).toEqual(
    new Set(["message_update", "message_end", "attempt_end", "turn_end", "reply_end"]),
  );
  for (const e of carrying) expect(deepFind(clientEvent(e), "signature")).toBe(false);
});

test("水位衔接：归约完、还没派发的那一拍挂上订阅，按 lastSeq 切——不重不漏", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "echo", {}), textTurn("完了")]), tools: [echoTool()] });

  // 挑一个「状态已经变了、事件还在派发途中」的时刻：第一个订阅者收到 message_end 时，
  // 状态里已经有这条消息了，而此刻挂上的第二个订阅者仍会收到同一条事件。
  let snap: ReturnType<typeof clientSnapshot> | null = null;
  const late: AgentEvent[] = [];
  const off = agent.subscribe((e) => {
    if (e.type !== "message_end" || snap !== null) return;
    snap = clientSnapshot(agentRuntimeOf(agent)); // 同一拍里取快照
    agent.subscribe((x) => void late.push(x)); // 紧接着订阅
  });
  await agent.prompt("go");
  off();

  const taken = snap as ReturnType<typeof clientSnapshot> | null;
  if (taken === null) throw new Error("没取到快照");
  const dup = late.filter((e) => e.seq <= taken.state.lastSeq);
  expect(dup.length).toBeGreaterThan(0); // 确实存在「快照里已有、订阅又收到」的重复
  expect(dup.every((e) => e.type === "message_end")).toBe(true);

  // 按水位切之后：客户端手里的 = 快照 + 水位之后的事件，恰好是最终状态，不多不少
  const after = late.filter((e) => e.seq > taken.state.lastSeq);
  const rebuilt = [
    ...taken.state.messages,
    ...after.flatMap((e) => (e.type === "message_end" ? [e.message] : [])),
  ];
  expect(rebuilt.map((m) => m.role)).toEqual(clientState(agent.state).messages.map((m) => m.role));
  expect(new Set(after.map((e) => e.seq)).size).toBe(after.length); // 水位之后没有重号
});

test("lastSeq 跟着事件走：构造出来是 -1，每收一个事件加一，且与最后一个事件的 seq 相等", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]) });
  expect(agent.state.lastSeq).toBe(-1);
  const seen: number[] = [];
  agent.subscribe((e) => void seen.push(e.seq));
  await agent.prompt("go");
  expect(agent.state.lastSeq).toBe(seen.at(-1)!);
  expect(seen).toEqual([...seen].sort((a, b) => a - b)); // 单调
});
