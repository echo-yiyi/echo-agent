import { test, expect, afterEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { FAKE_MODEL, scriptedDialect, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { toolResultMessage, userMessage, type Context } from "../src/messages.ts";
import type { StreamFn } from "../src/provider/types.ts";
import type { AgentEvent } from "../src/events.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import { DEFAULT_IDLE_CLEAR_MS } from "../src/compaction/types.ts";
import {
  estimateOutputTokens,
  exceedsInline,
  makeToolOutputReadTool,
  spillToolResult,
  toolOutputFile,
  TOOL_OUTPUT_INLINE_TOKENS,
  TOOL_OUTPUT_PREVIEW_HEAD,
  TOOL_OUTPUT_PREVIEW_TAIL,
  TOOL_OUTPUT_READ,
  TOOL_OUTPUTS_DIR,
} from "../src/tools/output.ts";

// 大工具结果的外存（2026-11-02，照 Claude Code 的做法）：超过内联上限就在入账时把全文存进会话目录，
// 对话里只记说明加头尾预览；模型用 `tool_output_read` 分页读或按关键词查。

process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

const running: Echo[] = [];
afterEach(async () => {
  for (const e of running.splice(0)) await e.stop();
});

/** 一份「大日志」：开头、中间埋一个标记、结尾。约 80k 字符，远超内联上限。 */
function bigLog(): string {
  const lines: string[] = ["BUILD START"];
  for (let i = 0; i < 2_000; i++) lines.push(`line ${i}: compiling module_${i}.ts ... ok`);
  lines.splice(1_000, 0, "MIDDLE-MARKER: the one line we search for");
  lines.push("ERROR: build failed at the very end");
  return lines.join("\n");
}

/* ───────────────────────── 纯逻辑 ───────────────────────── */

test("估算：中日韩文字一字一 token，其余四字符一 token；判定两头先判、中间才数", () => {
  expect(estimateOutputTokens("abcd".repeat(10))).toBe(10);
  expect(estimateOutputTokens("中文测试")).toBe(4);
  expect(estimateOutputTokens("中文ab")).toBe(3);
  // 同样 10,000 字符：英文约 2,500 token 不外存，中文 10,000 token 外存
  expect(exceedsInline("a".repeat(10_000), TOOL_OUTPUT_INLINE_TOKENS)).toBe(false);
  expect(exceedsInline("字".repeat(10_000), TOOL_OUTPUT_INLINE_TOKENS)).toBe(true);
  expect(exceedsInline("a".repeat(40_000), TOOL_OUTPUT_INLINE_TOKENS)).toBe(true);
  expect(exceedsInline("a".repeat(10_000_000), Infinity)).toBe(false);
});

test("文件名：工具调用 id 里文件名不认的字符换成下划线", () => {
  expect(toolOutputFile("call_00_abc-1.x")).toBe("call_00_abc-1.x.txt");
  expect(toolOutputFile("toolu/01:ab cd")).toBe("toolu_01_ab_cd.txt");
});

test("外存：全文落盘，对话里是说明在前、开头与结尾的预览，其余字段原样；没超就原样返回同一个对象", async () => {
  const saved = new Map<string, string>();
  const save = async (file: string, text: string): Promise<void> => {
    saved.set(file, text);
  };
  const small = { content: "ok", isError: false, metadata: { a: 1 } };
  expect(await spillToolResult(small, "t1", TOOL_OUTPUT_INLINE_TOKENS, save)).toBe(small);
  expect(saved.size).toBe(0);

  const log = bigLog();
  const out = await spillToolResult({ content: log, isError: true, metadata: { a: 1 } }, "t2", TOOL_OUTPUT_INLINE_TOKENS, save);
  expect(saved.get("t2.txt")).toBe(log);
  expect(out.isError).toBe(true);
  expect(out.metadata).toEqual({ a: 1 });
  expect(out.content.startsWith("[Output too large:")).toBe(true);
  expect(out.content).toContain('tool output "t2"');
  expect(out.content).toContain(TOOL_OUTPUT_READ);
  expect(out.content).toContain("BUILD START"); // 开头
  expect(out.content).toContain("ERROR: build failed at the very end"); // 结尾：报错多在这里
  expect(out.content).not.toContain("MIDDLE-MARKER"); // 中间不在预览里
  expect(out.content.length).toBeLessThan(TOOL_OUTPUT_PREVIEW_HEAD + TOOL_OUTPUT_PREVIEW_TAIL + 600);
});

test("写盘失败：这一轮不崩，说明讲清全文没存下来、只剩预览", async () => {
  const out = await spillToolResult({ content: bigLog(), isError: false, metadata: null }, "t3", TOOL_OUTPUT_INLINE_TOKENS, async () => {
    throw new Error("disk full");
  });
  expect(out.content).toContain("could not be saved (disk full)");
  expect(out.content).not.toContain(TOOL_OUTPUT_READ);
  expect(out.content).toContain("BUILD START");
});

test("读回工具不在本轮菜单上（比如角色收紧掉了）：照样外存，但说明不点它的名——不教模型用它没有的工具", async () => {
  const saved = new Map<string, string>();
  const out = await spillToolResult({ content: bigLog(), isError: false, metadata: null }, "t5", TOOL_OUTPUT_INLINE_TOKENS, async (f, t) => {
    saved.set(f, t);
  }, { readBack: false });
  expect(saved.get("t5.txt")).toBe(bigLog()); // 上下文照样受保护
  expect(out.content).not.toContain(TOOL_OUTPUT_READ);
  expect(out.content).toContain("cannot be read from this session");
});

test("预览不切开一对 surrogate：边界落在 emoji 中间时退一格", async () => {
  const text = `${"a".repeat(TOOL_OUTPUT_PREVIEW_HEAD - 1)}😀${"b".repeat(60_000)}😀${"c".repeat(TOOL_OUTPUT_PREVIEW_TAIL - 1)}`;
  const out = await spillToolResult({ content: text, isError: false, metadata: null }, "t4", TOOL_OUTPUT_INLINE_TOKENS, async () => {});
  // 没有落单的高位或低位代理
  expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out.content)).toBe(false);
});

