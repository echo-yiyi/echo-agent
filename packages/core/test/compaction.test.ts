// 压缩（docs/design/compaction.md）的判据。每条先写「没有这条会怎么错」。
//
//   视图层：切点永远不落在 tool_use 与 tool_result 之间；清理只换正文不删消息；transcript 一个字不动。
//   阶梯层：四个内建阶段各自的触发条件与产物；摘要框定里带取回提示。
//   循环层：触发之后**紧接着的那次** provider 请求不含被覆盖原文；压完不重复压；撞窗应急一次；
//           压缩后立即续与重启恢复后续，送模消息逐字节相同。
//   扩展层：阶段经 registry 装卸，装卸在轮边界生效（热插拔）；没有阶段就不压。
//   手动：/compact 走同一条流水线，忙时 rejected。

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, errorTurn, scriptedStreamFn, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { assistantMessage, toolResultMessage, userMessage, type AgentMessage, type Context } from "../src/messages.ts";
import type { Model, StreamFn } from "../src/provider/types.ts";
import type { AgentEvent, LifecycleEvent } from "../src/events.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { SessionService } from "../src/session/service.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { EMPTY_COMPACTION, type CompactionInput, type CompactionStage, type CompactionState } from "../src/compaction/types.ts";
import {
  IMAGE_TOKEN_ESTIMATE,
  buildWorkingMessages,
  clearedNotice,
  estimateText,
  estimateTokens,
  isLegalCut,
  measureContext,
  normalizeCompaction,
  omissionNotice,
  snapBack,
} from "../src/compaction/view.ts";
import {
  chooseTailStart,
  collapseStage,
  extractSummary,
  frameFull,
  snipStage,
  summaryStage,
  toolResultsStage,
} from "../src/compaction/builtin.ts";
import { renderTranscript, transcriptReadTool } from "../src/compaction/tool.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { AgentCompaction, ExtensionHost, agentRegistries, defineExtension, type ExtensionEntry } from "../src/extension/public.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";

/* ─────────────── 夹具 ─────────────── */

/** 两轮带工具的对话：0 user · 1 asst(tool_use) · 2 toolResult · 3 asst(text) · 4 user · 5 asst(tool_use) · 6 toolResult · 7 asst(text) */
function twoTurns(): AgentMessage[] {
  return [
    userMessage("first question"),
    assistantMessage([{ type: "tool_use", id: "c1", name: "echo", input: { a: 1 } }], "tool_use"),
    toolResultMessage("c1", "echo", "result one is long enough to matter ".repeat(4), false),
    assistantMessage([{ type: "text", text: "answer one" }], "end_turn"),
    userMessage("second question"),
    assistantMessage([{ type: "tool_use", id: "c2", name: "echo", input: { a: 2 } }], "tool_use"),
    toolResultMessage("c2", "echo", "result two", false),
    assistantMessage([{ type: "text", text: "answer two" }], "end_turn"),
  ];
}

function echoTool(): ModelTool {
  return { kind: "model", name: "echo", label: "echo", description: "echo", parameters: { type: "object", properties: {} }, execute: async () => toolOk("echoed") };
}

/** 一条只回一段文字的 scripted turn（摘要调用用它当模型回复）。 */
function reply(text: string): ScriptedTurn {
  return textTurn(text);
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

const SIG = new AbortController().signal;

/** 小窗口：400 token，reserve 100 → target 300，goal 260。 */
const SMALL: Model = { ...FAKE_MODEL, capabilities: { contextWindow: 400 } };
const BIG_TEXT = "x".repeat(2000); // ≈ 505 token，一条就超 target

function textOf(c: Context, i: number): string {
  return JSON.stringify(c.messages[i]?.content ?? null);
}

function stage(name: string, order: number, run: (input: CompactionInput) => CompactionState | null): CompactionStage {
  return { name, order, run };
}

function fakeCall(reply: string, seen: { systemPrompt: string | null; messages: readonly AgentMessage[] }[] = []): CompactionInput["callModel"] {
  return async (input) => {
    seen.push(input);
    return reply;
  };
}

function input(messages: readonly AgentMessage[], over: Partial<CompactionInput> = {}): CompactionInput {
  return {
    messages,
    state: EMPTY_COMPACTION,
    budget: { window: 400, used: 500, target: 300, goal: 260 },
    reason: "auto",
    callModel: fakeCall("<summary>S</summary>"),
    estimate: estimateTokens,
    ...over,
  };
}

/** 带 usage 的工具调用轮：压缩的触发与校准比都从这里的 usage 来。 */
function toolTurnUsage(toolCallId: string, usage: { inputTokens: number; outputTokens: number }): ScriptedTurn {
  return [
    { type: "start" },
    { type: "toolcall_start", toolCallId, name: "echo" },
    { type: "toolcall_delta", argsText: "{}" },
    { type: "toolcall_end" },
    { type: "done", message: { role: "assistant", content: [{ type: "tool_use", id: toolCallId, name: "echo", input: {} }], stopReason: "tool_use", usage } },
  ];
}

/* ═══════════════ 视图层 ═══════════════ */

test("切点：toolResult 前面不能切；snapBack 优先轮起点、其次合法切点、都没有回 min", () => {
  const m = twoTurns();
  expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => isLegalCut(m, i))).toEqual([true, true, false, true, true, true, false, true, true]);
  // 从 6（toolResult）往前：轮起点是 4
  expect(snapBack(m, 6, 0, "turn")).toBe(4);
  // 只找合法切点：5（带 tool_use 的 assistant 之前）
  expect(snapBack(m, 6, 0, "legal")).toBe(5);
  // min 之上没有任何切点 → min
  expect(snapBack(m, 2, 1, "turn")).toBe(1);
});

