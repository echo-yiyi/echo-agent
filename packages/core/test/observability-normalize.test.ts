import { test, expect, describe } from "bun:test";
import {
  ObservationEncodingError,
  boundaryEncodingLimits,
  canonicalJson,
  canonicalJsonBytes,
  encodeCanonical,
  MAX_BIGINT_DIGITS,
  MAX_STACK_DIGEST_INPUT,
  normalizeObservationValue,
  readExactPlainDict,
  syncEncodingLimits,
} from "../src/observability/normalize.ts";
import { sha256Hex } from "../src/observability/hash.ts";
import { OBSERVATION_SYNC_LIMITS } from "../src/observability/types.ts";

// §15.4.1：唯一 normalize。每条规则一个测试；上限用「刚好命中 / 超一单位」两个 fixture 锁边界（§15.4.2）。

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ObservationEncodingError) return e.code;
    throw e;
  }
  throw new Error("expected ObservationEncodingError");
}

describe("归一规则", () => {
  test("标量原样；-0 归一为 0；bigint 变带 tag 的十进制字符串", () => {
    expect(normalizeObservationValue({ a: 1, b: "x", c: true, d: null }).value).toEqual({ a: 1, b: "x", c: true, d: null });
    expect(normalizeObservationValue(-0).value).toBe(0);
    expect(Object.is(normalizeObservationValue(-0).value, -0)).toBe(false);
    expect(normalizeObservationValue(123n).value).toBe("bigint:123");
    expect(normalizeObservationValue(-9007199254740993n).value).toBe("bigint:-9007199254740993");
  });

  test("Error → ObservationError（name/message/code/stackDigest），不带 stack 正文", () => {
    const err = Object.assign(new RangeError("boom"), { code: "E_BOOM" });
    const v = normalizeObservationValue({ err }).value as { err: Record<string, unknown> };
    expect(v.err.name).toBe("RangeError");
    expect(v.err.message).toBe("boom");
    expect(v.err.code).toBe("E_BOOM");
    expect(typeof v.err.stackDigest).toBe("string");
    expect(v.err.stackDigest).toBe(sha256Hex(err.stack ?? ""));
    expect("stack" in v.err).toBe(false);
  });

  test("二进制 → BlobRef{digest,size} 并暂存 bytes；producer 之后改 buffer 不影响暂存副本", () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const n = normalizeObservationValue({ img: buf });
    const digest = sha256Hex(new Uint8Array([1, 2, 3, 4]));
    expect(n.value).toEqual({ img: { digest, size: 4 } });
    expect(n.blobs).toHaveLength(1);
    expect(n.blobs[0]?.digest).toBe(digest);
    buf[0] = 99;
    expect(n.blobs[0]?.bytes[0]).toBe(1);
  });

  test("ArrayBuffer 与带 offset 的 view 都按其可见字节取 blob", () => {
    const backing = new Uint8Array([9, 9, 7, 8]).buffer;
    const view = new Uint8Array(backing, 2, 2);
    const n = normalizeObservationValue(view);
    expect((n.value as { size: number }).size).toBe(2);
    expect(n.blobs[0]?.bytes).toEqual(new Uint8Array([7, 8]));
    expect((normalizeObservationValue(backing).value as { size: number }).size).toBe(4);
  });
});