test("读回：先找外存文件，找不到再去 transcript 按 id 找原文；分页、按关键词查、id 不存在都说清", async () => {
  const log = bigLog();
  const files = new Map([[toolOutputFile("spilled"), log]]);
  const cleared = toolResultMessage("cleared", "bash", "the original content of a cleared result", false);
  const read = makeToolOutputReadTool({ read: async (f) => files.get(f) ?? null, transcript: () => [userMessage("hi"), cleared] });
  const ctx = { toolCallId: "r", workspace: "/", sessionId: null, iteration: 1 };

  const page = await read.execute({ id: "spilled", offset: 0, limit: 100 }, ctx);
  expect(page.content.startsWith(`[characters 0–100 of ${log.length.toLocaleString("en-US")}; continue with offset=100]`)).toBe(true);
  expect(page.content).toContain("BUILD START");

  const hit = await read.execute({ id: "spilled", query: "middle-marker" }, ctx);
  expect(hit.content).toContain("[1 matching line of");
  expect(hit.content).toContain("MIDDLE-MARKER: the one line we search for");

  const fromTranscript = await read.execute({ id: "cleared" }, ctx);
  expect(fromTranscript.content).toContain("the original content of a cleared result");

  const missing = await read.execute({ id: "nope" }, ctx);
  expect(missing.isError).toBe(true);
  expect(missing.content).toContain("nope");
});

/* ───────────────────────── 接线：Agent ───────────────────────── */

function bigTool(name = "big_log", maxInlineTokens?: number): ModelTool {
  return {
    kind: "model",
    name,
    label: name,
    description: "Produce a big log",
    parameters: { type: "object", properties: {} },
    ...(maxInlineTokens !== undefined ? { maxInlineTokens } : {}),
    execute: async () => toolOk(bigLog()),
  };
}

