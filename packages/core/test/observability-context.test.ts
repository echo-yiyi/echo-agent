// 「用了什么」——送进模型的上下文看得见（观测白盒化 §2.2 / §3.2 / §3.3，2026-11-08 拍板）：
//   · 上下文镜像：主线程交出的字节数与 transcript 总长无关（硬规矩：观测不进主循环）；
//   · 观测线程用 agent 自己的投影函数重建视图，分得清每一块的来历，token 与压缩同一把尺子；
//   · 端到端：`context.built` 的构成与 provider 真正收到的请求对得上，`prompt.assembled` 记得每一段是谁注册的。

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOf, createEcho, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams, type Dialect } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { defineExtension } from "../src/extension/abi.ts";
import { AgentPrompt } from "../src/extension/registries.ts";
import type { Provider } from "../src/provider/types.ts";
import type { Context } from "../src/messages.ts";
import { assistantMessage, defaultConvertToLlm, environmentMessage, toolResultMessage, userMessage, type AgentMessage } from "../src/messages.ts";
import { buildWorkingMessages, estimateMessage } from "../src/compaction/view.ts";
import { ContextMirror } from "../src/observability/context-mirror.ts";
import { ContextMirrorStore, type ContextBuiltBody, type ContextBuiltMeta } from "../src/observability/context-mirror-host.ts";
import type { CompactionStage, CompactionState } from "../src/compaction/types.ts";
import type { ObservationEnvelope } from "../src/observability/types.ts";
import { runCompaction } from "../src/compaction/pipeline.ts";
import type { CompactionFact } from "../src/compaction/observe.ts";
import type { LoopFact } from "../src/loop/observe.ts";
import type { AgentLoopConfig, LoopDeps } from "../src/loop/types.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { DEFAULT_RETRY_POLICY } from "../src/provider/dialect.ts";
import { FAKE_MODEL, scriptedStreamFn } from "../src/testing.ts";
import type { Model } from "../src/provider/types.ts";

const META: ContextBuiltMeta = { purpose: "turn", attempt: 1, hooks: {}, converter: "default", request: { model: "p/m", thinkingLevel: null, maxOutputTokens: null } };
const NO_COMPACTION: CompactionState = { spans: [], clearedBefore: 0 };

function transcript(n: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? userMessage(`问题 ${i}`) : assistantMessage([{ type: "text", text: `回答 ${i}` }], "end_turn"));
  return out;
}

/* ─────────────── 镜像：主线程只交增量 ─────────────── */

test("开销：transcript 10 条与 10,000 条，再来一条时主线程交出去的字节数一样多（不随总长增长）", () => {
  const bytesOfSecondHandoff = (n: number): number => {
    const mirror = new ContextMirror();
    const list = transcript(n);
    const input = { systemPrompt: "你是测试员", compaction: NO_COMPACTION, injections: [], tools: [] };
    mirror.handoff({ ...input, transcript: list }); // 第一次：整段都是新的
    list.push(userMessage("再问一句"));
    return JSON.stringify(mirror.handoff({ ...input, transcript: list })).length;
  };
  const small = bytesOfSecondHandoff(10);
  const big = bytesOfSecondHandoff(10_000);
  // 只差编号的位数（11 与 10001）：两段连续编号各压成一段、新消息只交一次
  expect(big - small).toBeLessThan(16);
  expect(big).toBeLessThan(300);
});

test("同一个对象只交一次值：system 串、压缩状态、工具第二次只交编号；换了新 run 的数组，前缀仍是同一批消息，不重交", () => {
  const mirror = new ContextMirror();
  const list = transcript(4);
  const tool: ModelTool = { kind: "model", name: "t", label: "t", description: "d", parameters: { type: "object", properties: {} }, execute: async () => toolOk("x") };
  const first = mirror.handoff({ systemPrompt: "S", transcript: list, compaction: NO_COMPACTION, injections: [], tools: [tool] });
  expect(first.fresh.length).toBe(4 + 1 + 1 + 1); // 4 条消息 + system + 压缩状态 + 工具
  const again = mirror.handoff({ systemPrompt: "S", transcript: [...list], compaction: NO_COMPACTION, injections: [], tools: [tool] });
  expect(again.fresh).toEqual([]);
  expect(again.view).toEqual(first.view); // 新数组、同一批消息：编号一样
});