describe("拒绝而不是静默删字段", () => {
  test("NaN / ±Infinity", () => {
    expect(codeOf(() => normalizeObservationValue(NaN))).toBe("non_finite_number");
    expect(codeOf(() => normalizeObservationValue({ a: [Infinity] }))).toBe("non_finite_number");
    expect(codeOf(() => normalizeObservationValue(-Infinity))).toBe("non_finite_number");
  });

  test("undefined 值、稀疏数组洞——JSON.stringify 会静默丢，这里必须红", () => {
    expect(codeOf(() => normalizeObservationValue({ a: undefined }))).toBe("undefined_value");
    expect(codeOf(() => normalizeObservationValue(undefined))).toBe("undefined_value");
    const sparse: unknown[] = [];
    sparse[2] = 1;
    expect(codeOf(() => normalizeObservationValue(sparse))).toBe("undefined_value");
  });

  test("function / symbol 值、symbol key", () => {
    expect(codeOf(() => normalizeObservationValue({ f: () => 1 }))).toBe("unsupported_value");
    expect(codeOf(() => normalizeObservationValue(Symbol("s")))).toBe("unsupported_value");
    expect(codeOf(() => normalizeObservationValue({ [Symbol("k")]: 1, a: 1 }))).toBe("symbol_key");
  });

  test("Map / Set / Date / 自定义 class 实例", () => {
    expect(codeOf(() => normalizeObservationValue(new Map([["a", 1]])))).toBe("unsupported_value");
    expect(codeOf(() => normalizeObservationValue(new Set([1])))).toBe("unsupported_value");
    expect(codeOf(() => normalizeObservationValue({ when: new Date(0) }))).toBe("unsupported_value");
    class Foo {
      x = 1;
    }
    expect(codeOf(() => normalizeObservationValue(new Foo()))).toBe("unsupported_value");
  });

  test("循环引用；共享引用（DAG）不算循环", () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    expect(codeOf(() => normalizeObservationValue(a))).toBe("cycle");
    const shared = { k: 1 };
    expect(normalizeObservationValue({ x: shared, y: shared }).value).toEqual({ x: { k: 1 }, y: { k: 1 } });
  });

  test("accessor 属性一律拒（不管 getter 抛不抛）——body 与 attributes / counters 共用同一把尺", () => {
    const throwing = {
      get bad(): number {
        throw new Error("no");
      },
    };
    expect(codeOf(() => normalizeObservationValue(throwing))).toBe("unsupported_value");
    // 不抛的 accessor 同样拒：之前它会被**执行**，返回值直接进 canonical body 且不产生 gap
    let called = false;
    const quiet = {
      get sneaky(): number {
        called = true;
        return 1;
      },
    };
    expect(codeOf(() => normalizeObservationValue(quiet))).toBe("unsupported_value");
    expect(called).toBe(false);
  });

  test("non-enumerable 字段不再被静默丢——整个对象判红", () => {
    const o = { visible: 1 };
    Object.defineProperty(o, "secret", { value: "payload", enumerable: false, configurable: true });
    // 之前静默变成 {visible:1}，没有任何 gap
    expect(codeOf(() => normalizeObservationValue(o))).toBe("unsupported_value");
  });

  test("data 属性的 get trap 根本不会被调用——值取自 descriptor（2026-08-27 反转）", () => {
    // 原来这条断言的是「get trap 抛错归 getter_threw」，那说明 body 还在回读原容器。
    // 现在 body 只读 descriptor 快照，trap 没有被执行的机会，抛不抛都一样。
    let calls = 0;
    const trapped = new Proxy(
      { a: 1 },
      {
        get(t, k, r): unknown {
          calls += 1;
          if (k === "a") throw new Error("trap boom");
          return Reflect.get(t, k, r);
        },
      },
    );
    expect(normalizeObservationValue(trapped).value).toEqual({ a: 1 });
    expect(calls).toBe(0);
  });

  test("getPrototypeOf trap 抛错也收敛成 EncodingError，producer 的正文不外泄", () => {
    const trapped = new Proxy(
      { a: 1 },
      {
        getPrototypeOf(): never {
          throw new Error("producer secret");
        },
      },
    );
    try {
      normalizeObservationValue(trapped);
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObservationEncodingError);
      expect((e as Error).message).not.toContain("producer secret");
    }
    // encodeCanonical 同一条契约
    try {
      encodeCanonical(trapped);
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObservationEncodingError);
    }
  });

  test("Error.message 非字符串时不调它的 toString()——只记类型名", () => {
    let called = false;
    const err = new Error("x");
    Object.defineProperty(err, "message", {
      value: {
        toString(): string {
          called = true;
          throw new Error("message secret");
        },
      },
    });
    const v = normalizeObservationValue({ e: err }).value as { e: Record<string, unknown> };
    expect(called).toBe(false);
    expect(v.e.message).toBe("[object]");
    expect(JSON.stringify(v)).not.toContain("message secret");
  });

  test("只抛 ObservationEncodingError，带 path", () => {
    try {
      normalizeObservationValue({ a: [{ b: NaN }] });
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObservationEncodingError);
      expect((e as ObservationEncodingError).path).toBe("$.a[0].b");
    }
  });
});

