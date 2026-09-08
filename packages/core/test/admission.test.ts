// Unified Run Admission（standalone 版）：admission 类型面 / normalizeModelSnapshot / StandaloneRunAdmission 的 ABI 结算规则 /
// Agent 的 prompt · Inbox · Dream 全部经同一 port。conformance 由 fake 与 standalone 共跑一套。

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import {
  FAKE_MODEL,
  createFakeAgentAdmission,
  runAgentAdmissionConformance,
  runModelSnapshotConformance,
  scriptedStreamFn,
  textTurn,
  toolTurn,
  type AdmissionUnderTest,
} from "../src/testing.ts";
import { normalizeModelSnapshot, ModelSnapshotError } from "../src/admission/model-snapshot.ts";
import { StandaloneRunAdmission } from "../src/admission/standalone.ts";
import type { RunModelBinding, RunSource } from "../src/admission/types.ts";
import type { LoopResult } from "../src/loop/types.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { environmentMessage } from "../src/messages.ts";
import type { LifecycleEvent } from "../src/events.ts";
import type { Model } from "../src/provider/types.ts";

function tool(name: string, execute: ModelTool["execute"]): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute };
}

function lifecycle(agent: Agent): LifecycleEvent[] {
  const seen: LifecycleEvent[] = [];
  agent.subscribeLifecycle((e) => {
    seen.push(e);
  });
  return seen;
}

const STUB_BINDING = (source: RunSource, purpose: "foreground" | "maintenance"): RunModelBinding =>
  Object.freeze({
    bindingId: "b",
    source: Object.freeze({ ...source }),
    purpose,
    catalogRevision: "test:0",
    provider: Object.freeze({ id: "fake", entryId: "test", generation: "0" }),
    model: normalizeModelSnapshot(FAKE_MODEL),
    streamFunction: scriptedStreamFn([textTurn("ok")]),
    thinkingLevel: "off",
    retryPolicy: Object.freeze({ maxAttempts: 1, backoffMs: () => 0 }),
  });

/* ─────────────── normalizeModelSnapshot ─────────────── */

test("normalizeModelSnapshot：JSON-like 递归 clone + freeze；原对象之后怎么改都影响不到快照", () => {
  const model: Model = { ...FAKE_MODEL, params: { temperature: 0.2, stop: ["a", "b"], nested: { k: 1 } } };
  const snap = normalizeModelSnapshot(model);
  (model.params as Record<string, unknown>)["temperature"] = 0.9;
  ((model.params as Record<string, unknown>)["nested"] as Record<string, unknown>)["k"] = 2;
  expect(snap.params).toEqual({ temperature: 0.2, stop: ["a", "b"], nested: { k: 1 } });
  expect(Object.isFrozen(snap)).toBe(true);
  expect(Object.isFrozen(snap.params)).toBe(true);
  expect(Object.isFrozen((snap.params as { nested: unknown }).nested)).toBe(true);
});

test("normalizeModelSnapshot：函数 / undefined 值 / 非 finite / class 实例 / accessor / symbol key / sparse / 循环 一律 fail-loud，不静默删字段", () => {
  const bad = (params: Record<string, unknown>): (() => void) => () => normalizeModelSnapshot({ ...FAKE_MODEL, params });
  expect(bad({ f: () => 1 })).toThrow(ModelSnapshotError);
  expect(bad({ u: undefined })).toThrow("undefined");
  expect(bad({ n: Number.NaN })).toThrow("finite");
  expect(bad({ n: Number.POSITIVE_INFINITY })).toThrow("finite");
  expect(bad({ b: 10n as never })).toThrow("bigint");
  class Box {}
  expect(bad({ box: new Box() })).toThrow("Box 实例");
  expect(bad({ d: new Date() })).toThrow("实例");
  const acc = {};
  Object.defineProperty(acc, "x", { get: () => 1, enumerable: true });
  expect(bad({ acc })).toThrow("accessor");
  expect(bad({ s: { [Symbol("k")]: 1 } })).toThrow("symbol key");
  // eslint-disable-next-line no-sparse-arrays
  expect(bad({ arr: [1, , 3] })).toThrow("sparse");
  const cyc: Record<string, unknown> = {};
  cyc["self"] = cyc;
  expect(bad({ cyc })).toThrow("循环");
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, id: "" })).toThrow("model.id");
});