test("normalizeCompaction：越界截断、非法边界吸附、空段丢弃、乱序排好；重叠是阶段 bug → 抛", () => {
  const m = twoTurns();
  // [0,2) 切在 c1 的结果前面 → to 吸回 1；[6,9) from 在 toolResult 上 → 吸回 5、to 截到 8
  const s = normalizeCompaction(m, { spans: [{ from: 6, to: 9, summary: "b" }, { from: 0, to: 2, summary: "a" }], clearedBefore: 99 });
  expect(s).toEqual({ spans: [{ from: 0, to: 1, summary: "a" }, { from: 5, to: 8, summary: "b" }], clearedBefore: 8 });
  // 吸完变空的段消失
  expect(normalizeCompaction(m, { spans: [{ from: 1, to: 2, summary: "x" }], clearedBefore: 0 }).spans).toEqual([]);
  expect(() => normalizeCompaction(m, { spans: [{ from: 0, to: 4, summary: "a" }, { from: 3, to: 8, summary: "b" }], clearedBefore: 0 })).toThrow(/overlap/);
});

test("投影：段 → 一条 user/harness；清掉的 toolResult 换占位但 toolCallId / isError 不动；transcript 原对象一个字不改", () => {
  const m = twoTurns();
  const before = structuredClone(m);
  const state: CompactionState = { spans: [{ from: 0, to: 4, summary: "SUMMARY" }], clearedBefore: 7 };
  const view = buildWorkingMessages(m, state);
  expect(view.map((x) => x.role)).toEqual(["user", "user", "assistant", "toolResult", "assistant"]);
  const head = view[0]!;
  expect(head.role === "user" && head.source === "harness" && head.content[0]!.type === "text" && head.content[0]!.text === "SUMMARY").toBe(true);
  const cleared = view[3]!;
  if (cleared.role !== "toolResult") throw new Error("expected toolResult");
  expect(cleared.toolCallId).toBe("c2");
  expect(cleared.isError).toBe(false);
  expect(cleared.content).toBe(clearedNotice(6, "result two".length, 0));
  // 未动的消息是同一个对象（不复制），动过的是新对象；transcript 本身与之前逐字节相同
  expect(view[1]).toBe(m[4]);
  expect(view[2]).toBe(m[5]);
  expect(view[4]).toBe(m[7]);
  expect(m).toEqual(before);
  // summary null → 固定省略说明
  const omitted = buildWorkingMessages(m, { spans: [{ from: 0, to: 4, summary: null }], clearedBefore: 0 })[0]!;
  expect(omitted.role === "user" && omitted.content[0]!.type === "text" && omitted.content[0]!.text).toBe(omissionNotice(0, 4));
});

test("measureContext：有 usage 基准 = 基准 + 基准之后的字符估；没有 = system + 整个视图的字符估；校准比只乘字符估的部分", () => {
  const m = twoTurns();
  const noAnchor = measureContext({ messages: m, state: EMPTY_COMPACTION, systemPrompt: "s".repeat(40), anchor: null });
  expect(noAnchor).toBe(10 + estimateTokens(m));
  const anchored = measureContext({ messages: m, state: EMPTY_COMPACTION, systemPrompt: "s".repeat(40), anchor: { index: 6, tokens: 1000 } });
  expect(anchored).toBe(1000 + estimateTokens(m.slice(6)));
  expect(measureContext({ messages: m, state: EMPTY_COMPACTION, systemPrompt: null, anchor: null, calibration: 3 })).toBe(Math.ceil(estimateTokens(m) * 3));
  expect(measureContext({ messages: m, state: EMPTY_COMPACTION, systemPrompt: null, anchor: { index: 6, tokens: 1000 }, calibration: 3 })).toBe(1000 + Math.ceil(estimateTokens(m.slice(6)) * 3));
});