describe("__proto__ 不被静默吞掉，也改不了输出原型", () => {
  test("own __proto__ 作为普通字段保留，输出对象原型不变", () => {
    const src = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(src, "__proto__")).toBe(true);
    const v = normalizeObservationValue(src).value as Record<string, unknown>;
    // 之前 `out[key] = v` 会触发原型 setter：字段消失、原型被改、还不产生任何 gap
    expect(Object.prototype.hasOwnProperty.call(v, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect((v as { polluted?: unknown }).polluted).toBeUndefined();
    expect(canonicalJson(v as never)).toBe('{"__proto__":{"polluted":true},"a":1}');
  });

  test("round-trip 后 __proto__ 仍在，且没有污染全局原型", () => {
    const src = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
    const bytes = canonicalJsonBytes(normalizeObservationValue(src).value);
    const back = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(back, "__proto__")).toBe(true);
    expect(({} as { x?: unknown }).x).toBeUndefined();
  });
});

describe("数组按 sealed JSON-like 容器验形", () => {
  test("数组上的额外字符串键 / symbol 键一律拒，不静默丢", () => {
    const withExtra: unknown[] = [1, 2];
    (withExtra as unknown as Record<string, unknown>).sneaky = "payload";
    expect(codeOf(() => normalizeObservationValue(withExtra))).toBe("unsupported_value");
    const withSymbol: unknown[] = [1];
    (withSymbol as unknown as Record<symbol, unknown>)[Symbol("s")] = 1;
    expect(codeOf(() => normalizeObservationValue(withSymbol))).toBe("symbol_key");
  });

  test("accessor 下标 / non-enumerable 下标被拒", () => {
    const acc: unknown[] = [];
    Object.defineProperty(acc, "0", { get: () => 1, enumerable: true, configurable: true });
    Object.defineProperty(acc, "length", { value: 1, writable: true });
    expect(codeOf(() => normalizeObservationValue(acc))).toBe("unsupported_value");
    const hidden = [1, 2];
    Object.defineProperty(hidden, "1", { value: 2, enumerable: false, configurable: true, writable: true });
    expect(codeOf(() => normalizeObservationValue(hidden))).toBe("unsupported_value");
  });

  test("Array 子类被拒（只认 plain array）", () => {
    class MyArr extends Array {}
    const sub = MyArr.from([1, 2]);
    expect(codeOf(() => normalizeObservationValue(sub))).toBe("unsupported_value");
  });

  test("length 只读一次：Proxy 返回 0 也不会把非空数组规范化成 []", () => {
    const items = [1, 2, 3];
    let n = 0;
    const flip = new Proxy(items, {
      get(t, k, r): unknown {
        if (k === "length") {
          n += 1;
          return n === 1 ? 0 : 3; // 第一次骗成空数组
        }
        return Reflect.get(t, k, r);
      },
    });
    // length=0 与 ownKeys 里的下标 0/1/2 对不上 ⇒ 判为额外属性，绝不静默产出 []
    expect(codeOf(() => normalizeObservationValue(flip))).toBe("unsupported_value");
  });

  test("合法数组照常物化，且结果与源无别名", () => {
    const src = [1, [2, 3], { a: 4 }];
    const v = normalizeObservationValue(src).value as unknown[];
    expect(v).toEqual([1, [2, 3], { a: 4 }]);
    expect(v).not.toBe(src);
    expect(v[1]).not.toBe(src[1]);
  });
});

