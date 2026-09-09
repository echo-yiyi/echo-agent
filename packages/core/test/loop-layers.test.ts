// run loop 四层的判据（docs/design/run-loop-layers.md 导读「验收判据」）：run ⊃ reply ⊃ turn ⊃ attempt。
//
// 同一个栈式校验器扫每种 run 的事件流，断言五条结构规则：
//   ① 四层 start / end 严格嵌套，每层至少一对
//   ② assistant 的 message_* 与 usage 只在 attempt 内；tool_execution_* 与 toolResult 的 message_end 只在 attempt_end{landed} 之后、同一 turn 内
//   ③ retry_scheduled 只在同一 turn 的 attempt_end{failed} 与下一个 attempt_start 之间（退避被打断时其后是 turn_end{aborted}）
//   ④ turnId 在 run 内唯一，n 在每条 reply 内从 1 起、每个 turn 加 1（重试不消耗）
//   ⑤ 输入消息的 message_end 在它引发的 turn_start 之前，中间只允许 compaction_*
// 校验器只看 loop 事件；queue_update / resource_changed 不参与。
// 另有数值判据：失败 attempt 之后的请求不含那条失败消息；持续 retryable 时请求总数 = maxAttempts；reply 上限的两种收场。

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, errorTurn, scriptedStreamFn, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { AgentEvent, LifecycleEvent } from "../src/events.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { RunIntakeGate } from "../src/loop/intake.ts";
import { defaultConvertToLlm, userMessage, type Context } from "../src/messages.ts";
import { runAgentLoop } from "../src/loop/run-loop.ts";
import { turnNumberOf } from "../src/loop/ids.ts";
import type { AgentLoopConfig, AttemptResult } from "../src/loop/types.ts";
import { DEFAULT_RETRY_POLICY } from "../src/provider/dialect.ts";
import { EMPTY_COMPACTION } from "../src/compaction/types.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import type { Model, StreamFn } from "../src/provider/types.ts";

/* ─────────────── 校验器 ─────────────── */

type Layer = "agent" | "reply" | "turn" | "attempt";

const LOOP_EVENTS: ReadonlySet<string> = new Set([
  "agent_start", "agent_end", "reply_start", "reply_end", "turn_start", "turn_end", "attempt_start", "attempt_end",
  "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "compaction_start", "compaction_end", "retry_scheduled", "usage",
]);