/* ─────────────── 观测线程：重建视图、分清来历 ─────────────── */

test("重建：压缩折掉的段记 summary、清掉的旧结果记 cleared_placeholder、注入按来源；token 与压缩同一个估算器", () => {
  const messages: AgentMessage[] = [
    userMessage("最早的问题"),
    assistantMessage([{ type: "text", text: "最早的回答" }], "end_turn"),
    userMessage("读一下 a.ts"),
    assistantMessage([{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }], "tool_use"),
    toolResultMessage("t1", "read", "x".repeat(500), false),
    assistantMessage([{ type: "text", text: "读完了" }], "end_turn"),
  ];
  const state: CompactionState = { spans: [{ from: 0, to: 2, summary: "前面问过一个问题" }], clearedBefore: 5 };
  const injection = environmentMessage("技能正文", "skill", "review");
  const mirror = new ContextMirror();
  const store = new ContextMirrorStore();
  const body = store.resolve(mirror.handoff({ systemPrompt: "SYS", transcript: messages, compaction: state, injections: [injection], tools: [] }), META);

  expect(body.parts.map((p) => [p.kind, p.source ?? null, p.count])).toEqual([
    ["summary", null, 1],
    ["transcript", "user/human", 1],
    ["transcript", "assistant", 2],
    ["cleared_placeholder", null, 1],
    ["injection", "skill:review", 1],
  ]);
  const view = [...buildWorkingMessages(messages, state), injection];
  expect(body.messages).toBe(view.length);
  expect(body.parts.reduce((n, p) => n + p.tokens, 0)).toBe(view.reduce((n, m) => n + estimateMessage(m), 0));
  expect(body.converter).toMatchObject({ kind: "default", outputMessages: (defaultConvertToLlm(view) as unknown[]).length, dropped: 0, healedOrphans: 0 });
  expect(body.system).toEqual({ chars: 3, tokens: 1 });
  expect(body.unresolved).toBeUndefined();
});

/* ─────────────── 用完就丢：镜像不随模型调用次数涨（2026-11-13） ─────────────── */

test("每轮注入用完就丢：同一段 transcript 调 500 次模型、每次注入都是新对象，镜像里留着的值不随调用次数涨；每次的构成照样算得出", () => {
  // 此前注入按对象身份记编号、观测线程只存不删：每次调用都是新对象，500 次之后镜像里攒下 500 份正文
  const mirror = new ContextMirror();
  const store = new ContextMirrorStore();
  const list = [userMessage("问题")];
  const call = (): ContextBuiltBody =>
    store.resolve(
      mirror.handoff({ systemPrompt: "SYS", transcript: list, compaction: NO_COMPACTION, injections: [environmentMessage("技能正文".repeat(100), "skill", "review")], tools: [] }),
      META,
    );
  const first = call();
  const settled = store.size;
  expect(settled).toBe(3); // 一条消息 + system + 压缩状态；注入不在里面
  for (let i = 0; i < 500; i++) {
    const body = call();
    expect(body.unresolved).toBeUndefined();
    expect(body.parts.find((p) => p.kind === "injection")).toEqual(first.parts.find((p) => p.kind === "injection")!);
  }
  expect(store.size).toBe(settled);
});

test("被换掉的 system 用完就丢：主循环与子 agent 交替送模（每次都换 system），镜像里只留当前那一份，每次的 system 照样量得出", () => {
  // 此前主线程只记最近一份、每次换都发一个新编号，观测线程把每一份都留着
  const mirror = new ContextMirror();
  const store = new ContextMirrorStore();
  const list = [userMessage("问题")];
  const systems = ["主循环的 system", "子 agent 的 system，长一些"];
  const call = (system: string): ContextBuiltBody => store.resolve(mirror.handoff({ systemPrompt: system, transcript: list, compaction: NO_COMPACTION, injections: [], tools: [] }), META);
  call(systems[0]!);
  const settled = store.size;
  for (let i = 1; i <= 200; i++) {
    const system = systems[i % 2]!;
    const body = call(system);
    expect(body.unresolved).toBeUndefined();
    expect(body.system!.chars).toBe(system.length);
    expect(body.system!.tokens).toBeGreaterThan(0);
  }
  expect(store.size).toBe(settled);
});