describe("readExactPlainDict：非法容器不许被洗成合法空字典", () => {
  test("Map / Set / class 实例 / null 原型之外的对象一律拒，而不是得到空字典", () => {
    for (const bad of [new Map([["k", 1]]), new Set([1]), new Date(0), [1, 2], null, 42, "s"]) {
      const r = readExactPlainDict(bad, 32);
      expect(r.ok).toBe(false);
    }
    class Foo {
      x = 1;
    }
    expect(readExactPlainDict(new Foo(), 32).ok).toBe(false);
  });

  test("symbol 键 / accessor / non-enumerable 都拒，不静默丢", () => {
    const sym = { a: 1 } as Record<string, unknown>;
    (sym as unknown as Record<symbol, unknown>)[Symbol("s")] = 2;
    expect(readExactPlainDict(sym, 32).ok).toBe(false);
    const acc = {};
    Object.defineProperty(acc, "a", { get: () => 1, enumerable: true, configurable: true });
    expect(readExactPlainDict(acc, 32).ok).toBe(false);
    const hidden = {};
    Object.defineProperty(hidden, "a", { value: 1, enumerable: false, configurable: true });
    expect(readExactPlainDict(hidden, 32).ok).toBe(false);
  });

  test("plain object 与 null 原型对象通过；键数超限拒", () => {
    expect(readExactPlainDict({ a: 1, b: 2 }, 32).ok).toBe(true);
    expect(readExactPlainDict(Object.assign(Object.create(null), { a: 1 }), 32).ok).toBe(true);
    expect(readExactPlainDict({ a: 1, b: 2 }, 1).ok).toBe(false);
  });
});

describe("同步工作量也有界，不只是结果有界", () => {
  test("远超上限的数组：在 Reflect.ownKeys 之前就拒——trap 调用次数为 0", () => {
    let ownKeysCalls = 0;
    let getCalls = 0;
    const huge = new Proxy([] as unknown[], {
      get(t, k, r): unknown {
        if (k === "length") return 2_000_000;
        getCalls += 1;
        return Reflect.get(t, k, r);
      },
      ownKeys(t): ArrayLike<string | symbol> {
        ownKeysCalls += 1;
        return Reflect.ownKeys(t);
      },
    });
    expect(codeOf(() => normalizeObservationValue(huge))).toBe("nodes_exceeded");
    // 之前先跑完整 ownKeys + 逐键 descriptor，2,000,000 项实测约 678ms
    expect(ownKeysCalls).toBe(0);
    expect(getCalls).toBe(0);
  });

  test("远超上限的对象：排序与递归之前就拒，不逐键走一遍", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < OBSERVATION_SYNC_LIMITS.maxValueNodes + 10; i++) many[`k${i}`] = i;
    let reads = 0;
    const watched = new Proxy(many, {
      get(t, k, r): unknown {
        reads += 1;
        return Reflect.get(t, k, r);
      },
    });
    expect(codeOf(() => normalizeObservationValue(watched))).toBe("nodes_exceeded");
    expect(reads).toBe(0); // 一个值都没读
  });

  test("ownKeys trap 抛普通 Error 也只变成 ObservationEncodingError，不甩给调用方", () => {
    const hostile = new Proxy([1, 2] as unknown[], {
      ownKeys(): ArrayLike<string | symbol> {
        throw new Error("trap boom");
      },
    });
    expect(codeOf(() => normalizeObservationValue(hostile))).toBe("getter_threw");
  });

  test("超大字符串在 JSON.stringify 之前就拒，不先造完整转义串与 buffer", () => {
    const limits = { maxBytes: 1_024, maxValueDepth: 8, maxValueNodes: 64, maxBlobChunkBytes: 0 };
    const big = "x".repeat(50_000_000); // 单串就远超预算
    expect(codeOf(() => encodeCanonical(big, limits))).toBe("bytes_exceeded");
    // 嵌在对象里也一样：写到该字段时立刻停
    expect(codeOf(() => encodeCanonical({ a: 1, b: big }, limits))).toBe("bytes_exceeded");
  });

  test("bigint 先按位数拒，再转十进制", () => {
    const ok = 10n ** BigInt(MAX_BIGINT_DIGITS - 1);
    expect(normalizeObservationValue(ok).value).toBe(`bigint:${ok.toString(10)}`);
    const over = 10n ** BigInt(MAX_BIGINT_DIGITS);
    expect(codeOf(() => normalizeObservationValue(over))).toBe("bytes_exceeded");
    expect(codeOf(() => normalizeObservationValue(-over))).toBe("bytes_exceeded");
  });

  test("封顶写出的字节与未封顶序列化逐字节一致（正常路径不受影响）", () => {
    const v = normalizeObservationValue({ z: [1, "two", { c: null }], a: false }).value;
    expect(encodeCanonical(v).bytes).toEqual(canonicalJsonBytes(v));
  });
});