/** 返回违规清单；空 = 五条规则全部成立。 */
function validate(events: readonly AgentEvent[]): string[] {
  const v: string[] = [];
  const stack: Layer[] = [];
  const top = (): Layer | undefined => stack[stack.length - 1];
  const need = (e: AgentEvent, want: Layer): void => {
    if (top() !== want) v.push(`#${e.seq} ${e.type}：应在 ${want} 内，实际在 ${top() ?? "（空）"}`);
  };
  let repliesInRun = 0;
  let turnsInReply = 0;
  let attemptsInTurn = 0;
  let expectN = 1;
  const turnIds = new Set<string>();
  let lastAttempt: AttemptResult["kind"] | null = null;
  let pendingInput = false; // ⑤：刚吸收了输入，下一个 loop 事件只能是 compaction_* 或 turn_start
  let afterRetry = false; // ③：retry_scheduled 之后下一个 loop 事件必须是 attempt_start

  for (const e of events) {
    if (!LOOP_EVENTS.has(e.type)) continue;
    // 轮首硬闸（abort / deadline / max_iterations）在输入吸收之后、第一个 turn 之前命中：紧接着就是 reply_end（零 turn 的 reply）
    if (pendingInput && e.type === "reply_end") pendingInput = false;
    if (pendingInput && e.type !== "turn_start" && e.type !== "compaction_start" && e.type !== "compaction_end") {
      v.push(`#${e.seq} 输入消息之后来了 ${e.type}（只允许 compaction_* / turn_start，或轮首硬闸命中时的 reply_end）`);
      pendingInput = false;
    }
    if (afterRetry && e.type !== "attempt_start") {
      // 退避被 abort / deadline 打断：不再发起 attempt，turn 直接以 aborted 关门——这是唯一的例外
      if (!(e.type === "turn_end" && e.result.kind === "aborted")) v.push(`#${e.seq} retry_scheduled 之后来了 ${e.type}（必须是 attempt_start，或退避被打断时的 turn_end{aborted}）`);
      afterRetry = false;
    }
    switch (e.type) {
      case "agent_start":
        if (stack.length > 0) v.push(`#${e.seq} agent_start 时栈非空：${stack.join(">")}`);
        stack.push("agent");
        repliesInRun = 0;
        break;
      case "reply_start":
        need(e, "agent");
        stack.push("reply");
        repliesInRun += 1;
        turnsInReply = 0;
        expectN = 1;
        break;
      case "turn_start":
        need(e, "reply");
        stack.push("turn");
        turnsInReply += 1;
        attemptsInTurn = 0;
        lastAttempt = null;
        pendingInput = false;
        if (turnIds.has(e.turnId)) v.push(`#${e.seq} turnId 重用：${e.turnId}`);
        turnIds.add(e.turnId);
        if (!e.turnId.startsWith(`${e.replyId}#`)) v.push(`#${e.seq} turnId ${e.turnId} 不属于 reply ${e.replyId}`);
        if (turnNumberOf(e.turnId) !== expectN) v.push(`#${e.seq} turn 序号应为 ${expectN}，实际 ${turnNumberOf(e.turnId)}（${e.turnId}）`);
        expectN += 1;
        break;
      case "attempt_start":
        need(e, "turn");
        stack.push("attempt");
        attemptsInTurn += 1;
        afterRetry = false;
        if (e.attempt !== attemptsInTurn) v.push(`#${e.seq} attempt 序号应为 ${attemptsInTurn}，实际 ${e.attempt}`);
        break;
      case "attempt_end":
        need(e, "attempt");
        stack.pop();
        lastAttempt = e.result.kind;
        break;
      case "retry_scheduled":
        need(e, "turn");
        if (lastAttempt !== "failed") v.push(`#${e.seq} retry_scheduled 之前的 attempt 不是 failed（${lastAttempt}）`);
        if (e.attempt !== attemptsInTurn + 1) v.push(`#${e.seq} retry_scheduled.attempt 应是即将开始的 ${attemptsInTurn + 1}，实际 ${e.attempt}`);
        afterRetry = true;
        break;
      case "turn_end":
        need(e, "turn");
        // 允许零 attempt（§5 规则 1，2026-09-08 放宽）：turn_start 之后、发请求之前被 abort 的 turn 就是空的
        stack.pop();
        break;
      case "reply_end":
        need(e, "reply");
        // 允许零 turn：输入吸收之后轮首硬闸就命中（abort / deadline / max_iterations）
        if (e.turns !== turnsInReply) v.push(`#${e.seq} reply_end.turns=${e.turns}，实际 ${turnsInReply}`);
        stack.pop();
        break;
      case "agent_end":
        need(e, "agent");
        if (repliesInRun < 1) v.push(`#${e.seq} run 内没有 reply`);
        stack.pop();
        break;
      case "message_start":
      case "message_update":
      case "usage":
        need(e, "attempt");
        break;
      case "message_end":
        if (e.message.role === "assistant") need(e, "attempt");
        else if (e.message.role === "toolResult") {
          need(e, "turn");
          if (lastAttempt !== "landed") v.push(`#${e.seq} toolResult 出现在未落地的 attempt 之后（${lastAttempt}）`);
        } else {
          // 输入（user / harness）：在 reply 里、turn 之外
          need(e, "reply");
          pendingInput = true;
        }
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        need(e, "turn");
        if (lastAttempt !== "landed") v.push(`#${e.seq} ${e.type} 出现在未落地的 attempt 之后（${lastAttempt}）`);
        break;
      case "compaction_start":
      case "compaction_end":
        // 轮首（reply 内）或撞窗应急（turn 内、两个 attempt 之间）
        if (top() !== "reply" && top() !== "turn") v.push(`#${e.seq} ${e.type} 应在 reply 或 turn 内，实际在 ${top() ?? "（空）"}`);
        break;
      default:
        break;
    }
  }
  if (stack.length > 0) v.push(`结束时还开着：${stack.join(">")}`);
  return v;
}

/* ─────────────── 辅助 ─────────────── */

function tool(name: string, execute: ModelTool["execute"]): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute };
}

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
  });
  return events;
}

function lifecycle(agent: Agent): LifecycleEvent[] {
  const seen: LifecycleEvent[] = [];
  agent.subscribeLifecycle((e) => {
    seen.push(e);
  });
  return seen;
}