test("主线程：注入每次都交值、编号只在那一次交接里有效；system 换了才在 drop 里报出被换掉的编号", () => {
  const mirror = new ContextMirror();
  const injection = environmentMessage("技能正文", "skill", "review");
  const input = { transcript: [userMessage("问")], compaction: NO_COMPACTION, tools: [] };
  const injectionsOf = (h: ReturnType<ContextMirror["handoff"]>): readonly number[] => (h.view.kind === "rebuild" ? h.view.injections : []);
  const a = mirror.handoff({ ...input, systemPrompt: "S1", injections: [injection] });
  const b = mirror.handoff({ ...input, systemPrompt: "S1", injections: [injection] });
  // 同一个注入对象第二次也照交：不靠对象身份记它，观测线程那边上一次的已经删了
  expect(injectionsOf(b)).not.toEqual(injectionsOf(a));
  expect(b.fresh.map((f) => f.ref)).toEqual([...injectionsOf(b)]);
  expect(a.drop).toBeUndefined();
  expect(b.drop).toBeUndefined(); // system 没换
  const c = mirror.handoff({ ...input, systemPrompt: "S2", injections: [] });
  expect(c.drop).toEqual([a.system!.ref]);
  expect(c.system!.ref).not.toBe(a.system!.ref);
});

test("hook 改过的视图按给出的顺序记、来历只分角色；镜像里没有的编号（交接失败过）记进 unresolved、不计入构成", () => {
  const mirror = new ContextMirror();
  const store = new ContextMirrorStore();
  const replaced = [userMessage("hook 塞的"), assistantMessage([{ type: "text", text: "嗯" }], "end_turn")];
  const body: ContextBuiltBody = store.resolve(mirror.handoff({ systemPrompt: null, transcript: [], compaction: NO_COMPACTION, injections: [], final: replaced, tools: [] }), META);
  expect(body.parts.map((p) => [p.kind, p.source])).toEqual([
    ["message", "user/human"],
    ["message", "assistant"],
  ]);
  expect(body.system).toBeNull();

  // 第二份镜像没见过这两条：编号对不上的不算进构成，只计数
  const lost = new ContextMirrorStore().resolve({ ...mirror.handoff({ systemPrompt: null, transcript: [], compaction: NO_COMPACTION, injections: [], final: replaced, tools: [] }) }, META);
  expect([lost.messages, lost.unresolved]).toEqual([0, 2]);
});

/* ─────────────── 压缩：判断与它自己的那次模型调用 ─────────────── */

/** `window: null` = 目录没标窗口。transcript 缺省一条 4 万字的输入（≈ 1 万 token）：20k 窗口减 16k 预留，触发线 4k，过线。 */
function compactionDeps(opts: { window?: number | null; stages?: CompactionStage[]; messages?: AgentMessage[]; turns?: ScriptedTurn[] }): {
  deps: LoopDeps;
  loopFacts: LoopFact[];
  compactionFacts: CompactionFact[];
} {
  const loopFacts: LoopFact[] = [];
  const compactionFacts: CompactionFact[] = [];
  const model: Model = { ...FAKE_MODEL, capabilities: opts.window === null || opts.window === undefined ? {} : { contextWindow: opts.window } };
  const config: AgentLoopConfig = {
    model,
    runId: "run:c",
    convertToLlm: defaultConvertToLlm,
    getTools: () => [],
    knownToolNames: () => [],
    resolveTool: () => ({ ok: false, reason: "not_found" }),
    hooks: new HookRuntime(),
    hookContext: { origin: "model", hookId: "test" },
    permission: {
      authorize: () => ({ kind: "allow" }),
      ask: () => {
        throw new Error("不该 ask");
      },
    },
    maxIterations: 5,
    maxReplies: 10,
    retryPolicy: DEFAULT_RETRY_POLICY,
    compaction: { getStages: () => opts.stages ?? [] },
    workspace: process.cwd(),
  };
  const deps: LoopDeps = {
    context: { systemPrompt: "SYS", messages: opts.messages ?? [userMessage("x".repeat(40_000))], compaction: NO_COMPACTION },
    config,
    emit: async () => {},
    signal: new AbortController().signal,
    streamFn: scriptedStreamFn(opts.turns ?? [textTurn("<summary>摘要</summary>")]),
    observe: {
      loop: { offer: (f: LoopFact) => void loopFacts.push(f) },
      compaction: { offer: (f: CompactionFact) => void compactionFacts.push(f) },
      mirror: new ContextMirror(),
    },
  };
  return { deps, loopFacts, compactionFacts };
}

