import { test, expect, describe } from "bun:test";
import { MAX_REDACT_HASH_INPUT, redactError, redactedLabel, toSafeError } from "../src/observability/redact.ts";
import { assertIdentifier, freezeInstrumentation, freezeOwner, materializeDynamicIdentity, materializeRecordFrame, materializeScope, ObservationIdentityError } from "../src/observability/identity.ts";
import { OBSERVATION_IDENTITY_LIMITS } from "../src/observability/types.ts";

/** 取违规说明：materialize 通过时返回 undefined。 */
function violationOf(input: unknown): string | undefined {
  const r = materializeDynamicIdentity(input);
  return r.ok ? undefined : r.violation;
}

// redaction 是隔离层的一部分：它自己抛错，等于在「观测不影响主流程」上又开一个逃逸口（review P1 实测两种输入都能穿出去）。

describe("redactError 是 total function", () => {
  test("toString 抛错的陌生对象：不抛，也**不执行**它的 toString", () => {
    let called = false;
    const hostile = {
      toString(): string {
        called = true;
        throw new Error("toString boom");
      },
    };
    const r = redactError(hostile);
    expect(called).toBe(false); // 绝不给不可信代码执行机会
    expect(r.name).toBe("Error");
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => redactedLabel(hostile)).not.toThrow();
  });

  test("message / name / stack getter 全抛的 Error：不抛，仍给出可用 digest", () => {
    const e = new Error("x");
    for (const key of ["message", "name", "stack"]) {
      Object.defineProperty(e, key, {
        get() {
          throw new Error("getter boom");
        },
      });
    }
    const r = redactError(e);
    expect(r.name).toBe("Error");
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("各类原始值与 null / undefined / symbol / function 都不抛", () => {
    for (const v of [undefined, null, 0, -0, NaN, "s", true, 10n, Symbol("s"), () => 1, {}, []]) {
      expect(() => redactError(v)).not.toThrow();
      expect(redactError(v).digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("超长 message 只取上限内的材料参与同步 hash", () => {
    const long = new Error("x".repeat(MAX_REDACT_HASH_INPUT * 4));
    const cut = new Error("x".repeat(MAX_REDACT_HASH_INPUT));
    expect(redactError(long).digest).toBe(redactError(cut).digest);
  });

  test("材料是逐段按剩余预算取前缀拼的，不是先拼完整串再切（2026-08-27 review 同类）", () => {
    // message 占掉一半预算，stack 只应贡献剩下的一半——digest 必须等于手工拼出的那份前缀
    const half = MAX_REDACT_HASH_INPUT / 2;
    const msg = "m".repeat(half);
    const e = Object.assign(new Error(msg), { stack: "s".repeat(5 * 1024 * 1024) });
    const expected = Object.assign(new Error(msg), { stack: "s".repeat(half - 1) }); // 前缀里的 "\n" 占 1
    expect(redactError(e).digest).toBe(redactError(expected).digest);
  });
});

describe("instanceof 也会被劫持", () => {
  const trapped = new Proxy(new Error("secret"), {
    getPrototypeOf(): never {
      throw new Error("prototype trap");
    },
  });

  test("带 getPrototypeOf trap 的 Proxy：redactError / redactedLabel / toSafeError 都不抛", () => {
    expect(() => redactError(trapped)).not.toThrow();
    expect(() => redactedLabel(trapped)).not.toThrow();
    // 注意别用 `expect(() => toSafeError(...)).not.toThrow()`：它**返回** Error，
    // 而 bun 会把返回的 Error 当成抛出的——先落到变量里再断言。
    let out: Error | undefined;
    expect(() => {
      out = toSafeError(trapped, "上下文");
    }).not.toThrow();
    expect(out).toBeInstanceOf(Error);
    expect(out?.message).not.toContain("secret");
  });
});

describe("name 是白名单，不是第三方说了算", () => {
  test("标准名直出；伪造名回落 Error，且不出现在标签里", () => {
    expect(redactError(new TypeError("t")).name).toBe("TypeError");
    const forged = new Error("secret");
    forged.name = "AuthorizationBearerSecret";
    const r = redactError(forged);
    expect(r.name).toBe("Error");
    expect(redactedLabel(forged)).toStartWith("Error@");
    expect(redactedLabel(forged)).not.toContain("Authorization");
  });

  test("伪造名仍折进 hash：两个只有 name 不同的错误，digest 不同", () => {
    const a = new Error("same");
    a.name = "NameA";
    const b = new Error("same");
    b.name = "NameB";
    expect(redactError(a).digest).not.toBe(redactError(b).digest);
  });
});

describe("toSafeError 永不抛", () => {
  test("陌生对象、toString 抛错的对象，都能安全变成 Error", () => {
    const hostile = {
      toString(): string {
        throw new Error("boom");
      },
    };
    const e = toSafeError(hostile, "上下文");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain("上下文");
    expect(e.message).not.toContain("boom");
    const original = new RangeError("keep me");
    expect(toSafeError(original, "上下文")).toBe(original); // 已经是 Error 就原样传
  });
});

describe("动态 identity 是结构校验，不是字节计数", () => {
  const ok = { name: "n", scope: { runId: "r" } };

  test("合法输入通过", () => {
    expect(violationOf(ok)).toBeUndefined();
    expect(materializeDynamicIdentity({ name: "n" }).ok).toBe(true);
  });

  test("非字符串身份被拒——只数字节的话 TextEncoder 会把 42 悄悄转成 \"42\"", () => {
    expect(violationOf({ name: "n", scope: { runId: 42 } })).toMatch(/scope\.runId 必须是 string，实际是 number/);
    expect(violationOf({ name: "n", subject: { kind: "k", id: 123 } })).toMatch(/subject\.id 必须是 string/);
    expect(violationOf({ name: "n", scope: { runId: null } })).toMatch(/实际是 null/);
    expect(violationOf({ name: "n", scope: { runId: { nested: 1 } } })).toMatch(/实际是 object/);
    expect(violationOf({ name: 7 })).toMatch(/name 必须是 string/);
  });

  test("空字符串身份被拒", () => {
    expect(violationOf({ name: "" })).toMatch(/name 不能为空/);
    expect(violationOf({ name: "n", scope: { runId: "" } })).toMatch(/scope\.runId 不能为空/);
    expect(violationOf({ name: "n", subject: { kind: "k", id: "" } })).toMatch(/subject\.id 不能为空/);
  });

  test("容器验形：subject / scope / correlation / links 必须是对应类型", () => {
    expect(violationOf({ name: "n", subject: "s" })).toMatch(/subject 必须是对象/);
    expect(violationOf({ name: "n", scope: [] })).toMatch(/scope 必须是对象/);
    expect(violationOf({ name: "n", correlation: 1 })).toMatch(/correlation 必须是对象/);
    expect(violationOf({ name: "n", correlation: { links: "x" } })).toMatch(/links 必须是数组/);
    expect(violationOf(null)).toMatch(/draft 必须是对象/);
  });

  test("links 逐成员验形：只数条数的话 129 字节的 runtimeId 照样落盘", () => {
    const over = "x".repeat(OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes + 1);
    expect(violationOf({ name: "n", correlation: { links: [{ runtimeId: over, recordId: "r" }] } })).toMatch(
      /links\[0\]\.runtimeId 129 字节/,
    );
    expect(violationOf({ name: "n", correlation: { links: [{ runtimeId: "rt", recordId: 5 }] } })).toMatch(
      /links\[0\]\.recordId 必须是 string/,
    );
    expect(violationOf({ name: "n", correlation: { links: [null] } })).toMatch(/links\[0\] 必须是对象/);
    const sparse: unknown[] = [];
    sparse[1] = { runtimeId: "rt", recordId: "r" };
    expect(violationOf({ name: "n", correlation: { links: sparse } })).toMatch(/links\[0\] 是稀疏洞/);
    expect(materializeDynamicIdentity({ name: "n", correlation: { links: [{ runtimeId: "rt", recordId: "r" }] } }).ok).toBe(true);
  });

  test("超条数与超字节各自报各自的原因；本函数永不抛", () => {
    const many = Array.from({ length: OBSERVATION_IDENTITY_LIMITS.maxLinks + 1 }, () => ({ runtimeId: "rt", recordId: "r" }));
    expect(violationOf({ name: "n", correlation: { links: many } })).toMatch(/条 > 上限/);
    const hostile = {
      name: "n",
      get subject(): never {
        throw new Error("getter boom");
      },
    };
    expect(() => materializeDynamicIdentity(hostile)).not.toThrow();
    expect(violationOf(hostile)).toBe("identity 读取失败");
  });

  test("identity 是固定 schema：未登记字段一律拒——否则正文能塞进身份区、绕过 capture policy", () => {
    expect(violationOf({ name: "n", scope: { secret: "memory-body" } })).toMatch(/scope 含 1 个未登记字段/);
    expect(violationOf({ name: "n", correlation: { authorization: "Bearer secret" } })).toMatch(/correlation 含 1 个未登记字段/);
    expect(violationOf({ name: "n", subject: { kind: "k", id: "i", content: "hidden" } })).toMatch(/subject 含 1 个未登记字段/);
    expect(violationOf({ name: "n", correlation: { links: [{ runtimeId: "rt", recordId: "r", extra: "x" }] } })).toMatch(
      /links\[0\] 含 1 个未登记字段/,
    );
    // 合法键集照常通过
    expect(materializeDynamicIdentity({ name: "n", scope: { runId: "r", turnId: "t" }, subject: { kind: "k", id: "i" } }).ok).toBe(true);
  });

  test("未登记字段的**键名**不进说明——它由 producer 控制，回显等于新开一条外泄通道", () => {
    const msg = violationOf({ name: "n", scope: { "Authorization-Bearer-sk-secret": "v" } })!;
    expect(msg).not.toContain("Authorization");
    expect(msg).not.toContain("sk-secret");
    expect(violationOf({ name: "n", scope: { [Symbol("s")]: 1 } })).toMatch(/含 symbol 键/);
  });

  test("违规说明不回显原值", () => {
    const secret = "sk-secret-".repeat(40);
    const msg = violationOf({ name: "n", scope: { runId: secret } })!;
    expect(msg).not.toContain("sk-secret");
  });
});

describe("校验即物化：check 与 encode 之间不留 TOCTOU 窗口", () => {
  /** 第一次读返回 first，之后返回 second——检查时装好人、编码时换内容。 */
  function twoFaced<T>(first: T, second: T): { get value(): T } {
    let n = 0;
    return {
      get value(): T {
        n += 1;
        return n === 1 ? first : second;
      },
    };
  }

  test("identity 容器里的 accessor 直接判红——比「第一次读到的值胜出」更强（2026-08-27 收严）", () => {
    const flip = twoFaced<unknown>("safe", 123);
    const r = materializeDynamicIdentity({
      name: "n",
      subject: {
        kind: "k",
        get id(): unknown {
          return flip.value;
        },
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation).toMatch(/subject 必须是 plain object/);
  });

  test("值取自 descriptor：get trap 一次都不会被执行，变脸没有窗口", () => {
    const flip = twoFaced<unknown>("safe", 123);
    let getCalls = 0;
    const hostile = new Proxy(
      { kind: "k", id: "safe" },
      {
        getOwnPropertyDescriptor(_t, k): PropertyDescriptor {
          // descriptor 里给的是第一次读到的值——这就是全流程唯一一次读取
          return { value: k === "kind" ? "k" : flip.value, writable: true, enumerable: true, configurable: true };
        },
        get(_t, k): unknown {
          getCalls += 1;
          return k === "kind" ? "k" : flip.value;
        },
      },
    );
    const r = materializeDynamicIdentity({ name: "n", subject: hostile });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(getCalls).toBe(0); // 不给不可信代码执行机会
    // 再读几次也不会变：快照是 plain data，没有 getter，也不会回头碰那个 Proxy
    expect(r.identity.subject?.id).toBe("safe");
    expect(r.identity.subject?.id).toBe("safe");
    expect(JSON.parse(JSON.stringify(r.identity.subject)).id).toBe("safe");
  });

  test("getOwnPropertyDescriptor trap 抛错：整份容器判红，不抛出到调用方", () => {
    const hostile = new Proxy(
      { kind: "k", id: "i" },
      {
        getOwnPropertyDescriptor(): never {
          throw new Error("descriptor trap");
        },
      },
    );
    let r: ReturnType<typeof materializeDynamicIdentity> | undefined;
    expect(() => {
      r = materializeDynamicIdentity({ name: "n", subject: hostile });
    }).not.toThrow();
    expect(r?.ok).toBe(false);
    if (r?.ok !== false) return;
    expect(r.violation).toMatch(/subject 必须是 plain object/);
    expect(r.violation).not.toContain("descriptor trap"); // 违规说明不回显 producer 正文
  });

  test("ownKeys 永远只露 kind/id、但对象上真有 content：白名单取值使它进不了快照", () => {
    const target = { kind: "k", id: "i", content: "private-memory-body" };
    const hidden = new Proxy(target, {
      ownKeys(): ArrayLike<string | symbol> {
        return ["kind", "id"]; // 键集检查看不到 content
      },
      getOwnPropertyDescriptor(t, k): PropertyDescriptor | undefined {
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    const r = materializeDynamicIdentity({ name: "n", subject: hidden });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 输出只按白名单构造，藏起来的键无论何时暴露都进不来
    expect(Object.keys(r.identity.subject!).sort()).toEqual(["id", "kind"]);
    expect(JSON.stringify(r.identity)).not.toContain("private-memory-body");
  });

  test("ownKeys 前后不一致（检查时藏、之后露）：直接判违规，正文同样进不来", () => {
    let calls = 0;
    const flipping = new Proxy(
      { kind: "k", id: "i", content: "private-memory-body" },
      {
        ownKeys(t): ArrayLike<string | symbol> {
          calls += 1;
          return calls === 1 ? ["kind", "id"] : Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor(t, k): PropertyDescriptor | undefined {
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      },
    );
    const r = materializeDynamicIdentity({ name: "n", subject: flipping });
    // 无论被判违规还是被物化，正文都不会出现
    expect(JSON.stringify(r)).not.toContain("private-memory-body");
  });

  test("快照是冻结的 plain data：改不动，也不含原对象引用", () => {
    const source = { name: "n", scope: { runId: "r" }, subject: { kind: "k", id: "i" } };
    const r = materializeDynamicIdentity(source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.identity)).toBe(true);
    expect(Object.isFrozen(r.identity.subject)).toBe(true);
    expect(r.identity.subject).not.toBe(source.subject);
    expect(r.identity.scope).not.toBe(source.scope);
    source.scope.runId = "changed";
    expect(r.identity.scope?.runId).toBe("r");
  });
});

describe("length 也只读一次：Proxy 改不动硬上限", () => {
  /** length 第一次返回 first、之后返回 second。 */
  function lengthFlip(items: unknown[], first: number, second: number): unknown[] {
    let n = 0;
    return new Proxy(items, {
      get(t, k, r): unknown {
        if (k === "length") {
          n += 1;
          return n === 1 ? first : second;
        }
        return Reflect.get(t, k, r);
      },
    });
  }

  test("links.length 检查时 4、循环时 5：物化结果不会多出第 5 条", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ runtimeId: "rt", recordId: `r${i}` }));
    const r = materializeDynamicIdentity({ name: "n", correlation: { links: lengthFlip(five, 4, 5) } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.correlation?.links?.length).toBe(4);
  });
});

describe("两条路共用的 frame 物化：kind / occurredAt / sourceSeq / attributes", () => {
  const base = { kind: "event", occurredAt: 1, name: "n", attributes: {} };

  test("kind 必须是枚举值", () => {
    expect(materializeRecordFrame({ ...base, kind: "bogus" }).ok).toBe(false);
    expect(materializeRecordFrame({ ...base, kind: 1 }).ok).toBe(false);
    for (const k of ["event", "span_start", "span_end", "snapshot", "health"]) {
      expect(materializeRecordFrame({ ...base, kind: k }).ok).toBe(true);
    }
  });

  test("occurredAt 必须有限、sourceSeq 必须非负安全整数", () => {
    expect(materializeRecordFrame({ ...base, occurredAt: NaN }).ok).toBe(false);
    expect(materializeRecordFrame({ ...base, occurredAt: "1" }).ok).toBe(false);
    expect(materializeRecordFrame({ ...base, sourceSeq: -1 }).ok).toBe(false);
    expect(materializeRecordFrame({ ...base, sourceSeq: 1.5 }).ok).toBe(false);
    expect(materializeRecordFrame({ ...base, sourceSeq: 7 }).ok).toBe(true);
  });

  test("attributes 只许 string / 有限 number / boolean，且物化成副本", () => {
    expect(materializeRecordFrame({ ...base, attributes: { a: { nested: 1 } } }).ok).toBe(false);
    expect(materializeRecordFrame({ ...base, attributes: { a: NaN } }).ok).toBe(false);
    expect(materializeRecordFrame({ ...base, attributes: null }).ok).toBe(false);
    const src = { a: "x", b: 1, c: true };
    const r = materializeRecordFrame({ ...base, attributes: src });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frame.attributes).toEqual(src);
    expect(r.frame.attributes).not.toBe(src);
    expect(Object.isFrozen(r.frame.attributes)).toBe(true);
  });

  test("attribute 字符串走自己那把尺：空串合法、上限是 maxAttributeStringBytes", () => {
    // 之前套 identity 的尺（非空 + 128 字节），129 字节的 toolName 会直接 drop/gap——一条没写进契约的 ABI
    expect(materializeRecordFrame({ ...base, attributes: { toolName: "" } }).ok).toBe(true);
    const long = "x".repeat(OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes + 1);
    expect(materializeRecordFrame({ ...base, attributes: { toolName: long } }).ok).toBe(true);
    const exact = "x".repeat(OBSERVATION_IDENTITY_LIMITS.maxAttributeStringBytes);
    expect(materializeRecordFrame({ ...base, attributes: { toolName: exact } }).ok).toBe(true);
    const over = materializeRecordFrame({ ...base, attributes: { toolName: `${exact}x` } });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.violation).toMatch(/字节 > 上限/);
    expect(over.violation).not.toContain("xxxx");
  });

  test("attributes 里的 __proto__ 是普通字段，不改物化对象的原型", () => {
    const attrs = JSON.parse('{"__proto__":"payload","a":"b"}') as Record<string, string>;
    const r = materializeRecordFrame({ ...base, attributes: attrs });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.prototype.hasOwnProperty.call(r.frame.attributes, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(r.frame.attributes)).toBe(Object.prototype);
  });

  test("attributes 是非法容器时判违规，而不是被洗成空字典", () => {
    // 之前 `ok:true` 而 attributes 是 {}——正文丢了、没有 gap、没有诊断
    const m = materializeRecordFrame({ ...base, attributes: new Map([["toolName", "secret"]]) });
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.violation).toMatch(/attributes/);
    expect(m.violation).not.toContain("secret");
    for (const bad of [new Set([1]), new Date(0), [1, 2]]) {
      expect(materializeRecordFrame({ ...base, attributes: bad }).ok).toBe(false);
    }
    class Attrs {
      toolName = "x";
    }
    expect(materializeRecordFrame({ ...base, attributes: new Attrs() }).ok).toBe(false);
  });

  test("attributes 含 accessor / non-enumerable 也判违规", () => {
    const acc = {};
    Object.defineProperty(acc, "toolName", { get: () => "x", enumerable: true, configurable: true });
    expect(materializeRecordFrame({ ...base, attributes: acc }).ok).toBe(false);
    const hidden = { a: "1" };
    Object.defineProperty(hidden, "b", { value: "2", enumerable: false, configurable: true });
    expect(materializeRecordFrame({ ...base, attributes: hidden }).ok).toBe(false);
  });

  test("attributes 键数有上限，且违规说明不回显键名", () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1]));
    const r = materializeRecordFrame({ ...base, attributes: many });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violation).toMatch(/33 个键/);
    const secret = materializeRecordFrame({ ...base, attributes: { "Bearer-sk-secret": {} } });
    expect(secret.ok).toBe(false);
    if (secret.ok) return;
    expect(secret.violation).not.toContain("sk-secret");
  });
});