/** 确定性判据面：去掉时序性观测事件。 */
function types(events: readonly AgentEvent[]): string[] {
  return events.map((e) => e.type).filter((t) => t !== "message_update" && t !== "tool_execution_update" && t !== "usage" && t !== "queue_update" && t !== "resource_changed");
}

/** 记录每次送模的 Context（深拷贝，之后的 push 影响不到它）。 */
function capturing(turns: ScriptedTurn[]): { fn: StreamFn; requests: Context[] } {
  const base = scriptedStreamFn(turns);
  const requests: Context[] = [];
  return {
    requests,
    fn: (m, c, o) => {
      requests.push(structuredClone(c));
      return base(m, c, o);
    },
  };
}

/** 先流出半截正文再以 retryable 错误收场：失败 attempt 的定稿有内容，才能证明它没被送回模型。 */
function partialThenError(text: string, code: string): ScriptedTurn {
  return [
    { type: "start" },
    { type: "text_start" },
    { type: "text_delta", text },
    { type: "error", error: { source: "provider", code: code as never, retryable: true, message: "限流" } },
  ];
}

const FAST_RETRY = { maxAttempts: 3, backoffMs: () => 0 };

/* ─────────────── 场景 ─────────────── */

test("只有文本：一条 reply、一个 turn、一个 attempt，事件序列逐拍确定", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]) });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  expect(types(events)).toEqual([
    "agent_start",
    "reply_start",
    "message_end", // user 输入，在 reply 里、turn 之前
    "turn_start",
    "attempt_start",
    "message_start",
    "message_end",
    "attempt_end",
    "turn_end",
    "reply_end",
    "agent_end",
  ]);
  const reply = events.find((e) => e.type === "reply_start");
  const turn = events.find((e) => e.type === "turn_start");
  expect(reply?.type === "reply_start" && reply.source).toBe("prompt");
  expect(turn?.type === "turn_start" && turn.cause).toBe("input");
  expect(turn?.type === "turn_start" && turn.turnId).toBe(`${r.runId}/1#1`);
  const end = events.find((e) => e.type === "reply_end");
  expect(end?.type === "reply_end" && end.final?.stopReason).toBe("end_turn");
});

test("轮首 abort（turn 里）：turn_start 之后、发请求之前被中止 → 零 attempt 的 turn，配对仍成立（2026-09-08 放宽）", async () => {
  // 最朴素的生产路径就是用户 Ctrl-C 落在 turn_start 的 emit 期间；此前校验器要求「turn 内至少一个 attempt」，这一幕会被判红
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]) });
  const events = collect(agent);
  agent.subscribe((e) => {
    if (e.type === "turn_start") agent.abort("轮首中断");
  });
  const r = await agent.prompt("go");
  expect(r.outcome).toEqual({ kind: "aborted", reason: "轮首中断" });
  expect(validate(events)).toEqual([]);
  expect(types(events)).toEqual(["agent_start", "reply_start", "message_end", "turn_start", "turn_end", "reply_end", "agent_end"]);
  const turnEnd = events.find((e) => e.type === "turn_end");
  expect(turnEnd?.type === "turn_end" && turnEnd.result.kind).toBe("aborted");
});

test("轮首 abort（reply 里）：输入吸收之后、第一个 turn 之前被中止 → 零 turn 的 reply，配对仍成立（2026-09-08 放宽）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]) });
  const events = collect(agent);
  agent.subscribe((e) => {
    if (e.type === "reply_start") agent.abort("还没开 turn 就停");
  });
  const r = await agent.prompt("go");
  expect(r.outcome).toEqual({ kind: "aborted", reason: "还没开 turn 就停" });
  expect(validate(events)).toEqual([]);
  expect(types(events)).toEqual(["agent_start", "reply_start", "message_end", "reply_end", "agent_end"]);
  const replyEnd = events.find((e) => e.type === "reply_end");
  expect(replyEnd?.type === "reply_end" && replyEnd.turns).toBe(0);
});

