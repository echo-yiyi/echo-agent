import { test, expect, describe } from "bun:test";
import { preflightTerminalProjection } from "../src/observability/terminal.ts";
import { ObservationEncodingError } from "../src/observability/normalize.ts";
import { OBSERVATION_BOUNDARY_LIMITS } from "../src/observability/types.ts";
import type { CapabilityObservationSummary, EchoObservableState, ObservationSnapshot, RunClosedBodyInput } from "../src/observability/types.ts";

// §15.5.1「boundary body 按构造有界」的纯函数 preflight：不依赖 Runtime admission 就能验
// 「超限自动降级、required body 仍合法」（review P1）。

function summary(i: number, over: Partial<CapabilityObservationSummary> = {}): CapabilityObservationSummary {
  return { schemaVersion: 1, stateDigest: `d${i}`, counters: { n: i }, detailBytes: 0, detailTruncated: false, ...over };
}

function snapshotWith(caps: { id: string; summary: CapabilityObservationSummary }[], agentStatus = "idle"): ObservationSnapshot<EchoObservableState> {
  return {
    throughSeq: 0,
    at: 1_000,
    state: {
      runtime: { phase: "ready", status: "ready", observationPersistence: "healthy", generation: "g", activeEntryCount: 0 },
      agent: { status: agentStatus, activeRunId: null, activeTurnId: null, iteration: 1, messageCount: 2 },
      capabilities: caps.map((c) => ({ id: c.id, digest: "x", summary: c.summary })),
      omittedCapabilitySummaryCount: 0,
    },
  };
}

const caps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `cap-${String(i).padStart(3, "0")}`, summary: summary(i) }));

function body(finalSnapshot: ObservationSnapshot<EchoObservableState> | null, outcome: RunClosedBodyInput["outcome"] = { status: "completed" }): RunClosedBodyInput {
  return { outcome, finalSnapshot };
}