test("压缩每判一次记一条 context.compact.evaluated：没阶段 / 没窗口 / 没到线 / 开压，带上压缩本来就算的那几个数", async () => {
  const noop: CompactionStage = { name: "noop", order: 1, run: () => null };
  const cases: [Parameters<typeof compactionDeps>[0], string][] = [
    [{}, "no_stage"],
    [{ stages: [noop], window: null }, "no_window"],
    [{ stages: [noop], window: 1_000_000 }, "below_target"],
    [{ stages: [noop], window: 20_000 }, "run"],
  ];
  for (const [opts, decision] of cases) {
    const { deps, compactionFacts } = compactionDeps(opts);
    await runCompaction(deps, { reason: "auto", anchor: null });
    const evaluated = compactionFacts.filter((f) => f.kind === "compaction_evaluated");
    expect(evaluated.map((f) => (f as { decision: string }).decision)).toEqual([decision]);
    const numbers = evaluated[0] as { used?: number; target?: number; goal?: number };
    if (decision === "below_target" || decision === "run") expect([typeof numbers.used, typeof numbers.target, typeof numbers.goal]).toEqual(["number", "number", "number"]);
    else expect(numbers.used).toBeUndefined();
  }
});

test("压缩阶段自己的那次模型调用也记 context.built（purpose compaction、哪个阶段、送了什么）", async () => {
  const summary: CompactionStage = {
    name: "my-summary",
    order: 1,
    run: async (input, signal) => {
      await input.callModel({ systemPrompt: "你在写摘要", messages: [...input.messages, userMessage("请总结", "harness")] }, signal);
      return null;
    },
  };
  const { deps, loopFacts } = compactionDeps({ stages: [summary], window: 20_000 });
  await runCompaction(deps, { reason: "auto", anchor: null });
  const built = loopFacts.filter((f): f is Extract<LoopFact, { kind: "context_built" }> => f.kind === "context_built");
  expect(built).toHaveLength(1);
  expect(built[0]!.meta).toMatchObject({ purpose: "compaction", attempt: 1, stage: "my-summary" });
  const body = new ContextMirrorStore().resolve(built[0]!.handoff, built[0]!.meta);
  expect(body.system?.chars).toBe("你在写摘要".length);
  expect(body.parts.map((p) => [p.kind, p.source, p.count])).toEqual([
    ["message", "user/human", 1],
    ["message", "user/harness", 1],
  ]);
});

/* ─────────────── 端到端 ─────────────── */

const temps: string[] = [];
const running: Echo[] = [];
afterEach(async () => {
  for (const e of running.splice(0)) await e.stop().catch(() => {});
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true });
});

/** 脚本化 provider，并截下每次请求真正送到 provider 的上下文。 */
function capturing(turns: ScriptedTurn[]): { provider: Provider; requests: Context[] } {
  const requests: Context[] = [];
  const inner = scriptedDialect(turns);
  const dialect: Dialect = {
    api: inner.api,
    request(model, context, options) {
      requests.push(context);
      return inner.request(model, context, options);
    },
  };
  const provider = createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(dialect),
  });
  return { provider, requests };
}

async function echoWith(provider: Provider, opts: { tools?: ModelTool[]; extensions?: Parameters<typeof createEcho>[0]["extensions"] } = {}): Promise<Echo> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-context-"));
  temps.push(dir);
  const echo = await createEcho({
    provider,
    allowNetwork: false,
    stateDir: join(dir, "state"),
    extensionDirs: [],
    withoutMemory: true,
    agent: { tools: opts.tools ?? [] },
    ...(opts.extensions !== undefined ? { extensions: opts.extensions } : {}),
  });
  running.push(echo);
  await echo.start();
  return echo;
}

async function recordsOf(echo: Echo, runId: string): Promise<readonly ObservationEnvelope[]> {
  const lookup = await echo.observations.getRun(runId);
  if (lookup.kind !== "found") throw new Error(`run 没读回来：${lookup.kind}`);
  return lookup.observation.records;
}

const ping: ModelTool = { kind: "model", name: "ping", label: "ping", description: "回一个 pong", parameters: { type: "object", properties: {} }, execute: async () => toolOk("pong") };