test("估算：图片按固定值不按 base64 长度；toolResult 挂在 images 上的图也算进去", () => {
  const png = "A".repeat(1_000_000); // 1MB base64：按字符估会算成二十多万 token
  const withImage = userMessage("look", "human", [{ type: "image", mimeType: "image/png", data: png }]);
  expect(estimateTokens([withImage])).toBe(estimateTokens([userMessage("look")]) + IMAGE_TOKEN_ESTIMATE);
  const result = toolResultMessage("c9", "shot", "ok", false, null, [
    { type: "image", mimeType: "image/png", data: png },
    { type: "image", mimeType: "image/png", data: png },
  ]);
  expect(estimateTokens([result])).toBe(Math.ceil("ok".length / 4) + 2 * IMAGE_TOKEN_ESTIMATE);
  // 清掉带图的工具结果：占位要说有几张图没了，不能让模型以为它本来就没图
  const m = [userMessage("q"), assistantMessage([{ type: "tool_use", id: "c9", name: "shot", input: {} }], "tool_use"), result, assistantMessage([{ type: "text", text: "done" }], "end_turn")];
  const view = buildWorkingMessages(m, { spans: [], clearedBefore: 3 });
  const cleared = view[2]!;
  expect(cleared.role === "toolResult" && cleared.content).toBe(clearedNotice(2, 2, 2));
  expect(clearedNotice(2, 2, 2)).toContain("2 images");
  expect(cleared.role === "toolResult" && cleared.images).toBeUndefined();
});

/* ═══════════════ 阶梯层 ═══════════════ */

test("tool-results：保留最近 K 批，之前的 toolResult 标清；没有更旧的可清就 null；overflow 只留 1 批", () => {
  const m = twoTurns();
  expect(toolResultsStage(1).run(input(m), SIG)).toEqual({ spans: [], clearedBefore: 5 });
  expect(toolResultsStage(2).run(input(m), SIG)).toBeNull(); // 第 2 批是 #1，它之前没有 toolResult
  expect(toolResultsStage(3).run(input(m, { reason: "overflow" }), SIG)).toEqual({ spans: [], clearedBefore: 5 });
  // 已经清到 5 了 → 无事可做
  expect(toolResultsStage(1).run(input(m, { state: { spans: [], clearedBefore: 5 } }), SIG)).toBeNull();
});

/** 逐条估算再求和（chooseTailStart 就是这么累加的；整段一起估会因 ceil 少几个 token）。 */
function tokensOf(list: readonly AgentMessage[]): number {
  return list.reduce((acc, x) => acc + estimateTokens([x]), 0);
}

test("chooseTailStart：预算够就从最早的轮起点留起；预算只够半轮就退到合法切点；连一条都放不下就不留尾", () => {
  const m = twoTurns();
  expect(chooseTailStart(m, EMPTY_COMPACTION, 100_000, 0)).toBe(0);
  expect(chooseTailStart(m, EMPTY_COMPACTION, tokensOf(m.slice(4)), 0)).toBe(4);
  // 只够最后三条（asst tool_use + toolResult + asst）：在飞的一轮放不下，退到合法切点 5（不是 6，那会拆开 c2 的配对）
  expect(chooseTailStart(m, EMPTY_COMPACTION, tokensOf(m.slice(5)), 0)).toBe(5);
  expect(chooseTailStart(m, EMPTY_COMPACTION, 0, 0)).toBe(8);
});

