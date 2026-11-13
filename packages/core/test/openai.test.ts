// OpenAI 兼容方言 + kimi/deepseek provider 的契约门。
// 全程假 fetch(喂 SSE 字符串),零网络、零 key 泄漏风险。

import { test, expect, beforeEach, afterEach, jest } from "bun:test";
import {
  openAiDialect,
  kimiProvider,
  deepseekProvider,
  openaiProvider,
  zaiCodingProvider,
  minimaxProvider,
  OPENAI_COMPLETIONS_API,
  STREAM_IDLE_TIMEOUT_MS,
} from "../src/provider/openai.ts";
import { createProviderStreams, type Dialect } from "../src/provider/dialect.ts";
import { Models } from "../src/provider/models.ts";
import type { Model, ThinkingLevel } from "../src/provider/types.ts";
import type { AssistantMessage, ContentBlock, Context } from "../src/messages.ts";
import type { ProviderEvent } from "../src/events.ts";
import { AbortReason, agentError, type AgentError } from "../src/errors.ts";
import { Agent } from "../src/agent.ts";

const MODEL: Model = { provider: "kimi", id: "kimi-k3", api: "openai-completions" };
/** 与 `MODEL` 对应的来源三元组：thinking 块要带着它，回放判「同源」看的就是这个。 */
const ORIGIN = { provider: "kimi", api: "openai-completions", model: "kimi-k3" } as const;
const CTX: Context = { systemPrompt: "你是测试员", messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }], tools: [] };

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}
function fakeFetch(...responses: (() => Response)[]): { fn: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const make = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return make!();
  }) as typeof fetch;
  return { fn, calls };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/* ══════════ 响应翻译 ══════════ */

test("纯文本流:块三拍 + done 定稿(content/usage/stopReason)", async () => {
  const { fn } = fakeFetch(() =>
    new Response(
      sse([
        { choices: [{ delta: { content: "你" } }] },
        { choices: [{ delta: { content: "好" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]),
    ),
  );
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const events = await collect(d.request(MODEL, CTX, { apiKey: "k" }));

  expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
  const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
  expect(done.message.content).toEqual([{ type: "text", text: "你好" }]);
  expect(done.message.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  expect(done.message.stopReason).toBe("end_turn");
  expect(done.message.model).toEqual({ provider: "kimi", id: "kimi-k3" });
});

test("工具调用:参数分片累积、正确解析;finish=tool_calls → tool_use", async () => {
  const { fn } = fakeFetch(() =>
    new Response(
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    ),
  );
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const events = await collect(d.request(MODEL, CTX, {}));
  const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
  expect(done.message.stopReason).toBe("tool_use");
  expect(done.message.content).toEqual([{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } }]);
});

test("reasoning_content → thinking 事件，**并进 content**（订正：多轮要带回去）", async () => {
  const { fn } = fakeFetch(() =>
    new Response(
      sse([
        { choices: [{ delta: { reasoning_content: "想一想…" } }] },
        { choices: [{ delta: { content: "答案" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    ),
  );
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const events = await collect(d.request(MODEL, CTX, {}));
  expect(events.map((e) => e.type)).toEqual([
    "start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done",
  ]);
  const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
  // **2026-08-28 订正**：这条原本断言「thinking 不进 content」。那条取舍对单轮成立、
  // 对多轮工具循环不成立——preserved thinking 的 provider 要求原样带回上一轮 reasoning。
  // 现在思考既走事件流（上面那串三拍照旧），也落成 ThinkingBlock 带回下一轮。
  expect(done.message.content).toEqual([
    { type: "thinking", thinking: "想一想…", signature: "reasoning_content", origin: ORIGIN },
    { type: "text", text: "答案" },
  ]);
});

test("参数 JSON 坏掉:warning + 块丢弃,不塞半截参数；一个能执行的都没剩 → 可重试的协议错误（不交一个空的 tool_use 让循环空转）", async () => {
  const { fn } = fakeFetch(() =>
    new Response(
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "x", arguments: "{bad" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    ),
  );
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const events = await collect(d.request(MODEL, CTX, {}));
  expect(events.some((e) => e.type === "warning" && e.code === "tool_call_dropped")).toBe(true);
  // 2026-11-03：此前以 done{stopReason: tool_use, content: []} 收尾——循环拿着空消息再来一轮，空转到迭代上限、一直没有回复
  const last = events.at(-1) as Extract<ProviderEvent, { type: "error" }>;
  expect(last.type).toBe("error");
  expect(last.error).toMatchObject({ source: "provider", code: "protocol", retryable: true });
  expect(last.error.message).toContain("1 个工具调用无效");
  expect(events.some((e) => e.type === "done")).toBe(false);
});

/* ── 2026-11-03 用户报：服务端每个参数段都带 id（或 id: null、arguments: null），每段被当成一个新调用、段段解析不了、全被丢弃 ── */

/** 一次请求的定稿（最后一条事件必须是 done）。 */
async function doneOf(chunks: unknown[]): Promise<Extract<ProviderEvent, { type: "done" }>["message"]> {
  const { fn } = fakeFetch(() => new Response(sse(chunks)));
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, {}));
  const last = events.at(-1)!;
  if (last.type !== "done") throw new Error(`最后一条不是 done：${JSON.stringify(last)}`);
  return last.message;
}

test("每段都重发同一个 id（带 index）：还是一个调用，参数拼完整", async () => {
  const message = await doneOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { arguments: '"a.ts"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  expect(message.stopReason).toBe("tool_use");
  expect(message.content).toEqual([{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } }]);
});

test("后续分片是 id: null / arguments: null / name: null：接着上一个调用，null 不当成参数、不当成新调用", async () => {
  const message = await doneOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: null } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: null } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '"a.ts"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  expect(message.content).toEqual([{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } }]);
});

test("没有 index：同一个 id 重发算同一个调用，出现不同的 id 才是新调用（两个并行调用分得开）；名字晚一段到也认", async () => {
  const message = await doneOf([
    { choices: [{ delta: { tool_calls: [{ id: "c1", function: { arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: "c2", function: { name: "read_file", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: "c2", function: { arguments: '"b.ts"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  expect(message.content).toEqual([
    { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } },
    { type: "tool_use", id: "c2", name: "read_file", input: { path: "b.ts" } },
  ]);
});

test("两个调用的片段交错到达（index 0、1、0、1，后续段 id: null）：各自拼完整，按第一次出现的顺序；事件一个调用一组、不互相打断", async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "grep", arguments: '{"pat' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: null, function: { name: null, arguments: 'tern":"x"}' } }] } }] },
    // 同一个分片里两个调用各带一段
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { arguments: '"a.ts"}' } }, { index: 1, id: null, function: { arguments: null } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const expected: ContentBlock[] = [
    { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } },
    { type: "tool_use", id: "c2", name: "grep", input: { pattern: "x" } },
  ];
  const { fn } = fakeFetch(() => new Response(sse(chunks)));
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, {}));
  const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
  expect(done.type).toBe("done");
  expect(done.message.content).toEqual(expected);
  expect(events.map((e) => e.type)).toEqual([
    "start",
    "toolcall_start", "toolcall_delta", "toolcall_end",
    "toolcall_start", "toolcall_delta", "toolcall_end",
    "done",
  ]);
  // 壳（MessageAccumulator）只看事件拼出来的 partial 也与定稿一致：事件流本身就对，不靠 done 兜底
  const items: { type: string; partial: { content: unknown[] } }[] = [];
  const shell = createProviderStreams(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }));
  for await (const item of shell.stream(MODEL, CTX, {}) as AsyncIterable<{ type: string; partial: { content: unknown[] } }>) items.push(item);
  expect(items.some((i) => i.type === "warning")).toBe(false);
  expect(items.findLast((i) => i.type === "toolcall_end")!.partial.content).toEqual(expected);
});

test("id、name 都是 null 的片段不开新调用：没有 index、前面也没有可接的调用 → 丢掉并告警；之后的正常调用不受影响", async () => {
  const { fn } = fakeFetch(() =>
    new Response(
      sse([
        { choices: [{ delta: { tool_calls: [{ id: null, function: { name: null, arguments: '{"stray":1}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    ),
  );
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, {}));
  expect(events.some((e) => e.type === "warning" && e.code === "tool_call_fragment_dropped")).toBe(true);
  const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
  expect(done.message.content).toEqual([{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } }]);
});

test("到最后都没有名字的调用丢掉并告警，不交给循环；同一轮里有名字的照常", async () => {
  const { fn } = fakeFetch(() =>
    new Response(
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: null, arguments: "{}" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    ),
  );
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, {}));
  expect(events.some((e) => e.type === "warning" && e.code === "tool_call_dropped" && e.message.includes("没有名字"))).toBe(true);
  const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
  expect(done.message.content).toEqual([{ type: "tool_use", id: "c2", name: "read_file", input: { path: "a.ts" } }]);
});

test("真 id 晚一段才到：换上真 id（结果要按这个 id 回传）；先按 id 认上的、后来才带 index 的，之后只带 index 的片段也找得回来", async () => {
  const message = await doneOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { name: "read_file", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c9", function: { arguments: '"a.ts"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: "c2", function: { name: "grep", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { arguments: '{"pattern":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: null, function: { arguments: null } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: null, function: { arguments: '"x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);
  expect(message.content).toEqual([
    { type: "tool_use", id: "c9", name: "read_file", input: { path: "a.ts" } },
    { type: "tool_use", id: "c2", name: "grep", input: { pattern: "x" } },
  ]);
});

test("finish_reason 是 tool_calls 却一个调用都没发：可重试的协议错误", async () => {
  const { fn } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "我来查一下" } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }])));
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, {}));
  const last = events.at(-1) as Extract<ProviderEvent, { type: "error" }>;
  expect(last.type).toBe("error");
  expect(last.error).toMatchObject({ code: "protocol", retryable: true });
  expect(last.error.message).toContain("响应里没有工具调用");
});