describe("preflightTerminalProjection", () => {
  test("合法 body 原样通过，无 projection gap", () => {
    const p = preflightTerminalProjection(body(snapshotWith(caps(3))));
    expect(p.projectionGaps).toEqual([]);
    expect(p.omittedCapabilitySummaries).toBe(0);
    expect(p.body.finalSnapshot?.state.capabilities.map((c) => c.id)).toEqual(["cap-000", "cap-001", "cap-002"]);
    expect(preflightTerminalProjection(body(null)).projectionGaps).toEqual([]);
  });

  test("33 个 summary → 按 id 排序保留 32、omitted 1、要求 capabilities gap", () => {
    const shuffled = [...caps(33)].reverse();
    const p = preflightTerminalProjection(body(snapshotWith(shuffled)));
    expect(p.body.finalSnapshot?.state.capabilities).toHaveLength(OBSERVATION_BOUNDARY_LIMITS.maxCapabilitySummaries);
    expect(p.body.finalSnapshot?.state.capabilities[0]?.id).toBe("cap-000");
    expect(p.body.finalSnapshot?.state.omittedCapabilitySummaryCount).toBe(1);
    expect(p.omittedCapabilitySummaries).toBe(1);
    expect(p.projectionGaps).toEqual(["run.final_snapshot.capabilities"]);
  });

  test("非法 summary（counters 超 24 key / 单项超 1 KiB / schemaVersion 不对）被丢并计入 omitted", () => {
    const tooManyCounters = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
    const list = [
      { id: "a", summary: summary(0, { counters: tooManyCounters }) },
      { id: "b", summary: summary(1, { stateDigest: "x".repeat(1_100) }) },
      { id: "c", summary: { ...summary(2), schemaVersion: 2 as unknown as 1 } },
      { id: "d", summary: summary(3) },
    ];
    const p = preflightTerminalProjection(body(snapshotWith(list)));
    expect(p.body.finalSnapshot?.state.capabilities.map((c) => c.id)).toEqual(["d"]);
    expect(p.omittedCapabilitySummaries).toBe(3);
    expect(p.projectionGaps).toEqual(["run.final_snapshot.capabilities"]);
  });

  test("caller 自报的存量 omission 也要 gap 覆盖——不接受「省略了 5 条但没有任何 gap」", () => {
    const base = snapshotWith(caps(2));
    const legacy: ObservationSnapshot<EchoObservableState> = { ...base, state: { ...base.state, omittedCapabilitySummaryCount: 5 } };
    const p = preflightTerminalProjection(body(legacy));
    expect(p.omittedCapabilitySummaries).toBe(0); // 本次没新省略
    expect(p.body.finalSnapshot?.state.omittedCapabilitySummaryCount).toBe(5);
    expect(p.projectionGaps).toEqual(["run.final_snapshot.capabilities"]); // 但仍要 gap
  });

  test("summary 形状恶劣（counters:null / getter 抛错 / 非对象）只当 omission，不升级成 run.closed 失败", () => {
    const hostile = {
      id: "h",
      summary: { schemaVersion: 1, stateDigest: "d", counters: null, detailBytes: 0, detailTruncated: false } as unknown as CapabilityObservationSummary,
    };
    const thrower = {
      id: "t",
      summary: new Proxy({ schemaVersion: 1 } as unknown as CapabilityObservationSummary, {
        get(_t, k): unknown {
          if (k === "schemaVersion") return 1;
          throw new Error("getter boom");
        },
      }),
    };
    const notObject = { id: "n", summary: 42 as unknown as CapabilityObservationSummary };
    const good = { id: "g", summary: summary(1) };
    let p!: ReturnType<typeof preflightTerminalProjection>;
    expect(() => {
      p = preflightTerminalProjection(body(snapshotWith([hostile, thrower, notObject, good])));
    }).not.toThrow();
    expect(p.body.finalSnapshot?.state.capabilities.map((c) => c.id)).toEqual(["g"]);
    expect(p.omittedCapabilitySummaries).toBe(3);
    expect(p.projectionGaps).toEqual(["run.final_snapshot.capabilities"]);
  });

  test("外层 entry 坏形状不击穿封口：null / 非对象 / id 非串 / 稀疏洞都只算 omission", () => {
    const good = { id: "g", summary: summary(1) };
    const base = snapshotWith([good]);
    const caps: unknown[] = [null, 42, { id: 7, digest: "d", summary: summary(0) }, { id: "x", digest: "", summary: summary(0) }, { id: "g", digest: "x", summary: summary(1) }];
    caps[7] = { id: "z", digest: "x", summary: summary(2) }; // 中间留稀疏洞
    const snap: ObservationSnapshot<EchoObservableState> = {
      ...base,
      state: { ...base.state, capabilities: caps as EchoObservableState["capabilities"] },
    };
    let p!: ReturnType<typeof preflightTerminalProjection>;
    expect(() => {
      p = preflightTerminalProjection(body(snap));
    }).not.toThrow();
    // 留下的只有两条合法 entry；其余 4 条坏的 + 2 个稀疏洞都记成省略
    expect(p.body.finalSnapshot?.state.capabilities.map((c) => c.id)).toEqual(["g", "z"]);
    expect(p.omittedCapabilitySummaries).toBe(6);
    expect(p.projectionGaps).toEqual(["run.final_snapshot.capabilities"]);
  });

  test("纯稀疏数组：filter 会静默跳过并报 complete，这里必须记成省略并开 gap", () => {
    const base = snapshotWith([]);
    const sparse: unknown[] = [];
    sparse[2] = { id: "a", digest: "d", summary: summary(0) };
    const snap: ObservationSnapshot<EchoObservableState> = {
      ...base,
      state: { ...base.state, capabilities: sparse as EchoObservableState["capabilities"] },
    };
    const p = preflightTerminalProjection(body(snap));
    expect(p.body.finalSnapshot?.state.capabilities.map((c) => c.id)).toEqual(["a"]);
    expect(p.omittedCapabilitySummaries).toBe(2);
    expect(p.projectionGaps).toEqual(["run.final_snapshot.capabilities"]);
  });

  test("capability id getter 第一次 \"safe\"、之后 123：落盘的是物化副本，不会变成非法类型", () => {
    let reads = 0;
    const flip = {
      get id(): unknown {
        reads += 1;
        return reads === 1 ? "safe" : 123;
      },
      digest: "d",
      summary: summary(0),
    };
    const base = snapshotWith([]);
    const snap: ObservationSnapshot<EchoObservableState> = {
      ...base,
      state: { ...base.state, capabilities: [flip] as unknown as EchoObservableState["capabilities"] },
    };
    const p = preflightTerminalProjection(body(snap));
    const caps = p.body.finalSnapshot!.state.capabilities;
    // 之前验完仍 push 原对象，最终落盘 capabilities[0].id === 123 且 projectionGaps === []
    expect(caps[0]!.id).toBe("safe");
    expect(caps[0]!.id).toBe("safe"); // 再读也不变：快照没有 getter
    expect(typeof JSON.parse(JSON.stringify(caps))[0].id).toBe("string");
  });

  test("投影结果是冻结的 plain data，且不持有原对象引用", () => {
    const src = { id: "a", digest: "d", summary: summary(0) };
    const base = snapshotWith([]);
    const snap: ObservationSnapshot<EchoObservableState> = {
      ...base,
      state: { ...base.state, capabilities: [src] as unknown as EchoObservableState["capabilities"] },
    };
    const p = preflightTerminalProjection(body(snap));
    const entry = p.body.finalSnapshot!.state.capabilities[0]!;
    expect(entry).not.toBe(src);
    expect(entry.summary).not.toBe(src.summary);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.summary)).toBe(true);
  });

  test("finishReason getter 第一次 \"ok\"、之后 257 字节：物化后的 body 不会留下超限值", () => {
    let reads = 0;
    const outcome = {
      status: "completed" as const,
      get finishReason(): string {
        reads += 1;
        return reads === 1 ? "ok" : "r".repeat(OBSERVATION_BOUNDARY_LIMITS.maxSafeStringBytes + 1);
      },
    };
    const p = preflightTerminalProjection({ outcome, finalSnapshot: null });
    // 之前 check 后重读原对象，body 里会留下 257 字节的值
    expect(p.body.outcome.finishReason).toBe("ok");
    expect(p.body.outcome.finishReason).toBe("ok");
    expect(JSON.parse(JSON.stringify(p.body.outcome)).finishReason).toBe("ok");
    expect(Object.isFrozen(p.body.outcome)).toBe(true);
  });

  test("outcome 的其余字段也验形：status 枚举 / outputBytes 计数 / digest 是串", () => {
    const bad = (o: unknown): (() => unknown) => () => preflightTerminalProjection({ outcome: o as never, finalSnapshot: null });
    expect(bad({ status: "banana" })).toThrow(ObservationEncodingError);
    expect(bad({ status: "completed", outputBytes: -1 })).toThrow(ObservationEncodingError);
    expect(bad({ status: "completed", outputBytes: 1.5 })).toThrow(ObservationEncodingError);
    expect(bad({ status: "completed", outputDigest: 42 })).toThrow(ObservationEncodingError);
    expect(bad(null)).toThrow(ObservationEncodingError);
  });

  test("runtime 枚举按白名单验：banana / kumquat / papaya 都让整份 snapshot 降级", () => {
    const base = snapshotWith([{ id: "a", summary: summary(0) }]);
    const cases: Record<string, unknown>[] = [
      { phase: "banana" },
      { status: "kumquat" },
      { observationPersistence: "papaya" },
    ];
    for (const patch of cases) {
      const snap: ObservationSnapshot<EchoObservableState> = {
        ...base,
        state: { ...base.state, runtime: { ...base.state.runtime, ...patch } as EchoObservableState["runtime"] },
      };
      const p = preflightTerminalProjection(body(snap));
      expect(p.body.finalSnapshot).toBeNull();
      expect(p.projectionGaps).toEqual(["run.final_snapshot"]);
    }
    // 合法枚举照常投影
    expect(preflightTerminalProjection(body(base)).body.finalSnapshot).not.toBeNull();
  });

  test("capabilities.length 检查时 1,024、循环时 1,025：扫描上限绕不过", () => {
    const items = Array.from({ length: OBSERVATION_BOUNDARY_LIMITS.maxCapabilityScan + 1 }, (_, i) => ({
      id: `c${String(i).padStart(5, "0")}`,
      digest: "x",
      summary: summary(i),
    }));
    let n = 0;
    const flip = new Proxy(items, {
      get(t, k, r): unknown {
        if (k === "length") {
          n += 1;
          return n === 1 ? OBSERVATION_BOUNDARY_LIMITS.maxCapabilityScan : items.length;
        }
        return Reflect.get(t, k, r);
      },
    });
    const base = snapshotWith([]);
    const snap: ObservationSnapshot<EchoObservableState> = {
      ...base,
      state: { ...base.state, capabilities: flip as unknown as EchoObservableState["capabilities"] },
    };
    const p = preflightTerminalProjection(body(snap));
    // length 只读一次 ⇒ 用的是第一次那个值，循环不会跑到 1,025
    expect(p.body.finalSnapshot?.state.capabilities.length).toBe(OBSERVATION_BOUNDARY_LIMITS.maxCapabilitySummaries);
  });

  test("counters / flags 是非法容器时省略整条 summary 并开 gap，不是留下空字典", () => {
    const base = snapshotWith([]);
    const withCounters = (counters: unknown, flags?: unknown): ObservationSnapshot<EchoObservableState> => ({
      ...base,
      state: {
        ...base.state,
        capabilities: [
          { id: "a", digest: "d", summary: { ...summary(0), counters, ...(flags === undefined ? {} : { flags }) } },
        ] as unknown as EchoObservableState["capabilities"],
      },
    });
    // 之前 `new Map([["writes",1]])` 被保留成 counters:{}，omitted 仍是 0、projectionGaps 空
    for (const bad of [new Map([["writes", 1]]), new Set([1]), [1, 2], new Date(0)]) {
      const p = preflightTerminalProjection(body(withCounters(bad)));
      expect(p.body.finalSnapshot?.state.capabilities).toHaveLength(0);
      expect(p.omittedCapabilitySummaries).toBe(1);
      expect(p.projectionGaps).toEqual(["run.final_snapshot.capabilities"]);
    }
    // flags 同款
    const pf = preflightTerminalProjection(body(withCounters({ n: 1 }, new Map([["on", true]]))));
    expect(pf.omittedCapabilitySummaries).toBe(1);
    expect(pf.projectionGaps).toEqual(["run.final_snapshot.capabilities"]);
  });

  test("counters 含 symbol 键 / accessor 也省略整条 summary，不静默删该键", () => {
    const base = snapshotWith([]);
    const withSymbol = { n: 1 } as Record<string, number>;
    (withSymbol as unknown as Record<symbol, number>)[Symbol("s")] = 2;
    const acc = {};
    Object.defineProperty(acc, "n", { get: () => 1, enumerable: true, configurable: true });
    for (const counters of [withSymbol, acc]) {
      const snap: ObservationSnapshot<EchoObservableState> = {
        ...base,
        state: {
          ...base.state,
          capabilities: [{ id: "a", digest: "d", summary: { ...summary(0), counters } }] as unknown as EchoObservableState["capabilities"],
        },
      };
      const p = preflightTerminalProjection(body(snap));
      expect(p.omittedCapabilitySummaries).toBe(1);
      expect(p.projectionGaps).toEqual(["run.final_snapshot.capabilities"]);
    }
  });

  test("counters 里的 __proto__ 是普通字段，不改物化对象的原型", () => {
    const counters = JSON.parse('{"__proto__":1,"n":2}') as Record<string, number>;
    const base = snapshotWith([]);
    const snap: ObservationSnapshot<EchoObservableState> = {
      ...base,
      state: {
        ...base.state,
        capabilities: [{ id: "a", digest: "d", summary: summary(0, { counters }) }] as unknown as EchoObservableState["capabilities"],
      },
    };
    const p = preflightTerminalProjection(body(snap));
    const kept = p.body.finalSnapshot!.state.capabilities[0]!.summary.counters;
    expect(Object.prototype.hasOwnProperty.call(kept, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  });

  test("整个 body 超 boundary 预算 → finalSnapshot:null + run.final_snapshot gap；required body 仍合法", () => {
    const huge = snapshotWith(caps(2), "s".repeat(OBSERVATION_BOUNDARY_LIMITS.maxCanonicalBoundaryBytes));
    const p = preflightTerminalProjection(body(huge));
    expect(p.body.finalSnapshot).toBeNull();
    expect(p.projectionGaps).toEqual(["run.final_snapshot"]);
    expect(p.body.outcome).toEqual({ status: "completed" });
  });

  test("capabilities 容器损坏（null / 非数组）→ 整份丢掉 + run.final_snapshot gap，不抛", () => {
    const base = snapshotWith([{ id: "a", summary: summary(0) }]);
    for (const broken of [null, 42, { not: "array" }, "caps"]) {
      const snap: ObservationSnapshot<EchoObservableState> = {
        ...base,
        state: { ...base.state, capabilities: broken as unknown as EchoObservableState["capabilities"] },
      };
      let p!: ReturnType<typeof preflightTerminalProjection>;
      expect(() => {
        p = preflightTerminalProjection(body(snap));
      }).not.toThrow();
      expect(p.body.finalSnapshot).toBeNull();
      expect(p.projectionGaps).toEqual(["run.final_snapshot"]);
    }
  });

  test("omittedCapabilitySummaryCount 不是合法计数 → 同样整份丢掉", () => {
    const base = snapshotWith([{ id: "a", summary: summary(0) }]);
    for (const bad of [-1, 1.5, NaN, "3", null]) {
      const snap: ObservationSnapshot<EchoObservableState> = {
        ...base,
        state: { ...base.state, omittedCapabilitySummaryCount: bad as unknown as number },
      };
      const p = preflightTerminalProjection(body(snap));
      expect(p.body.finalSnapshot).toBeNull();
      expect(p.projectionGaps).toEqual(["run.final_snapshot"]);
    }
  });

  test("超扫描上限的巨型稀疏数组：整份丢掉且不逐下标扫（可选投影不值得让封口等）", () => {
    const base = snapshotWith([]);
    const huge: unknown[] = [];
    huge.length = 5_000_000;
    const snap: ObservationSnapshot<EchoObservableState> = {
      ...base,
      state: { ...base.state, capabilities: huge as EchoObservableState["capabilities"] },
    };
    const t0 = performance.now();
    const p = preflightTerminalProjection(body(snap));
    const elapsed = performance.now() - t0;
    expect(p.body.finalSnapshot).toBeNull();
    expect(p.projectionGaps).toEqual(["run.final_snapshot"]);
    expect(elapsed).toBeLessThan(20); // 之前逐下标扫，实测约 79ms
  });

  test("刚好命中扫描上限仍正常投影，超一个就整份丢", () => {
    const base = snapshotWith([]);
    const mk = (n: number): ObservationSnapshot<EchoObservableState> => {
      const arr = Array.from({ length: n }, (_, i) => ({ id: `c${String(i).padStart(5, "0")}`, digest: "x", summary: summary(i) }));
      return { ...base, state: { ...base.state, capabilities: arr as EchoObservableState["capabilities"] } };
    };
    const exact = preflightTerminalProjection(body(mk(OBSERVATION_BOUNDARY_LIMITS.maxCapabilityScan)));
    expect(exact.body.finalSnapshot).not.toBeNull();
    expect(exact.projectionGaps).toEqual(["run.final_snapshot.capabilities"]); // 只留 32 条，其余记省略
    const over = preflightTerminalProjection(body(mk(OBSERVATION_BOUNDARY_LIMITS.maxCapabilityScan + 1)));
    expect(over.body.finalSnapshot).toBeNull();
    expect(over.projectionGaps).toEqual(["run.final_snapshot"]);
  });

  test("finishReason / errorCode 超 maxSafeStringBytes → required safe body 非法，抛 ObservationEncodingError，不截断", () => {
    const long = "r".repeat(OBSERVATION_BOUNDARY_LIMITS.maxSafeStringBytes + 1);
    try {
      preflightTerminalProjection(body(null, { status: "error", finishReason: long }));
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObservationEncodingError);
      expect((e as ObservationEncodingError).path).toBe("$.outcome.finishReason");
    }
    expect(() => preflightTerminalProjection(body(null, { status: "error", errorCode: long }))).toThrow(ObservationEncodingError);
    // 刚好命中不算超
    expect(() => preflightTerminalProjection(body(null, { status: "completed", finishReason: "r".repeat(OBSERVATION_BOUNDARY_LIMITS.maxSafeStringBytes) }))).not.toThrow();
  });
});