describe("canonical 序列化", () => {
  test("key 按 code unit 排序，嵌套同样；数组保序", () => {
    expect(canonicalJson({ b: 1, a: { z: [3, 1], y: "q" } })).toBe('{"a":{"y":"q","z":[3,1]},"b":1}');
    // "Z"(0x5A) < "a"(0x61) < "é"(0xE9)：按 code unit，不按 locale
    expect(canonicalJson({ é: 1, a: 2, Z: 3 })).toBe('{"Z":3,"a":2,"é":1}');
  });

  test("字符串 / 数字转义走 JSON.stringify 的确定性规则", () => {
    expect(canonicalJson('a"b\n ')).toBe(JSON.stringify('a"b\n '));
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson(0.1 + 0.2)).toBe("0.30000000000000004");
  });

  test("round-trip 后再序列化字节相同", () => {
    const v = normalizeObservationValue({ z: [1, "two", { c: null, a: false }], é: -0, big: 10n }).value;
    const bytes = canonicalJsonBytes(v);
    const again = canonicalJsonBytes(JSON.parse(new TextDecoder().decode(bytes)) as never);
    expect(again).toEqual(bytes);
  });
});

describe("同步预算：刚好命中 / 超一单位", () => {
  test("bytes：64 KiB 正好通过，+1 字节 bytes_exceeded", () => {
    // canonical 形式是 `"` + s + `"`，ASCII 每字符 1 字节
    const exact = "a".repeat(OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes - 2);
    expect(encodeCanonical(exact).bytes.byteLength).toBe(OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes);
    expect(codeOf(() => encodeCanonical(`${exact}a`))).toBe("bytes_exceeded");
  });

  test("depth：32 层通过，33 层 depth_exceeded", () => {
    const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)]);
    expect(normalizeObservationValue(nest(OBSERVATION_SYNC_LIMITS.maxValueDepth)).depth).toBe(OBSERVATION_SYNC_LIMITS.maxValueDepth);
    expect(codeOf(() => normalizeObservationValue(nest(OBSERVATION_SYNC_LIMITS.maxValueDepth + 1)))).toBe("depth_exceeded");
  });

  test("nodes：4096 个节点通过（根数组 + 4095 标量），4097 nodes_exceeded", () => {
    const ok = new Array<number>(OBSERVATION_SYNC_LIMITS.maxValueNodes - 1).fill(0);
    expect(normalizeObservationValue(ok).nodes).toBe(OBSERVATION_SYNC_LIMITS.maxValueNodes);
    expect(codeOf(() => normalizeObservationValue([...ok, 0]))).toBe("nodes_exceeded");
  });

  test("blob chunk：1 MiB 通过，+1 字节 blob_chunk_exceeded", () => {
    const max = OBSERVATION_SYNC_LIMITS.maxBlobChunkBytes;
    expect((normalizeObservationValue(new Uint8Array(max)).value as { size: number }).size).toBe(max);
    expect(codeOf(() => normalizeObservationValue(new Uint8Array(max + 1)))).toBe("blob_chunk_exceeded");
  });

  test("boundary 上限更紧：depth 16/17、nodes 2048/2049，且不允许任何 blob", () => {
    const b = boundaryEncodingLimits();
    const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)]);
    expect(normalizeObservationValue(nest(16), b).depth).toBe(16);
    expect(codeOf(() => normalizeObservationValue(nest(17), b))).toBe("depth_exceeded");
    expect(normalizeObservationValue(new Array<number>(2047).fill(0), b).nodes).toBe(2048);
    expect(codeOf(() => normalizeObservationValue(new Array<number>(2048).fill(0), b))).toBe("nodes_exceeded");
    expect(codeOf(() => normalizeObservationValue(new Uint8Array(1), b))).toBe("blob_chunk_exceeded");
    expect(syncEncodingLimits().maxBlobChunkBytes).toBeGreaterThan(0);
  });
});

