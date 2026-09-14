// ExtensionHost 的观测探针：一代装上 / 没装上（PREPARE 与 LOADING 两个阶段）/ 卸下 / 卸载被拒，
// 每种结果在 Host 的事务链上各记一条事实。给 Host 一个会记录的探针，逐个分支钉住。

import { test, expect } from "bun:test";
import { ExtensionAbiError, ExtensionHost, ExtensionMountError, defineExtension, defineService, type ExtensionEntry } from "../src/extension/public.ts";
import { projectExtensionFact, type ExtensionFact } from "../src/extension/observe.ts";

function recorder(): { host: (opts?: ConstructorParameters<typeof ExtensionHost>[0]) => ExtensionHost; facts: ExtensionFact[] } {
  const facts: ExtensionFact[] = [];
  return { facts, host: (opts = {}) => new ExtensionHost({ ...opts, observe: { offer: (f) => void facts.push(f) } }) };
}

const entry = (entryId: string, definition: ExtensionEntry["definition"], config?: unknown): ExtensionEntry => ({ entryId, definition, ...(config !== undefined ? { config } : {}) });

const Client = defineService<{ ok: true }>({ id: "demo.client", version: 1, kind: "single", scope: "agent", reload: "agent" });
const provider = defineExtension({
  name: "demo-provider",
  hostAbiVersion: 1,
  provide: [Client],
  apply(ctx) {
    ctx.provide(Client, { ok: true });
  },
});
const consumer = defineExtension({
  name: "demo-consumer",
  hostAbiVersion: 1,
  inject: { client: { service: Client, required: true } },
  apply(ctx) {
    ctx.get(Client);
  },
});

test("装上一代：记下每个 extension 的名字、作用域、它 provide 了什么、inject 的服务实际连到了哪个 Entry", async () => {
  const { host, facts } = recorder();
  const h = host();
  await h.mount("g1", [entry("consumer", consumer), entry("provider", provider)]);
  expect(facts.map((f) => f.kind)).toEqual(["generation_mounted"]);
  const mounted = facts[0] as Extract<ExtensionFact, { kind: "generation_mounted" }>;
  expect(mounted.generation).toBe("g1");
  // 按加载顺序（依赖拓扑：provider 先）
  expect(mounted.fibers).toEqual([
    { entryId: "provider", name: "demo-provider", scope: "agent", reload: "agent", effects: 0, injects: [], provides: ["demo.client"] },
    { entryId: "consumer", name: "demo-consumer", scope: "agent", reload: "agent", effects: 0, injects: [{ service: "demo.client", required: true, provider: "provider" }], provides: [] },
  ]);
});

test("PREPARE 阶段被拒（required 的服务没人提供）：stage=prepare，没有哪个 Entry 被加载过", async () => {
  const { host, facts } = recorder();
  const err = await host()
    .mount("g1", [entry("consumer", consumer)])
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExtensionAbiError);
  expect(facts).toHaveLength(1);
  const failed = facts[0] as Extract<ExtensionFact, { kind: "generation_mount_failed" }>;
  expect(failed).toMatchObject({ kind: "generation_mount_failed", generation: "g1", entryIds: ["consumer"], stage: "prepare", unwindErrors: 0 });
  expect(failed.failedEntryId).toBeUndefined();
  expect(failed.error).toBe(err);
});

test("LOADING 阶段某个 apply 抛错：stage=apply，指明是哪个 Entry，错误是 extension 自己抛的那个（不是 Host 包的那层）", async () => {
  const boom = new TypeError("apply exploded: token=secret");
  const broken = defineExtension({
    name: "demo-broken",
    hostAbiVersion: 1,
    inject: { client: { service: Client, required: true } },
    apply() {
      throw boom;
    },
  });
  const { host, facts } = recorder();
  const err = await host()
    .mount("g1", [entry("provider", provider), entry("broken", broken)])
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExtensionMountError);
  const failed = facts[0] as Extract<ExtensionFact, { kind: "generation_mount_failed" }>;
  expect(failed).toMatchObject({ kind: "generation_mount_failed", stage: "apply", failedEntryId: "broken", entryIds: ["provider", "broken"], unwindErrors: 0 });
  expect(failed.error).toBe(boom);

  // metadata 档只记错误名，消息可能带敏感内容，content 档才记
  const meta = projectExtensionFact(failed, "metadata")!;
  expect(meta.name).toBe("extension.generation.mount_failed");
  expect(meta.attributes).toEqual({ generation: "g1", stage: "apply", errorName: "TypeError", failedEntryId: "broken" });
  expect(JSON.stringify(meta)).not.toContain("token=secret");
  expect((projectExtensionFact(failed, "content")!.body as Record<string, unknown>).errorMessage).toBe("apply exploded: token=secret");
});

test("卸下一代：记 unmounted；卸一个没装过的代什么都没发生，不记", async () => {
  const { host, facts } = recorder();
  const h = host();
  await h.mount("g1", [entry("provider", provider)]);
  await h.unmount("g1");
  await h.unmount("never-mounted");
  expect(facts.map((f) => f.kind)).toEqual(["generation_mounted", "generation_unmounted"]);
  expect(facts[1]).toMatchObject({ kind: "generation_unmounted", generation: "g1", entryIds: ["provider"], cleanupErrors: 0 });
});

