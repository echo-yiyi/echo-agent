// 落单 `tool_use` 的判据（docs/decisions/implemented/2026-09-07-orphan-tool-use.md 选项 B；
// 2026-11-05 起账本当场记下没启动的调用，投影补齐退为兜底：docs/decisions/implemented/2026-11-05-input-lifecycle.md）。
//
// 形状是：**没启动的调用当场入账「没执行」**（`run-turn.ts` 的 `NOT_EXECUTED`）；账本里真没有的
// （进程在一批中途崩掉、那之前写下的老会话），送模前由 `defaultConvertToLlm` 补一条 error `tool_result`，让请求合法。
//
// 1 是端到端的新契约；2–6 手工构造缺结果的 transcript，都是**摘掉 healOrphanToolUses 就会红**的反例：
//   1. 端到端：一条消息点三件、第一件把 run 中止 → 账本里三条齐（后两条是「没执行」），投影不必补
//   2. 补出来的并进同一条 user 消息（线上协议要求一批结果同处一条）
//   3. 欠账在**下一条 assistant 之前**结清
//   4. 欠账在**真正的 user 消息之前**结清（不是塞到它后面）
//   5. 全都配上时投影一个字不多（不误伤）
//   6. `stopReason: "error"` / `"aborted"` 的 assistant 整条隐形，它的 tool_use 不登记、也就不补

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedStreamFn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { NOT_EXECUTED } from "../src/loop/run-turn.ts";
import {
  assistantMessage,
  defaultConvertToLlm,
  toolResultMessage,
  userMessage,
  type AgentMessage,
  type ProviderMessage,
  type ProviderToolResultBlock,
  type ToolResultMessage,
} from "../src/messages.ts";

/* ─────────────── fixtures ─────────────── */

function tool(name: string, execute: ModelTool["execute"]): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute };
}

/** 一条助手消息里点若干个工具。 */
function toolsTurn(names: readonly string[]): ScriptedTurn {
  return [
    { type: "start" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: names.map((n) => ({ type: "tool_use" as const, id: n, name: n, input: {} })),
        stopReason: "tool_use",
        usage: null,
      },
    },
  ];
}

function calls(names: readonly string[]): AgentMessage {
  return assistantMessage(
    names.map((n) => ({ type: "tool_use" as const, id: n, name: n, input: {} })),
    "tool_use",
  );
}

/** 投影里每条 tool_result 的 id → 是不是 error。 */
function resultsOf(wire: readonly ProviderMessage[]): { id: string; isError: boolean }[] {
  const out: { id: string; isError: boolean }[] = [];
  for (const m of wire) {
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ id: (b as ProviderToolResultBlock).tool_use_id, isError: (b as ProviderToolResultBlock).is_error });
    }
  }
  return out;
}

/** 投影里每条 assistant 消息点了哪些 tool_use。 */
function usesOf(wire: readonly ProviderMessage[]): string[] {
  return wire.flatMap((m) => (m.role === "assistant" ? m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id) : []));
}

/* ─────────────── 1. 端到端 ─────────────── */

test("批中 abort：没轮到的两件当场入账「没执行」（metadata 标原因），投影三件都配上、不靠补（2026-11-05 起账本记下它）", async () => {
  let agent: Agent;
  const ran: string[] = [];
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn(["a", "b", "c"])]),
    tools: [
      tool("a", async () => {
        ran.push("a");
        agent.abort("test"); // 第一件跑完就中止：b 与 c 再也轮不到
        return toolOk("a done");
      }),
      tool("b", async () => {
        ran.push("b");
        return toolOk("b done");
      }),
      tool("c", async () => {
        ran.push("c");
        return toolOk("c done");
      }),
    ],
  });

  await agent.prompt("go");

  // 账本：真的跑过的只有 a；b、c 没启动——「系统决定不跑它」这件事本身发生了，当场记一条「没执行」
  // （2026-11-05 推翻选项 B 的「账本不动」：docs/decisions/implemented/2026-11-05-input-lifecycle.md）
  expect(ran).toEqual(["a"]);
  const ledger = agent.messages.filter((m) => m.role === "toolResult") as (ToolResultMessage & { at: number })[];
  expect(ledger.map((m) => m.toolCallId)).toEqual(["a", "b", "c"]);
  expect(ledger.slice(1).map((m) => [m.isError, m.content, m.metadata])).toEqual([
    [true, NOT_EXECUTED.aborted, { notExecuted: "aborted" }],
    [true, NOT_EXECUTED.aborted, { notExecuted: "aborted" }],
  ]);

  // 投影：三个 tool_use 一个不少地配上，没执行的两条标 error（来自账本，不是补出来的）
  const wire = await defaultConvertToLlm([...agent.messages]);
  expect(usesOf(wire)).toEqual(["a", "b", "c"]);
  expect(resultsOf(wire)).toEqual([
    { id: "a", isError: false },
    { id: "b", isError: true },
    { id: "c", isError: true },
  ]);
});