test("轮首 deadline：输入吸收期间就超时 → 零 turn 的 reply，outcome error{timeout}，配对仍成立（2026-09-08 放宽）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("不该到")]), timeoutMs: 10 });
  const events = collect(agent);
  agent.subscribe(async (e) => {
    if (e.type === "message_end") await new Promise((r) => setTimeout(r, 40)); // 普通 listener 是被 await 的：拖过 deadline
  });
  const r = await agent.prompt("go");
  expect(r.outcome).toMatchObject({ kind: "error", error: { code: "timeout" } });
  expect(validate(events)).toEqual([]);
  expect(types(events)).toEqual(["agent_start", "reply_start", "message_end", "reply_end", "agent_end"]);
});

test("要工具：第二个 turn 的 cause 是 tool_use，工具事件与 toolResult 落在第一个 turn 里、attempt_end{landed} 之后", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("done")]),
    tools: [tool("t", async () => toolOk("ok"))],
  });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  const causes = events.filter((e) => e.type === "turn_start").map((e) => (e.type === "turn_start" ? e.cause : ""));
  expect(causes).toEqual(["input", "tool_use"]);
  const end = events.find((e) => e.type === "reply_end");
  expect(end?.type === "reply_end" && end.turns).toBe(2);
});

test("tool_execution_update 的订阅者抛错：不成 unhandled rejection，turn 按 emit 违约关成失败、run 报 error（review 2026-09-07）", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const t = tool("t", async (_params, ctx) => {
      ctx.onUpdate?.("half");
      return toolOk("ok");
    });
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("不该到")]), tools: [t] });
    agent.subscribe((e) => {
      if (e.type === "tool_execution_update") throw new Error("订阅者违约");
    });
    const events = collect(agent);
    const r = await agent.prompt("go");
    await new Promise((res) => setTimeout(res, 0));
    expect(r.outcome.kind).toBe("error");
    expect(validate(events)).toEqual([]); // 关门仍成对
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("transport 错误后成功：同一 turn 两个 attempt，中间恰好一个 retry_scheduled；失败 attempt 的半截正文留在 transcript、不送回模型", async () => {
  const { fn, requests } = capturing([partialThenError("半截", "rate_limit"), textTurn("ok")]);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, retryPolicy: FAST_RETRY });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  expect(types(events).filter((t) => t === "turn_start")).toHaveLength(1);
  expect(types(events).filter((t) => t === "attempt_start")).toHaveLength(2);
  const retries = events.filter((e) => e.type === "retry_scheduled");
  expect(retries).toHaveLength(1);
  expect(retries[0]?.type === "retry_scheduled" && retries[0].attempt).toBe(2);
  // 账本里留着那次失败（事实要入账）……
  const failed = agent.messages.find((m) => m.role === "assistant" && m.stopReason === "error");
  expect(failed !== undefined && JSON.stringify(failed.content)).toContain("半截");
  // ……但第二次请求不含它（不是模型说过的话）
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1]!.messages)).not.toContain("半截");
});

test("持续 retryable 错误：一个 run 的请求总数 = maxAttempts，outcome 是那个错误", async () => {
  const { fn, requests } = capturing([errorTurn("rate_limit", "限流", true), errorTurn("rate_limit", "限流", true), errorTurn("rate_limit", "限流", true), textTurn("不该到")]);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, retryPolicy: FAST_RETRY });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome).toMatchObject({ kind: "error", error: { code: "rate_limit" } });
  expect(validate(events)).toEqual([]);
  expect(requests).toHaveLength(FAST_RETRY.maxAttempts);
  expect(types(events).filter((t) => t === "attempt_start")).toHaveLength(3);
  expect(types(events).filter((t) => t === "retry_scheduled")).toHaveLength(2);
  const turnEnd = events.find((e) => e.type === "turn_end");
  expect(turnEnd?.type === "turn_end" && turnEnd.result.kind).toBe("failed");
});

test("backoff 中 abort：retryable 失败进入退避后 abort，run 在远小于 backoff 的时间内以 aborted 收场，不再发起 attempt", async () => {
  const { fn, requests } = capturing([errorTurn("rate_limit", "限流", true), textTurn("不该到")]);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, retryPolicy: { maxAttempts: 3, backoffMs: () => 5_000 } });
  const events = collect(agent);
  agent.subscribe((e) => {
    if (e.type === "retry_scheduled") agent.abort("测试");
  });
  const started = Date.now();
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("aborted");
  expect(Date.now() - started).toBeLessThan(500);
  expect(validate(events)).toEqual([]);
  expect(requests).toHaveLength(1); // 退避被打断，第二个 attempt 没有发起
  const turnEnd = events.find((e) => e.type === "turn_end");
  expect(turnEnd?.type === "turn_end" && turnEnd.result.kind).toBe("aborted");
  expect(agent.status).toBe("idle");
});

