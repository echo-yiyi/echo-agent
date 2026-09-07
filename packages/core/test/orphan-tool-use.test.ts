// 落单 `tool_use` 的判据（docs/decisions/implemented/2026-09-07-orphan-tool-use.md，拍板选项 B）。
//
// 形状是：**账本不动，投影补齐**。中止之后没轮到的那几个调用在 transcript 里本来就没有结果
// （`run-turn.ts` 的批循环判到 abort 就 break，它们从来没进过 `runOneTool`），那是真实发生的事；
// 送模前由 `defaultConvertToLlm` 给它们补一条 error `tool_result`，让请求合法。
//
// 每条都是**摘掉 healOrphanToolUses 就会红**的反例：
//   1. 端到端：一条消息点三件、第一件把 run 中止 → transcript 仍只有一条 toolResult，投影里三条齐
//   2. 补出来的并进同一条 user 消息（线上协议要求一批结果同处一条）
//   3. 欠账在**下一条 assistant 之前**结清
//   4. 欠账在**真正的 user 消息之前**结清（不是塞到它后面）
//   5. 全都配上时投影一个字不多（不误伤）
//   6. `stopReason: "error"` / `"aborted"` 的 assistant 整条隐形，它的 tool_use 不登记、也就不补

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedStreamFn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import {
  assistantMessage,
  defaultConvertToLlm,
  toolResultMessage,
  userMessage,
  type AgentMessage,
  type ProviderMessage,
  type ProviderToolResultBlock,
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

test("批中 abort：transcript 里少的那两条结果，投影时补齐并标 error", async () => {
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

  // 账本：只有真的跑过的那一件有结果——**这一条不能变**，B 的全部意思就是账本不动
  expect(ran).toEqual(["a"]);
  const ledger = agent.messages.filter((m) => m.role === "toolResult");
  expect(ledger.map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["a"]);

  // 投影：三个 tool_use 一个不少地配上，补出来的两条标 error
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
