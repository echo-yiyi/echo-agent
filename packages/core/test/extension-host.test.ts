// Extension Host 内核：ServiceKey canonicalize / 依赖图 / Fiber 状态机 / EffectStack / registry sidecar。
// 每条反例先写「没有这条规则会怎么错」。

import { test, expect } from "bun:test";
import {
  AgentBackgroundService,
  AgentHooks,
  AgentSkills,
  AgentTools,
  ExtensionAbiError,
  ExtensionDisposedError,
  ExtensionHost,
  ExtensionMountError,
  agentRegistries,
  defineExtension,
  defineService,
  type Disposer,
  type EffectLease,
  type ExtensionContext,
  type ExtensionEntry,
} from "../src/extension/public.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { defineToolPack, mountBuiltinTools } from "../src/extension/builtin.ts";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedStreamFn } from "../src/testing.ts";
import { registerTool, type ToolMap } from "../src/tools/harness.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { ActiveSkillMap } from "../src/skill/harness.ts";
import type { Skill } from "../src/skill/types.ts";

function tool(name: string): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => toolOk("ok") };
}

/** 一个纯内存的 EffectLease 工厂：记录 dispose 顺序。 */
function leaseOf<T>(log: string[], label: string, value: T, onDispose?: () => unknown): EffectLease<T> {
  return {
    value,
    dispose: async () => {
      log.push(`dispose:${label}`);
      await onDispose?.();
    },
  };
}

function entry(entryId: string, definition: ExtensionEntry["definition"], config?: unknown): ExtensionEntry {
  return { entryId, definition, config };
}

/* ─────────────── github 例子：provider + consumer，装上/卸下都要成对 ─────────────── */

test("fixture：provider 发布 single Service，consumer 注册 Tool + Hook；unmount 逆序卸、Tool/Hook 真的没了", async () => {
  const log: string[] = [];
  type Client = { close(): void };
  const GithubClient = defineService<Client>({ id: "github.client", version: 1, kind: "single", scope: "agent", reload: "run" });

  const provider = defineExtension({
    name: "github-client",
    hostAbiVersion: 1,
    reload: "run",
    provide: [GithubClient],
    config: (input) => ({ token: String((input as { token: string }).token) }),
    async apply(ctx, config) {
      log.push(`apply:provider:${config.token}`);
      const client = await ctx.effect({
        boundary: "run",
        start: async () => leaseOf(log, "client", { close: () => log.push("client.closed") }, () => log.push("client.dispose-cb")),
      });
      ctx.provide(GithubClient, client);
    },
  });
  const consumer = defineExtension({
    name: "github-tools",
    hostAbiVersion: 1,
    reload: "turn",
    inject: { client: { service: GithubClient, required: true }, tools: { service: AgentTools, required: true }, hooks: { service: AgentHooks, required: true } },
    async apply(ctx) {
      log.push("apply:consumer");
      expect(typeof ctx.get(GithubClient).close).toBe("function");
      await ctx.effect({ boundary: "turn", start: () => ({ value: undefined, dispose: ctx.get(AgentTools).register(tool("gh")) }) });
      await ctx.effect({ boundary: "turn", start: () => ({ value: undefined, dispose: ctx.get(AgentHooks).on("postToolUse", () => undefined) }) });
    },
  });

  const tools: ToolMap = new Map();
  const hooks = new HookRuntime();
  const host = new ExtensionHost({ services: agentRegistries({ tools, hooks }) });
  // 声明顺序故意把 consumer 放前面：mount 必须按依赖拓扑（provider 先）
  await host.mount("g1", [entry("tools", consumer), entry("client", provider, { token: "t0" })]);
  expect(log).toEqual(["apply:provider:t0", "apply:consumer"]);
  expect(tools.has("gh")).toBe(true);
  expect(hooks.snapshot().has("postToolUse")).toBe(true);
  expect(host.inspect().map((f) => `${f.entryId}:${f.status}:${f.effects}`)).toEqual(["client:active:1", "tools:active:2"]);

  await host.unmount("g1");
  // consumer 先卸（它的两个 effect 是 Tool/Hook 卸载器，不写 log），provider 的 client 最后卸
  expect(log.slice(2)).toEqual(["dispose:client", "client.dispose-cb"]);
  expect(tools.has("gh")).toBe(false);
  expect(hooks.snapshot().has("postToolUse")).toBe(false);
  expect(host.inspect()).toEqual([]);
  await host.unmount("g1"); // 幂等
});