test("model 快照 conformance：`normalizeModelSnapshot` 必须过共享判据（O3 的 Runtime binding 冻结跑同一套）", () => {
  runModelSnapshotConformance(() => ({ snapshot: normalizeModelSnapshot }));
  // 反证 1：`JSON.parse(JSON.stringify(...))` 这条近路会静默删字段、也不冻结 —— suite 必须判红
  expect(() =>
    runModelSnapshotConformance(() => ({
      snapshot: (model) => JSON.parse(JSON.stringify(model)) as ReturnType<typeof normalizeModelSnapshot>,
    })),
  ).toThrow(/conformance 不合格/);

  // 反证 2：**只冻结对象、嵌套数组仍可变**——上一版的判据放它过去了
  expect(() =>
    runModelSnapshotConformance(() => ({
      snapshot: (model) => {
        const real = normalizeModelSnapshot(model);
        const params = real.params as Record<string, unknown> | undefined;
        if (params === undefined) return real;
        const thawed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(params)) thawed[k] = Array.isArray(v) ? [...v] : v; // 数组解冻
        return Object.freeze({ ...real, params: Object.freeze(thawed) }) as ReturnType<typeof normalizeModelSnapshot>;
      },
    })),
  ).toThrow(/嵌套数组也必须冻结|嵌套数组必须是拷贝/);

  // 反证 3：**把 own `__proto__` 悄悄删掉**——不污染原型，但字段没了
  expect(() =>
    runModelSnapshotConformance(() => ({
      snapshot: (model) => {
        const real = normalizeModelSnapshot(model);
        const params = real.params as Record<string, unknown> | undefined;
        if (params === undefined) return real;
        const dropped: Record<string, unknown> = {};
        for (const k of Object.keys(params)) {
          if (k === "__proto__") continue; // 静默丢字段
          Object.defineProperty(dropped, k, { value: params[k], enumerable: true });
        }
        return Object.freeze({ ...real, params: Object.freeze(dropped) }) as ReturnType<typeof normalizeModelSnapshot>;
      },
    })),
  ).toThrow(/必须留在快照里/);
});

/* ─────────────── conformance：fake 与 standalone 共跑一套 ─────────────── */

function standaloneUnderTest(): AdmissionUnderTest {
  let broken = false;
  const admission = new StandaloneRunAdmission({
    binding: (input) => STUB_BINDING(input.source, input.purpose),
    normalizeFailure: async ({ error, aborted }) => {
      if (broken) {
        broken = false;
        throw new Error("normalizer sink 炸了");
      }
      return {
        outcome: aborted ? { kind: "aborted" } : { kind: "error", error: { source: "internal", code: "internal", retryable: false, message: String(error) } },
        messages: [],
      };
    },
  });
  return {
    port: admission,
    admitUser: (execute) => admission.admitUser(execute),
    drive: () => new Promise((r) => setTimeout(r, 1)), // 自动实现：让出事件循环即推进
    abortActive: () => admission.abortActive(),
    close: () => admission.close("stopping"),
    breakNormalizer: () => {
      broken = true;
    },
  };
}

test("conformance：StandaloneRunAdmission 通过", async () => {
  await runAgentAdmissionConformance(standaloneUnderTest);
});

/* ─────────────── Agent：prompt / Inbox / Dream 都经同一 admission ─────────────── */