test("usage 上游没报 → null,不填 0 冒充报了账", async () => {
  const { fn } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const events = await collect(d.request(MODEL, CTX, {}));
  expect((events.at(-1) as Extract<ProviderEvent, { type: "done" }>).message.usage).toBeNull();
});

/* ══════════ 请求翻译 ══════════ */

test("请求体:system / tool_result→role:tool / assistant tool_calls / tools 映射", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1/", fetchFn: fn }); // 尾斜杠要被归一
  const ctx: Context = {
    systemPrompt: "sys",
    messages: [
      { role: "user", content: [{ type: "text", text: "问题" }] },
      { role: "assistant", content: [{ type: "text", text: "我查查" }, { type: "tool_use", id: "c1", name: "read", input: { p: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "内容", is_error: false }, { type: "text", text: "继续" }] },
    ],
    tools: [{ name: "read", description: "读文件", input_schema: { type: "object" } }],
  };
  await collect(d.request({ ...MODEL, capabilities: { maxOutputTokens: 4096 } }, ctx, { apiKey: "k" }));

  expect(calls[0]!.url).toBe("https://x/v1/chat/completions");
  const body = calls[0]!.body as {
    model: string; stream: boolean; max_tokens: number;
    messages: { role: string; content: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
    tools: { type: string; function: { name: string } }[];
  };
  expect(body.model).toBe("kimi-k3");
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBe(4096);
  expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
  expect(body.messages[2]!.tool_calls?.[0]).toEqual({ id: "c1", type: "function", function: { name: "read", arguments: '{"p":1}' } } as never);
  expect(body.messages[3]!.tool_call_id).toBe("c1");
  expect(body.tools[0]!.function.name).toBe("read");
});

test("tool_result 的失败前缀全英文；目录标了 vision 才发 image_url（review 2026-09-07；没标时的省略见下面 2026-11-03 那条）", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const failed: Context = { systemPrompt: null, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }] }], tools: [] };
  await collect(d.request(MODEL, failed, { apiKey: "k" }));
  const body = calls[0]!.body as { messages: { role: string; tool_call_id?: string; content: unknown }[] };
  expect(body.messages[0]).toEqual({ role: "tool", tool_call_id: "c1", content: "[tool execution failed]\nboom" });
  const withImage: Context = { systemPrompt: null, messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }], tools: [] };
  await collect(d.request({ ...MODEL, capabilities: { vision: true } }, withImage, { apiKey: "k" }));
  const sent = calls[1]!.body as { messages: { content: { type: string }[] }[] };
  expect(sent.messages[0]!.content[0]!.type).toBe("image_url");
});

test("工具带回的图：role:tool 后面跟一条 user 消息发 image_url，并标明来自哪次调用；目录没标 vision 时省略并告诉模型，不抛（2026-09-09 拍板接上，此前静默丢）", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const ctx: Context = {
    systemPrompt: null,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "shot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "captured", is_error: false, images: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }] },
    ],
    tools: [],
  };
  // 不收图的模型：请求照发，图省掉、留一句——抛的话会被当成可重试的 provider 错误，而带图的 tool_result 已入账，会话就卡死
  const plain = await collect(d.request(MODEL, ctx, { apiKey: "k" }));
  expect(JSON.stringify(plain)).not.toContain("does not accept image input");
  expect(calls.length).toBe(1);
  const omitted = calls[0]!.body as { messages: { role: string; content: unknown }[] };
  expect(omitted.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
  expect(omitted.messages[2]!.content).toBe("[1 image returned by tool call c1 omitted: model does not accept image input]");
  await collect(d.request({ ...MODEL, capabilities: { vision: true } }, ctx, { apiKey: "k" }));
  const body = calls[1]!.body as { messages: { role: string; tool_call_id?: string; content: unknown }[] };
  expect(body.messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
  expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "captured" });
  expect(body.messages[2]!.content).toEqual([
    { type: "text", text: "[1 image returned by tool call c1]" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
});

test("thinkingLevel → 请求体参数：按目录里的 thinkingLevelMap 合并；没映射的档、没映射表的模型一个字节都不发；params 赢过档位（review 2026-09-07；2026-09-08 值改成参数对象）", async () => {
  // 此前 `StreamOptions.thinkingLevel` 一路传到方言就断了：Shift+Tab / setThinkingLevel / 压缩要的 off，请求体纹丝不动
  const reply = (): Response => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));
  const { fn, calls } = fakeFetch(reply);
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const ctx: Context = { systemPrompt: null, messages: [{ role: "user", content: [{ type: "text", text: "问" }] }], tools: [] };
  const mapped: Model = { ...MODEL, thinkingLevelMap: { off: { thinking: { type: "disabled" } }, high: { reasoning_effort: "high" }, max: null } };
  await collect(d.request(mapped, ctx, { apiKey: "k", thinkingLevel: "high" }));
  await collect(d.request(mapped, ctx, { apiKey: "k", thinkingLevel: "off" })); // off 有映射：发关的参数，字段名方言不认
  await collect(d.request(mapped, ctx, { apiKey: "k", thinkingLevel: "max" })); // null：不发
  await collect(d.request(mapped, ctx, { apiKey: "k", thinkingLevel: "low" })); // 没映射的档：不发
  await collect(d.request(MODEL, ctx, { apiKey: "k", thinkingLevel: "high" })); // 没映射表的模型：不发
  await collect(d.request({ ...mapped, params: { reasoning_effort: "none" } }, ctx, { apiKey: "k", thinkingLevel: "high" })); // params 最后合并
  const bodies = calls.map((c) => c.body as { reasoning_effort?: string; thinking?: unknown });
  expect(bodies.map((b) => [b.reasoning_effort, b.thinking])).toEqual([
    ["high", undefined],
    [undefined, { type: "disabled" }],
    [undefined, undefined],
    [undefined, undefined],
    [undefined, undefined],
    ["none", undefined],
  ]);
});

