// 并行工具的判据（docs/decisions/implemented/2026-09-07-parallel-tools.md 的「验收」）。
// 每条都是**摘掉实现就会红**的反例，不是「探到能力」：
//
//   1. 两个 `concurrent: true` 的阻塞探针：第二个的 tool_execution_start 在第一个的 tool_execution_end 之前
//   2. 缺省是串行——**不标就不并行**（同样两个探针，去掉标记就退回逐个跑）
//   3. `[并行, 串行, 并行]` 切成三段；`[并行, 并行, 串行, 并行, 并行]` 切成三段且只有连续的同批
//   4. 两个都要 ask：`pendingPermissions` 任一时刻长度 ≤ 1，问的顺序 = tool_use 顺序
//   5. 完成顺序倒过来时 transcript 里 toolResult 仍按 tool_use 顺序
//   6. 批中 abort：每个 tool_use 都有对应的 toolResult，被中断的记 error
//
// 重叠关系一律从事件里算（`overlaps()`），不靠 sleep 的时长去猜。

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolError, toolOk, type ModelTool } from "../src/tools/types.ts";
import type { AgentEvent, LifecycleEvent } from "../src/events.ts";
import type { AgentMessage } from "../src/messages.ts";
import type { PermissionPolicy } from "../src/permission/types.ts";

type ToolResultEntry = Extract<AgentMessage, { role: "toolResult" }>;

/* ─────────────── fixtures ─────────────── */

function tool(name: string, execute: ModelTool["execute"], concurrent = false): ModelTool {
  return {
    kind: "model",
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    ...(concurrent ? { concurrent: true } : {}),
    execute,
  };
}

/** 一条助手消息里点若干个工具（`toolTurn` 只支持一个，这里直接给定稿）。 */
function toolsTurn(calls: readonly (readonly [id: string, name: string])[]): ScriptedTurn {
  return [
    { type: "start" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: calls.map(([id, name]) => ({ type: "tool_use" as const, id, name, input: {} })),
        stopReason: "tool_use",
        usage: null,
      },
    },
  ];
}

function collect(agent: Agent): AgentEvent[] {
  const out: AgentEvent[] = [];
  agent.subscribe((e) => {
    out.push(e);
  });
  return out;
}

/** 只留工具执行的开与关，压成 `id:start` / `id:end`——判据全在这条序列上。 */
function execSeq(events: readonly AgentEvent[]): string[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: "tool_execution_start" | "tool_execution_end" }> =>
      e.type === "tool_execution_start" || e.type === "tool_execution_end",
    )
    .map((e) => `${e.toolCallId}:${e.type === "tool_execution_start" ? "start" : "end"}`);
}

/**
 * 从执行序列里算出**真正同时在跑**的成对 id（按 `a|b` 排好序）。
 * 两个工具重叠 ⟺ 各自的 [start, end] 区间相交——比数 sleep 时长可靠。
 */
function overlaps(seq: readonly string[]): string[] {
  const at = (key: string): number => seq.indexOf(key);
  const ids = [...new Set(seq.map((s) => s.split(":")[0]!))];
  const pairs: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [x, y] = [ids[i]!, ids[j]!];
      if (at(`${x}:start`) < at(`${y}:end`) && at(`${y}:start`) < at(`${x}:end`)) {
        pairs.push([x, y].sort().join("|"));
      }
    }
  }
  return pairs.sort();
}

function toolResults(messages: readonly AgentMessage[]): ToolResultEntry[] {
  return messages.filter((m): m is ToolResultEntry => m.role === "toolResult");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 阻塞探针：每个工具都等「同批里排在自己后面的那个也开跑了」再返回。
 * 同批 → 大家都等到 → 立刻放行；不同批 → 前一个永远等不到，只能被 `capMs` 兜底放行。
 * 于是「有没有同批」变成事件序列上的重叠关系，不是时长比较。
 */
function makeProbes(capMs = 300): {
  probe: (name: string, next: string | null, concurrent: boolean) => ModelTool;
} {
  const started = new Map<string, () => void>();
  const waiters = new Map<string, Promise<void>>();
  const gate = (name: string): Promise<void> => {
    let p = waiters.get(name);
    if (p === undefined) {
      p = new Promise<void>((r) => started.set(name, r));
      waiters.set(name, p);
    }
    return p;
  };
  return {
    probe: (name, next, concurrent) =>
      tool(
        name,
        async () => {
          gate(name); // 先建好自己的槽，再唤醒
          started.get(name)?.();
          if (next !== null) await Promise.race([gate(next), sleep(capMs)]);
          return toolOk(name);
        },
        concurrent,
      ),
  };
}

/* ─────────────── 1–2. 同批才并行，不标就不并行 ─────────────── */

test("两个 concurrent 工具同批：第二个的 tool_execution_start 在第一个的 tool_execution_end 之前", async () => {
  const { probe } = makeProbes();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn([["c1", "a"], ["c2", "b"]]), textTurn("done")]),
    tools: [probe("a", "b", true), probe("b", null, true)],
  });
  const events = collect(agent);
  const result = await agent.prompt("go");
  expect(result.outcome.kind).toBe("completed");

  const seq = execSeq(events);
  expect(new Set(seq.slice(0, 2))).toEqual(new Set(["c1:start", "c2:start"])); // 两个都先开跑
  expect(seq.indexOf("c2:start")).toBeLessThan(seq.indexOf("c1:end")); // 判据原文
  expect(overlaps(seq)).toEqual(["c1|c2"]);
});

