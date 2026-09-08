// `echo-agent observe serve`：本地只读面板。判据：页面自足（token + 术语表内联）、三条 JSON 路由出的是 reader 的真数据、
// 服务停得下来、`runObserve serve` 打 URL 并在 signal 之后以 0 退出。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, createProvider, createProviderStreams, environmentMessage, observationDatabasePath, toolError, type Echo, type ModelTool, type Provider } from "@echo-agent/core";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "@echo-agent/core/testing";
import { OBSERVE_DEFAULT_PORT, parseObserveArgs, runObserve } from "../src/observe.ts";
import { observePageHtml, startObserveServer } from "../src/observe/server.ts";
import { SessionObservationReaders } from "../src/observe/sessions.ts";
import { lexicon } from "../src/observe/lexicon.ts";
import type { Sink } from "../src/run.ts";

let dir: string;
const running: Echo[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-observe-serve-"));
});
afterEach(async () => {
  for (const e of running.splice(0)) await e.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

function sink(): Sink & { text: string } {
  const box = {
    text: "",
    write(s: string) {
      box.text += s;
    },
  };
  return box;
}

function scripted(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

async function echoAt(turns: ScriptedTurn[], extra: Partial<Parameters<typeof createEcho>[0]> = {}): Promise<Echo> {
  // `dir` 是**会话目录的上一层**（2026-09-03）：每段 session 一个状态根，观测库也跟着一段一份。
  const echo = await createEcho({ provider: scripted(turns), sessionsRoot: dir, allowNetwork: false, withoutMemory: true, extensionDirs: [], ...extra });
  running.push(echo);
  await echo.agent.start();
  return echo;
}

test("/api/runs 顺带给会话摘要：产品名与 workspace 按 sessionId 反查", async () => {
  // **观测库一段一份**（2026-09-03：状态根 = session 目录），所以一个 reader 只看得到那一段的 run。
  // 这条盯的仍是「反查得到」：会话摘要从 session 目录的**上一层**扫，所以面板里出现的
  // 任何 sessionId 都认得出产品名与 workspace——哪怕那一段不是本库这一段。
  const coding = await echoAt([textTurn("coding 说")], { product: "echo-coding", workspace: "/tmp/ws-coding" });
  const a = await coding.send("x");
  const codingId = coding.agent.state.sessionId!;
  await coding.stop();
  const general = await echoAt([textTurn("agent 说")], { product: "echo-agent", workspace: "/tmp/ws-general" });
  await general.send("y");
  const generalId = general.agent.state.sessionId!;

  const reader = new SessionObservationReaders({ sessionsRoot: dir, sessionId: codingId });
  const server = startObserveServer({ readers: reader, port: 0 });
  try {
    const page = (await (await fetch(`${server.url}/api/runs?limit=10`)).json()) as {
      items: { runId: string; sessionId: string | null }[];
      sessions: Record<string, { product: string; agent: string; workspace: string; name: string }>;
    };
    const runA = page.items.find((h) => h.runId === a.runId)!;
    expect(runA.sessionId).toBe(codingId);
    // 产品与角色是两维（2026-09-07）：这一段是 echo-coding 开的，没挂角色所以 `agent` 是 default
    expect(page.sessions[codingId]).toMatchObject({ product: "echo-coding", agent: "default", workspace: "/tmp/ws-coding" });
    // 只带这页用到的会话，不把整层的会话表都吐出去——另一段在盘上，但这页没用到它
    expect(Object.keys(page.sessions)).toEqual([codingId]);
    expect(generalId).not.toBe(codingId);
  } finally {
    await server.stop();
    await reader.close();
  }
});

test("content 档：/api/runs/<id> 的时间线带工具 params 与结果正文，页面有对应的分段渲染", async () => {
  const grep: ModelTool = {
    kind: "model",
    name: "grep",
    label: "grep",
    description: "搜",
    parameters: { type: "object", properties: { pattern: { type: "string" } } },
    execute: async () => toolError("grep: no matches for observationTap"),
  };
  const echo = await echoAt([toolTurn("c1", "grep", { pattern: "observationTap" }), textTurn("没搜到。")], { observation: { capture: "content" }, agent: { tools: [grep] } });
  const r = await echo.send("搜一下");
  const reader = new SessionObservationReaders({ sessionsRoot: dir });
  const server = startObserveServer({ readers: reader, port: 0 });
  try {
    const vm = (await (await fetch(`${server.url}/api/runs/${r.runId}`)).json()) as {
      header: { capturePolicy: string };
      timeline: { kind: string; name: string; body?: Record<string, unknown> }[];
    };
    expect(vm.header.capturePolicy).toBe("content");
    const start = vm.timeline.find((t) => t.kind === "span_start" && t.name === "tool.execute");
    const end = vm.timeline.find((t) => t.kind === "span_end" && t.name === "tool.execute");
    expect(start?.body?.params).toEqual({ pattern: "observationTap" });
    expect(end?.body).toMatchObject({ isError: true, content: "grep: no matches for observationTap" });
    expect(vm.timeline.some((t) => t.name === "model.generate.delta")).toBe(true);
  } finally {
    await server.stop();
    await reader.close();
  }
  // 页面侧：正文分段、delta 折叠、参数预览三件都在（渲染逻辑在浏览器里跑，这里只验它们没被删）
  const html = observePageHtml();
  for (const marker of ["contentSections", "FOLDED_INTO", "argPreview", "--observe content"]) expect(html).toContain(marker);
});

/** 等 inbox 触发的那条 run 封口（listRuns 只见已 COMMIT 的 header）。 */
async function waitForInboxRun(echo: Echo): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const page = await echo.observations.listRuns({ limit: 10 });
    const run = page.items.find((h) => h.source.kind === "inbox" && h.status !== "running");
    if (run !== undefined) return run.runId;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("inbox 触发的 run 5s 内没有封口");
}

test("跨 session：/api/runs 合并各段、/api/runs/<id> 不必知道在哪一段、/api/health 每段一块、/api/activity 有收件与 ack 且带 sessionId", async () => {
  const a = await echoAt([textTurn("A 说")], { product: "echo-coding", workspace: "/tmp/ws-a" });
  const ra = await a.send("a");
  const aId = a.agent.state.sessionId!;
  const b = await echoAt([textTurn("B 说"), textTurn("B 收到")], { product: "echo-agent", workspace: "/tmp/ws-b" });
  const rb = await b.send("b");
  const bId = b.agent.state.sessionId!;
  // A 给 B 发一句：与 session_send 同一条路（进 B 的 inbox 账本），B 消费成一条 inbox run
  await b.agent.ingress.deliverDurable({ message: environmentMessage("A 找你", "session", `${aId}:m1`), dedupeKey: `session:${aId}:m1` });
  await b.agent.consumeInbox();
  const inboxRun = await waitForInboxRun(b);

  const readers = new SessionObservationReaders({ sessionsRoot: dir });
  const server = startObserveServer({ readers, port: 0 });
  try {
    const runs = (await (await fetch(`${server.url}/api/runs?limit=10`)).json()) as { items: { runId: string; sessionId: string; acceptedAt: number }[]; nextCursor: null; sessions: Record<string, { product: string }> };
    expect(runs.items.map((h) => h.runId).sort()).toEqual([ra.runId, rb.runId, inboxRun].sort());
    for (let i = 1; i < runs.items.length; i++) expect(runs.items[i - 1]!.acceptedAt).toBeGreaterThanOrEqual(runs.items[i]!.acceptedAt); // 合并后仍按时间倒序
    expect(runs.nextCursor).toBeNull();
    expect(runs.sessions[aId]!.product).toBe("echo-coding");
    expect(runs.sessions[bId]!.product).toBe("echo-agent");
    for (const id of [ra.runId, rb.runId, inboxRun]) {
      const vm = (await (await fetch(`${server.url}/api/runs/${encodeURIComponent(id)}`)).json()) as { header: { runId: string } };
      expect(vm.header.runId).toBe(id);
    }
    const health = (await (await fetch(`${server.url}/api/health`)).json()) as { sessionsRoot: string; sessions: { sessionId: string; counts: { runs: number } }[] };
    expect(health.sessionsRoot).toBe(dir);
    expect(health.sessions.map((s) => s.sessionId).sort()).toEqual([aId, bId].sort());
    expect(health.sessions.find((s) => s.sessionId === bId)!.counts.runs).toBe(2);
    const activity = (await (await fetch(`${server.url}/api/activity?limit=20`)).json()) as { items: { sessionId: string; record: { name: string; scope: { runId?: string }; attributes: Record<string, unknown> } }[]; sessions: Record<string, unknown> };
    const inbox = activity.items.filter((i) => i.record.name.startsWith("inbox."));
    expect(inbox.map((i) => i.record.name)).toEqual(expect.arrayContaining(["inbox.accepted", "inbox.acked"]));
    for (const i of inbox) {
      expect(i.sessionId).toBe(bId);
      expect(i.record.scope.runId).toBeUndefined(); // run 之外的记录
    }
    expect(inbox.find((i) => i.record.name === "inbox.accepted")!.record.attributes).toMatchObject({ source: "session", ref: `${aId}:m1` });
    expect(inbox.find((i) => i.record.name === "inbox.acked")!.record.attributes).toMatchObject({ runId: inboxRun });
    expect(Object.keys(activity.sessions)).toEqual(expect.arrayContaining([aId, bId]));
  } finally {
    await server.stop();
    await readers.close();
  }
});

test("parseObserveArgs：serve 缺省端口与地址；--port 校验；--port / --host 只对 serve 有意义", () => {
  expect(parseObserveArgs(["serve"], "x")).toEqual({ command: { kind: "serve", port: OBSERVE_DEFAULT_PORT, host: "127.0.0.1" } });
  expect(parseObserveArgs(["serve", "--port", "0", "--host", "0.0.0.0", "--state-dir", "/s"], "x")).toEqual({ stateDir: "/s", command: { kind: "serve", port: 0, host: "0.0.0.0" } });
  expect(() => parseObserveArgs(["serve", "--port", "abc"], "x")).toThrow("--port 要");
  expect(() => parseObserveArgs(["serve", "--port", "70000"], "x")).toThrow("--port 要");
  expect(() => parseObserveArgs(["last", "--port", "1"], "x")).toThrow("只对 serve 有意义");
  expect(() => parseObserveArgs(["serve", "--format", "json"], "x")).toThrow("serve 没有");
});

test("术语表：每条四字段齐全，hint 不是同义反复", () => {
  const lex = lexicon();
  for (const group of [lex.runStatus, lex.runSource, lex.replySource, lex.integrity, lex.persistence, lex.records]) {
    for (const [key, term] of Object.entries(group)) {
      expect(term.zh.length, key).toBeGreaterThan(0);
      expect(term.en.length, key).toBeGreaterThan(0);
      expect(["neutral", "accent", "positive", "caution", "critical", "info"], key).toContain(term.tone);
      expect(term.hint.length, key).toBeGreaterThan(6);
      expect(term.hint, key).not.toBe(term.zh);
    }
  }
  // 终态五值 + running 都有；截停与完成是两个词
  expect(lex.runStatus.completed!.zh).not.toBe(lex.runStatus.truncated!.zh);
  // 「running」只是没封口，不是「进行中」：agent 停没停不由观测判断（2026-09-06 用户定）
  expect(lex.runStatus.running!.zh).toBe("未收尾");
  const html = observePageHtml();
  expect(html).not.toContain("进行中 · 已");
  // 列表的三条收敛（2026-09-07）：整理 run 走一行的次要行、只重复区分得开的维度、筛选片标签截断
  for (const marker of ["run--minor", "const varies", "clipLabel"]) expect(html).toContain(marker);
  // 详情的四条（2026-09-07）：标题是会话不是 runId、运行环境折叠、单支的 reply / attempt 层不占行、耗时条
  for (const marker of ["foldSingleLayers", "FOLDED_INTO_PREVIOUS", "tl-bar", 'class: "env"']) expect(html).toContain(marker);
  // 四层循环的两层已是一等 span，不再是 agent.custom_event
  expect(lex.records["reply.execute"]).toBeDefined();
  expect(lex.records["attempt.execute"]).toBeDefined();
  // 视觉分工（2026-09-07 用户评审）：正常状态走圆点、色块留给要立刻注意的；时间线四列 + 条形轨；筛选恒两行
  for (const marker of ["function statusMark", "function dot(", "class: \"track\"", "class: \"selrow\"", "class: \"chiprow\""]) expect(html).toContain(marker);
  // 排查版面（2026-09-07 第三轮评审）：顶部概览 + 中间时间线 + 右侧事件详情；折叠归箭头、选中归行；
  // 原始 JSON 收进右栏而不是就地展开（那会把后面的行推走，连着看两条就找不回位置）
  for (const marker of ["class: \"overview\"", "class: \"metrics\"", "function renderEventDetail", "function selectEvent", "function visibleEntries", "原始 JSON", "function copyButton"]) {
    expect(html).toContain(marker);
  }
  expect(html).not.toContain('class: "tl-detail"'); // 行内展开已经没有了
  // 标签不再中英双写：badge 只出中文，英文进 title
  expect(html).not.toContain('el("span", { class: "en", text: t.en })');
  expect(Object.keys(lex.runStatus).sort()).toEqual(["aborted", "completed", "error", "interrupted", "running", "truncated"]);
});

test("页面的内联脚本能解析：语法错会让整页空白，而 HTML 本身照样 200", () => {
  // 实测教训（2026-09-07）：改版时留下一个重复的 `const m`，服务照常返回页面、Chrome 里一片空白，
  // 直到截图才发现。`new Function` 只编译不执行，正好把语法错挡在渲染之前。
  const script = observePageHtml().split("<script>")[1]?.split("</script>")[0] ?? "";
  expect(script.length).toBeGreaterThan(1000);
  expect(() => new Function(script)).not.toThrow();
});

test("颜色规则可判（2026-09-07 用户定）：紫只用于交互态、成功色不再出现、强色只给失败与警告", () => {
  // 读**未注入 token 的源文件**：那才是页面自己的样式，注入后的 token 块里出现颜色名是应该的。
  // 注释先剥掉：这条规则本身就写在注释里，不剥的话它会把自己判红。
  const raw = readFileSync(new URL("../src/observe/page.html", import.meta.url), "utf8").split("</style>")[0] ?? "";
  expect(raw).toContain("/*__TOKENS__*/");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css.length).toBeGreaterThan(500);

  // ① 紫（accent）只表示「你能操作 / 你选中了」：每一条用到它的规则，选择器必须是交互态
  const interaction = /:focus-visible|\[aria-pressed="true"\]|\[aria-selected="true"\]/;
  const offenders = css
    .split("\n")
    .filter((line) => line.includes("var(--accent"))
    .filter((line) => !interaction.test(line));
  expect(offenders).toEqual([]);

  // ② 正常状态不再用成功色：整页一次 `var(--moss)` 都没有（16 行全「已完成」时那点绿不携带信息）
  expect(observePageHtml()).not.toContain("var(--moss");

  // ③ 强色只给失败与警告：色块只剩 caution / critical 两种，没有「正常也发光」的类
  expect(css).not.toMatch(/\.(badge|dot)--(positive|info|accent)\b/);
  expect(css).toContain(".badge--caution");
  expect(css).toContain(".badge--critical");
});

test("页面自足：token CSS 与术语表内联，不引外部资源", () => {
  const html = observePageHtml();
  expect(html).toContain("<title>Echo · observe</title>");
  expect(html).toContain("--accent:"); // vendor 的 token 变量已注入
  expect(html).toContain('"runStatus"'); // 术语表已注入
  expect(html).not.toContain("/*__TOKENS__*/");
  expect(html).not.toContain("/*__LEXICON__*/");
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/); // 零外部资源
  // 页面自己的样式只用 token 变量：去掉注入的 token 段之后，不该再有裸 hex / 裸 oklch
  const own = html.replace(/\/\* Echo 编程[\s\S]*?\n}\n(?:[\s\S]*?\n}\n)*/, "");
  expect(own.split("<style>")[1]?.split("</style>")[0] ?? "").not.toMatch(/#[0-9a-fA-F]{3,6}\b|oklch\(/);
});