test("卸载被拒（别的代还有 consumer 绑在它的 provider 上）：记 unmount_refused，这一代原样留着", async () => {
  const { host, facts } = recorder();
  const h = host();
  await h.mount("base", [entry("provider", provider)]);
  await h.mount("top", [entry("consumer", consumer)]);
  const err = await h.unmount("base").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExtensionAbiError);
  expect(h.mountedGenerations).toContain("base");
  const refused = facts.at(-1) as Extract<ExtensionFact, { kind: "generation_unmount_refused" }>;
  expect(refused).toMatchObject({ kind: "generation_unmount_refused", generation: "base", entryIds: ["provider"] });
  expect(projectExtensionFact(refused, "metadata")!.name).toBe("extension.generation.unmount_refused");
});

/* ── 换代事务 replace()（热部署，2026-09-14）：卸旧、装新、装回、被拒，每一步都是账本里已有的那几种事实 ── */

const swappable = (tag: string, failApply = false) =>
  defineExtension({
    name: `demo-swappable-${tag}`,
    hostAbiVersion: 1,
    reload: "run",
    apply() {
      if (failApply) throw new Error(`${tag} 装不上`);
    },
  });

test("replace 换成功：记 unmounted（旧代）+ mounted（新代），顺序就是先卸后装", async () => {
  const { host, facts } = recorder();
  const h = host();
  await h.mount("g1", [entry("hot", swappable("v1"))]);
  const r = await h.replace("g1", { generation: "g2", entries: [entry("hot", swappable("v2"))] }, { safePoint: "run" });
  expect(r.kind).toBe("replaced");
  expect(facts.map((f) => `${f.kind}:${f.generation}`)).toEqual(["generation_mounted:g1", "generation_unmounted:g1", "generation_mounted:g2"]);
});

test("replace 新的装不上：记 unmounted（旧）+ mount_failed（新，指明 Entry）+ mounted（旧装回来）", async () => {
  const { host, facts } = recorder();
  const h = host();
  await h.mount("g1", [entry("hot", swappable("v1"))]);
  const r = await h.replace("g1", { generation: "g2", entries: [entry("hot", swappable("v2", true))] }, { safePoint: "run" });
  expect(r.kind).toBe("rolled_back");
  expect(facts.map((f) => `${f.kind}:${f.generation}`)).toEqual([
    "generation_mounted:g1",
    "generation_unmounted:g1",
    "generation_mount_failed:g2",
    "generation_mounted:g1",
  ]);
  expect(facts[2]).toMatchObject({ kind: "generation_mount_failed", stage: "apply", failedEntryId: "hot" });
});

test("replace 被拒（声明的 reload 比安全点强）：记 unmount_refused，Host 零变化；只卸（next 为 null）记 unmounted", async () => {
  const { host, facts } = recorder();
  const h = host();
  await h.mount("g1", [entry("provider", provider)]); // reload 缺省 agent
  const refused = await h.replace("g1", { generation: "g2", entries: [entry("provider", provider)] }, { safePoint: "run" });
  expect(refused.kind).toBe("refused");
  expect(facts.map((f) => f.kind)).toEqual(["generation_mounted", "generation_unmount_refused"]);
  expect(facts[1]).toMatchObject({ kind: "generation_unmount_refused", generation: "g1", entryIds: ["provider"] });
  expect(h.mountedGenerations).toEqual(["g1"]);

  await h.mount("g3", [entry("hot", swappable("v1"))]);
  expect((await h.replace("g3", null, { safePoint: "run" })).kind).toBe("replaced");
  expect(facts.at(-1)).toMatchObject({ kind: "generation_unmounted", generation: "g3", entryIds: ["hot"], cleanupErrors: 0 });
});

test("replace 新代 PREPARE 就没过（config 抛）：只记 mount_failed(prepare)，没有 unmounted——旧代原样，账本里也没有「卸了又装回」", async () => {
  const { host, facts } = recorder();
  const h = host();
  await h.mount("g1", [entry("hot", swappable("v1"))]);
  const badConfig = defineExtension({
    name: "demo-swappable-bad",
    hostAbiVersion: 1,
    reload: "run",
    config() {
      throw new Error("bad config");
    },
    apply() {},
  });
  const r = await h.replace("g1", { generation: "g2", entries: [entry("hot", badConfig)] }, { safePoint: "run" });
  expect(r.kind).toBe("rolled_back");
  expect(facts.map((f) => `${f.kind}:${f.generation}`)).toEqual(["generation_mounted:g1", "generation_mount_failed:g2"]);
  expect(facts[1]).toMatchObject({ kind: "generation_mount_failed", stage: "prepare", entryIds: ["hot"], unwindErrors: 0 });
  expect(h.mountedGenerations).toEqual(["g1"]);
});

test("没给探针的 Host 照常工作（低层用法）", async () => {
  const h = new ExtensionHost();
  await h.mount("g1", [entry("provider", provider)]);
  await h.unmount("g1");
  expect(h.mountedGenerations).toEqual([]);
});