test("缺省不并行：同样两个探针去掉 concurrent，就退回 a:start, a:end, b:start", async () => {
  const { probe } = makeProbes(60);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn([["c1", "a"], ["c2", "b"]]), textTurn("done")]),
    tools: [probe("a", "b", false), probe("b", null, false)],
  });
  const events = collect(agent);
  await agent.prompt("go");
  expect(execSeq(events)).toEqual(["c1:start", "c1:end", "c2:start", "c2:end"]);
  expect(overlaps(execSeq(events))).toEqual([]);
});

/* ─────────────── 3. 切批：只有连续的可并行调用同批 ─────────────── */

test("[并行, 串行, 并行] 切成三段：三个各跑各的，一对重叠都没有", async () => {
  const { probe } = makeProbes(60);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([
      toolsTurn([["c1", "a"], ["c2", "s"], ["c3", "b"]]),
      textTurn("done"),
    ]),
    tools: [probe("a", "s", true), probe("s", "b", false), probe("b", null, true)],
  });
  const events = collect(agent);
  const result = await agent.prompt("go");
  expect(result.outcome.kind).toBe("completed");

  const seq = execSeq(events);
  expect(seq).toEqual(["c1:start", "c1:end", "c2:start", "c2:end", "c3:start", "c3:end"]);
  expect(overlaps(seq)).toEqual([]);
});

test("[并行, 并行, 串行, 并行, 并行] 切成三段：{c1,c2} 与 {c4,c5} 各自同批，c3 独占", async () => {
  const { probe } = makeProbes(60);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([
      toolsTurn([["c1", "a"], ["c2", "b"], ["c3", "s"], ["c4", "d"], ["c5", "e"]]),
      textTurn("done"),
    ]),
    tools: [
      probe("a", "b", true),
      probe("b", null, true),
      probe("s", "d", false), // 若 c3 被错并进任何一批，这个等待就会成功 → 出现跨批重叠
      probe("d", "e", true),
      probe("e", null, true),
    ],
  });
  const events = collect(agent);
  await agent.prompt("go");

  const seq = execSeq(events);
  expect(overlaps(seq)).toEqual(["c1|c2", "c4|c5"]);
  // 三段的边界：前一段全部收工，后一段才开跑
  expect(seq.indexOf("c3:start")).toBeGreaterThan(seq.indexOf("c2:end"));
  expect(seq.indexOf("c4:start")).toBeGreaterThan(seq.indexOf("c3:end"));
});

/* ─────────────── 4. 授权询问批内串行 ─────────────── */

test("同批两个都要 ask：pendingPermissions 任一时刻 ≤ 1，问的顺序 = tool_use 顺序", async () => {
  const policy: PermissionPolicy = { authorize: () => ({ kind: "ask", reason: "要问" }), askTimeoutMs: null, responder: "host" };
  const ran: string[] = [];
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn([["c1", "a"], ["c2", "b"]]), textTurn("done")]),
    tools: [
      tool("a", async () => (ran.push("a"), toolOk("a")), true),
      tool("b", async () => (ran.push("b"), toolOk("b")), true),
    ],
    permission: policy,
  });

  const asked: string[] = [];
  const atRequest: number[] = [];
  agent.subscribeLifecycle((e: LifecycleEvent) => {
    if (e.type !== "permissionRequest") return;
    asked.push(e.toolCallId);
    atRequest.push(agent.pendingPermissions.length);
    // 慢一点答，让采样器有机会看到「同时挂着几个」
    setTimeout(() => void agent.answerPermission({ permissionId: e.permissionId, decision: "allow" }), 15);
  });

  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, agent.pendingPermissions.length);
  }, 1);
  let result;
  try {
    result = await agent.prompt("go");
  } finally {
    clearInterval(sampler);
  }

  expect(result.outcome.kind).toBe("completed");
  expect(asked).toEqual(["c1", "c2"]); // 排队顺序 = tool_use 顺序
  expect(atRequest).toEqual([1, 1]);
  expect(peak).toBeLessThanOrEqual(1); // 判据原文：任一时刻 ≤ 1
  expect(peak).toBe(1); // 且确实挂起过——不是「一次都没问」的假绿
  expect(ran.sort()).toEqual(["a", "b"]);
});