function capturing(turns: Parameters<typeof scriptedStreamFn>[0]): { fn: StreamFn; requests: Context[] } {
  const requests: Context[] = [];
  const inner = scriptedStreamFn(turns);
  return {
    fn: (m, c, o) => {
      requests.push(c);
      return inner(m, c, o);
    },
    requests,
  };
}

/** 一次请求里所有工具结果块的正文。 */
function toolResultsOf(c: Context): string[] {
  return c.messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])));
}

test("Agent：大结果入账的是预览、事件里是全文、模型请求里是预览；模型用 tool_output_read 查得到中间那行", async () => {
  const { fn, requests } = capturing([
    toolTurn("call_big", "big_log", {}),
    toolTurn("call_read", TOOL_OUTPUT_READ, { id: "call_big", query: "MIDDLE-MARKER" }),
    textTurn("found it"),
  ]);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, tools: [bigTool()] });
  await mountBuiltinTools(agent);
  const ends: AgentEvent[] = [];
  agent.subscribe((e) => {
    if (e.type === "tool_execution_end") ends.push(e);
  });

  const r = await agent.prompt("build it");
  expect(r.outcome.kind).toBe("completed");

  const recorded = agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === "call_big");
  expect(recorded?.role === "toolResult" && recorded.content.startsWith("[Output too large:")).toBe(true);
  const end = ends.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call_big");
  expect(end?.type === "tool_execution_end" && end.result.content).toBe(bigLog()); // 事件与 hook 拿全文

  const afterBig = toolResultsOf(requests[1]!);
  expect(afterBig[0]!.startsWith("[Output too large:")).toBe(true);
  expect(afterBig[0]!).not.toContain("MIDDLE-MARKER");
  const afterRead = toolResultsOf(requests[2]!);
  expect(afterRead[1]!).toContain("MIDDLE-MARKER: the one line we search for");
  // 读回工具常驻菜单
  expect(requests[0]!.tools.map((t) => t.name)).toContain(TOOL_OUTPUT_READ);
});

test("声明 maxInlineTokens: Infinity 的工具从不外存（自己会分页的读文件就这样声明）", async () => {
  const { fn, requests } = capturing([toolTurn("c1", "pager", {}), textTurn("ok")]);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, tools: [bigTool("pager", Infinity)] });
  await mountBuiltinTools(agent);
  await agent.prompt("go");
  expect(toolResultsOf(requests[1]!)[0]).toBe(bigLog());
});

/* ───────────────────────── 空闲清理（reason: "idle"） ───────────────────────── */

/** 一个 reply 里四批工具调用，每批结果约 12.5k token（自己声明不外存，好让它们原样攒在上下文里）。 */
function fourBatches(): Parameters<typeof scriptedStreamFn>[0] {
  return [toolTurn("c1", "pager", {}), toolTurn("c2", "pager", {}), toolTurn("c3", "pager", {}), toolTurn("c4", "pager", {}), textTurn("done")];
}
const PAGE = "x".repeat(50_000);
function pager(content = PAGE): ModelTool {
  return {
    kind: "model",
    name: "pager",
    label: "pager",
    description: "Return a page",
    parameters: { type: "object", properties: {} },
    maxInlineTokens: Infinity,
    execute: async () => toolOk(content),
  };
}

async function idleAgent(opts: { content?: string; builtinCompaction?: boolean } = {}) {
  const clock = new FakeClock(Date.now());
  const { fn, requests } = capturing([...fourBatches(), textTurn("ok")]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: fn,
    tools: [pager(opts.content)],
    clock,
    ...(opts.builtinCompaction === false ? { compaction: { builtin: false } } : {}),
  });
  await mountBuiltinTools(agent);
  const reasons: string[] = [];
  agent.subscribe((e) => {
    if (e.type === "compaction_end") reasons.push(e.reason);
  });
  await agent.prompt("read four pages");
  return { agent, clock, requests, reasons };
}