test("目录的 thinkingLevelMap 按官方文档：GLM / K3 两两折且关不掉、DeepSeek 照官方兼容表（xhigh → high）且 off 真关、K2.6 只有开关、没档位的不填（2026-09-08 刷表）", async () => {
  // 走真 provider 目录 + 假 fetch：证明的是「选了这档、请求体里是哪些参数」，不是端点真的接受它
  const reply = (): Response => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));
  const { fn, calls } = fakeFetch(reply);
  const opts = { fetchFn: fn };
  type P = ReturnType<typeof kimiProvider>;
  const pick = (p: P, id: string): Model => p.getModels().find((m) => m.id === id)!;
  const OFF = { type: "disabled" };
  const ON = { type: "enabled" };
  const cases: [P, string, ThinkingLevel, string | undefined, unknown][] = [
    [kimiProvider(opts), "kimi-k3", "xhigh", "max", undefined],
    [kimiProvider(opts), "kimi-k3", "minimal", "low", undefined],
    [kimiProvider(opts), "kimi-k3", "off", undefined, undefined], // 关不掉：不发，服务端缺省 max
    [zaiCodingProvider(opts), "glm-5.3-flash", "medium", "high", { type: "enabled", clear_thinking: false }], // thinking 来自 params
    [zaiCodingProvider(opts), "glm-5.3", "off", undefined, { type: "enabled", clear_thinking: false }], // 关不掉
    [deepseekProvider(opts), "deepseek-v4-pro", "xhigh", "high", undefined], // 官方兼容表：xhigh → high，不是 max
    [deepseekProvider(opts), "deepseek-flash", "medium", "high", undefined],
    [deepseekProvider(opts), "deepseek-flash", "off", undefined, OFF], // off 真关
    [kimiProvider(opts), "kimi-k2.7-code", "max", undefined, undefined], // 官方既没给深度也没给开关
    [kimiProvider(opts), "kimi-k2.6", "off", undefined, OFF], // 只有开关
    [kimiProvider(opts), "kimi-k2.6", "max", undefined, ON],
    [minimaxProvider(opts), "MiniMax-M3", "max", undefined, OFF], // params 里关着（2026-08-30 拍板），没有档位表
    [openaiProvider(opts), "gpt-5.6-sol", "max", "none", undefined], // params 里被迫 none，档位选了也不算数
  ];
  for (const [p, id, level, effort, thinking] of cases) {
    await collect(p.stream(pick(p, id), CTX, { apiKey: "k", thinkingLevel: level }));
    const body = calls.at(-1)!.body as { reasoning_effort?: string; thinking?: unknown };
    expect([id, level, body.reasoning_effort, body.thinking]).toEqual([id, level, effort, thinking]);
  }
});

test("model.params 最后合并:显式调参赢过缺省", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  await collect(d.request({ ...MODEL, params: { temperature: 0.3, max_tokens: 1000 }, capabilities: { maxOutputTokens: 4096 } }, CTX, {}));
  const body = calls[0]!.body as { temperature: number; max_tokens: number };
  expect(body.temperature).toBe(0.3);
  expect(body.max_tokens).toBe(1000); // params 覆盖 capabilities 推出来的
});

/* ══════════ 错误归类与重试 ══════════ */

test("401 → auth 不可重试;400 带 context 字样 → context_overflow", async () => {
  const f1 = fakeFetch(() => new Response("bad key", { status: 401 }));
  const d1 = openAiDialect({ baseUrl: "https://x/v1", fetchFn: f1.fn });
  const e1 = await collect(d1.request(MODEL, CTX, {}));
  expect(e1).toEqual([{ type: "error", error: expect.objectContaining({ code: "auth", retryable: false }) }] as never);

  const f2 = fakeFetch(() => new Response("maximum context length exceeded", { status: 400 }));
  const d2 = openAiDialect({ baseUrl: "https://x/v1", fetchFn: f2.fn });
  const e2 = await collect(d2.request(MODEL, CTX, {}));
  expect((e2[0] as { error: { code: string } }).error.code).toBe("context_overflow");
});

test("429 → 壳不重试：一次 stream = 一次请求，以 error{retryable} 收场——重试是 loop 的下一个 attempt（2026-09-05）", async () => {
  const { fn, calls } = fakeFetch(
    () => new Response("rate limited", { status: 429 }),
    () => new Response(sse([{ choices: [{ delta: { content: "好了" }, finish_reason: "stop" }] }])),
  );
  const streams = createProviderStreams(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }));
  const msg = await streams.stream(MODEL, CTX, {}).result();
  expect(calls.length).toBe(1); // 第二个响应没人去拿：壳不重试
  expect(msg.stopReason).toBe("error");
  expect(msg.error).toMatchObject({ code: "rate_limit", retryable: true });
});

/* ══════════ 流在半路断开：连接干净关闭 ≠ 回复完整 ══════════ */

/** 与 `sse()` 相同，但**不补** `[DONE]`——模拟连接在终结事件之前被关掉。 */
function sseCut(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
}

test("流在终结事件之前断开（没有 finish_reason 也没有 [DONE]）：报 network 可重试，不当成 end_turn 完成；已流出的正文留在失败消息里", async () => {
  const { fn } = fakeFetch(() => new Response(sseCut([{ choices: [{ delta: { content: "Hello, wor" } }] }])));
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, { apiKey: "k" }));

  expect(events.some((e) => e.type === "done")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "network", retryable: true } });

  const { fn: fn2 } = fakeFetch(() => new Response(sseCut([{ choices: [{ delta: { content: "Hello, wor" } }] }])));
  const msg = await createProviderStreams(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn2 })).stream(MODEL, CTX, { apiKey: "k" }).result();
  expect(msg.stopReason).toBe("error");
  expect(msg.error).toMatchObject({ code: "network", retryable: true });
  expect(msg.content).toEqual([{ type: "text", text: "Hello, wor" }]);
});

test("有 finish_reason、没等到 [DONE] 就关连接：内容已完整，照常 done", async () => {
  const { fn } = fakeFetch(() => new Response(sseCut([{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }])));
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, { apiKey: "k" }));

  expect(events.at(-1)).toMatchObject({ type: "done", message: { stopReason: "end_turn", content: [{ type: "text", text: "好" }] } });
});

test("只有 [DONE]、没有 finish_reason：上游明确收尾，照常 done（不误伤）", async () => {
  const { fn } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "好" } }] }])));
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, { apiKey: "k" }));

  expect(events.at(-1)).toMatchObject({ type: "done", message: { stopReason: "end_turn" } });
});

/* ══════════ provider 与 Models 整链 ══════════ */

/**
 * **每一个被读到的环境变量都要进这张表**（review 二轮 P2）：上一版只存了三个，
 * 于是新三家的凭据一旦被测到，就会读进跑测试那台机器上真实的 `OPENAI_API_KEY` 之类，
 * 结果随环境飘，测完也不还原。表由 `ENV_KEYS` 一处定义，存档 / 清空 / 还原都从它派生——
 * 加一家 provider 时漏改的只可能是这一处，不会漏成三处各改一半。
 */
const ENV_KEYS = [
  "MOONSHOT_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "ZHIPU_API_KEY",
  "MINIMAX_API_KEY",
  "ECHO_LLM_API_KEY",
] as const;
const SAVED: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("kimi 取 key:MOONSHOT_API_KEY / ECHO_LLM_API_KEY 择一;没配 = undefined(诚实拒跑的依据)", async () => {
  const p = kimiProvider({ fetchFn: fakeFetch(() => new Response("")).fn });
  expect(await p.auth.apiKey!.resolve({})).toBeUndefined();
  process.env.ECHO_LLM_API_KEY = "k2";
  expect(await p.auth.apiKey!.resolve({})).toEqual({ apiKey: "k2", env: "ECHO_LLM_API_KEY" });
  process.env.MOONSHOT_API_KEY = "k1"; // 排前面的赢
  expect(await p.auth.apiKey!.resolve({})).toEqual({ apiKey: "k1", env: "MOONSHOT_API_KEY" });
});