test("Inbox：多条 pending 一次 reserve 成一批 → 恰好一次 run；跑完整批 ack；跑的中途新到的进下一批", async () => {
  let runs = 0;
  let agent!: Agent;
  const t = tool("t", async () => {
    // run 中途又来一条：不并入已 reserve 的批
    agent.deliver(environmentMessage("late", "bg", "b3"));
    return toolOk("ok");
  });
  agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok"), textTurn("ok2")]),
    tools: [t],
  });
  agent.subscribe((e) => {
    if (e.type === "agent_start") runs += 1;
  });
  agent.deliver(environmentMessage("one", "bg", "b1"));
  agent.deliver(environmentMessage("two", "bg", "b2"));
  await new Promise((r) => setTimeout(r, 5));
  const first = await agent.consumeInbox();
  expect(first?.outcome.kind).toBe("completed");
  expect(runs).toBe(1);
  // 第一批的两条都进了 transcript；晚到的那条还在队列里等下一批
  const envTexts = (): string[] =>
    agent.state.messages.filter((m) => m.role === "environment").map((m) => (m.content[0] as { text: string }).text);
  expect(envTexts()).toEqual(["one", "two"]);
  const second = await agent.consumeInbox();
  expect(second?.outcome.kind).toBe("completed");
  expect(runs).toBe(2);
  expect(envTexts()).toEqual(["one", "two", "late"]);
});

test("prompt 与 Inbox 都经 admission：run 中途 consumeInbox() 返回 null（那批留到 idle）；dispose 之后 prompt 被 admission 拒绝", async () => {
  let agent!: Agent;
  let midRun: LoopResult | null | undefined;
  const t = tool("t", async () => {
    agent.deliver(environmentMessage("evt", "bg", "b1"));
    midRun = await agent.consumeInbox();
    return toolOk("ok");
  });
  agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]), tools: [t] });
  await agent.prompt("go");
  expect(midRun).toBeNull();
  await agent.dispose();
  // **拒绝从 admission 提前到了入口判据**（review 六轮 P1）：以前 `prompt()` 一路走到 admission
  // 才被拒（`run 被 admission 拒绝：stopping`），而同一时刻 `acceptsWork` 还报 true——
  // 那就破了「同真同假」。现在 `refuseWorkReason()` 在入口就认收摊态，两者一起为假。
  // 行为没变（照样拒、照样是 dispose 之后不能再干活），变的是在哪一层拒。
  expect(agent.acceptsWork).toBe(false);
  await expect(agent.prompt("again")).rejects.toThrow("已收摊");
});

test("model seam：构造期与 setter 都验 JSON-like（fail-loud 在装备期，不等到 admission）", () => {
  const bad: Model = { ...FAKE_MODEL, params: { f: () => 1 } };
  expect(() => new Agent({ model: bad, streamFunction: scriptedStreamFn([]) })).toThrow(ModelSnapshotError);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  expect(() => {
    agent.model = bad;
  }).toThrow(ModelSnapshotError);
});

test("终态之后 listener 抛错（agent_end 已应用、executor 因此 reject）：复用锁存的终态，不发第二个 agent_end，prompt 拿到原 outcome", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("ok"), textTurn("ok")]) });
  const seen = lifecycle(agent);
  let ends = 0;
  agent.subscribe((e) => {
    if (e.type === "agent_end") {
      ends += 1;
      throw new Error("listener 在终态之后炸了"); // 让 executor reject
    }
  });
  const result = await agent.prompt("go");
  // 上一版只在 executor 成功返回后写 terminal map：这条路 normalizer 看不到终态，再合成一次 → ends === 2
  expect(ends).toBe(1);
  expect(result.outcome.kind).toBe("completed");
  expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(seen.some((e) => e.type === "notification" && e.message.includes("[run_callback_contract_failure]"))).toBe(true);
  // 下一个 run 照常
  expect((await agent.prompt("again")).outcome.kind).toBe("completed");
});