describe("身份字段的构造期上限", () => {
  const over = "x".repeat(OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes + 1);
  const exact = "x".repeat(OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes);

  test("刚好命中放行，超一字节 fail-loud，且报错不回显原值", () => {
    expect(() => assertIdentifier(exact, "runtimeId")).not.toThrow();
    expect(() => assertIdentifier(over, "runtimeId")).toThrow(ObservationIdentityError);
    expect(() => assertIdentifier("", "runtimeId")).toThrow(/不能为空/);
    try {
      assertIdentifier(over, "runtimeId");
    } catch (e) {
      expect((e as Error).message).not.toContain("xxxx");
      expect((e as Error).message).toContain("runtimeId");
    }
  });

  test("多字节字符按 UTF-8 计，不是按 code unit", () => {
    const emoji = "🙂".repeat(OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes / 4 + 1); // 每个 4 字节
    expect(() => assertIdentifier(emoji, "f")).toThrow(ObservationIdentityError);
  });

  test("instrumentation 与 owner 各字段都过同一把尺", () => {
    expect(() => freezeInstrumentation({ name: over, version: "1" }, "i")).toThrow(/i\.name/);
    expect(() => freezeInstrumentation({ name: "n", version: over }, "i")).toThrow(/i\.version/);
    expect(() => freezeOwner({ status: "known", entryId: over, entryGeneration: "1", via: "assembly" }, "owner")).toThrow(/owner\.entryId/);
    expect(() => freezeOwner({ status: "known", entryId: "e", entryGeneration: over, via: "assembly" }, "owner")).toThrow(/owner\.entryGeneration/);
    expect(() => freezeOwner({ status: "unknown", reason: over }, "owner")).toThrow(/owner\.reason/);
    expect(() => freezeOwner({ status: "not-applicable" }, "owner")).not.toThrow();
  });
});