test("backoff 中 deadline：退避期间 run 超时，以 error{timeout} 收场，不等 backoff 走完", async () => {
  const { fn, requests } = capturing([errorTurn("rate_limit", "限流", true), textTurn("不该到")]);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, retryPolicy: { maxAttempts: 3, backoffMs: () => 5_000 }, timeoutMs: 20 });
  const events = collect(agent);
  const started = Date.now();
  const r = await agent.prompt("go");
  expect(r.outcome).toMatchObject({ kind: "error", error: { code: "timeout" } });
  expect(Date.now() - started).toBeLessThan(500);
  expect(validate(events)).toEqual([]);
  expect(requests).toHaveLength(1);
});

test("abort 的 reason 一路带到 outcome：宿主传的字符串原样透传；裸 abort() 没有 reason；工具阶段与退避阶段两条路都带", async () => {
  // 工具阶段 abort
  let agent!: Agent;
  const t = tool("t", async () => {
    agent.abort("用户中断");
    return toolOk("ok");
  });
  agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("不该到")]), tools: [t] });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome).toEqual({ kind: "aborted", reason: "用户中断" });
  expect(validate(events)).toEqual([]);
  const end = events.find((e) => e.type === "agent_end");
  expect(end?.type === "agent_end" && end.outcome).toEqual({ kind: "aborted", reason: "用户中断" });
  const replyEnd = events.find((e) => e.type === "reply_end");
  expect(replyEnd?.type === "reply_end" && replyEnd.outcome).toEqual({ kind: "aborted", reason: "用户中断" });

  // 退避阶段 abort
  const { fn } = capturing([errorTurn("rate_limit", "限流", true), textTurn("不该到")]);
  const backing = new Agent({ model: FAKE_MODEL, streamFunction: fn, retryPolicy: { maxAttempts: 3, backoffMs: () => 5_000 } });
  backing.subscribe((e) => {
    if (e.type === "retry_scheduled") backing.abort("收到停止信号");
  });
  expect((await backing.prompt("go")).outcome).toEqual({ kind: "aborted", reason: "收到停止信号" });

  // 没给理由：outcome 不带 reason 字段
  let bare!: Agent;
  const t2 = tool("t", async () => {
    bare.abort();
    return toolOk("ok");
  });
  bare = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("不该到")]), tools: [t2] });
  expect((await bare.prompt("go")).outcome).toEqual({ kind: "aborted" });
});

test("agent_end 不是 idle barrier：监听器里 status 仍是 generating，prompt() resolve 才是 idle", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("hi")]) });
  const seen = { statusAtEnd: null as string | null }; // 对象字段：闭包里的赋值不会被 TS 的控制流收窄吃掉
  agent.subscribe((e) => {
    if (e.type === "agent_end") seen.statusAtEnd = agent.status;
  });
  await agent.prompt("go");
  expect(seen.statusAtEnd).toBe("generating");
  expect(agent.status).toBe("idle");
});