test("Models 整链:setProvider → getModel → stream → 定稿;未配 key 诚实报 auth 错", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "回答" }, finish_reason: "stop" }] }])));
  const models = new Models();
  models.setProvider(kimiProvider({ fetchFn: fn }));
  models.setProvider(deepseekProvider({ fetchFn: fn }));
  const model = models.getModel("kimi", "kimi-k3")!;
  expect(model.capabilities?.reasoning).toBe(true);
  expect(models.getModel("deepseek", "deepseek-v4-pro")).toBeDefined();

  // 没配 key:错误终结,不抛
  const noKey = await models.stream(model, CTX).result();
  expect(noKey.stopReason).toBe("error");
  expect(noKey.error?.code).toBe("auth");

  // 配上 key:整链通,Authorization 真的带上了
  process.env.MOONSHOT_API_KEY = "sk-test";
  const msg = await models.stream(model, CTX).result();
  expect(msg.content).toEqual([{ type: "text", text: "回答" }]);
  expect(calls.length).toBe(1);
});

/* ══════════ 内置 provider 工厂（M6 开源验收第 2 条） ══════════ */

test("五家内置 provider 的**目录**：id / 缺省模型 / 方言 / 窗口口径各就各位", () => {
  // 标题原本写「凭据变量各就各位」，但这里一次 `auth.apiKey.resolve()` 都没调——
  // 那是**声称验过而没验**（review 二轮 P2）。凭据归下面那条真调 resolve 的测试。
  const cases = [
    { p: kimiProvider(), id: "kimi", model: "kimi-k3", host: "api.moonshot.cn" },
    { p: deepseekProvider(), id: "deepseek", model: "deepseek-flash", host: "api.deepseek.com" },
    { p: openaiProvider(), id: "openai", model: "gpt-5.6-sol", host: "api.openai.com" },
    { p: zaiCodingProvider(), id: "zai-coding-cn", model: "glm-5.3", host: "open.bigmodel.cn" },
    // MiniMax 2026-08-30 换成 M3 并回到 CLI 清单：M3 可以关 thinking（M2.x 关不掉，已从目录摘掉）
    { p: minimaxProvider(), id: "minimax", model: "MiniMax-M3", host: "api.minimax.io" },
  ];
  for (const c of cases) {
    expect([c.id, c.p.id]).toEqual([c.id, c.id]);
    // **必须声明 defaultModelId**：目录里不止一个而没有缺省时，`createAgent({ provider })` 会 fail-loud（D17 第 4 级）
    expect([c.id, c.p.defaultModelId]).toEqual([c.id, c.model]);
    const models = c.p.getModels();
    expect([c.id, models.length > 0]).toEqual([c.id, true]);
    expect([c.id, models.every((m) => m.api === OPENAI_COMPLETIONS_API)]).toEqual([c.id, true]);
    expect([c.id, models.some((m) => m.id === c.model)]).toEqual([c.id, true]);
    // 每个模型都得有窗口口径——没有的话压缩策略只能瞎猜
    expect([c.id, models.every((m) => (m.capabilities?.contextWindow ?? 0) > 0)]).toEqual([c.id, true]);
  }
});

test("新三家真的把请求打到自己的端点上（假 fetch，零网络）", async () => {
  for (const [factory, host] of [
    [openaiProvider, "api.openai.com"],
    [zaiCodingProvider, "open.bigmodel.cn"],
    [minimaxProvider, "api.minimax.io"],
  ] as const) {
    const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
    const provider = factory({ fetchFn: fn });
    const model = provider.getModels()[0]!;
    await collect(provider.stream(model, CTX, { apiKey: "k" }));
    expect([host, calls.length]).toEqual([host, 1]);
    expect(calls[0]!.url).toContain(host);
    expect(calls[0]!.url).toContain("/chat/completions");
    expect((calls[0]!.body as { model?: string }).model).toBe(model.id);
  }
});

test("baseUrl 可覆盖：MiniMax 换区、自建网关都不用改代码（那条端点尚未实跑验证）", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const provider = minimaxProvider({ baseUrl: "https://api.minimaxi.com/v1", fetchFn: fn });
  await collect(provider.stream(provider.getModels()[0]!, CTX, { apiKey: "k" }));
  expect(calls[0]!.url).toContain("api.minimaxi.com");
});

test("**思考进 content**：reasoning_content 落成 ThinkingBlock，并记住来源字段", async () => {
  const { fn } = fakeFetch(
    () =>
      new Response(
        sse([
          { choices: [{ delta: { reasoning_content: "先想想" } }] },
          { choices: [{ delta: { reasoning_content: "再想想" } }] },
          { choices: [{ delta: { content: "答案" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      ),
  );
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const events = await collect(d.request(MODEL, CTX, { apiKey: "k" }));
  const done = events.find((e) => e.type === "done") as Extract<ProviderEvent, { type: "done" }>;
  const blocks = done.message.content;
  // 上一版这里只有 text 一块——思考被当成「观测」丢掉了，下一轮带不回去
  expect(blocks[0]).toEqual({ type: "thinking", thinking: "先想想再想想", signature: "reasoning_content", origin: ORIGIN });
  expect(blocks[1]).toEqual({ type: "text", text: "答案" });
  // 事件流照旧有 thinking 三拍（UI 仍然实时看得见）
  expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(2);
});

test("字段名各家不同：reasoning / reasoning_text 也认，且签名记的是各自那个", async () => {
  for (const field of ["reasoning", "reasoning_text"] as const) {
    const { fn } = fakeFetch(
      () =>
        new Response(
          sse([{ choices: [{ delta: { [field]: "想" } }] }, { choices: [{ delta: { content: "答" }, finish_reason: "stop" }] }]),
        ),
    );
    const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
    const events = await collect(d.request(MODEL, CTX, { apiKey: "k" }));
    const done = events.find((e) => e.type === "done") as Extract<ProviderEvent, { type: "done" }>;
    expect([field, done.message.content[0]]).toEqual([field, { type: "thinking", thinking: "想", signature: field, origin: ORIGIN }]);
  }
});

test("**两轮回传**：第一轮 reasoning + tool_call，第二轮请求体必须原样带回那段 reasoning（review P0）", async () => {
  const { fn, calls } = fakeFetch(
    () =>
      new Response(
        sse([
          { choices: [{ delta: { reasoning_content: "我要查一下" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "t", arguments: "{}" } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    () => new Response(sse([{ choices: [{ delta: { content: "好了" }, finish_reason: "stop" }] }])),
  );
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });

  // 第一轮：拿到带 thinking + tool_use 的定稿
  const first = await collect(d.request(MODEL, CTX, { apiKey: "k" }));
  const done = first.find((e) => e.type === "done") as Extract<ProviderEvent, { type: "done" }>;
  const assistantBlocks = done.message.content;
  expect(assistantBlocks.some((b) => b.type === "thinking")).toBe(true);

  // 第二轮：把上一轮的 assistant（含 thinking）与工具结果一起发回去——真实 agent 循环就是这样
  const second: Context = {
    ...CTX,
    messages: [
      ...CTX.messages,
      { role: "assistant", content: assistantBlocks },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "结果", is_error: false }] },
    ],
  };
  await collect(d.request(MODEL, second, { apiKey: "k" }));

  expect(calls).toHaveLength(2);
  const sent = (calls[1]!.body as { messages: Record<string, unknown>[] }).messages;
  const assistant = sent.find((m) => m.role === "assistant")!;
  // **这一条是 P0 的判据**：上一版这里是 undefined，服务端的 tool loop 因此不闭合
  expect(assistant["reasoning_content"]).toBe("我要查一下");
  expect(assistant["tool_calls"]).toBeDefined();
});

test("老会话没有 thinking 块时：要求该字段在场的家补空串，别家一个字都不加", async () => {
  // 这一条修的是「2026-08-28 之前落盘的会话」那一格：那时思考被当观测丢了，
  // 恢复后停在工具循环中间会把「没有 reasoning 的 assistant + 工具结果」一起发回去。
  // 补的是**字段在不在**，不是把思考编出来——当初没存下来的，谁也变不回来。
  const legacy: Context = {
    ...CTX,
    messages: [
      ...CTX.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] }, // 老形状：无 thinking
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "结果", is_error: false }] },
    ],
  };
  const reasoningModel: Model = { ...MODEL, capabilities: { ...MODEL.capabilities, reasoning: true } };

  const on = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: on.fn, alwaysSendReasoningField: true }).request(reasoningModel, legacy, { apiKey: "k" }));
  const withFlag = (on.calls[0]!.body as { messages: Record<string, unknown>[] }).messages.find((m) => m.role === "assistant")!;
  expect(withFlag["reasoning_content"]).toBe(""); // 字段在场，内容为空

  const off = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: off.fn }).request(reasoningModel, legacy, { apiKey: "k" }));
  const without = (off.calls[0]!.body as { messages: Record<string, unknown>[] }).messages.find((m) => m.role === "assistant")!;
  expect("reasoning_content" in without).toBe(false); // 别家不加——加了是往协议里塞它没要的东西
});