test("summary：尾巴之前折成一段，摘要经框定（来历 + 取回提示）；模型收到的是投影后的前缀 + harness 指令；manual 的指令追加在末尾", async () => {
  const m = twoTurns();
  const seen: { systemPrompt: string | null; messages: readonly AgentMessage[] }[] = [];
  const keep = tokensOf(m.slice(4));
  const s = await summaryStage({ keepRecentTokens: keep }).run(input(m, { callModel: fakeCall("<scratchpad>think</scratchpad><summary>THE SUMMARY</summary>", seen) }), new AbortController().signal);
  expect(s).toEqual({ spans: [{ from: 0, to: 4, summary: frameFull(0, 4, "THE SUMMARY") }], clearedBefore: 0 });
  expect(s!.spans[0]!.summary).toContain("transcript_read");
  expect(s!.spans[0]!.summary).not.toContain("think");
  expect(seen[0]!.messages.map((x) => x.role)).toEqual(["user", "assistant", "toolResult", "assistant", "user"]);
  const last = seen[0]!.messages[4]!;
  expect(last.role === "user" && last.source).toBe("harness");
  // 尾巴（#4–#7）以只读文本附在指令里：摘要器据它把「现在在干什么」写对，但它不在被总结的消息里
  const askText = last.role === "user" && last.content[0]!.type === "text" ? last.content[0]!.text : "";
  expect(askText).toContain("<recent>");
  expect(askText).toContain("#7 [assistant] answer two");
  expect(askText).not.toContain("#3 [assistant] answer one");
  // manual + 指令
  const seen2: { systemPrompt: string | null; messages: readonly AgentMessage[] }[] = [];
  await summaryStage({ keepRecentTokens: keep }).run(input(m, { reason: "manual", instructions: "keep only TODOs", callModel: fakeCall("<summary>x</summary>", seen2) }), new AbortController().signal);
  const ask = seen2[0]!.messages[4]!;
  expect(ask.role === "user" && ask.content[0]!.type === "text" && ask.content[0]!.text).toContain("keep only TODOs");
  // 已经是同一段覆盖到同一个尾巴：auto 无事可做
  expect(await summaryStage({ keepRecentTokens: keep }).run(input(m, { state: s! }), new AbortController().signal)).toBeNull();
  // 模型回了空 → 抛（流水线记 compactionFailed），不产出空摘要
  await expect(summaryStage({ keepRecentTokens: keep }).run(input(m, { callModel: fakeCall("") }), new AbortController().signal)).rejects.toThrow(/no summary/);
});

test("collapse：只服务 auto；从最旧原文起一段一段折，够了就停；每段一次模型调用", async () => {
  const m = twoTurns();
  const calls: { systemPrompt: string | null; messages: readonly AgentMessage[] }[] = [];
  const keep = tokensOf(m.slice(4));
  // 段大小 1 token → 段在下一个轮起点收口（一轮比段大就整轮一段）；goal 定得很低 → 一直折到只剩尾巴
  const s = await collapseStage({ sectionTokens: 1, keepRecentTokens: keep }).run(
    input(m, { budget: { window: 400, used: 500, target: 300, goal: 0 }, callModel: fakeCall("<summary>C</summary>", calls) }),
    new AbortController().signal,
  );
  expect(s!.spans.map((x) => [x.from, x.to])).toEqual([[0, 4]]);
  expect(s!.spans[0]!.summary).toContain("#0–#3");
  expect(calls.length).toBe(1);
  // goal 已经满足 → 一段都不折
  expect(await collapseStage({ sectionTokens: 1, keepRecentTokens: keep }).run(input(m, { budget: { window: 400, used: 100, target: 300, goal: 260 } }), new AbortController().signal)).toBeNull();
  expect(await collapseStage().run(input(m, { reason: "overflow" }), new AbortController().signal)).toBeNull();
  expect(await collapseStage().run(input(m, { reason: "manual" }), new AbortController().signal)).toBeNull();
});

test("snip：只在 overflow；产物是 summary=null 的一段；整个 transcript 都塞得进应急尾巴时无事可做", () => {
  const small = twoTurns();
  expect(snipStage().run(input(small, { reason: "overflow" }), SIG)).toBeNull(); // 全部 < 2k token，尾巴就是全文
  const m = [userMessage("x".repeat(12_000)), ...twoTurns()];
  expect(snipStage().run(input(m), SIG)).toBeNull();
  expect(snipStage().run(input(m, { reason: "overflow" }), SIG)).toEqual({ spans: [{ from: 0, to: 1, summary: null }], clearedBefore: 0 });
});

test("extractSummary：剥 scratchpad、取 summary 里面的；都没有就整段", () => {
  expect(extractSummary("<scratchpad>a</scratchpad>\n<summary>\nS\n</summary>")).toBe("S");
  expect(extractSummary("plain")).toBe("plain");
  expect(extractSummary("<scratchpad>only</scratchpad>")).toBe("");
});

/* ═══════════════ 循环层 ═══════════════ */

/** 低层路径：`new Agent()` + `mountBuiltinTools()`，与 createEcho 同一张 builtin 表。 */
async function agentWithBuiltins(
  streamFunction: StreamFn,
  opts: { model?: Model; session?: { store: InMemoryDir; id: string }; compaction?: Agent["compaction"] } = {},
): Promise<Agent> {
  const agent = new Agent({
    model: opts.model ?? SMALL,
    streamFunction,
    tools: [echoTool()],
    // 一个 store 就是一段 session 的目录（2026-09-03）：同一个 store 换个 Agent 就是「另一个进程续同一段」
    ...(opts.session !== undefined ? { sessionService: new SessionService(opts.session.store), sessionId: opts.session.id } : {}),
    compaction: opts.compaction ?? { reserveTokens: 100, keepRecentTokens: 40 },
  });
  await mountBuiltinTools(agent);
  // 注入了 sessionService 就是 lifecycle-managed：不 start 连 prompt 都不接
  if (opts.session !== undefined) await agent.start();
  return agent;
}