describe("诊断 redaction 的前置工作也必须有界（2026-08-27 review P1）", () => {
  test("超幅度 bigint 只记 [bigint]，不做 toString(10)", () => {
    // 修复前：100,000 位 bigint 光 redactError() 就约 142ms——完整转十进制发生在 4 KiB 限额**之前**
    const huge = 10n ** 100_000n;
    const huger = 10n ** 200_000n;
    expect(redactError(huge).digest).toBe(redactError(huger).digest); // 两者都落到同一个 [bigint]
    expect(redactError(huge).digest).toBe(redactError(-huger).digest);
  });

  test("幅度之内的 bigint 仍各记各的十进制，分辨力不丢", () => {
    expect(redactError(1n).digest).not.toBe(redactError(2n).digest);
    expect(redactError(1n).digest).not.toBe(redactError(10n ** 100_000n).digest);
  });

  test("伪造 name 逐段追加：预算之外的部分不参与 hash", () => {
    const prefix = "F".repeat(MAX_REDACT_HASH_INPUT);
    const a = Object.assign(new Error("m"), { name: prefix + "-aaaa" });
    const b = Object.assign(new Error("m"), { name: prefix + "-bbbb" });
    expect(redactError(a).digest).toBe(redactError(b).digest);
    expect(redactError(a).name).toBe("Error"); // 白名单之外一律回落分类
  });
});