test("兜底不许盖掉真思考：有 thinking 块时带的是原文，不是空串", async () => {
  const withThinking: Context = {
    ...CTX,
    messages: [
      ...CTX.messages,
      { role: "assistant", content: [{ type: "thinking", thinking: "真想过", signature: "reasoning_content", origin: ORIGIN }, { type: "tool_use", id: "c1", name: "t", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "结果", is_error: false }] },
    ],
  };
  const reasoningModel: Model = { ...MODEL, capabilities: { ...MODEL.capabilities, reasoning: true } };
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn, alwaysSendReasoningField: true }).request(reasoningModel, withThinking, { apiKey: "k" }));
  const assistant = (calls[0]!.body as { messages: Record<string, unknown>[] }).messages.find((m) => m.role === "assistant")!;
  expect(assistant["reasoning_content"]).toBe("真想过");
});

test("只有同源思考、没有正文也没有工具调用的 assistant 消息整条不发（回放成 content: null 上游会拒，而它留在 transcript 里每次请求都带着）", async () => {
  const thinkingOnly: Context = {
    ...CTX,
    messages: [
      ...CTX.messages,
      // 推理模型某一轮只出了 reasoning：正文为空，或 finish_reason: length 截在思考里
      { role: "assistant", content: [{ type: "thinking", thinking: "只想了没说", signature: "reasoning_content", origin: ORIGIN }] },
      { role: "user", content: [{ type: "text", text: "接着说" }] },
    ],
  };
  const reasoningModel: Model = { ...MODEL, capabilities: { ...MODEL.capabilities, reasoning: true } };
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn, alwaysSendReasoningField: true }).request(reasoningModel, thinkingOnly, { apiKey: "k" }));
  const sent = (calls[0]!.body as { messages: Record<string, unknown>[] }).messages;
  // 修之前这里有一条 { role: "assistant", content: null, reasoning_content: "只想了没说" }
  expect(sent.filter((m) => m["role"] === "assistant" && m["content"] === null)).toEqual([]);
  expect(JSON.stringify(sent)).not.toContain("只想了没说");
  expect(sent.at(-1)).toEqual({ role: "user", content: "接着说" });
});

test("DeepSeek 这家开着这个开关（pi 的探测规则就是 isDeepSeek，我们不按 URL 猜）", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const provider = deepseekProvider({ fetchFn: fn });
  const reasoner = provider.getModels().find((m) => m.id === "deepseek-v4-pro")!;
  const legacy: Context = {
    ...CTX,
    messages: [...CTX.messages, { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] }],
  };
  await collect(provider.stream(reasoner, legacy, { apiKey: "k" }));
  const assistant = (calls[0]!.body as { messages: Record<string, unknown>[] }).messages.find((m) => m.role === "assistant")!;
  expect(assistant["reasoning_content"]).toBe("");
});

test("GLM：thinking 开着且 clear_thinking:false（preserved thinking 要的就是这个）", () => {
  const provider = zaiCodingProvider();
  for (const model of provider.getModels()) {
    expect([model.id, model.params]).toEqual([model.id, { thinking: { type: "enabled", clear_thinking: false } }]);
    expect([model.id, model.capabilities?.reasoning]).toEqual([model.id, true]);
  }
});

test("MiniMax 仍不声称 reasoning：它的 <think> 混在正文里，需要专门的 compat", () => {
  for (const model of minimaxProvider().getModels()) {
    expect([model.id, model.capabilities?.reasoning ?? false]).toEqual([model.id, false]);
  }
});

test("新三家的凭据变量与 ECHO_LLM_API_KEY 的优先级：**真调 resolve()**，不是看注释", async () => {
  // review 二轮 P2：上面那条目录测试的标题曾写「凭据变量各就各位」，实际一次 resolve 都没调。
  // 这条把三家逐个走一遍：没配 = undefined（诚实拒跑的依据）→ 只有兜底 → 专用变量排前面赢。
  const cases = [
    { factory: openaiProvider, keys: ["OPENAI_API_KEY"] },
    // GLM 认两个专用名，顺序即优先级（`ZAI_CODING_CN_API_KEY` 在前）
    { factory: zaiCodingProvider, keys: ["ZAI_CODING_CN_API_KEY", "ZHIPU_API_KEY"] },
    { factory: minimaxProvider, keys: ["MINIMAX_API_KEY"] },
  ] as const;

  for (const { factory, keys } of cases) {
    const p = factory({ fetchFn: fakeFetch(() => new Response("")).fn });
    const label = p.id;

    // ① 一个都没配 → undefined。**不是空串、不是抛**：诚实拒跑要靠这个判据
    expect([label, await p.auth.apiKey!.resolve({})]).toEqual([label, undefined]);

    // ② 只有兜底 `ECHO_LLM_API_KEY`
    process.env.ECHO_LLM_API_KEY = "fallback";
    expect([label, await p.auth.apiKey!.resolve({})]).toEqual([label, { apiKey: "fallback", env: "ECHO_LLM_API_KEY" }]);

    // ③ 专用变量**排在兜底前面**，逐个验（后配的靠前那个应当赢）
    for (let i = keys.length - 1; i >= 0; i--) {
      process.env[keys[i]!] = `key-${i}`;
      expect([label, keys[i], await p.auth.apiKey!.resolve({})]).toEqual([label, keys[i], { apiKey: `key-${i}`, env: keys[i] }]);
    }

    for (const k of keys) delete process.env[k];
    delete process.env.ECHO_LLM_API_KEY;
  }
  // 收尾由 afterEach 按 ENV_KEYS 全量还原——这里的手动清理只是为了下一个 case 干净
});

test("OpenAI 目录五条都声明 vision（消费者据此判断能不能发图）", () => {
  // review 二轮 P2：官方都支持图片输入，目录里漏了 `vision: true` 的话，
  // 读 `ModelCapabilities` 的消费者（投影层按它裁剪或拒绝 image 块）会误判成不支持。
  const models = openaiProvider().getModels();
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-4.1", "gpt-4.1-mini"]) {
    const m = models.find((x) => x.id === id);
    expect([id, m?.capabilities?.vision]).toEqual([id, true]);
  }
});