describe("stackDigest 的同步工作量也有上限（2026-08-27 review P1）", () => {
  const withStack = (stack: string): Error => Object.assign(new Error("boom"), { stack });
  const digestOf = (e: Error): Record<string, unknown> => (normalizeObservationValue({ err: e }).value as { err: Record<string, unknown> }).err;

  test("不超上限：digest 覆盖完整 stack，不标 truncated", () => {
    const stack = "s".repeat(MAX_STACK_DIGEST_INPUT);
    const d = digestOf(withStack(stack));
    expect(d.stackDigest).toBe(sha256Hex(stack));
    expect(d.stackTruncated).toBeUndefined();
    expect(d.stackChars).toBeUndefined();
  });

  test("超一个 code unit：改成有界前缀 digest，并显式标 stackTruncated + 原长", () => {
    const stack = "s".repeat(MAX_STACK_DIGEST_INPUT + 1);
    const d = digestOf(withStack(stack));
    expect(d.stackDigest).toBe(sha256Hex("s".repeat(MAX_STACK_DIGEST_INPUT)));
    expect(d.stackTruncated).toBe(true);
    expect(d.stackChars).toBe(MAX_STACK_DIGEST_INPUT + 1);
  });

  test("review 复现：5 MB stack 也只 hash 有界前缀，且 digest 不再冒充完整 stack 的指纹", () => {
    // 修复前：1 MB / 5 MB 的 stack 都能生成一条合法的一百多字节 canonical record，
    // 64 KiB 上限完全没约束到 sha256 的输入。
    const prefix = "p".repeat(MAX_STACK_DIGEST_INPUT);
    const a = digestOf(withStack(prefix + "a".repeat(5 * 1024 * 1024)));
    const b = digestOf(withStack(prefix + "b".repeat(1 * 1024 * 1024)));
    expect(a.stackDigest).toBe(b.stackDigest); // 前缀相同 → digest 相同
    expect(a.stackTruncated).toBe(true);
    expect(b.stackTruncated).toBe(true);
    expect(a.stackChars).not.toBe(b.stackChars); // 但长度不同，读者分得清这不是全量指纹
  });

  test("超长 stack 不让整条事实变成 gap：canonical 仍编得出来且很小", () => {
    const enc = encodeCanonical({ err: withStack("q".repeat(5 * 1024 * 1024)) }, syncEncodingLimits());
    expect(enc.bytes.byteLength).toBeLessThan(1_024);
  });

  test("stack 正文一个字都不进 canonical", () => {
    const enc = encodeCanonical({ err: withStack("SECRET-TOKEN-" + "z".repeat(MAX_STACK_DIGEST_INPUT * 2)) }, syncEncodingLimits());
    expect(canonicalJson(enc.value)).not.toContain("SECRET-TOKEN");
  });
});