test("撞窗应急后成功：同一 turn 的第二个 attempt，compaction_* 夹在两个 attempt 之间，不发 retry_scheduled", async () => {
  const big: Model = { ...FAKE_MODEL, capabilities: { contextWindow: 1_000_000 } };
  const { fn } = capturing([textTurn("first"), errorTurn("context_overflow", "prompt too long", false), textTurn("<summary>RECOVERED</summary>"), textTurn("ok")]);
  const agent = new Agent({ model: big, streamFunction: fn, compaction: { keepRecentTokens: 8_000 } });
  await mountBuiltinTools(agent);
  await agent.prompt("x".repeat(12_000));
  const events = collect(agent);
  const r = await agent.prompt("second");
  expect(r.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  expect(types(events).filter((t) => t === "turn_start")).toHaveLength(1);
  expect(types(events).filter((t) => t === "attempt_start")).toHaveLength(2);
  expect(types(events).filter((t) => t === "retry_scheduled")).toHaveLength(0);
  const seq = types(events);
  const firstEnd = seq.indexOf("attempt_end");
  const secondStart = seq.lastIndexOf("attempt_start");
  expect(seq.slice(firstEnd + 1, secondStart)).toEqual(["compaction_start", "compaction_end"]);
});

test("contextBeforeBuild block：attempt_end{blocked} → turn_end → reply_end → agent_end{aborted, reason}，配对由结构成立", async () => {
  const h = new HookRuntime();
  h.on("contextBeforeBuild", () => ({ decision: "block", reason: "DO_NOT_CALL_MODEL" }));
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("x")]), hooks: h });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome).toEqual({ kind: "aborted", reason: "DO_NOT_CALL_MODEL" });
  expect(validate(events)).toEqual([]);
  expect(types(events)).toEqual(["agent_start", "reply_start", "message_end", "turn_start", "attempt_start", "attempt_end", "turn_end", "reply_end", "agent_end"]);
  const attemptEnd = events.find((e) => e.type === "attempt_end");
  expect(attemptEnd?.type === "attempt_end" && attemptEnd.result).toEqual({ kind: "blocked", reason: "DO_NOT_CALL_MODEL" });
});

test("工具执行中 abort：已跑完的工具结果保留，reply 以 aborted 收场，层层关门", async () => {
  let agent!: Agent;
  const t = tool("t", async () => {
    agent.abort("测试");
    return toolOk("ok");
  });
  agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("不该到")]), tools: [t] });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("aborted");
  expect(validate(events)).toEqual([]);
  expect(types(events).filter((t) => t === "turn_start")).toHaveLength(1);
});

test("run 超时：deadline 在工具阶段到了，reply 以 error{timeout} 收场，层层关门", async () => {
  const t = tool("t", async () => {
    await new Promise((r) => setTimeout(r, 40));
    return toolOk("ok");
  });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("不该到")]), tools: [t], timeoutMs: 15 });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome).toMatchObject({ kind: "error", error: { code: "timeout" } });
  expect(validate(events)).toEqual([]);
});

test("followUp：同一 run 两条 reply，第二条 source=follow_up、turn 序号从 1 重数", async () => {
  let agent!: Agent;
  const t = tool("t", async () => {
    await agent.followUp("跟进");
    return toolOk("ok");
  });
  agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("b"), textTurn("c")]), tools: [t] });
  const events = collect(agent);
  const r = await agent.prompt("开始");
  expect(r.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  const sources = events.filter((e) => e.type === "reply_start").map((e) => (e.type === "reply_start" ? e.source : ""));
  expect(sources).toEqual(["prompt", "follow_up"]);
  const ids = events.filter((e) => e.type === "turn_start").map((e) => (e.type === "turn_start" ? e.turnId : ""));
  expect(ids).toEqual([`${r.runId}/1#1`, `${r.runId}/1#2`, `${r.runId}/2#1`]);
});

test("stop hook 注入：第二条 reply source=stop_hook，注入的 harness 消息在 reply_start 之后、turn_start 之前", async () => {
  const h = new HookRuntime();
  let asked = 0;
  h.on("stop", () => {
    asked += 1;
    return asked === 1 ? { decision: "block", reason: "还没完" } : undefined;
  });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("a"), textTurn("b")]), hooks: h });
  const events = collect(agent);
  const r = await agent.prompt("开始");
  expect(r.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  const sources = events.filter((e) => e.type === "reply_start").map((e) => (e.type === "reply_start" ? e.source : ""));
  expect(sources).toEqual(["prompt", "stop_hook"]);
  const seq = types(events);
  const second = seq.lastIndexOf("reply_start");
  expect(seq.slice(second, second + 3)).toEqual(["reply_start", "message_end", "turn_start"]);
});

test("steer：turn 还开着时插话 → 下一个 turn 的 cause 是 steer，插话的 message_end 在上一个 turn_end 之后", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("第一轮"), textTurn("第二轮")]) });
  agent.subscribe((e) => {
    if (e.type === "message_end" && e.message.role === "assistant" && agent.state.iteration === 1) agent.steer("补充一句");
  });
  const events = collect(agent);
  const r = await agent.prompt("开始");
  expect(r.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  const causes = events.filter((e) => e.type === "turn_start").map((e) => (e.type === "turn_start" ? e.cause : ""));
  expect(causes).toEqual(["input", "steer"]);
  expect(types(events).filter((t) => t === "reply_start")).toHaveLength(1);
});