/* ─────────────── ServiceKey：按 id 归一，不兼容声明 fail-loud ─────────────── */

test("ServiceKey：两份同 id 同形状的声明归一为同一个 Service；同 id 不同 version 在 PREPARE 抛", async () => {
  const A1 = defineService<number>({ id: "svc.a", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const A1again = defineService<number>({ id: "svc.a", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const A2 = defineService<number>({ id: "svc.a", version: 2, kind: "single", scope: "agent", reload: "agent" });
  const provider = defineExtension({ name: "p", hostAbiVersion: 1, provide: [A1], apply: (ctx) => ctx.provide(A1, 42) });
  let seen = 0;
  const consumer = defineExtension({ name: "c", hostAbiVersion: 1, inject: { a: { service: A1again, required: true } }, apply: (ctx) => void (seen = ctx.get(A1again)) });
  const host = new ExtensionHost();
  await host.mount("g", [entry("p", provider), entry("c", consumer)]);
  expect(seen).toBe(42);

  const badConsumer = defineExtension({ name: "c2", hostAbiVersion: 1, inject: { a: { service: A2, required: true } }, apply: () => {} });
  await expect(host.mount("g2", [entry("c2", badConsumer)])).rejects.toThrow("声明冲突");
  expect(host.mountedGenerations).toEqual(["g"]);
});

test("defineService / defineExtension 形状门：坏 version、坏 reload、hostAbiVersion≠1 都抛", () => {
  expect(() => defineService({ id: "x", version: 0, kind: "single", scope: "agent", reload: "agent" })).toThrow("正整数");
  expect(() => defineService({ id: "x", version: 1, kind: "single", scope: "agent", reload: "weekly" as never })).toThrow("reload");
  expect(() => defineExtension({ name: "x", hostAbiVersion: 2 as never, apply: () => {} })).toThrow("hostAbiVersion");
});

/* ─────────────── 依赖图 ─────────────── */

test("cycle：报完整路径，不进 PENDING 假装启动成功；Host 状态零变化", async () => {
  const A = defineService<number>({ id: "cyc.a", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const B = defineService<number>({ id: "cyc.b", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const a = defineExtension({ name: "a", hostAbiVersion: 1, provide: [A], inject: { b: { service: B, required: true } }, apply: (ctx) => ctx.provide(A, 1) });
  const b = defineExtension({ name: "b", hostAbiVersion: 1, provide: [B], inject: { a: { service: A, required: true } }, apply: (ctx) => ctx.provide(B, 2) });
  const host = new ExtensionHost();
  await expect(host.mount("g", [entry("a", a), entry("b", b)])).rejects.toThrow("依赖成环：a → b → a");
  expect(host.inspect()).toEqual([]);
});

test("required 缺失 → mount 失败、无残留；optional 缺失 → 能 mount，但 ctx.get 说清「当前没有 provider」", async () => {
  const S = defineService<number>({ id: "opt.s", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const needs = defineExtension({ name: "needs", hostAbiVersion: 1, inject: { s: { service: S, required: true } }, apply: () => {} });
  const host = new ExtensionHost();
  await expect(host.mount("g", [entry("needs", needs)])).rejects.toThrow("required 依赖 'opt.s'");
  expect(host.inspect()).toEqual([]);

  let err: unknown;
  const wants = defineExtension({
    name: "wants",
    hostAbiVersion: 1,
    inject: { s: { service: S } },
    apply: (ctx) => {
      try {
        ctx.get(S);
      } catch (e) {
        err = e;
      }
    },
  });
  await host.mount("g", [entry("wants", wants)]);
  expect(err).toBeInstanceOf(ExtensionAbiError);
  expect((err as Error).message).toContain("当前没有 provider");
});

test("scope 方向：process-scope Extension 不能 inject agent-scope Service；agent-scope Extension 不能 provide process-scope Service", async () => {
  const AgentS = defineService<number>({ id: "dir.agent", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const ProcS = defineService<number>({ id: "dir.proc", version: 1, kind: "single", scope: "process", reload: "process" });
  const host = new ExtensionHost();
  const pAgentProvider = defineExtension({ name: "ap", hostAbiVersion: 1, provide: [AgentS], apply: (ctx) => ctx.provide(AgentS, 1) });
  const procConsumer = defineExtension({ name: "pc", hostAbiVersion: 1, scope: "process", reload: "process", inject: { s: { service: AgentS, required: true } }, apply: () => {} });
  await expect(host.mount("g1", [entry("ap", pAgentProvider), entry("pc", procConsumer)])).rejects.toThrow("不能 inject agent-scope Service");
  const agentProvidesProc = defineExtension({ name: "app", hostAbiVersion: 1, scope: "agent", reload: "process", provide: [ProcS], apply: (ctx) => ctx.provide(ProcS, 1) });
  await expect(host.mount("g2", [entry("app", agentProvidesProc)])).rejects.toThrow("不能 provide process-scope Service");
  expect(host.inspect()).toEqual([]);
});

test("boundary：provider 的 reload 弱于 Service 的 reload → PREPARE 拒绝", async () => {
  const RunStable = defineService<number>({ id: "bd.s", version: 1, kind: "single", scope: "agent", reload: "run" });
  const turnProvider = defineExtension({ name: "tp", hostAbiVersion: 1, reload: "turn", provide: [RunStable], apply: (ctx) => ctx.provide(RunStable, 1) });
  const host = new ExtensionHost();
  await expect(host.mount("g", [entry("tp", turnProvider)])).rejects.toThrow("provider 的 boundary 必须不弱于 Service");
});

test("single Service 在同一 generation 两个 provider → PREPARE 抛；未声明就 provide / 未声明就 get → apply 期抛并回滚", async () => {
  const S = defineService<number>({ id: "dup.s", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const p1 = defineExtension({ name: "p1", hostAbiVersion: 1, provide: [S], apply: (ctx) => ctx.provide(S, 1) });
  const p2 = defineExtension({ name: "p2", hostAbiVersion: 1, provide: [S], apply: (ctx) => ctx.provide(S, 2) });
  const host = new ExtensionHost();
  await expect(host.mount("g", [entry("p1", p1), entry("p2", p2)])).rejects.toThrow("有两个 provider");

  const sneaky = defineExtension({ name: "sneaky", hostAbiVersion: 1, apply: (ctx) => ctx.provide(S, 3) });
  await expect(host.mount("g", [entry("sneaky", sneaky)])).rejects.toThrow("未在 provide 声明");
  const peeker = defineExtension({ name: "peeker", hostAbiVersion: 1, apply: (ctx) => void ctx.get(S) });
  await expect(host.mount("g", [entry("p1", p1), entry("peeker", peeker)])).rejects.toThrow("未在 inject 声明");
  expect(host.inspect()).toEqual([]);
});

test("声明了 provide 却没 provide → apply 返回时判失败（consumer 不能拿到空）", async () => {
  const S = defineService<number>({ id: "lazy.s", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const lazy = defineExtension({ name: "lazy", hostAbiVersion: 1, provide: [S], apply: () => {} });
  const host = new ExtensionHost();
  await expect(host.mount("g", [entry("lazy", lazy)])).rejects.toThrow("但 apply 返回时没有 provide");
});

/* ─────────────── Fiber / Effect ─────────────── */

test("Effect boundary 强于声明的 reload → 拒绝该 generation：先登记的 Effect 已卸、别的 Fiber 也回滚，Host 零残留", async () => {
  const log: string[] = [];
  const liar = defineExtension({
    name: "liar",
    hostAbiVersion: 1,
    reload: "run",
    async apply(ctx) {
      await ctx.effect({ boundary: "run", start: () => leaseOf(log, "ok-effect", 1) });
      await ctx.effect({ boundary: "agent", start: () => leaseOf(log, "never", 2) }); // 比声明强
    },
  });
  const bystander = defineExtension({ name: "by", hostAbiVersion: 1, async apply(ctx) { await ctx.effect({ start: () => leaseOf(log, "bystander", 0) }); } });
  const host = new ExtensionHost();
  const err = await host.mount("g", [entry("by", bystander), entry("liar", liar)]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExtensionMountError);
  expect((err as ExtensionMountError).entryId).toBe("liar");
  expect(((err as ExtensionMountError).cause as Error).message).toContain("Host 不自动升级");
  // 上一版若「自动升级 boundary 后继续」：never 会登记、liar 会 ACTIVE
  expect(log).toEqual(["dispose:ok-effect", "dispose:bystander"]);
  expect(host.inspect()).toEqual([]);
});

test("Effect start 自己抛：ctx.effect reject、Fiber FAILED、已登记的 LIFO 卸；start 的部分资源由它自己清（Host 拿不到 disposer）", async () => {
  const log: string[] = [];
  const bad = defineExtension({
    name: "bad",
    hostAbiVersion: 1,
    async apply(ctx) {
      await ctx.effect({ start: () => leaseOf(log, "first", 1) });
      await ctx.effect({
        start: async () => {
          log.push("partial-created");
          log.push("partial-cleaned"); // start 自行清理
          throw new Error("connect 失败");
        },
      });
    },
  });
  const host = new ExtensionHost();
  await expect(host.mount("g", [entry("bad", bad)])).rejects.toThrow("connect 失败");
  expect(log).toEqual(["partial-created", "partial-cleaned", "dispose:first"]);
  expect(host.inspect()).toEqual([]);
});

test("UNLOADING 闸：ACTIVE 后旧回调发起的 pending start，闸关之后才完成也照样被卸；之后再 ctx.effect / ctx.get → ExtensionDisposedError", async () => {
  const log: string[] = [];
  let ctxRef!: ExtensionContext;
  const keeper = defineExtension({
    name: "keeper",
    hostAbiVersion: 1,
    apply(ctx) {
      ctxRef = ctx; // 旧 callback 会拿着它
    },
  });
  const host = new ExtensionHost();
  await host.mount("g", [entry("keeper", keeper)]);
  // ACTIVE 之后，旧 callback 发起一个慢 start（不 await）
  let releaseStart!: () => void;
  void ctxRef.effect({
    start: () =>
      new Promise<EffectLease<number>>((resolve) => {
        releaseStart = () => resolve(leaseOf(log, "late", 1));
      }),
  });
  const unmounting = host.unmount("g");
  await new Promise((r) => setTimeout(r, 5));
  expect(ctxRef.signal.aborted).toBe(true);
  releaseStart(); // 闸关之后才完成
  await unmounting;
  // 上一版若不等 pending start：late 的 lease 在 disposer snapshot 之后才出现，永远没人卸
  expect(log).toEqual(["dispose:late"]);
  // 状态 / 声明类错误同步抛（旧 callback 当场炸，不是悄悄 reject 一个没人接的 promise）
  expect(() => ctxRef.effect({ start: () => leaseOf(log, "x", 0) })).toThrow(ExtensionDisposedError);
  expect(() => ctxRef.get(AgentTools)).toThrow(ExtensionDisposedError);
});

test("一个 disposer reject：其余照样全部尝试，最后聚合抛；第二次 unmount 不重复执行", async () => {
  const log: string[] = [];
  const flaky = defineExtension({
    name: "flaky",
    hostAbiVersion: 1,
    async apply(ctx) {
      await ctx.effect({ start: () => leaseOf(log, "a", 1) });
      await ctx.effect({ start: () => ({ value: 2, dispose: () => { log.push("dispose:b-throws"); throw new Error("b 炸了"); } }) });
      await ctx.effect({ start: () => leaseOf(log, "c", 3) });
    },
  });
  const host = new ExtensionHost();
  await host.mount("g", [entry("flaky", flaky)]);
  const err = await host.unmount("g").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AggregateError);
  expect((err as AggregateError).errors.map((e) => (e as Error).message)).toEqual(["b 炸了"]);
  expect(log).toEqual(["dispose:c", "dispose:b-throws", "dispose:a"]);
  await host.unmount("g");
  expect(log).toHaveLength(3);
});

/* ─────────────── generation overlap ─────────────── */

test("两代 overlap：同一 entryId 的 g1、g2 同时 ACTIVE；g2 的 consumer 绑本代 provider；先卸 g1 不影响 g2", async () => {
  const S = defineService<string>({ id: "ov.s", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const mk = (tag: string) => ({
    provider: defineExtension({ name: "p", hostAbiVersion: 1, provide: [S], apply: (ctx) => ctx.provide(S, tag) }),
    consumer: defineExtension({ name: "c", hostAbiVersion: 1, inject: { s: { service: S, required: true } }, apply: (ctx) => void seen.push(`${tag}:${ctx.get(S)}`) }),
  });
  const seen: string[] = [];
  const host = new ExtensionHost();
  const g1 = mk("g1");
  const g2 = mk("g2");
  await host.mount("g1", [entry("p", g1.provider), entry("c", g1.consumer)]);
  await host.mount("g2", [entry("p", g2.provider), entry("c", g2.consumer)]);
  expect(seen).toEqual(["g1:g1", "g2:g2"]);
  expect(host.inspect().filter((f) => f.status === "active")).toHaveLength(4);
  await host.unmount("g1");
  expect(host.inspect().map((f) => f.generation)).toEqual(["g2", "g2"]);
});

test("跨代依赖：新代 consumer 绑到旧代仍 ACTIVE 的 provider；卸旧代被拒并列出 consumer（consumer 先 UNLOAD 是契约）", async () => {
  const S = defineService<string>({ id: "xg.s", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const provider = defineExtension({ name: "p", hostAbiVersion: 1, provide: [S], apply: (ctx) => ctx.provide(S, "old") });
  let got = "";
  const consumer = defineExtension({ name: "c", hostAbiVersion: 1, inject: { s: { service: S, required: true } }, apply: (ctx) => void (got = ctx.get(S)) });
  const host = new ExtensionHost();
  await host.mount("g1", [entry("p", provider)]);
  await host.mount("g2", [entry("c", consumer)]);
  expect(got).toBe("old");
  await expect(host.unmount("g1")).rejects.toThrow("先卸 consumer");
  await host.unmount("g2");
  await host.unmount("g1");
  expect(host.inspect()).toEqual([]);
});

test("跨代 provide：另一个 entry 在新代 provide 旧代仍 ACTIVE 的 Service → 整代被拒，旧 provider 不受影响（review 2026-09-07）", async () => {
  // 此前「恰好一个 provider」只在同一代内成立：盘上任一扩展能在下一代静默劫持 AgentRuntimeService，壳绑到假 runtime 上
  const S = defineService<string>({ id: "xp.s", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const real = defineExtension({ name: "real", hostAbiVersion: 1, provide: [S], apply: (ctx) => ctx.provide(S, "real") });
  const impostor = defineExtension({ name: "impostor", hostAbiVersion: 1, provide: [S], apply: (ctx) => ctx.provide(S, "fake") });
  const host = new ExtensionHost();
  await host.mount("g1", [entry("real", real)]);
  await expect(host.mount("g2", [entry("impostor", impostor)])).rejects.toThrow("跨代也只有一个 provider");
  expect(host.inspect().filter((f) => f.status === "active").map((f) => f.generation)).toEqual(["g1"]);
  await host.unmount("g1");
});

/* ─────────────── registry sidecar：exact-reference disposer、同名 fail-loud ─────────────── */

test("registry disposer 只认对象身份：Fiber 注册的 Tool 被显式 replace 成 A2 后，unmount 不误删 A2", async () => {
  const tools: ToolMap = new Map();
  const host = new ExtensionHost({ services: agentRegistries({ tools, hooks: new HookRuntime() }) });
  const A = tool("t");
  const ext = defineExtension({
    name: "e",
    hostAbiVersion: 1,
    reload: "turn",
    inject: { tools: { service: AgentTools, required: true } },
    async apply(ctx) {
      await ctx.effect({ boundary: "turn", start: () => ({ value: undefined, dispose: ctx.get(AgentTools).register(A) }) });
    },
  });
  await host.mount("g", [entry("e", ext)]);
  const A2 = tool("t");
  registerTool(tools, A2, { replace: true }); // 别的显式操作
  await host.unmount("g");
  expect(tools.get("t")).toBe(A2);
});

test("同名注册 fail-loud：mount 失败并回滚，池里没留下半个", async () => {
  const tools: ToolMap = new Map();
  registerTool(tools, tool("dup"));
  const host = new ExtensionHost({ services: agentRegistries({ tools, hooks: new HookRuntime() }) });
  const log: string[] = [];
  const ext = defineExtension({
    name: "e",
    hostAbiVersion: 1,
    reload: "turn",
    inject: { tools: { service: AgentTools, required: true } },
    async apply(ctx) {
      await ctx.effect({ boundary: "turn", start: () => ({ value: undefined, dispose: ctx.get(AgentTools).register(tool("fresh")) }) });
      log.push("fresh registered");
      await ctx.effect({ boundary: "turn", start: () => ({ value: undefined, dispose: ctx.get(AgentTools).register(tool("dup")) }) });
    },
  });
  await expect(host.mount("g", [entry("e", ext)])).rejects.toThrow("已注册");
  expect(log).toEqual(["fresh registered"]);
  expect([...tools.keys()]).toEqual(["dup"]);
});

test("Fiber 不能 provide Host 自带的 registry Service", async () => {
  const host = new ExtensionHost({ services: agentRegistries({ tools: new Map(), hooks: new HookRuntime() }) });
  const impostor = defineExtension({
    name: "i",
    hostAbiVersion: 1,
    reload: "turn",
    provide: [AgentTools],
    apply: (ctx) => ctx.provide(AgentTools, { register: (): Disposer => () => {}, restrict: (): Disposer => () => {} }),
  });
  await expect(host.mount("g", [entry("i", impostor)])).rejects.toThrow("不能 provide Host 自带的 Service");
});

test("config：解析失败在 PREPARE 就拒（apply 一个都不跑）；解析结果原样交给 apply", async () => {
  const applied: unknown[] = [];
  const parsed = defineExtension<{ n: number }>({
    name: "cfg",
    hostAbiVersion: 1,
    config: (input) => {
      const n = (input as { n?: unknown }).n;
      if (typeof n !== "number") throw new Error("n 必须是数字");
      return { n };
    },
    apply: (_ctx, config) => void applied.push(config),
  });
  const host = new ExtensionHost();
  await expect(host.mount("g", [entry("ok", parsed, { n: 1 }), entry("bad", parsed, { n: "x" })])).rejects.toThrow("config 解析失败：n 必须是数字");
  expect(applied).toEqual([]);
  await host.mount("g", [entry("ok", parsed, { n: 1 })]);
  expect(applied).toEqual([{ n: 1 }]);
});

test("AgentSkills registry：批量 add 先查后写；disposer 只卸那一批对象，且顺手撤 active", async () => {
  const pool = new Map<string, Skill>();
  const active: ActiveSkillMap = new Map();
  const skill = (name: string): Skill => ({ name, description: name, content: name, files: [], requiredTools: [], modelInvocable: true, frontmatter: {} });
  const host = new ExtensionHost({ services: agentRegistries({ tools: new Map(), hooks: new HookRuntime(), skills: { pool, active } }) });
  const ext = defineExtension({
    name: "skills",
    hostAbiVersion: 1,
    reload: "turn",
    inject: { skills: { service: AgentSkills, required: true } },
    async apply(ctx) {
      await ctx.effect({ boundary: "turn", start: () => ({ value: undefined, dispose: ctx.get(AgentSkills).add([skill("s1"), skill("s2")]) }) });
    },
  });
  await host.mount("g", [entry("skills", ext)]);
  expect([...pool.keys()]).toEqual(["s1", "s2"]);
  active.set("s1", { name: "s1", activatedAt: 0 });
  await host.unmount("g");
  expect(pool.size).toBe(0);
  expect(active.size).toBe(0);
  // 同名 fail-loud：先查后写，不留半批
  pool.set("s2", skill("s2"));
  await expect(host.mount("g2", [entry("skills", ext)])).rejects.toThrow("已存在");
  expect([...pool.keys()]).toEqual(["s2"]);
});

/* ─────────────── review 反例：并发事务 / staged ServiceKey / 未 await 的 start / registry 单 owner ─────────────── */

test("并发 mount 同一 generation：串行执行，第二个轮到时发现已存在而被拒；只起一套 Effect，unmount 后全部卸掉", async () => {
  let starts = 0;
  let disposes = 0;
  const ext = defineExtension({
    name: "e",
    hostAbiVersion: 1,
    async apply(ctx) {
      await new Promise((r) => setTimeout(r, 5)); // 让两个 mount 有机会交错
      await ctx.effect({ start: () => (starts++, { value: undefined, dispose: () => void disposes++ }) });
    },
  });
  const host = new ExtensionHost();
  const first = host.mount("g", [entry("e", ext)]);
  const second = host.mount("g", [entry("e", ext)]);
  await expect(second).rejects.toThrow("已经 mount 过");
  await first;
  // 上一版：两次都越过 has() 检查、都成功，Map 只留后一代——start=2、unmount 后 dispose=1
  expect(starts).toBe(1);
  await host.unmount("g");
  expect(disposes).toBe(1);
  expect(host.inspect()).toEqual([]);
});

test("mount / unmount 竞争：同一条事务链，unmount 排在 mount 之后执行，起来的都能卸干净", async () => {
  let starts = 0;
  let disposes = 0;
  const ext = defineExtension({
    name: "e",
    hostAbiVersion: 1,
    async apply(ctx) {
      await new Promise((r) => setTimeout(r, 5));
      await ctx.effect({ start: () => (starts++, { value: undefined, dispose: () => void disposes++ }) });
    },
  });
  const host = new ExtensionHost();
  const m = host.mount("g", [entry("e", ext)]);
  const u = host.unmount("g"); // mount 还没完成就来卸
  await Promise.all([m, u]);
  expect(starts).toBe(1);
  expect(disposes).toBe(1);
  expect(host.inspect()).toEqual([]);
  expect(host.mountedGenerations).toEqual([]);
});

test("失败的 mount 不污染 ServiceKey 表：v1 candidate 失败后，同 id 的 v2 照样能 mount（staged 表整代 ACTIVE 才 commit）", async () => {
  const V1 = defineService<number>({ id: "stage.s", version: 1, kind: "single", scope: "agent", reload: "agent" });
  const V2 = defineService<number>({ id: "stage.s", version: 2, kind: "single", scope: "agent", reload: "agent" });
  const host = new ExtensionHost();
  const p1 = defineExtension({ name: "p1", hostAbiVersion: 1, provide: [V1], apply: (ctx) => ctx.provide(V1, 1) });
  const crash = defineExtension({ name: "crash", hostAbiVersion: 1, inject: { s: { service: V1, required: true } }, apply: () => { throw new Error("candidate 炸了"); } });
  await expect(host.mount("g1", [entry("p1", p1), entry("crash", crash)])).rejects.toThrow("candidate 炸了");
  // 上一版：v1 已永久占住 'stage.s'，下面这次合法的 v2 mount 被报「声明冲突」
  const p2 = defineExtension({ name: "p2", hostAbiVersion: 1, provide: [V2], apply: (ctx) => ctx.provide(V2, 2) });
  let got = 0;
  const c2 = defineExtension({ name: "c2", hostAbiVersion: 1, inject: { s: { service: V2, required: true } }, apply: (ctx) => void (got = ctx.get(V2)) });
  await host.mount("g2", [entry("p2", p2), entry("c2", c2)]);
  expect(got).toBe(2);
  // commit 之后 v1 才是冲突
  const c1 = defineExtension({ name: "c1", hostAbiVersion: 1, inject: { s: { service: V1, required: true } }, apply: () => {} });
  await expect(host.mount("g3", [entry("c1", c1)])).rejects.toThrow("声明冲突");
});

test("未 await 的 Effect start 在 apply 返回后才 reject：Fiber 不得标 ACTIVE——按 mount failure 回滚，且不成 unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const log: string[] = [];
    const ext = defineExtension({
      name: "e",
      hostAbiVersion: 1,
      async apply(ctx) {
        await ctx.effect({ start: () => leaseOf(log, "first", 1) });
        void ctx.effect({
          start: async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error("late boom");
          },
        });
      },
    });
    const host = new ExtensionHost();
    await expect(host.mount("g", [entry("e", ext)])).rejects.toThrow("late boom");
    // 上一版：apply 一返回就 ACTIVE，随后 start reject，inspect() 仍显示 ACTIVE
    expect(host.inspect()).toEqual([]);
    expect(log).toEqual(["dispose:first"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("registry Service 也只能有一个 provider（owner）：两个 registry provider → PREPARE 失败", async () => {
  const R = defineService<{ register(x: string): Disposer }>({ id: "reg.r", version: 1, kind: "registry", scope: "agent", reload: "agent" });
  const mk = (name: string) => defineExtension({ name, hostAbiVersion: 1, provide: [R], apply: (ctx) => ctx.provide(R, { register: () => () => {} }) });
  const host = new ExtensionHost();
  // 上一版：只拒 single 的重复，两个 registry provider 都成功、providers.set() 静默取后者
  await expect(host.mount("g", [entry("r1", mk("r1")), entry("r2", mk("r2"))])).rejects.toThrow("两个 provider");
  expect(host.inspect()).toEqual([]);
});

test("unmount(g) 紧接 mount(g)：按调用顺序先卸后装——新代不会被还没卸的旧代误拒", async () => {
  const log: string[] = [];
  const mk = (tag: string) =>
    defineExtension({
      name: "e",
      hostAbiVersion: 1,
      async apply(ctx) {
        await new Promise((r) => setTimeout(r, 3));
        await ctx.effect({ start: () => (log.push(`start:${tag}`), leaseOf(log, tag, undefined)) });
      },
    });
  const host = new ExtensionHost();
  await host.mount("g", [entry("e", mk("old"))]);
  const u = host.unmount("g");
  const m = host.mount("g", [entry("e", mk("new"))]); // 不等 unmount 完成
  // 上一版：mount 在链外看 generations.has("g") → 旧代还在 → 误拒「已经 mount 过」
  await Promise.all([u, m]);
  expect(log).toEqual(["start:old", "dispose:old", "start:new"]);
  expect(host.inspect().map((f) => f.status)).toEqual(["active"]);
  await host.unmount("g");
  expect(log.at(-1)).toBe("dispose:new");
});

test("Effect 立即 reject、apply 随后还等了 5ms：失败不能从账本消失——mount 必须失败", async () => {
  const log: string[] = [];
  const ext = defineExtension({
    name: "e",
    hostAbiVersion: 1,
    async apply(ctx) {
      await ctx.effect({ start: () => leaseOf(log, "first", 1) });
      void ctx.effect({
        start: () => {
          throw new Error("instant boom"); // 同步 throw → 链立刻 reject
        },
      });
      await new Promise((r) => setTimeout(r, 5)); // 上一版：settle 即删，等 Host 来 settle 时失败已经不在 pending 里
    },
  });
  const host = new ExtensionHost();
  await expect(host.mount("g", [entry("e", ext)])).rejects.toThrow("instant boom");
  expect(host.inspect()).toEqual([]);
  expect(log).toEqual(["dispose:first"]);
});

test("tool pack 的注册是**原子的**：中途撞名 → registry 零残留（review 二轮 P1）", async () => {
  // 上一版是 `tools.map(register)`：第 3 个撞名时前两个已经进了 registry，而 `start()` 还没返回
  // lease，Host 拿不到 disposer、回滚不了它们。于是 mount 报「已回滚」而 registry 里有残留——
  // **门说干净了、其实没有**，是最坏的一种假绿。
  const tools = new Map() as ToolMap;
  const host = new ExtensionHost({ services: agentRegistries({ tools, hooks: new HookRuntime() }) });

  const mk = (name: string): ModelTool => ({
    kind: "model",
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => toolOk("ok"),
  });

  // 先占住 "c"，让第三个注册撞名
  registerTool(tools, mk("c"));
  expect([...tools.keys()]).toEqual(["c"]);

  await expect(
    host.mount("g", [
      { entryId: "pack", definition: defineToolPack("pack") as never, config: { tools: [mk("a"), mk("b"), mk("c")] } },
    ]),
  ).rejects.toThrow();

  // **判据是 registry 的最终状态**，不是「mount 抛没抛」：抛了但留下 a/b 才是那个 bug
  expect([...tools.keys()]).toEqual(["c"]); // 只剩本来就在的那个
  expect(host.mountedGenerations).toEqual([]);
});


/* ── 低层路径：`mountBuiltinTools()` 自己造的默认 Host 提供了哪些 Service ── */

test("默认 Host 把**能力端口**也提供出去：inject 后台队列的扩展在低层路径上装得上", async () => {
  // 2026-08-31 review 四轮 P1 实测的缺口：`echo:shell` 从 optional 改成 `required: true` 之后，
  //   `new Agent()` → `mountBuiltinTools(agent)` → mount 一条 inject 后台队列的扩展
  // 当场报「required 依赖 'echo.agent.background' 没有 provider」。
  // 上一轮只把 `background` 补进了 `createEcho()` 那一处调用，**漏了这里自己造的默认 Host**。
  //
  // 缺口能溜进来是因为没人测这条路径：既有的 `mountBuiltinTools()` 测试只装 `echo:*` 内建，
  // 而内建一个都不消费能力端口。所以这里用一条**消费它**的假扩展来守——
  // 不用 `ECHO_SHELL`（那住在 coding-agent 包里，core 不认识它，也不该认识）。
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const host = await mountBuiltinTools(agent);

  let seen: unknown = null;
  const consumer = defineExtension({
    name: "test:background-consumer",
    hostAbiVersion: 1,
    inject: { background: { service: AgentBackgroundService, required: true } },
    apply(ctx) {
      seen = ctx.get(AgentBackgroundService);
    },
  });

  await host.mount("probe", [{ entryId: "test:background-consumer", definition: consumer as never }]);
  // 拿到的必须是 Agent 那一份，不是随便一个占位对象
  expect(seen).toBe(agent.background);

  await host.unmount("probe");
  await agent.dispose();
});