describe("descriptor 快照是唯一取值来源（2026-08-27 review P1）", () => {
  /** descriptor 说 "safe"、get trap 说 "secret"：谁落进结果就暴露了谁被回读。 */
  function twoFaced(): { p: Record<string, unknown>; calls: () => number } {
    let calls = 0;
    const p = new Proxy(
      { x: "safe" },
      {
        getOwnPropertyDescriptor(): PropertyDescriptor {
          return { value: "safe", writable: true, enumerable: true, configurable: true };
        },
        get(): unknown {
          calls += 1;
          return "secret";
        },
      },
    );
    return { p: p as Record<string, unknown>, calls: () => calls };
  }

  test("body：canonical 里是 descriptor 的值，get trap 调用次数为 0", () => {
    // 修复前实测：encodeCanonical(proxy) → {"x":"secret"}、getCalls=1
    const a = twoFaced();
    const enc = encodeCanonical(a.p, syncEncodingLimits());
    expect(new TextDecoder().decode(enc.bytes)).toBe('{"x":"safe"}');
    expect(a.calls()).toBe(0);
  });

  test("readExactPlainDict 不再交出原容器——没有 obj 这个口子", () => {
    const r = readExactPlainDict({ a: 1 }, 8);
    expect(r.ok).toBe(true);
    expect("obj" in r).toBe(false);
    expect(r.values).toEqual({ a: 1 });
  });

  test("逐键 descriptor：后面的键 trap 抛错，不吃掉前面已物化的字段", () => {
    // 修复前：整段共用一个 try，第二个键一抛就走外层 catch，values 变成全新的空对象
    const hostile = new Proxy(
      { good: "keep", bad: "x" },
      {
        getOwnPropertyDescriptor(t, k): PropertyDescriptor | undefined {
          if (k === "bad") throw new Error("descriptor trap");
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      },
    );
    const r = readExactPlainDict(hostile, 8);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("read_failed");
    expect(r.values).toEqual({ good: "keep" }); // 好字段活着
    expect(r.reason).not.toContain("descriptor trap"); // 违规说明不回显 producer 正文
  });

  test("ownKeys 抛错才是真的什么都拿不到", () => {
    const hostile = new Proxy(
      { good: "keep" },
      {
        ownKeys(): ArrayLike<string | symbol> {
          throw new Error("ownKeys trap");
        },
      },
    );
    const r = readExactPlainDict(hostile, 8);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.values).toEqual({});
  });
});

describe("数组也只认 descriptor 快照，且归一化结果不可变（2026-08-27 review P1）", () => {
  function twoFacedArray(): { p: unknown[]; calls: () => number } {
    let calls = 0;
    const p = new Proxy(["safe"], {
      getOwnPropertyDescriptor(t, k): PropertyDescriptor | undefined {
        if (k === "0") return { value: "safe", writable: true, enumerable: true, configurable: true };
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
      get(t, k, r): unknown {
        if (k === "0") {
          calls += 1;
          return "secret";
        }
        return Reflect.get(t, k, r);
      },
    });
    return { p: p as unknown[], calls: () => calls };
  }

  test("数组下标：canonical 里是 descriptor 的值，get trap 调用次数为 0", () => {
    // 修复前实测：{"value":["secret"],"getCalls":1}——字典路径刚修掉的 TOCTOU，数组路径原样还在
    const a = twoFacedArray();
    const enc = encodeCanonical(a.p, syncEncodingLimits());
    expect(enc.value).toEqual(["safe"]);
    expect(new TextDecoder().decode(enc.bytes)).toBe('["safe"]');
    expect(a.calls()).toBe(0);
  });

  test("稀疏洞仍然判红——判据来自 ownKeys，不再回摸 hasOwnProperty", () => {
    const sparse: unknown[] = [];
    sparse[2] = 1;
    expect(codeOf(() => normalizeObservationValue(sparse))).toBe("undefined_value");
  });

  test("归一化结果是不可变快照：数组冻结、字典冻结且不可扩展", () => {
    // 修复前实测：subscriber 原地改 body 后，落盘 bytes 仍是 "safe"，
    // 第二个 subscriber 与后续 replay 却看到 "tampered"——已提交的事实面分裂
    const v = normalizeObservationValue({ list: ["safe"], nested: { k: 1 } }).value as {
      list: string[];
      nested: Record<string, number>;
    };
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.list)).toBe(true);
    expect(Object.isFrozen(v.nested)).toBe(true);
    expect(Object.isExtensible(v)).toBe(false);
    expect(() => {
      v.list[0] = "tampered";
    }).toThrow();
    expect(() => {
      (v as Record<string, unknown>).injected = "also-tampered";
    }).toThrow();
    expect(v.list[0]).toBe("safe");
  });

  test("encodeCanonical 出来的 value 同样冻结（Sequencer 把它当 envelope 发给所有 subscriber）", () => {
    const enc = encodeCanonical({ list: ["safe"] }, syncEncodingLimits());
    const value = enc.value as { list: string[] };
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
  });
});