test("shouldStopAfterTurn：reply 以 completed 收场、run 直接关门，不再 drain", async () => {
  const gate = new RunIntakeGate("a@1");
  gate.openRun("run:x");
  const events: AgentEvent[] = [];
  let seq = 0;
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
    maxReplies: 10,
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
      events.push({ ...e, seq: seq++, at: 0 } as AgentEvent);
    },
    new AbortController().signal,
    scriptedStreamFn([textTurn("ok")]),
  );
  expect(result.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  expect(gate.activeRunId).toBeNull();
});

test("从 transcript 续跑：reply source=resume，没有输入的 message_end，直接 turn_start{input}", async () => {
  let agent!: Agent;
  const t = tool("t", async () => {
    agent.abort("先停");
    return toolOk("ok");
  });
  agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("续上了")]), tools: [t] });
  const first = await agent.prompt("开始");
  expect(first.outcome.kind).toBe("aborted");
  expect(agent.messages.at(-1)?.role).toBe("toolResult");
  const events = collect(agent);
  const r = await agent.continue();
  expect(r.outcome.kind).toBe("completed");
  expect(validate(events)).toEqual([]);
  expect(types(events).slice(0, 4)).toEqual(["agent_start", "reply_start", "turn_start", "attempt_start"]);
  const reply = events.find((e) => e.type === "reply_start");
  expect(reply?.type === "reply_start" && reply.source).toBe("resume");
});

test("reply 数达上限且仍有待办：agent_end{error, max_replies}，待办经 [queue_dropped] 报出；达上限但无待办 → completed", async () => {
  let agent!: Agent;
  const t = tool("t", async () => {
    await agent.followUp("跟进");
    return toolOk("ok");
  });
  agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("b"), textTurn("不该到")]), tools: [t], maxReplies: 1 });
  const events = collect(agent);
  const seen = lifecycle(agent);
  const r = await agent.prompt("开始");
  expect(r.outcome).toMatchObject({ kind: "error", error: { code: "max_replies" } });
  expect(validate(events)).toEqual([]);
  expect(types(events).filter((t) => t === "reply_start")).toHaveLength(1);
  const dropped = seen.filter((e) => e.type === "notification" && e.message.includes("[queue_dropped]"));
  expect(dropped).toHaveLength(1);
  expect((dropped[0] as { message: string }).message).toContain("followUp 1 条");

  // 上限内、无待办：正常完成
  const quiet = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("a")]), maxReplies: 1 });
  expect((await quiet.prompt("go")).outcome.kind).toBe("completed");
});

test("maxIterations 按 reply 计：第一条 reply 撞闸不影响同一 run 的下一条 reply", async () => {
  // 第一条 reply：工具循环两轮撞闸（maxIterations=2）。判据只看 outcome 与 turn 序号——撞闸的 reply 让 run 以 error 收场，这是现状语义
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), toolTurn("c2", "t", {}), textTurn("不该到")]),
    tools: [tool("t", async () => toolOk("ok"))],
    maxIterations: 2,
  });
  const events = collect(agent);
  const r = await agent.prompt("go");
  expect(r.outcome).toMatchObject({ kind: "error", error: { code: "max_iterations" } });
  expect(validate(events)).toEqual([]);
  const end = events.find((e) => e.type === "reply_end");
  expect(end?.type === "reply_end" && end.turns).toBe(2);
});

test("streamFn 抛出（违约）：折成 attempt_end{failed, internal}，层层关门，outcome error", async () => {
  const boom = (() => {
    throw new Error("STREAM_FN_EXPLODED");
  }) as unknown as StreamFn;
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: boom, timeoutMs: 5_000 });
  const events = collect(agent);
  const started = Date.now();
  const r = await agent.prompt("go");
  expect(r.outcome).toMatchObject({ kind: "error", error: { code: "internal", message: "STREAM_FN_EXPLODED" } });
  expect(validate(events)).toEqual([]);
  expect(types(events)).toEqual(["agent_start", "reply_start", "message_end", "turn_start", "attempt_start", "message_start", "message_end", "attempt_end", "turn_end", "reply_end", "agent_end"]);
  // deadline timer 已清：run 立刻收场，不等 timeoutMs
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(agent.status).toBe("idle");
});