/** 从盘上把那一段读回来——测试要验的是「落盘了什么」，所以每次新开一个 Service。 */
async function loadSession(store: InMemoryDir, id: string): Promise<{ compaction: CompactionState }> {
  return await new SessionService(store).createOrResume(id);
}

function collect(agent: Agent): { events: AgentEvent[]; lifecycle: LifecycleEvent[] } {
  const events: AgentEvent[] = [];
  const lifecycle: LifecycleEvent[] = [];
  agent.subscribe((e) => void events.push(e));
  agent.subscribeLifecycle((e) => void lifecycle.push(e));
  return { events, lifecycle };
}

test("auto：超阈值 → 轮首压缩 → 紧接着的 provider 请求只含摘要不含原文；压完下一轮不重复压；状态与 session 都记下", async () => {
  const store = new InMemoryDir();
  const { fn, requests } = capturing([reply("<summary>S1</summary>"), toolTurn("t1", "echo", {}), textTurn("done")]);
  const agent = await agentWithBuiltins(fn, { session: { store, id: "s1" } });
  const { events, lifecycle } = collect(agent);
  const result = await agent.prompt(BIG_TEXT);
  expect(result.outcome.kind).toBe("completed");
  // 请求 0 是摘要调用（无工具、末尾一条 harness 指令），请求 1 是真正的那一轮
  expect(requests[0]!.tools).toEqual([]);
  expect(requests[1]!.messages.length).toBe(1);
  expect(textOf(requests[1]!, 0)).toContain("S1");
  expect(textOf(requests[1]!, 0)).not.toContain(BIG_TEXT);
  // 第二轮（工具结果回来之后）没有再压：compaction_start 只有一次
  expect(events.filter((e) => e.type === "compaction_start").length).toBe(1);
  const end = events.find((e) => e.type === "compaction_end");
  expect(end !== undefined && end.type === "compaction_end" && end.stages).toEqual(["collapse"]);
  expect(agent.state.compaction.spans.length).toBe(1);
  expect(agent.state.contextTokens).not.toBeNull();
  expect(lifecycle.some((e) => e.type === "postCompact")).toBe(true);
  // transcript 原文还在
  expect(agent.messages[0]!.role === "user" && JSON.stringify(agent.messages[0]!.content)).toContain(BIG_TEXT);
  // session 里有一条 compaction entry，状态与运行时同一份
  const loaded = await loadSession(store, "s1");
  expect(loaded.compaction).toEqual(agent.state.compaction);
});

test("压缩后立即续跑 vs 重启恢复后续跑：下一次送模消息逐字节相同（§7.4 第 4 条）", async () => {
  const store = new InMemoryDir();
  const a = capturing([reply("<summary>S1</summary>"), textTurn("one"), textTurn("two")]);
  const agentA = await agentWithBuiltins(a.fn, { session: { store, id: "s1" } });
  await agentA.prompt(BIG_TEXT);
  // 另一个进程在这一刻恢复同一段（transcript 两条 + 一条 compaction entry）
  const b = capturing([textTurn("two")]);
  const agentB = await agentWithBuiltins(b.fn, { session: { store, id: "s1" } });
  expect(agentB.state.compaction).toEqual(agentA.state.compaction);
  await agentA.prompt("next");
  await agentB.prompt("next");
  expect(b.requests[0]!.messages).toEqual(a.requests[2]!.messages);
  expect(b.requests[0]!.messages.length).toBe(3); // 摘要 · one · next
});

test("撞窗应急：context_overflow → 同一条流水线以 overflow 跑一次 → 重跑本轮成功；第二次撞窗按 error 收场", async () => {
  const big: Model = { ...FAKE_MODEL, capabilities: { contextWindow: 1_000_000 } };
  const { fn, requests } = capturing([
    textTurn("first"),
    errorTurn("context_overflow", "prompt too long", false),
    reply("<summary>RECOVERED</summary>"),
    textTurn("ok"),
  ]);
  const agent = await agentWithBuiltins(fn, { model: big, compaction: { keepRecentTokens: 8_000 } });
  const { events } = collect(agent);
  await agent.prompt("x".repeat(12_000)); // 3k token 的历史，比应急尾巴（2k）大 → 有东西可折
  const result = await agent.prompt("second");
  expect(result.outcome.kind).toBe("completed");
  const starts = events.filter((e) => e.type === "compaction_start");
  expect(starts.length).toBe(1);
  expect(starts[0]!.type === "compaction_start" && starts[0]!.reason).toBe("overflow");
  // 请求：0 first · 1 撞窗 · 2 摘要调用 · 3 重跑——重跑不含 12k 原文，含摘要
  expect(requests.length).toBe(4);
  expect(JSON.stringify(requests[3]!.messages)).not.toContain("x".repeat(12_000));
  expect(JSON.stringify(requests[3]!.messages)).toContain("RECOVERED");

  // 同一 run 第二次撞窗：不再应急，error
  const again = capturing([textTurn("first"), errorTurn("context_overflow", "too long", false), reply("<summary>R</summary>"), errorTurn("context_overflow", "still too long", false)]);
  const agent2 = await agentWithBuiltins(again.fn, { model: big, compaction: { keepRecentTokens: 8_000 } });
  await agent2.prompt("x".repeat(12_000));
  const r2 = await agent2.prompt("second");
  expect(r2.outcome.kind === "error" && r2.outcome.error.code).toBe("context_overflow");
});