test("终态之前 listener 抛错（agent_start 就炸）：runLoop 在 finally 里封口 agent_end，Agent 不再合成第二个；没开过的层不补", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("ok")]) });
  const events: string[] = [];
  let armed = true;
  agent.subscribe((e) => {
    events.push(e.type);
    if (e.type === "agent_start" && armed) {
      armed = false;
      throw new Error("listener 在开头炸了");
    }
  });
  const result = await agent.prompt("go");
  expect(result.outcome).toMatchObject({ kind: "error", error: { code: "internal", message: "listener 在开头炸了" } });
  expect(events.filter((t) => t === "agent_end")).toHaveLength(1);
  // reply / turn / attempt 一个都没开（agent_start 就炸），所以一个 *_end 都不合成——配对由结构成立，不靠外层补
  expect(events).toEqual(["agent_start", "agent_end"]);
  expect(agent.status).toBe("idle");
});

test("终态之前 listener 抛错（attempt 中途炸）：Agent 按序收掉开着的 attempt → turn → reply，恰好一个 agent_end", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("ok")]) });
  const events: string[] = [];
  let armed = true;
  agent.subscribe((e) => {
    events.push(e.type);
    // attempt_end 上炸：runAttempt 的 catch 已经过了（它只兜 callModel），异常从 emit 穿出 runLoop 的 finally
    if (e.type === "attempt_end" && armed) {
      armed = false;
      throw new Error("listener 在 attempt_end 炸了");
    }
  });
  const result = await agent.prompt("go");
  expect(result.outcome).toMatchObject({ kind: "error", error: { code: "internal" } });
  expect(events.filter((t) => t === "agent_end")).toHaveLength(1);
  expect(events.filter((t) => t === "turn_end")).toHaveLength(1);
  expect(events.filter((t) => t === "reply_end")).toHaveLength(1);
  expect(events.slice(-3)).toEqual(["turn_end", "reply_end", "agent_end"]);
});

test("Inbox：同一个 message 对象投递两次 = 两条事实、两个 recordId、一次批量 run，最终没有 reservation 泄漏", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("ok"), textTurn("ok2")]) });
  let runs = 0;
  agent.subscribe((e) => {
    if (e.type === "agent_start") runs += 1;
  });
  const same = environmentMessage("dup", "bg", undefined as never);
  agent.deliver(same);
  agent.deliver(same);
  await new Promise((r) => setTimeout(r, 5));
  // 上一版按对象记 id：两次投递复用同一个 recordId → 批里重复 → admission 同步拒，且 drain 掉的 reservation 没被 release
  const result = await agent.consumeInbox();
  expect(result?.outcome.kind).toBe("completed");
  expect(runs).toBe(1);
  expect(agent.state.messages.filter((m) => m.role === "environment")).toHaveLength(2);
  const ledger = (agent as unknown as { inbox: { reservationCount: number } }).inbox;
  expect(ledger.reservationCount).toBe(0);
  // 还能继续投、继续消费——没有残留的 outstanding 标记
  agent.deliver(environmentMessage("next", "bg", "b9"));
  await new Promise((r) => setTimeout(r, 5));
  expect((await agent.consumeInbox())?.outcome.kind).toBe("completed");
  expect(ledger.reservationCount).toBe(0);
});