test("GPT-5.6 在 chat/completions 上：请求体带 reasoning_effort:none、不带 max_tokens、不声称 reasoning", async () => {
  // 官方迁移指南：GPT-5.4 起 Chat Completions 带工具调用时 `reasoning_effort` 只许 `none`；
  // `max_tokens` 已 deprecated（改 `max_completion_tokens`）。判据落在**真实发出去的请求体**上。
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const p = openaiProvider({ fetchFn: fn });
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    const model = p.getModels().find((m) => m.id === id)!;
    expect([id, model.capabilities?.reasoning ?? false]).toEqual([id, false]); // chat/completions 不回传任何 reasoning 文本
    expect([id, model.capabilities?.maxOutputTokens]).toEqual([id, undefined]);
  }
  await collect(p.stream(p.getModels()[0]!, { ...CTX, tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }] }, { apiKey: "k" }));
  const body = calls[0]!.body as Record<string, unknown>;
  expect(body["model"]).toBe("gpt-5.6-sol");
  expect(body["reasoning_effort"]).toBe("none");
  expect(Object.hasOwn(body, "max_tokens")).toBe(false);
  // 4.1 是原生非推理模型：不带 reasoning_effort，`max_tokens` 照发
  const legacy = p.getModels().find((m) => m.id === "gpt-4.1")!;
  await collect(p.stream(legacy, CTX, { apiKey: "k" }));
  const body41 = calls[1]!.body as Record<string, unknown>;
  expect(Object.hasOwn(body41, "reasoning_effort")).toBe(false);
  expect(body41["max_tokens"]).toBe(32_768);
});

test("MiniMax 走 M3：请求体带 thinking:disabled，且**不带 max_tokens**（上限没确认就不发）", async () => {
  // 两条判据都落在**真实发出去的请求体**上：
  //  ① M3 官方可以关 thinking——关掉才不需要先改消息契约（M2.x 关不掉，已从目录摘掉）；
  //  ② 上一版填的 `maxOutputTokens: 131072` 抄自 pi 的 **Anthropic** 目录，不是这个 OpenAI 兼容
  //     端点的上限，却被「假 fetch 无条件收下请求」测成了绿。现在留空 → 方言不发 `max_tokens`。
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const p = minimaxProvider({ fetchFn: fn });
  const model = p.getModels()[0]!;
  expect(model.id).toBe("MiniMax-M3");
  expect(model.capabilities?.contextWindow).toBe(1_000_000);
  expect(model.capabilities?.maxOutputTokens).toBeUndefined();
  // thinking 是关掉的，就不许声称有思考通道
  expect(model.capabilities?.reasoning).not.toBe(true);

  await collect(p.stream(model, CTX, { apiKey: "k" }));
  const body = calls[0]!.body as Record<string, unknown>;
  expect(body["model"]).toBe("MiniMax-M3");
  expect(body["thinking"]).toEqual({ type: "disabled" });
  expect(Object.hasOwn(body, "max_tokens")).toBe(false); // 抄错的上限宁可不发
});

/* ══════════ 回放边界：不透明数据只回放给同源（review 三轮 P1） ══════════ */

test("跨模型：GLM 的历史切到 gpt-4.1，请求体里**不许**出现 reasoning_content", async () => {
  // 实测过的病：`convertMessage()` 见到任何 ThinkingBlock 都往目标 provider 写回，
  // 于是上一家的思考被原样发给下一家（可能 400，也违反签名不得跨家使用的契约）。
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const target: Model = { provider: "openai", id: "gpt-4.1", api: "openai-completions" };
  const glmOrigin = { provider: "zai-coding-cn", api: "openai-completions", model: "glm-4.7" };

  const ctx: Context = {
    ...CTX,
    messages: [
      ...CTX.messages,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "上一家模型的思考", signature: "reasoning_content", origin: glmOrigin },
          { type: "text", text: "上一家的正文" },
        ],
      },
    ],
  };
  await collect(d.request(target, ctx, { apiKey: "k" }));
  const body = calls[0]!.body as { messages: Record<string, unknown>[] };
  const assistant = body.messages.find((m) => m["role"] === "assistant")!;

  expect(Object.hasOwn(assistant, "reasoning_content")).toBe(false); // 上一版这里带着别家的思考
  // 2026-11-03 起也不并进正文（照 pi）：可读的思考当正文发过去，下一家会把它当成自己说过的可见回复
  expect(assistant["content"]).toBe("上一家的正文");
});

test("跨模型的 redacted 块**直接丢弃**：正文本来就没有，签名对别家一个字节的意义都没有", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const target: Model = { provider: "openai", id: "gpt-4.1", api: "openai-completions" };

  const ctx: Context = {
    ...CTX,
    messages: [
      ...CTX.messages,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", redacted: true, signature: "reasoning_content", origin: { provider: "deepseek", api: "openai-completions", model: "deepseek-v4-pro" } },
          { type: "text", text: "正文" },
        ],
      },
    ],
  };
  await collect(d.request(target, ctx, { apiKey: "k" }));
  const body = calls[0]!.body as { messages: Record<string, unknown>[] };
  const assistant = body.messages.find((m) => m["role"] === "assistant")!;
  expect(Object.hasOwn(assistant, "reasoning_content")).toBe(false);
  expect(assistant["content"]).toBe("正文"); // 空的 redacted 正文不该污染下一家
});

test("同一家但**换了模型**也算跨源：reasoner 的历史切到非 reasoning 模型不带回", async () => {
  // 三元组是 provider + api + model，缺一不可——同 provider 不等于同模型，
  // 签名是按模型发的（review 点名的第二条反例）。
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const target: Model = { provider: "deepseek", id: "deepseek-flash", api: "openai-completions" };

  const ctx: Context = {
    ...CTX,
    messages: [
      ...CTX.messages,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoner 的思考", signature: "reasoning_content", origin: { provider: "deepseek", api: "openai-completions", model: "deepseek-v4-pro" } },
          { type: "text", text: "reasoner 的正文" },
        ],
      },
    ],
  };
  await collect(d.request(target, ctx, { apiKey: "k" }));
  const body = calls[0]!.body as { messages: Record<string, unknown>[] };
  const assistant = body.messages.find((m) => m["role"] === "assistant")!;
  expect(Object.hasOwn(assistant, "reasoning_content")).toBe(false);
  expect(assistant["content"]).toBe("reasoner 的正文");
});

test("没有 origin 的老会话按**跨源**处理：不赌它同源", async () => {
  const { fn, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const ctx: Context = {
    ...CTX,
    messages: [
      ...CTX.messages,
      { role: "assistant", content: [{ type: "thinking", thinking: "老会话的思考", signature: "reasoning_content" }, { type: "text", text: "老会话的正文" }] },
    ],
  };
  await collect(d.request(MODEL, ctx, { apiKey: "k" })); // 目标就是产它的那家，但块上没标来源
  const body = calls[0]!.body as { messages: Record<string, unknown>[] };
  const assistant = body.messages.find((m) => m["role"] === "assistant")!;
  // 赌错的代价是把别家的不透明数据发出去，所以宁可不回放
  expect(Object.hasOwn(assistant, "reasoning_content")).toBe(false);
  expect(assistant["content"]).toBe("老会话的正文");
});

test("thinking 流到一半就报错：失败消息里**仍带着已经流出的思考**", async () => {
  // review 三轮 P1 实测：`thinking_start → thinking_delta → error` 恢复出的失败消息是 `content: []`，
  // 与「失败轮保留已流出的 partial」直接冲突。thinking 尤其不能丢——常常是失败前唯一的产出。
  const dialect: Dialect = {
    api: "fake",
    async *request(): AsyncGenerator<ProviderEvent> {
      yield { type: "start" };
      yield { type: "thinking_start" };
      yield { type: "thinking_delta", text: "想了一半" };
      yield { type: "error", error: agentError("provider", "internal", "断了", false) };
    },
  };
  const streams = createProviderStreams(dialect);
  const msg = await streams.stream(MODEL, CTX, { apiKey: "k" }).result();

  expect(msg.stopReason).toBe("error");
  const thinking = msg.content.filter((b) => b.type === "thinking");
  expect(thinking.length).toBe(1);
  expect((thinking[0] as { thinking: string }).thinking).toBe("想了一半");
  // 还没收口就没有签名——**不编一个**：半截思考本就不该当可回放数据用
  expect((thinking[0] as { signature?: string }).signature).toBeUndefined();

  // ——— 上面那句「不该当可回放数据用」必须**在请求体上**兑现（review 四轮 P1 实测复现的病）———
  // 把这条失败消息投进下一次**同模型**调用：同源，但没有签名。
  // 上一版只判同源，签名缺失时兜底成 `reasoning_content`，于是半截思考真的被发了出去。
  const { fn: fn2, calls } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }])));
  const d2 = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn2 });
  const next: Context = { ...CTX, messages: [...CTX.messages, { role: "assistant", content: msg.content }] };
  await collect(d2.request(MODEL, next, { apiKey: "k" }));
  const sentMessages = (calls[0]!.body as { messages: Record<string, unknown>[] }).messages;

  // 不可回放就一个字段都不发，也不并进正文（2026-11-03 照 pi）；这条除了半截思考什么都没有，整条不发
  expect(sentMessages.some((m) => m["role"] === "assistant")).toBe(false);
  expect(JSON.stringify(sentMessages)).not.toContain("想了一半");
});