/**
 * 量纲：触发看 provider usage，阶段之间只能重新字符估。中文 1 字约 0.6–1 token，chars/4 低估 2–4 倍——
 * 不校准的话中文会话清完第一段就「够了」，collapse / summary 永远轮不到；英文会话恰好对得上所以看不出来。
 * 判据：同一段对话的 ASCII 版与中文版，usage 一样，压缩跑过的阶段必须一样。
 */
test("校准比：ASCII 与中文同一段对话、同一份 usage，压缩跑过的阶段一致（中文不会在第一段就停）", async () => {
  const window: Model = { ...FAKE_MODEL, capabilities: { contextWindow: 1_000 } };
  const run = async (text: string): Promise<readonly string[]> => {
    // 轮 1 usage 300（不触发）；轮 2 usage 950（> target 900）→ 轮 3 轮首触发；之后每次模型调用都回同一段摘要
    const { fn } = capturing([toolTurnUsage("t1", { inputTokens: 300, outputTokens: 0 }), toolTurnUsage("t2", { inputTokens: 950, outputTokens: 0 }), ...Array.from({ length: 4 }, () => reply("<summary>S</summary>"))]);
    const agent = await agentWithBuiltins(fn, { model: window, compaction: { reserveTokens: 100, keepRecentTokens: 40, keepRecentToolResults: 1 } });
    const { events } = collect(agent);
    await agent.prompt(text);
    const ends = events.filter((e): e is Extract<AgentEvent, { type: "compaction_end" }> => e.type === "compaction_end");
    expect(ends.length).toBe(1);
    return ends[0]!.stages;
  };
  // 同一份 usage（950）。估算里还有 system（内建段约 140 token）。ASCII 2800 字符按 chars/4 ≈ 700：第一轮不会靠字符估
  // 误触发（700 + 140 < 900），清完工具结果后仍 > goal 800，不校准也会继续跑 collapse；中文 1200 字按 chars/4 只有 300，
  // 不校准的话清完第一段就「够了」（300 + 140 < 800）——真值却还是 950
  const ascii = await run("word ".repeat(560));
  const cjk = await run("汉字".repeat(600));
  expect(ascii).toEqual(["tool-results", "collapse"]);
  expect(cjk).toEqual(ascii);
});

test("手动压缩沿用上一次 usage 的校准比：中文会话压完报出的 contextTokens 不是裸字符估", async () => {
  const withUsage: ScriptedTurn = [
    { type: "start" },
    { type: "done", message: { role: "assistant", content: [{ type: "text", text: "好" }], stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 50 } } },
  ];
  const agent = await agentWithBuiltins(scriptedStreamFn([withUsage, reply("<summary>S</summary>")]), { model: FAKE_MODEL, compaction: { keepRecentTokens: 0 } });
  await agent.prompt("汉字".repeat(600)); // 字符估 300，provider 说 950 → 校准比 ≈ 2
  const r = await agent.compact();
  expect(r.kind === "done" && r.stages).toEqual(["summary"]);
  const rawAfter = estimateText(await agent.assemblePrompt()) + estimateTokens(buildWorkingMessages(agent.messages, agent.state.compaction));
  expect(r.kind === "done" && r.contextTokens!).toBeGreaterThan(Math.ceil(rawAfter * 1.8));
  expect(agent.state.contextTokens).toBe(r.kind === "done" ? r.contextTokens : -1);
  agent.reset(); // 归 1：换了会话不能带着上一场的语言密度
  expect(agent.state.contextTokens).toBeNull();
});

test("没有任何阶段（builtin=false、没别的策略）：不压、撞窗直接 error、compaction 事件一个都没有", async () => {
  const { fn } = capturing([errorTurn("context_overflow", "too long", false)]);
  const agent = new Agent({ model: SMALL, streamFunction: fn, compaction: { builtin: false } });
  await mountBuiltinTools(agent);
  const { events } = collect(agent);
  const r = await agent.prompt(BIG_TEXT);
  expect(r.outcome.kind === "error" && r.outcome.error.code).toBe("context_overflow");
  expect(events.some((e) => e.type === "compaction_start")).toBe(false);
  expect(agent.tools.has("transcript_read")).toBe(false);
});