test("空闲清理：停了够久、最近 3 批之前的旧结果又够多 → 只清那些旧结果（保留最近 3 批），原因记 idle，占位带工具调用 id", async () => {
  const { agent, clock, requests, reasons } = await idleAgent();
  clock.advance(DEFAULT_IDLE_CLEAR_MS + 60_000);
  await agent.prompt("summarize");
  const last = toolResultsOf(requests[requests.length - 1]!);
  expect(last[0]).toContain('[Tool result cleared to save context: 50000 characters omitted');
  expect(last[0]).toContain('tool call "c1"');
  expect(last.slice(1)).toEqual([PAGE, PAGE, PAGE]); // 最近 3 批原样
  expect(reasons).toEqual(["idle"]);
});

test("空闲清理：缓存还热（没停够）不清——清了会让之后整段历史按未命中重付", async () => {
  const { agent, requests, reasons } = await idleAgent();
  await agent.prompt("summarize");
  expect(toolResultsOf(requests[requests.length - 1]!)).toEqual([PAGE, PAGE, PAGE, PAGE]);
  expect(reasons).toEqual([]);
});

test("空闲清理：停够了但可清的不够量就不清", async () => {
  const small = "y".repeat(400);
  const { agent, clock, requests, reasons } = await idleAgent({ content: small });
  clock.advance(DEFAULT_IDLE_CLEAR_MS + 60_000);
  await agent.prompt("summarize");
  expect(toolResultsOf(requests[requests.length - 1]!)).toEqual([small, small, small, small]);
  expect(reasons).toEqual([]);
});

test("空闲清理：产品关掉内建压缩、换了自己的阶段（没有清工具结果的那个）就不触发，也不发失败通知", async () => {
  const { agent, clock, requests, reasons } = await idleAgent({ builtinCompaction: false });
  // 产品自己的策略：碰窗口线时才做事，别的时候返回 null
  agent.compactionStages.set("product-stage", { name: "product-stage", order: 5, run: () => null });
  const failures: string[] = [];
  agent.hooks.on("compactionFailed", (e) => {
    failures.push(e.message);
  });
  clock.advance(DEFAULT_IDLE_CLEAR_MS + 60_000);
  await agent.prompt("summarize");
  expect(toolResultsOf(requests[requests.length - 1]!)).toEqual([PAGE, PAGE, PAGE, PAGE]);
  expect(reasons).toEqual([]);
  expect(failures).toEqual([]);
});

/* ───────────────────────── 接线：createEcho 与会话目录 ───────────────────────── */

test("createEcho：全文落在会话目录的 tool-outputs/ 下，续会话之后照样读得回", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-tool-outputs-"));
  const providerOf = (turns: Parameters<typeof scriptedDialect>[0]) =>
    createProvider({
      id: "scripted",
      auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
      defaultModelId: "only",
      models: [{ id: "only", api: "fake" }],
      api: createProviderStreams(scriptedDialect(turns)),
    });
  const first = await createEcho({
    provider: providerOf([toolTurn("call_big", "big_log", {}), textTurn("done")]),
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
    sessionsRoot: root,
    agent: { tools: [bigTool()] },
  });
  await first.start();
  await first.agent.prompt("build it");
  const id = first.agent.state.sessionId!;
  await first.stop();

  const file = join(root, id, TOOL_OUTPUTS_DIR, toolOutputFile("call_big"));
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(bigLog());

  const second = await createEcho({
    provider: providerOf([toolTurn("call_read", TOOL_OUTPUT_READ, { id: "call_big", query: "very end" }), textTurn("ok")]),
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
    sessionsRoot: root,
    sessionId: id,
    agent: { tools: [bigTool()] },
  });
  running.push(second);
  const ends: string[] = [];
  second.agent.subscribe((e) => {
    if (e.type === "tool_execution_end" && e.toolCallId === "call_read") ends.push(e.result.content);
  });
  await second.start();
  await second.agent.prompt("what failed?");
  expect(ends[0]).toContain("ERROR: build failed at the very end");
});