describe("attributes / scope 也只认 descriptor 快照（2026-08-27 review P1）", () => {
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

  test("attributes：物化出来的是 descriptor 的值，get trap 调用次数为 0", () => {
    // 修复前实测：materializeRecordFrame(...) → attributes.x="secret"、getCalls=1
    const a = twoFaced();
    const f = materializeRecordFrame({ kind: "event", occurredAt: 1, name: "n", scope: {}, attributes: a.p });
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.frame.attributes).toEqual({ x: "safe" });
    expect(a.calls()).toBe(0);
  });

  test("scope：某个键的 descriptor trap 抛错，已物化的 runId 仍然留得住", () => {
    // 修复前：materializeScope(proxy) → {ok:false, violation:"...容器读取失败"}，runId 消失
    const hostile = new Proxy(
      { runId: "r1", sessionId: "s1" },
      {
        getOwnPropertyDescriptor(t, k): PropertyDescriptor | undefined {
          if (k === "sessionId") throw new Error("descriptor trap");
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      },
    );
    const m = materializeScope(hostile);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.runId).toBe("r1");
    expect(m.violation).not.toContain("descriptor trap");
  });

  test("runId 自己的 descriptor 不可读时，才是真的恢复不了", () => {
    const hostile = new Proxy(
      { runId: "r1", sessionId: "s1" },
      {
        getOwnPropertyDescriptor(t, k): PropertyDescriptor | undefined {
          if (k === "runId") throw new Error("descriptor trap");
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      },
    );
    const m = materializeScope(hostile);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.runId).toBeUndefined();
  });
});