test("preCompact 返回 block：这次不压，模型照常收到全文", async () => {
  const hooks = new HookRuntime();
  hooks.on("preCompact", () => ({ decision: "block" as const, reason: "not now" }));
  const { fn, requests } = capturing([textTurn("done")]);
  const agent = new Agent({ model: SMALL, streamFunction: fn, hooks, compaction: { reserveTokens: 100 } });
  await mountBuiltinTools(agent);
  await agent.prompt(BIG_TEXT);
  expect(textOf(requests[0]!, 0)).toContain(BIG_TEXT);
});

test("阶段抛错：记 compactionFailed（带 stage）、跳到下一段；全部没压动也记一条", async () => {
  const bad = stage("bad", 5, () => {
    throw new Error("boom");
  });
  const { fn } = capturing([textTurn("done")]);
  const agent = new Agent({ model: SMALL, streamFunction: fn, compaction: { builtin: false, reserveTokens: 100 } });
  agent.compactionStages.set(bad.name, bad);
  const { lifecycle, events } = collect(agent);
  await agent.prompt(BIG_TEXT);
  const failed = lifecycle.filter((e): e is Extract<LifecycleEvent, { type: "compactionFailed" }> => e.type === "compactionFailed");
  expect(failed.map((e) => e.stage)).toEqual(["bad", undefined]);
  expect(failed[0]!.message).toContain("boom");
  // start / end 仍成对（观测 span 要闭合），end 的 stages 为空
  const end = events.find((e) => e.type === "compaction_end");
  expect(end !== undefined && end.type === "compaction_end" && end.stages).toEqual([]);
});

test("contextTokens：每轮以 provider 的 usage 刷新（输入 + 输出）", async () => {
  const withUsage: ScriptedTurn = [
    { type: "start" },
    { type: "done", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 7 } } },
  ];
  const agent = new Agent({ model: SMALL, streamFunction: scriptedStreamFn([withUsage]) });
  expect(agent.state.contextTokens).toBeNull();
  await agent.prompt("hello");
  expect(agent.state.contextTokens).toBe(127);
  agent.reset();
  expect(agent.state.contextTokens).toBeNull();
});

/* ═══════════════ 扩展层：热插拔 ═══════════════ */

test("阶段是 extension：mount 一代就用它的策略，unmount 后没有阶段就不压，再 mount 另一代就用新的——都在轮边界生效", async () => {
  const { fn, requests } = capturing([textTurn("1"), textTurn("2"), textTurn("3")]);
  const agent = new Agent({ model: SMALL, streamFunction: fn, compaction: { builtin: false, reserveTokens: 100 } });
  const host = new ExtensionHost({ services: agentRegistries({ tools: agent.tools, hooks: agent.hooks, compaction: agent.compactionStages }) });
  const strategy = (name: string, marker: string): ExtensionEntry => ({
    entryId: name,
    definition: defineExtension({
      name,
      hostAbiVersion: 1,
      inject: { compaction: { service: AgentCompaction, required: true } },
      apply(ctx) {
        const reg = ctx.get(AgentCompaction);
        void ctx.effect({
          boundary: "turn",
          start: () => ({
            value: name,
            // 策略：把尾巴之前全部换成一句标记（不调模型）
            dispose: reg.stage(stage(name, 10, (i) => ({ spans: [{ from: 0, to: i.messages.length, summary: marker }], clearedBefore: 0 }))),
          }),
        });
      },
    }),
  });
  const { events } = collect(agent);
  await host.mount("g1", [strategy("acme:compaction", "MARK-A")]);
  await agent.prompt(BIG_TEXT);
  expect(textOf(requests[0]!, 0)).toContain("MARK-A");

  await host.unmount("g1");
  expect(agent.compactionStages.size).toBe(0);
  await agent.prompt(BIG_TEXT); // transcript 又超线，但没有阶段 → 全文照发
  expect(JSON.stringify(requests[1]!.messages)).toContain(BIG_TEXT);

  await host.mount("g2", [strategy("other:compaction", "MARK-B")]);
  await agent.prompt("again");
  expect(textOf(requests[2]!, 0)).toContain("MARK-B");
  expect(events.filter((e) => e.type === "compaction_end").map((e) => (e.type === "compaction_end" ? e.stages[0] : ""))).toEqual(["acme:compaction", "other:compaction"]);
});