/* ─────────────── 2. 合并 ─────────────── */

test("补出来的结果与已有的并进同一条 user 消息", async () => {
  const wire = await defaultConvertToLlm([
    userMessage("go"),
    calls(["a", "b", "c"]),
    toolResultMessage("a", "a", "a done", false),
  ]);
  const bearing = wire.filter((m) => m.content.some((b) => b.type === "tool_result"));
  expect(bearing).toHaveLength(1);
  expect(bearing[0]!.content).toHaveLength(3);
});

/* ─────────────── 3 / 4. 结清的位置 ─────────────── */

test("欠账在下一条 assistant 之前结清", async () => {
  const wire = await defaultConvertToLlm([
    userMessage("go"),
    calls(["a", "b"]),
    toolResultMessage("a", "a", "a done", false),
    assistantMessage([{ type: "text", text: "done" }], "end_turn"),
  ]);
  const roles = wire.map((m) => m.role);
  expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  expect(resultsOf(wire)).toEqual([
    { id: "a", isError: false },
    { id: "b", isError: true },
  ]);
});

test("欠账在真正的 user 消息之前结清，不塞到它后面", async () => {
  const wire = await defaultConvertToLlm([userMessage("go"), calls(["a"]), userMessage("再来一句")]);
  expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
  // 补出来的那条排在「再来一句」之前
  const idx = wire.findIndex((m) => m.content.some((b) => b.type === "tool_result"));
  const said = wire.findIndex((m) => m.content.some((b) => b.type === "text" && (b as { text: string }).text === "再来一句"));
  expect(idx).toBeGreaterThan(0);
  expect(idx).toBeLessThan(said);
});

/* ─────────────── 5. 不误伤 ─────────────── */

test("全都配上时投影一个字不多", async () => {
  const paired: AgentMessage[] = [
    userMessage("go"),
    calls(["a", "b"]),
    toolResultMessage("a", "a", "a done", false),
    toolResultMessage("b", "b", "b done", false),
  ];
  const wire = await defaultConvertToLlm(paired);
  expect(resultsOf(wire)).toEqual([
    { id: "a", isError: false },
    { id: "b", isError: false },
  ]);
  expect(wire).toHaveLength(3); // user + assistant + 合并后的一条结果
});

/* ─────────────── 6. 失败 attempt / 中止的半截回复都不登记 ─────────────── */

test("stopReason error 的 assistant 整条隐形，它的 tool_use 不补结果", async () => {
  const wire = await defaultConvertToLlm([
    userMessage("go"),
    assistantMessage([{ type: "tool_use", id: "x", name: "x", input: {} }], "error"),
    assistantMessage([{ type: "text", text: "retry ok" }], "end_turn"),
  ]);
  expect(usesOf(wire)).toEqual([]);
  expect(resultsOf(wire)).toEqual([]);
  expect(wire.map((m) => m.role)).toEqual(["user", "assistant"]);
});

// 中止的半截回复与失败 attempt 同一条理由：账本里是真事，但不是模型**说完**的话
// （docs/decisions/implemented/2026-09-05-failed-attempt-in-transcript.md，2026-09-07 修订）。
test("stopReason aborted 的 assistant 整条隐形", async () => {
  const wire = await defaultConvertToLlm([
    userMessage("go"),
    assistantMessage([{ type: "text", text: "我先看一" }], "aborted"),
    assistantMessage([{ type: "text", text: "重来一遍" }], "end_turn"),
  ]);
  expect(wire.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(wire[1]!.content).toEqual([{ type: "text", text: "重来一遍" }]);
});

// 顺序判据：丢在 healOrphanToolUses **之前**发生，所以被丢的那条压根不登记 tool_use。
// 若两者顺序反了（或只丢在补齐之后），这里会多出一条 id 为 "x" 的 error tool_result。
test("aborted 的 assistant 带 tool_use 时不会被补结果", async () => {
  const wire = await defaultConvertToLlm([
    userMessage("go"),
    assistantMessage([{ type: "tool_use", id: "x", name: "x", input: {} }], "aborted"),
    userMessage("换个说法"),
  ]);
  expect(usesOf(wire)).toEqual([]);
  expect(resultsOf(wire)).toEqual([]);
  expect(wire.map((m) => m.role)).toEqual(["user", "user"]);
});
