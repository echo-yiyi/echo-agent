import { test, expect } from "bun:test";
import { sealAgentAssemblyObservation, snapshotRunModelBinding, type BuiltinSlotContribution } from "../src/observability/assembly.ts";
import { FAKE_MODEL } from "../src/testing.ts";

// O2a：最小 sealed AgentAssembly 与 RunModelBinding 观测快照。schema 与 digest 必须稳定——
// O2b 接上正式 Entry owner 后往同一 schema 填值，slot ID 与 contribution digest 不漂移。

const slots: BuiltinSlotContribution[] = [
  { slot: "store", entryId: "echo:agent", entryGeneration: "0.1.0", safeConfig: { kind: "FileDir" } },
  { slot: "memory", entryId: "echo:memory", entryGeneration: "0.1.0", safeConfig: { partitions: 2 } },
  { slot: "lock", entryId: "echo:agent", entryGeneration: "0.1.0", safeConfig: { kind: "fileStateLock" } },
];

test("按 slot 排序封口；注入顺序不影响 digest；owner 是 known(via assembly)", () => {
  const a = sealAgentAssemblyObservation(slots);
  const b = sealAgentAssemblyObservation([...slots].reverse());
  expect(a.digest).toBe(b.digest);
  expect(a.slots.map((s) => s.slot)).toEqual(["lock", "memory", "store"]);
  expect(a.slots[1]).toMatchObject({ entryId: "echo:memory", owner: { status: "known", entryId: "echo:memory", entryGeneration: "0.1.0", via: "assembly" } });
  expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
});

test("safeConfig 或 generation 变了，对应 slot digest 与总 digest 都变；别的 slot 不变", () => {
  const a = sealAgentAssemblyObservation(slots);
  const changed = sealAgentAssemblyObservation(slots.map((s) => (s.slot === "memory" ? { ...s, safeConfig: { partitions: 3 } } : s)));
  expect(changed.digest).not.toBe(a.digest);
  expect(changed.slots.find((s) => s.slot === "memory")!.digest).not.toBe(a.slots.find((s) => s.slot === "memory")!.digest);
  expect(changed.slots.find((s) => s.slot === "store")!.digest).toBe(a.slots.find((s) => s.slot === "store")!.digest);
  const regen = sealAgentAssemblyObservation(slots.map((s) => ({ ...s, entryGeneration: "0.2.0" })));
  expect(regen.digest).not.toBe(a.digest);
});

test("槽重复 fail-loud；快照里没有对象本体", () => {
  expect(() => sealAgentAssemblyObservation([...slots, slots[0]!])).toThrow(/重复/);
  const snap = sealAgentAssemblyObservation([{ slot: "session", entryId: "echo:agent", entryGeneration: "1", safeConfig: { kind: "SessionService" } }]);
  expect(Object.keys(snap.slots[0]!).sort()).toEqual(["digest", "entryGeneration", "entryId", "owner", "slot"]);
});

test("RunModelBinding：provider/model id 直出，configDigest 只看安全配置", () => {
  const a = snapshotRunModelBinding(FAKE_MODEL, "rev-1");
  expect(a.providerId).toBe(FAKE_MODEL.provider);
  expect(a.modelId).toBe(FAKE_MODEL.id);
  expect(a.catalogRevision).toBe("rev-1");
  expect(a.configDigest).toMatch(/^[0-9a-f]{64}$/);
  const b = snapshotRunModelBinding({ ...FAKE_MODEL, params: { temperature: 0.2 } }, "rev-1");
  expect(b.configDigest).not.toBe(a.configDigest);
  // name 只是展示用，不进 digest
  const c = snapshotRunModelBinding({ ...FAKE_MODEL, name: "renamed" }, "rev-1");
  expect(c.configDigest).toBe(a.configDigest);
});