/* ─────────────── 缓存命中（2026-09-01：状态栏要看到缓存情况） ─────────────── */

test("OpenAI 系的 prompt_tokens_details.cached_tokens → usage.cachedInputTokens", async () => {
  const { fn } = fakeFetch(() =>
    new Response(
      sse([
        { choices: [{ delta: { content: "嗯" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } } },
      ]),
    ),
  );
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const events = await collect(d.request(MODEL, CTX, { apiKey: "k" }));
  const done = events.at(-1) as Extract<ProviderEvent, { type: "done" }>;
  expect(done.message.usage).toEqual({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 64 });
});

test("DeepSeek 的 prompt_cache_hit_tokens 也认；两种都没报 → **字段缺席**（没报 ≠ 0）", async () => {
  const { fn } = fakeFetch(
    () =>
      new Response(
        sse([
          { choices: [{ delta: { content: "a" }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 50, completion_tokens: 1, prompt_cache_hit_tokens: 30 } },
        ]),
      ),
    () =>
      new Response(
        sse([
          { choices: [{ delta: { content: "b" }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 7, completion_tokens: 1 } },
        ]),
      ),
  );
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });

  const hit = (await collect(d.request(MODEL, CTX, { apiKey: "k" }))).at(-1) as Extract<ProviderEvent, { type: "done" }>;
  expect(hit.message.usage).toEqual({ inputTokens: 50, outputTokens: 1, cachedInputTokens: 30 });

  const none = (await collect(d.request(MODEL, CTX, { apiKey: "k" }))).at(-1) as Extract<ProviderEvent, { type: "done" }>;
  expect(none.message.usage).toEqual({ inputTokens: 7, outputTokens: 1 });
  expect(Object.hasOwn(none.message.usage!, "cachedInputTokens"), "没报却带了字段——0 冒充报了账").toBe(false);
});

/* ══════════ 2026-11-03 provider 适配修复（用户拍板「按推荐修」） ══════════ */

const okSse = (): Response => new Response(sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));

test("用户贴图遇上不收图的模型：图省掉、换一句英文标签，请求照发——不再本地抛（输入已经入账，抛了就每次都炸）", async () => {
  const { fn, calls } = fakeFetch(okSse);
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const ctx: Context = {
    systemPrompt: null,
    messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/png", data: "AAAA" }] }],
    tools: [],
  };
  const events = await collect(d.request(MODEL, ctx, { apiKey: "k" }));
  expect(events.at(-1)?.type).toBe("done");
  expect(calls.length).toBe(1);
  const body = calls[0]!.body as { messages: { role: string; content: unknown }[] };
  expect(body.messages[0]).toEqual({ role: "user", content: "看图\n\n[image omitted: model does not accept image input]" });
});

test("收图模型上贴过图、换成不收图的模型：之后的 prompt 照常完成，每次都真发了请求（此前每个 run 重试到上限后失败，会话卡死）", async () => {
  let sent = 0;
  const fetchFn = (async () => {
    sent += 1;
    return okSse();
  }) as unknown as typeof fetch;
  const streams = createProviderStreams(openAiDialect({ baseUrl: "https://x/v1", fetchFn }));
  const vision: Model = { provider: "p", id: "flash", api: OPENAI_COMPLETIONS_API, capabilities: { vision: true, contextWindow: 100_000 } };
  const plain: Model = { provider: "p", id: "pro", api: OPENAI_COMPLETIONS_API, capabilities: { contextWindow: 100_000 } };
  const agent = new Agent({ model: vision, streamFunction: (m, c, o) => streams.stream(m, c, o) });
  const r1 = await agent.prompt("看图", [{ type: "image", mimeType: "image/png", data: "AAAA" }]);
  agent.model = plain;
  const r2 = await agent.prompt("你好");
  const r3 = await agent.prompt("再试一次");
  expect([r1.outcome.kind, r2.outcome.kind, r3.outcome.kind]).toEqual(["completed", "completed", "completed"]);
  expect(sent).toBe(3);
});

test("请求体构造失败：不发请求，以不可重试的 internal 错误收场（此前在 fetch 的 try 里求值，被归成 network 可重试）", async () => {
  const { fn, calls } = fakeFetch(okSse);
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  // BigInt 进不了 JSON：构造请求体必然抛——同样的输入每次都一样，重试没有意义
  const ctx: Context = { ...CTX, tools: [{ name: "t", description: "d", input_schema: { type: "object", default: 1n } as never }] };
  const events = await collect(d.request(MODEL, ctx, { apiKey: "k" }));
  expect(calls.length).toBe(0);
  expect(events).toEqual([{ type: "error", error: expect.objectContaining({ source: "provider", code: "internal", retryable: false }) }] as never);
});

test("finish_reason 是 stop、却带着能执行的工具调用：定成 tool_use（此前 end_turn——工具执行了，结果不回模型）", async () => {
  const done = await doneOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "t", arguments: '{"a":1}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
  expect(done.stopReason).toBe("tool_use");
  expect(done.content).toEqual([{ type: "tool_use", id: "c1", name: "t", input: { a: 1 } }]);
});

test("finish_reason 的异常值不当正常结束：内容过滤 → 不可重试的 error（带说明、已流出的正文留在失败消息里）；推理异常 → 可重试；未知值仍是 end_turn", async () => {
  const finishWith = async (reason: string) => {
    const { fn } = fakeFetch(() => new Response(sse([{ choices: [{ delta: { content: "部分" } }] }, { choices: [{ delta: {}, finish_reason: reason }] }])));
    return createProviderStreams(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn })).stream(MODEL, CTX, { apiKey: "k" }).result();
  };
  for (const reason of ["content_filter", "sensitive"]) {
    const msg = await finishWith(reason);
    expect(msg.stopReason).toBe("error");
    // 自己的码，不混在 `protocol` 里：调用方要能分出「后端违约」与「内容被拦」（2026-11-13）
    expect(msg.error).toMatchObject({ source: "provider", code: "content_filter", retryable: false });
    expect(msg.error!.message).toContain(reason);
    expect(msg.content).toEqual([{ type: "text", text: "部分" }]);
  }
  for (const reason of ["network_error", "error"]) {
    const msg = await finishWith(reason);
    expect(msg.stopReason).toBe("error");
    expect(msg.error).toMatchObject({ source: "provider", code: "server", retryable: true });
    expect(msg.error!.message).toContain(reason);
  }
  for (const reason of ["stop", "end", "something_new"]) expect((await finishWith(reason)).stopReason).toBe("end_turn");
  const legacy = await doneOf([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "t", arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "function_call" }] },
  ]);
  expect(legacy.stopReason).toBe("tool_use");
});

test("Kimi 把 usage 放在 choices[0].usage：顶层没有时从那里读", async () => {
  const { fn } = fakeFetch(() =>
    new Response(sse([{ choices: [{ delta: { content: "嗯" }, finish_reason: "stop", usage: { prompt_tokens: 12, completion_tokens: 3 } }] }])),
  );
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, { apiKey: "k" }));
  expect((events.at(-1) as Extract<ProviderEvent, { type: "done" }>).message.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
});