test("model 快照的精确 schema：class 实例 / capabilities 非法标量 / 未知字段 / non-enumerable / __proto__ 键", () => {
  class M {
    provider = "p";
    id = "i";
    api = "a";
  }
  expect(() => normalizeModelSnapshot(new M() as unknown as Model)).toThrow("M 实例");
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, capabilities: { reasoning: "yes" as never } })).toThrow("boolean");
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, capabilities: { bogus: 1 } as never })).toThrow("未知字段");
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, extra: 1 } as never)).toThrow("未知字段");
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, cost: { input: 1 } as never })).toThrow("必填");
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, thinkingLevelMap: { weird: "x" } as never })).toThrow("不是 ThinkingLevel");
  // 2026-09-08：值是参数字典（`reasoning_effort` / `thinking.type` 之类）或 null，不再是字符串
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, thinkingLevelMap: { low: "low" } as never })).toThrow("plain object | null");
  expect(normalizeModelSnapshot({ ...FAKE_MODEL, thinkingLevelMap: { off: { thinking: { type: "disabled" } }, max: null } }).thinkingLevelMap).toEqual({
    off: { thinking: { type: "disabled" } },
    max: null,
  });
  const hidden: Record<string, unknown> = { a: 1 };
  Object.defineProperty(hidden, "secret", { value: 2, enumerable: false });
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, params: hidden })).toThrow("non-enumerable");
  // 原型字段不是 schema 字段：上一版 `key in fields` 把 toString / constructor 放过了
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, capabilities: { toString: true } as never })).toThrow("未知字段");
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, capabilities: { constructor: true } as never })).toThrow("未知字段");
  // 数组：额外属性 / accessor 下标 / symbol key / Array 子类——上一版只按下标遍历，全部静默放过
  const extra = Object.assign([1, 2], { extra: 3 });
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, params: { extra } })).toThrow("额外属性");
  const accessor: unknown[] = [1];
  Object.defineProperty(accessor, 1, { get: () => 2, enumerable: true, configurable: true });
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, params: { accessor } })).toThrow("accessor 下标");
  const sym: unknown[] = [1];
  (sym as unknown as Record<symbol, unknown>)[Symbol("s")] = 1;
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, params: { sym } })).toThrow("symbol key");
  class L extends Array<number> {}
  expect(() => normalizeModelSnapshot({ ...FAKE_MODEL, params: { sub: L.from([1]) } })).toThrow("不是 plain array");
  const ok = normalizeModelSnapshot({ ...FAKE_MODEL, params: { list: [1, "a", null, [true]] } });
  expect(ok.params).toEqual({ list: [1, "a", null, [true]] });
  // `__proto__` 作为 params 的键：克隆出来是自身属性，原型不变、自身字段不丢
  const proto = JSON.parse('{"__proto__": {"polluted": true}, "keep": 1}') as Record<string, unknown>;
  const snap = normalizeModelSnapshot({ ...FAKE_MODEL, params: proto });
  expect(Object.getPrototypeOf(snap.params)).toBe(Object.prototype);
  expect(Object.prototype.hasOwnProperty.call(snap.params, "__proto__")).toBe(true);
  expect((snap.params as Record<string, unknown>)["keep"]).toBe(1);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});

test("binding 递归冻结：source / provider / model / retryPolicy 都是 frozen 副本，不别名 caller 对象", () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const internals = agent as unknown as { modelBinding(input: { source: RunSource; purpose: "foreground" | "maintenance" }): RunModelBinding };
  const source: RunSource = { kind: "extension", entryId: "e", sourceId: "s" };
  const b = internals.modelBinding({ source, purpose: "foreground" });
  expect(Object.isFrozen(b)).toBe(true);
  expect(Object.isFrozen(b.source)).toBe(true);
  expect(b.source).not.toBe(source);
  expect(Object.isFrozen(b.provider)).toBe(true);
  expect(Object.isFrozen(b.model)).toBe(true);
  expect(Object.isFrozen(b.retryPolicy)).toBe(true);
});

test("conformance：fake admission 通过", async () => {
  await runAgentAdmissionConformance(() => {
    const fake = createFakeAgentAdmission();
    let closed = false;
    return {
      port: {
        enqueue: (request, execute) => {
          const t = fake.port.enqueue(request, execute);
          if (closed) fake.rejectNext("stopping");
          return t;
        },
      },
      admitUser: (execute) => {
        const t = fake.admitUser(execute);
        if (closed) fake.rejectNext("stopping");
        return t;
      },
      drive: async () => {
        // grantNext 要等 execute 跑完才 resolve（在跑的 Dream 要等 abort）：不能阻塞在它上面，发出去就让事件循环转一圈
        if (fake.activeRunId === null && fake.pending().length > 0) void fake.grantNext();
        await new Promise((r) => setTimeout(r, 0));
      },
      abortActive: () => fake.abortActive(),
      close: async () => {
        closed = true;
        while (fake.rejectNext("stopping")) {
          /* 排队的全部拒掉 */
        }
        fake.abortActive();
      },
      breakNormalizer: () => fake.failNextNormalization(),
    };
  });
});