test("同批一个要问、一个不要问：不要问的那个不等人，照常与问的一起跑", async () => {
  // **只有「不要问的那个先跑完」才会放行**——若询问把整批锁住，`free` 永远跑不了，
  // ask 只能超时收场，下面两条断言都会红（不是挂死）。
  let markFree!: () => void;
  const freeRan = new Promise<void>((r) => {
    markFree = r;
  });
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn([["c1", "asks"], ["c2", "free"]]), textTurn("done")]),
    tools: [
      tool("asks", async () => toolOk("asks"), true),
      tool("free", async () => (markFree(), toolOk("free")), true),
    ],
    permission: {
      authorize: (input) => (input.toolName === "asks" ? { kind: "ask", reason: "要问" } : { kind: "allow" }),
      askTimeoutMs: 2000,
    },
  });
  agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") {
      void freeRan.then(() => agent.answerPermission({ permissionId: e.permissionId, decision: "allow" }));
    }
  });
  const result = await agent.prompt("go");
  expect(result.outcome.kind).toBe("completed");
  expect(toolResults(result.messages).map((m) => m.content)).toEqual(["asks", "free"]);
});

/* ─────────────── 5. 入账按 tool_use 顺序，不按完成顺序 ─────────────── */

test("完成顺序倒过来：transcript 里 toolResult 仍按 tool_use 顺序", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn([["c1", "slow"], ["c2", "fast"]]), textTurn("done")]),
    tools: [
      tool("slow", async () => (await sleep(30), toolOk("slow")), true),
      tool("fast", async () => toolOk("fast"), true),
    ],
  });
  const events = collect(agent);
  const result = await agent.prompt("go");

  const seq = execSeq(events);
  expect(seq.indexOf("c2:end")).toBeLessThan(seq.indexOf("c1:end")); // 完成顺序确实反了
  const results = toolResults(result.messages);
  expect(results.map((m) => m.toolCallId)).toEqual(["c1", "c2"]); // 入账顺序没反
  expect(results.map((m) => m.content)).toEqual(["slow", "fast"]);
  // message_end 的先后也按 tool_use 顺序
  const ended = events
    .filter((e): e is Extract<AgentEvent, { type: "message_end" }> => e.type === "message_end")
    .map((e) => e.message)
    .filter((m): m is ToolResultEntry => m.role === "toolResult")
    .map((m) => m.toolCallId);
  expect(ended).toEqual(["c1", "c2"]);
});

/* ─────────────── 6. 批中 abort ─────────────── */

test("批中 abort：已起跑的各自收 signal 结束，每个 tool_use 都有对应的 toolResult（记 error）", async () => {
  let started = 0;
  let agent!: Agent;
  const halt = (name: string): ModelTool =>
    tool(
      name,
      async (_p, ctx) => {
        started += 1;
        if (started === 2) agent.abort("不等了"); // 两个都起跑了才中止
        await new Promise<void>((r) => {
          if (ctx.signal?.aborted === true) return r();
          ctx.signal?.addEventListener("abort", () => r(), { once: true });
        });
        return toolError(`${name} aborted`);
      },
      true,
    );
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolsTurn([["c1", "a"], ["c2", "b"]]), textTurn("done")]),
    tools: [halt("a"), halt("b")],
  });
  const events = collect(agent);
  const result = await agent.prompt("go");

  expect(result.outcome.kind).toBe("aborted");
  expect(started).toBe(2); // 未起跑的不跑；这一批两个都起跑了
  const results = toolResults(result.messages);
  expect(results.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
  expect(results.every((m) => m.isError)).toBe(true);
  expect(overlaps(execSeq(events))).toEqual(["c1|c2"]);
});

test("批中 abort，后面还有一批：起跑过的那批全员入账，没起跑的那批一个都不跑", async () => {
  let started = 0;
  let laterRan = 0;
  let agent!: Agent;
  const halt = (name: string): ModelTool =>
    tool(
      name,
      async (_p, ctx) => {
        started += 1;
        if (started === 2) agent.abort("不等了");
        await new Promise<void>((r) => {
          if (ctx.signal?.aborted === true) return r();
          ctx.signal?.addEventListener("abort", () => r(), { once: true });
        });
        return toolError(`${name} aborted`);
      },
      true,
    );
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([
      toolsTurn([["c1", "a"], ["c2", "b"], ["c3", "later"]]),
      textTurn("done"),
    ]),
    tools: [halt("a"), halt("b"), tool("later", async () => ((laterRan += 1), toolOk("later")))],
  });
  const result = await agent.prompt("go");

  expect(result.outcome.kind).toBe("aborted");
  expect(laterRan).toBe(0); // 「剩下的不跑」——批与批之间的老规矩没变
  expect(toolResults(result.messages).map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
});