test("跨源的思考不回放、也不并进正文（照 pi：可读的思考当正文发给下一家，会被当成可见回复的一部分）；多个 text 块之间有分隔", async () => {
  const { fn, calls } = fakeFetch(okSse);
  const d = openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn });
  const glm: Model = { provider: "zai", id: "glm-5.3", api: OPENAI_COMPLETIONS_API };
  const deepseek = { provider: "deepseek", api: OPENAI_COMPLETIONS_API, model: "deepseek-flash" };
  const ctx: Context = {
    systemPrompt: null,
    tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "用户想要X，我先想想。", signature: "reasoning_content", origin: deepseek },
          { type: "text", text: "第一段" },
          { type: "thinking", thinking: "再想想", signature: "reasoning_content", origin: deepseek },
          { type: "text", text: "第二段" },
        ],
      },
      // 只有跨源思考的那条：什么都不剩，整条不发（不发一条 content: null 的空 assistant）
      { role: "assistant", content: [{ type: "thinking", thinking: "只有思考", signature: "reasoning_content" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ],
  };
  await collect(d.request(glm, ctx, { apiKey: "k" }));
  const body = calls[0]!.body as { messages: Record<string, unknown>[] };
  expect(body.messages).toEqual([
    { role: "user", content: "q" },
    { role: "assistant", content: "第一段\n\n第二段" },
    { role: "user", content: "q2" },
  ]);
});

/* ── 重试分类：Retry-After、408 / 413、流内错误、撞窗判定收窄 ── */

async function errorOf(make: () => Response): Promise<AgentError> {
  const { fn } = fakeFetch(make);
  const events = await collect(openAiDialect({ baseUrl: "https://x/v1", fetchFn: fn }).request(MODEL, CTX, { apiKey: "k" }));
  const last = events.at(-1) as Extract<ProviderEvent, { type: "error" }>;
  expect(last.type).toBe("error");
  return last.error;
}

test("Retry-After（秒 / HTTP 日期）、retry-after-ms、限流 reset 头：AgentError 带上服务端要求的等待时长；没给就没有这个字段", async () => {
  expect(await errorOf(() => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }))).toMatchObject({ code: "rate_limit", retryable: true, retryAfterMs: 7000 });
  expect(await errorOf(() => new Response("busy", { status: 503, headers: { "retry-after": "2" } }))).toMatchObject({ code: "server", retryable: true, retryAfterMs: 2000 });
  expect(await errorOf(() => new Response("x", { status: 429, headers: { "retry-after-ms": "1500" } }))).toMatchObject({ retryAfterMs: 1500 });
  const dated = await errorOf(() => new Response("x", { status: 429, headers: { "retry-after": new Date(Date.now() + 30_000).toUTCString() } }));
  expect(dated.retryAfterMs).toBeGreaterThan(25_000);
  expect(dated.retryAfterMs).toBeLessThanOrEqual(30_000);
  expect(await errorOf(() => new Response("x", { status: 429, headers: { "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" } }))).toMatchObject({ retryAfterMs: 360_000 });
  const bare = await errorOf(() => new Response("x", { status: 429 }));
  expect(Object.hasOwn(bare, "retryAfterMs")).toBe(false);
});

test("408 → 可重试的 timeout；413 → 撞窗（应急压缩）；400 只认明确的上下文超限短语，「string too long」不算撞窗", async () => {
  expect(await errorOf(() => new Response("request timeout", { status: 408 }))).toMatchObject({ code: "timeout", retryable: true });
  expect(await errorOf(() => new Response("payload too large", { status: 413 }))).toMatchObject({ code: "context_overflow", retryable: false });
  for (const text of [
    "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens",
    '{"error":{"code":"1261","message":"Prompt exceeds max length"}}',
    "Your request exceeded model token limit: 262144 (requested: 300000)",
    "invalid params, context window exceeds limit",
    '{"error":{"code":"context_length_exceeded"}}',
  ]) {
    expect((await errorOf(() => new Response(text, { status: 400 }))).code, text).toBe("context_overflow");
  }
  for (const text of [
    "Invalid 'messages[3].content': string too long. Expected a string with maximum length 10485760, but got a string with length 12000000 instead.",
    "max_tokens is too large: 200000. This model supports at most 32768 completion tokens",
    "Invalid parameter: token",
  ]) {
    expect((await errorOf(() => new Response(text, { status: 400 }))).code, text).toBe("protocol");
  }
});

test("流内 chunk.error 按 code / type 分：限流、过载类可重试，上下文超限是撞窗，其余仍是不可重试的协议错误", async () => {
  const inStream = (error: unknown) => errorOf(() => new Response(sse([{ choices: [{ delta: { content: "半" } }] }, { error }])));
  expect(await inStream({ type: "overloaded_error", message: "Overloaded" })).toMatchObject({ code: "server", retryable: true });
  expect(await inStream({ code: "rate_limit_exceeded", message: "slow" })).toMatchObject({ code: "rate_limit", retryable: true });
  expect(await inStream({ code: 429, message: "Too Many Requests" })).toMatchObject({ code: "rate_limit", retryable: true });
  expect(await inStream({ code: 502, message: "upstream" })).toMatchObject({ code: "server", retryable: true });
  expect(await inStream({ code: "context_length_exceeded", message: "too long" })).toMatchObject({ code: "context_overflow", retryable: false });
  expect(await inStream({ message: "bad request" })).toMatchObject({ code: "protocol", retryable: false });
});

/* ── 流空闲超时：连着但不再吐字节，不能永远等 ── */

/** 先吐一段、之后再也不吐的流；`waiting` 在方言第二次读（开始干等）时 resolve。 */
function stalledBody(): { body: ReadableStream<Uint8Array>; waiting: Promise<void> } {
  let markWaiting!: () => void;
  const waiting = new Promise<void>((r) => (markWaiting = r));
  const first = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`);
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        c.enqueue(first);
      },
      pull() {
        markWaiting();
        return new Promise<void>(() => {}); // 再也不吐
      },
    },
    { highWaterMark: 0 },
  );
  return { body, waiting };
}

test("流空闲 300s 没收到任何字节：中止这次请求，以可重试的 timeout 收场（已流出的正文留在失败消息里）", async () => {
  expect(STREAM_IDLE_TIMEOUT_MS).toBe(300_000); // codex-rs 的 stream idle timeout 缺省
  const { body, waiting } = stalledBody();
  const fetchFn = (async () => new Response(body)) as unknown as typeof fetch;
  // 假时钟下 bun 的用例超时也不走了：只靠微任务推进，等不到就判红，不会挂住
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 1000; i++) await Promise.resolve();
  };
  jest.useFakeTimers();
  try {
    let msg: AssistantMessage | undefined;
    void createProviderStreams(openAiDialect({ baseUrl: "https://x/v1", fetchFn }))
      .stream(MODEL, CTX, { apiKey: "k" })
      .result()
      .then((m) => (msg = m));
    await waiting;
    jest.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS - 1);
    await flush();
    expect(msg).toBeUndefined(); // 还没到点
    jest.advanceTimersByTime(1);
    await flush();
    expect(msg?.stopReason).toBe("error");
    expect(msg?.error).toMatchObject({ source: "provider", code: "timeout", retryable: true });
    expect(msg?.content).toEqual([{ type: "text", text: "hel" }]);
  } finally {
    jest.useRealTimers();
  }
});

test("流空闲期间外层 signal 中止：以 aborted 收场，不等空闲计时", async () => {
  const { body, waiting } = stalledBody();
  const fetchFn = (async () => new Response(body)) as unknown as typeof fetch;
  const ac = new AbortController();
  const result = createProviderStreams(openAiDialect({ baseUrl: "https://x/v1", fetchFn })).stream(MODEL, CTX, { apiKey: "k", signal: ac.signal }).result();
  await waiting;
  ac.abort(new AbortReason("user"));
  const msg = await result;
  expect(msg.stopReason).toBe("aborted");
});