test("serve：/ 出页面，/api/runs、/api/runs/<id>、/api/health 出 reader 的真数据；未知 run 404；能停", async () => {
  const echo = await echoAt([textTurn("你好")]);
  const r = await echo.send("hi");
  const stateRoot = join(dir, echo.agent.state.sessionId!); // 观测库一段一份
  const reader = new SessionObservationReaders({ sessionsRoot: dir });
  const server = startObserveServer({ readers: reader, port: 0 });
  try {
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
    const page = await fetch(`${server.url}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Echo · observe");

    const runs = (await (await fetch(`${server.url}/api/runs?limit=5`)).json()) as { items: { runId: string; status: string }[]; nextCursor: string | null };
    expect(runs.items.map((h) => h.runId)).toEqual([r.runId]);
    expect(runs.items[0]!.status).toBe("completed");

    const vm = (await (await fetch(`${server.url}/api/runs/${encodeURIComponent(r.runId)}`)).json()) as { header: { runId: string }; timeline: unknown[]; rendererVersion: number };
    expect(vm.header.runId).toBe(r.runId);
    expect(vm.rendererVersion).toBe(1);
    expect(vm.timeline.length).toBeGreaterThan(3);

    expect((await fetch(`${server.url}/api/runs/run:nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/runs`, { method: "POST" })).status).toBe(405);

    const health = (await (await fetch(`${server.url}/api/health`)).json()) as { sessionsRoot: string; sessions: { sessionId: string; path: string; counts: { runs: number }; heads: unknown[] }[] };
    expect(health.sessionsRoot).toBe(dir);
    expect(health.sessions.map((s) => s.sessionId)).toEqual([echo.agent.state.sessionId!]);
    expect(health.sessions[0]!.path).toBe(observationDatabasePath(stateRoot));
    expect(health.sessions[0]!.counts.runs).toBe(1);
    expect(health.sessions[0]!.heads.length).toBe(1);
  } finally {
    await server.stop();
    await reader.close();
  }
  // 停了就连不上
  await expect(fetch(`${server.url}/api/health`)).rejects.toThrow();
});

test("runObserve serve：打印 URL；signal abort 后关服务、关 reader，退出码 0", async () => {
  const echo = await echoAt([textTurn("一句")]);
  await echo.send("x");
  const controller = new AbortController();
  const out = sink();
  const err = sink();
  const exit = runObserve(["serve", "--port", "0", "--state-dir", dir], "echo-agent", { out, err, signal: controller.signal });
  for (let i = 0; i < 200 && !out.text.includes("observe 面板"); i++) await new Promise((r) => setTimeout(r, 10));
  const url = /http:\/\/[^\s（]+/.exec(out.text)?.[0];
  expect(url).toBeDefined();
  expect((await fetch(`${url}/api/health`)).status).toBe(200);
  controller.abort();
  expect(await exit).toBe(0);
  expect(err.text).toBe("");
  await expect(fetch(`${url}/api/health`)).rejects.toThrow();
});