test("registry：同名阶段 fail-loud；disposer 只卸自己那个对象", () => {
  const stages = new Map<string, CompactionStage>();
  const [[, reg]] = agentRegistries({ tools: new Map(), hooks: new HookRuntime(), compaction: stages }).filter(([k]) => k.id === "echo.agent.compaction") as [[unknown, { stage(s: CompactionStage): () => void }]];
  const a = stage("s", 1, () => null);
  const off = reg.stage(a);
  expect(() => reg.stage(stage("s", 2, () => null))).toThrow(/已存在/);
  expect(() => reg.stage(stage("", 2, () => null))).toThrow(/缺 name/);
  off();
  expect(stages.size).toBe(0);
});

/* ═══════════════ transcript_read ═══════════════ */

test("transcript_read：按下标读原文（含被压掉的）、query 过滤、超长截断并告诉模型从哪续；参数验形", async () => {
  const m = twoTurns();
  const text = renderTranscript(m, { from: 0, to: 3 });
  expect(text).toContain("#0 [user] first question");
  expect(text).toContain('#1 [assistant] <tool_use name="echo" id="c1">');
  expect(text).toContain("#2 [tool_result echo id=\"c1\"]");
  expect(text).not.toContain("#3");
  expect(renderTranscript(m, { from: 0, query: "answer two" })).toBe("#7 [assistant] answer two");
  expect(renderTranscript(m, { from: 0, query: "nothing here" })).toContain("No message");
  expect(renderTranscript(m, { from: 99 })).toContain("past the end");
  const huge = Array.from({ length: 10 }, (_, i) => userMessage(String.fromCharCode(97 + i).repeat(20_000)));
  const out = renderTranscript(huge, { from: 0 });
  expect(out).toContain("truncated at 4000 characters"); // 单条上限
  expect(out).toMatch(/call again with from=\d+ to continue/); // 总上限：告诉模型从哪续
  expect(out).not.toContain("#9 [user]");

  const tool = transcriptReadTool(() => m);
  expect(tool.prepareArguments!({ from: "2", to: 4 })).toEqual({ from: 2, to: 4 });
  expect(() => tool.prepareArguments!({ from: -1 })).toThrow(/from/);
  expect(() => tool.prepareArguments!({ from: 3, to: 3 })).toThrow(/to/);
  const r = await tool.execute({ from: 4, to: 5 }, { toolCallId: "x", workspace: "/", sessionId: null, iteration: 1 });
  expect(r.content).toBe("#4 [user] second question");
});

test("echo:compaction 装上之后 transcript_read 在工具面上，读的是活的 transcript", async () => {
  const agent = await agentWithBuiltins(scriptedStreamFn([textTurn("hi")]), { model: FAKE_MODEL });
  expect(agent.tools.has("transcript_read")).toBe(true);
  await agent.prompt("hello there");
  const tool = agent.tools.get("transcript_read")!;
  const r = await tool.execute({ from: 0 }, { toolCallId: "x", workspace: "/", sessionId: null, iteration: 1 });
  expect(r.content).toContain("#0 [user] hello there");
  expect(r.content).toContain("#1 [assistant] hi");
});

/* ═══════════════ 手动 ═══════════════ */

test("Agent.compact：走同一条流水线（manual，无视阈值，指令交给摘要）；忙时 rejected；没阶段 rejected", async () => {
  const store = new InMemoryDir();
  const { fn, requests } = capturing([textTurn("hi"), reply("<summary>MANUAL</summary>")]);
  const agent = await agentWithBuiltins(fn, { session: { store, id: "s1" }, model: FAKE_MODEL, compaction: { keepRecentTokens: 0 } });
  await agent.prompt("hello");
  const { events } = collect(agent);
  const r = await agent.compact("only the TODOs");
  expect(r.kind === "done" && r.stages).toEqual(["summary"]);
  expect(JSON.stringify(requests[1]!.messages)).toContain("only the TODOs");
  expect(agent.state.compaction.spans[0]!.summary).toContain("MANUAL");
  expect(agent.state.status).toBe("idle");
  expect(events.map((e) => e.type)).toEqual(["compaction_start", "compaction_end"]); // 不是一个 run：没有 agent_start / agent_end
  expect((await loadSession(store, "s1")).compaction).toEqual(agent.state.compaction);

  // 忙：run 中途 compact
  const busy = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("x")]) });
  await mountBuiltinTools(busy);
  let seen: string | undefined;
  busy.subscribe(async (e) => {
    if (e.type === "turn_start") {
      const res = await busy.compact();
      seen = res.kind === "rejected" ? res.reason : "done";
    }
  });
  await busy.prompt("go");
  expect(seen).toContain("正在处理");

  // 没阶段
  const bare = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), compaction: { builtin: false } });
  const none = await bare.compact();
  expect(none.kind === "rejected" && none.reason).toContain("没有注册任何压缩阶段");
});