test("端到端：每次调模型一条 context.built，构成与 provider 真正收到的请求对得上（system 字数、工具菜单、投影后的条数）", async () => {
  const { provider, requests } = capturing([toolTurn("c1", "ping", {}), textTurn("好了")]);
  const echo = await echoWith(provider, { tools: [ping] });
  const r = await echo.send("go");
  const built = (await recordsOf(echo, r.runId)).filter((e) => e.name === "context.built");
  expect(built).toHaveLength(requests.length);
  expect(requests).toHaveLength(2);

  built.forEach((rec, i) => {
    const body = rec.body as ContextBuiltBody;
    const sent = requests[i]!;
    expect(rec.scope.turnId).toBe(`${r.runId}/1#${i + 1}`);
    expect([body.purpose, body.attempt]).toEqual(["turn", 1]);
    expect(body.system?.chars).toBe(sent.systemPrompt?.length);
    expect(body.tools.names).toEqual(sent.tools.map((t) => t.name));
    expect(body.tools.schemaChars).toBe(JSON.stringify(sent.tools).length);
    expect(body.converter.outputMessages).toBe(sent.messages.length);
    expect(body.parts.reduce((n, p) => n + p.count, 0)).toBe(body.messages);
    expect(rec.attributes).toMatchObject({ purpose: "turn", messages: body.messages, tokens: body.tokens, tools: body.tools.count });
  });
  // 第二轮：带着第一轮的工具调用与结果
  const second = built[1]!.body as ContextBuiltBody;
  expect(second.parts.map((p) => p.source)).toEqual(["user/human", "assistant", "toolResult"]);
});

test("端到端：turn.execute 记的工具名单就是模型这一轮的实际菜单——不上菜单的内部工具不混进去", async () => {
  const internal = { kind: "internal" as const, name: "internal_only", label: "internal_only", execute: async () => toolOk("x") };
  const { provider, requests } = capturing([textTurn("好")]);
  const echo = await echoWith(provider, { tools: [ping, internal as never] });
  const r = await echo.send("go");
  const start = (await recordsOf(echo, r.runId)).find((e) => e.kind === "span_start" && e.name === "turn.execute")!;
  const names = (start.body as { tools: string[] }).tools;
  expect(names).toEqual(requests[0]!.tools.map((t) => t.name));
  expect(names).toContain("ping");
  expect(names).not.toContain("internal_only");
});

test("端到端：prompt.assembled 每个 run 一条——每段的注册者、字数，总长与这次的 system 一致；替代层记替代者", async () => {
  const replacer = defineExtension({
    name: "replacer",
    hostAbiVersion: 1,
    reload: "turn",
    inject: { prompt: { service: AgentPrompt, required: true } },
    apply(ctx) {
      const prompt = ctx.get(AgentPrompt);
      void ctx.effect({
        boundary: "turn",
        start: () => {
          const off1 = prompt.section({ name: "test-mine", order: 900, render: () => "我的段" });
          const off2 = prompt.section({ name: "test-mine", order: 900, render: () => "替代后的段" }, { replace: true });
          return { value: undefined, dispose: async () => (await off2(), await off1()) };
        },
      });
    },
  });
  const { provider } = capturing([textTurn("好")]);
  const echo = await echoWith(provider, { extensions: [{ entryId: "test:replacer", definition: replacer as never }] });
  const r = await echo.send("go");
  const assembled = (await recordsOf(echo, r.runId)).filter((e) => e.name === "prompt.assembled");
  expect(assembled).toHaveLength(1);
  const body = assembled[0]!.body as { sections: { name: string; owner: string | null; status: string; chars: number }[]; chars: number };
  expect(body.chars).toBe((await agentOf(echo).assemblePrompt())?.length ?? 0);
  expect(body.sections.find((s) => s.name === "test-mine")).toMatchObject({ owner: "test:replacer", status: "rendered", chars: "替代后的段".length });
  // 内建的段也记得是谁：经 Fiber 注册的都有注册者
  expect(body.sections.every((s) => s.owner !== null)).toBe(true);
  const rendered = body.sections.filter((s) => s.status === "rendered");
  expect(rendered.reduce((n, s) => n + s.chars, 0) + (rendered.length - 1) * 2).toBe(body.chars); // 段之间是 "\n\n"
});
