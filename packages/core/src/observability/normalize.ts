// 唯一的 normalize / canonical 序列化（§15.4.1）。Sequencer 在预留 identity 之后调它；producer 与 adapter
// 不得预先跑另一套（两套 normalize = 两份真相）。
//
// 规则（每条都有测试锁着）：
//   · `Error` → `ObservationError`；二进制 → `ObservationBlobRef`（digest + size，bytes 交给 worker 暂存）；
//     `bigint` → 带 type tag 的十进制字符串；`-0` → `0`。
//   · `NaN` / `±Infinity`、function、symbol、`undefined`、Map/Set、未知 class instance、getter 抛错、循环引用
//     一律 `ObservationEncodingError`——**不能靠 `JSON.stringify()` 静默删字段**。
//   · depth / nodes / bytes / blob chunk 任一上限超出也是 encoding failure，不静默截断成另一份事实。
//   · canonical 序列化：UTF-8、key 按 code unit 排序、number/string 走 `JSON.stringify` 的确定性转义；
//     同一值 byte-for-byte 稳定，JSON round-trip 后再序列化字节不变。

import { sha256Hex } from "./hash.ts";
import type { ObservationBlobRef, ObservationError, ObservationValue } from "./types.ts";
import { OBSERVATION_BOUNDARY_LIMITS, OBSERVATION_ENVELOPE_RESERVE, OBSERVATION_SYNC_LIMITS } from "./types.ts";

export type ObservationEncodingErrorCode =
  | "non_finite_number"
  | "unsupported_value"
  | "undefined_value"
  | "symbol_key"
  | "cycle"
  | "getter_threw"
  | "depth_exceeded"
  | "nodes_exceeded"
  | "bytes_exceeded"
  | "blob_chunk_exceeded";

export class ObservationEncodingError extends Error {
  readonly code: ObservationEncodingErrorCode;
  /** 出错位置（`$.a[2].b` 形式），给诊断用；不进 canonical record。 */
  readonly path: string;
  constructor(code: ObservationEncodingErrorCode, path: string, detail?: string) {
    super(`observation encoding failed at ${path}: ${code}${detail === undefined ? "" : ` (${detail})`}`);
    this.name = "ObservationEncodingError";
    this.code = code;
    this.path = path;
  }
}

export type EncodingLimits = Readonly<{
  /** canonical UTF-8 字节上限（含 envelope 时由调用方传 envelope 级上限）。 */
  maxBytes: number;
  maxValueDepth: number;
  maxValueNodes: number;
  /** 0 = 不允许任何 blob（boundary lane：run 边界不得引用未 verified 的 blob，§15.4.2.4）。 */
  maxBlobChunkBytes: number;
}>;

export function syncEncodingLimits(): EncodingLimits {
  return {
    maxBytes: OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes,
    maxValueDepth: OBSERVATION_SYNC_LIMITS.maxValueDepth,
    maxValueNodes: OBSERVATION_SYNC_LIMITS.maxValueNodes,
    maxBlobChunkBytes: OBSERVATION_SYNC_LIMITS.maxBlobChunkBytes,
  };
}

/**
 * 观测投影的共享预算：同步预算扣掉 canonical envelope 的框架保留。
 * `/engine` 的 ephemeral fact 按它量；Sequencer 那边框架另有断言，两面因此同一个 admission boundary。
 */
export function projectionEncodingLimits(): EncodingLimits {
  return {
    maxBytes: OBSERVATION_SYNC_LIMITS.maxCanonicalDraftBytes - OBSERVATION_ENVELOPE_RESERVE.bytes,
    maxValueDepth: OBSERVATION_SYNC_LIMITS.maxValueDepth,
    maxValueNodes: OBSERVATION_SYNC_LIMITS.maxValueNodes - OBSERVATION_ENVELOPE_RESERVE.nodes,
    maxBlobChunkBytes: OBSERVATION_SYNC_LIMITS.maxBlobChunkBytes,
  };
}

/** envelope 框架自身的上限：Sequencer 用它断言框架没有吃掉保留额（吃掉了就是 encoding failure，不静默分叉）。 */
export function envelopeFramingLimits(): EncodingLimits {
  return {
    maxBytes: OBSERVATION_ENVELOPE_RESERVE.bytes,
    maxValueDepth: OBSERVATION_SYNC_LIMITS.maxValueDepth,
    maxValueNodes: OBSERVATION_ENVELOPE_RESERVE.nodes,
    maxBlobChunkBytes: 0,
  };
}

export function boundaryEncodingLimits(): EncodingLimits {
  return {
    maxBytes: OBSERVATION_BOUNDARY_LIMITS.maxCanonicalBoundaryBytes,
    maxValueDepth: OBSERVATION_BOUNDARY_LIMITS.maxValueDepth,
    maxValueNodes: OBSERVATION_BOUNDARY_LIMITS.maxValueNodes,
    maxBlobChunkBytes: 0,
  };
}

/** worker 在 SQL 引用提交前要持久化的 blob（§15.4.2.4）；digest 已进 candidate bytes。 */
export type StagedBlob = Readonly<{ digest: string; bytes: Uint8Array }>;

export type NormalizedValue = Readonly<{
  value: ObservationValue;
  nodes: number;
  depth: number;
  blobs: readonly StagedBlob[];
}>;

type Counters = { nodes: number; maxDepth: number };

/** bigint 的十进制位数上限。超过就直接拒——观测记录里不存在需要四千位整数的事实。 */
export const MAX_BIGINT_DIGITS = 4_096;
const MAX_BIGINT = 10n ** BigInt(MAX_BIGINT_DIGITS);

/**
 * 逐键 `defineProperty` 造字典。**不能用 `out[key] = v`**：键名是 `__proto__` 时那是原型 setter，
 * 字段会静默消失、输出对象的原型还被改掉，canonical JSON 因此少一个字段却不产生任何 gap
 * （review 实测）——正是本模块开头那句「不靠 `JSON.stringify()` 静默删字段」要防的事。
 * 同款实现见 `admission/model-snapshot.ts`。
 */
function safeDict(entries: readonly (readonly [string, ObservationValue])[]): Record<string, ObservationValue> {
  const out: Record<string, ObservationValue> = {};
  for (const [key, value] of entries) Object.defineProperty(out, key, { value, enumerable: true, writable: false, configurable: false });
  // **必须真冻结，不能只靠 TypeScript 的 `Readonly`**（2026-08-27 review P1）：字段虽然不可写，
  // 对象仍可扩展，数组也没冻。Sequencer 把**同一个 envelope 引用**发给所有 subscriber 并存进 replay 缓存，
  // 于是第一个 subscriber 原地改 body 之后，落盘 bytes 还是 `"safe"`、第二个 subscriber 与后续 replay 却看到
  // `"tampered"`——已提交的事实面当场分裂。归一化结果是**不可变快照**，这是它的定义，不是可选项。
  return Object.freeze(out);
}

/**
 * 反射操作也要包起来：`Reflect.ownKeys` / `getPrototypeOf` / `getOwnPropertyDescriptor` 打在 Proxy 上会走 trap，
 * producer 抛的普通 `Error` 会**原样甩出** normalize——而 `offer()` 的契约是永不抛（review 实测）。
 */
function guard<T>(fn: () => T, path: string): T {
  try {
    return fn();
  } catch {
    return (() => {
      throw new ObservationEncodingError("getter_threw", path, "反射操作抛错");
    })();
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v); // 调用方已在 try 里
  return proto === Object.prototype || proto === null;
}

/** `instanceof` 会走原型链——Proxy 的 `getPrototypeOf` trap 能让它抛，而这里在 `offer()` 的 no-throw 路径上。 */
function isA(v: unknown, ctor: { new (...args: never[]): unknown }, path: string): boolean {
  return guard(() => v instanceof ctor, path);
}

/**
 * **精确 plain 字典读取**：容器必须是 plain object（原型只许 `Object.prototype | null`），
 * 不许 symbol 键、accessor、non-enumerable。
 *
 * 为什么必须共用这一份（review 实测）：只判「是 object 且非 array」再 `Object.keys()` 的话，
 * `new Map([["toolName","secret"]])` 会得到 `[]` —— 非法容器在进入唯一 normalizer **之前**就被洗成了
 * 合法空字典，attributes / counters 变成 `{}`、省略计数仍是 0、`projectionGaps` 空，最终 RunObservation
 * 还标 complete。这正好绕开「Map/Set/class/symbol 必须拒绝、不得静默删字段」那条。
 */
export type PlainDictFailureKind = "not_plain" | "symbol_key" | "accessor" | "non_enumerable" | "too_many_keys" | "read_failed";

/**
 * **故意不返回原容器**（2026-08-27 review P1）：上一版同时给 `obj` 和 `values`，于是 body、`attributes`、
 * `counters`/`flags` 三个消费方全都拿 `obj` 回读了一遍——descriptor 说 `"safe"`、`get` trap 说 `"secret"` 时，
 * 落进 canonical 的是 `"secret"`、`getCalls=1`，§15 那句「值取自 descriptor，get trap 一次都不执行」是假的。
 * 删掉 `obj` 让 TypeScript 把漏点一次找全，是这条唯一靠得住的修法：只要还留着口子，就还得靠人记得别用。
 */
export type PlainDictRead =
  /** `values` 是**从 descriptor 直接物化**的 plain 快照（null 原型），读它不会再触发任何 trap。 */
  | Readonly<{ ok: true; keys: readonly string[]; values: Readonly<Record<string, unknown>> }>
  /** 失败也带回已物化的合法字段：同一容器里的好字段不该被坏字段连坐（见下）。 */
  | Readonly<{ ok: false; kind: PlainDictFailureKind; reason: string; values: Readonly<Record<string, unknown>> }>;

export function readExactPlainDict(v: unknown, maxKeys: number): PlainDictRead {
  const empty: Readonly<Record<string, unknown>> = Object.freeze(Object.create(null) as Record<string, unknown>);
  const fail = (kind: PlainDictFailureKind, reason: string, values = empty): PlainDictRead => ({ ok: false, kind, reason, values });
  try {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return fail("not_plain", "必须是 plain object");
    if (!isPlainObject(v)) return fail("not_plain", "不是 plain object（Map/Set/class 实例一律拒）");
    const own = Reflect.ownKeys(v);
    if (own.length > maxKeys) return fail("too_many_keys", `${own.length} 个键 > 上限 ${maxKeys}`);
    const keys: string[] = [];
    const values = Object.create(null) as Record<string, unknown>;
    let bad: Readonly<{ kind: PlainDictFailureKind; reason: string }> | undefined;
    // **扫完再判，不遇坏就走**：遇到第一个坏键就 return 的话，同一容器里本来合法的字段会跟着丢
    // ——`{ runId:"r1", nope:"x" }` 或「另一个字段是 accessor」时 `scope.runId` 读不出来，
    // gap 就只能退成 runtime-scoped，run 级对账看不见那个洞（2026-08-27 review P1 实测）。
    // 键数已经在上面按剩余预算封顶，所以扫完仍是有界工作。
    for (const key of own) {
      if (typeof key === "symbol") {
        bad ??= { kind: "symbol_key", reason: "含 symbol 键" };
        continue;
      }
      // **每个 descriptor 单独 try**：整段共用一个 try 时，第二个键的 trap 一抛就走外层 catch，
      // 连**已经物化好**的第一个键一起丢——`{runId:"r1", sessionId:<trap>}` 会让 `scope.runId` 消失，
      // gap 又退成 runtime-scoped（2026-08-27 review P1 实测）。逐键失败只记 read_failed 并继续。
      let desc: PropertyDescriptor | undefined;
      try {
        desc = Object.getOwnPropertyDescriptor(v, key);
      } catch {
        bad ??= { kind: "read_failed", reason: "键描述符读取抛错" };
        continue;
      }
      if (desc === undefined) {
        bad ??= { kind: "read_failed", reason: "键描述符读取失败" };
        continue;
      }
      if (desc.get !== undefined || desc.set !== undefined) {
        bad ??= { kind: "accessor", reason: "含 accessor 属性" };
        continue;
      }
      if (desc.enumerable !== true) {
        bad ??= { kind: "non_enumerable", reason: "含 non-enumerable 属性" };
        continue;
      }
      keys.push(key);
      // 值取自 descriptor：单次读取，get trap 不会被执行
      Object.defineProperty(values, key, { value: desc.value, enumerable: true, writable: false, configurable: false });
    }
    if (bad !== undefined) return fail(bad.kind, bad.reason, Object.freeze(values));
    return { ok: true, keys, values: Object.freeze(values) };
  } catch {
    return fail("read_failed", "容器读取失败");
  }
}

const DICT_FAILURE_CODE: Readonly<Record<PlainDictFailureKind, ObservationEncodingErrorCode>> = {
  not_plain: "unsupported_value",
  symbol_key: "symbol_key",
  accessor: "unsupported_value",
  non_enumerable: "unsupported_value",
  too_many_keys: "nodes_exceeded",
  read_failed: "getter_threw",
};

function ctorName(v: object, path: string): string {
  const name = guard(() => Object.getPrototypeOf(v)?.constructor?.name, path);
  return typeof name === "string" && name.length > 0 ? name : "anonymous";
}

/**
 * 把任意运行期值归一成 `ObservationValue`。只抛 `ObservationEncodingError`。
 * `limits.maxBytes` 在这里**不**检查——字节上限要连 envelope 一起量，见 `encodeCanonical()`。
 */
export function normalizeObservationValue(input: unknown, limits: EncodingLimits = syncEncodingLimits()): NormalizedValue {
  const counters: Counters = { nodes: 0, maxDepth: 0 };
  const blobs: StagedBlob[] = [];
  const ancestors = new Set<object>();

  const walk = (v: unknown, path: string, depth: number): ObservationValue => {
    counters.nodes += 1;
    if (counters.nodes > limits.maxValueNodes) throw new ObservationEncodingError("nodes_exceeded", path, `> ${limits.maxValueNodes}`);

    switch (typeof v) {
      case "boolean":
      case "string":
        return v;
      case "number":
        if (!Number.isFinite(v)) throw new ObservationEncodingError("non_finite_number", path, String(v));
        return Object.is(v, -0) ? 0 : v;
      case "bigint": {
        // 先按幅度拒，再转十进制：`toString(10)` 对大 bigint 是超线性的，任意大的输入 = 任意大的同步开销。
        if (v >= MAX_BIGINT || v <= -MAX_BIGINT) throw new ObservationEncodingError("bytes_exceeded", path, `bigint 超过 ${MAX_BIGINT_DIGITS} 位`);
        return `bigint:${v.toString(10)}`;
      }
      case "undefined":
        throw new ObservationEncodingError("undefined_value", path);
      case "function":
      case "symbol":
        throw new ObservationEncodingError("unsupported_value", path, typeof v);
      case "object":
        break;
      default:
        throw new ObservationEncodingError("unsupported_value", path, typeof v);
    }
    if (v === null) return null;
    const obj = v as object;
    if (ancestors.has(obj)) throw new ObservationEncodingError("cycle", path);

    if (isA(obj, Error, path)) return walk(errorToObservation(obj as Error, path), path, depth);

    if (isA(obj, ArrayBuffer, path) || guard(() => ArrayBuffer.isView(obj), path)) {
      const view = guard(
        () => (obj instanceof ArrayBuffer ? new Uint8Array(obj) : new Uint8Array((obj as ArrayBufferView).buffer, (obj as ArrayBufferView).byteOffset, (obj as ArrayBufferView).byteLength)),
        path,
      );
      if (view.byteLength > limits.maxBlobChunkBytes) {
        throw new ObservationEncodingError("blob_chunk_exceeded", path, `${view.byteLength} > ${limits.maxBlobChunkBytes}`);
      }
      const bytes = new Uint8Array(view); // 拷贝：producer 之后改 buffer 不能改已预留的 candidate
      const ref: ObservationBlobRef = { digest: sha256Hex(bytes), size: bytes.byteLength };
      blobs.push({ digest: ref.digest, bytes });
      return walk(ref, path, depth);
    }

    if (isA(obj, Map, path) || isA(obj, Set, path) || isA(obj, WeakMap, path) || isA(obj, WeakSet, path)) {
      throw new ObservationEncodingError("unsupported_value", path, ctorName(obj, path));
    }

    if (Array.isArray(obj)) {
      const d = depth + 1;
      if (d > limits.maxValueDepth) throw new ObservationEncodingError("depth_exceeded", path, `> ${limits.maxValueDepth}`);
      if (d > counters.maxDepth) counters.maxDepth = d;
      // **按 sealed JSON-like 容器验形，不是只按下标遍历**：只按下标走会静默放过数组上的额外字符串键、
      // symbol 键、accessor 下标与 Array 子类；`length` 不单次冻结的话，Proxy 返回 0 就能把非空数组
      // 规范化成 `[]`（review 实测）。判据与 `admission/model-snapshot.ts` 同款。
      if (guard(() => Object.getPrototypeOf(obj), path) !== Array.prototype) {
        throw new ObservationEncodingError("unsupported_value", path, "Array 子类不是 plain array");
      }
      const arr = obj as unknown[];
      const length = guard(() => arr.length, path); // ← 只读一次
      if (!Number.isSafeInteger(length) || length < 0) throw new ObservationEncodingError("unsupported_value", path, "length 非法");
      // **在 `Reflect.ownKeys()` 之前就按 node 预算 fail-fast**：上限限制的是结果，不是同步工作量——
      // 2,000,000 个元素的数组即便最终返回 nodes_exceeded，也已经在 Agent 线程上烧掉几百毫秒
      // （实测约 678ms），而 length=100,000 的 Proxy 还会先跑一遍 ownKeys trap（review 实测）。
      if (counters.nodes + length > limits.maxValueNodes) {
        throw new ObservationEncodingError("nodes_exceeded", path, `数组 ${length} 项 > 剩余预算 ${limits.maxValueNodes - counters.nodes}`);
      }
      // **验形的同时把下标值物化下来**（2026-08-27 review P1）：原来校验完 descriptor 之后又走
      // `readProp()` 回读一次，get trap 因此照样被执行——descriptor 说 `"safe"`、trap 说 `"secret"` 时
      // 落进 canonical 的是 `["secret"]`、`getCalls=1`。字典路径刚修掉的 TOCTOU，数组路径原样还在。
      const items = new Array<unknown>(length);
      const present = new Array<boolean>(length).fill(false);
      for (const key of guard(() => Reflect.ownKeys(arr), path)) {
        if (typeof key === "symbol") throw new ObservationEncodingError("symbol_key", path, "数组有 symbol key");
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
          throw new ObservationEncodingError("unsupported_value", `${path}.${key}`, "数组上的额外属性");
        }
        const desc = guard(() => Object.getOwnPropertyDescriptor(arr, key), `${path}[${key}]`);
        if (desc === undefined) throw new ObservationEncodingError("unsupported_value", `${path}[${key}]`, "描述符读取失败");
        if (desc.get !== undefined || desc.set !== undefined) throw new ObservationEncodingError("unsupported_value", `${path}[${key}]`, "accessor 下标");
        if (desc.enumerable !== true) throw new ObservationEncodingError("unsupported_value", `${path}[${key}]`, "non-enumerable 下标");
        items[index] = desc.value; // ← 全流程唯一一次取值
        present[index] = true;
      }
      ancestors.add(obj);
      const out: ObservationValue[] = [];
      for (let i = 0; i < length; i++) {
        const p = `${path}[${i}]`;
        // 稀疏洞由「ownKeys 里没出现过这个下标」判定，不再 `hasOwnProperty` 回摸一次容器
        if (!present[i]) throw new ObservationEncodingError("undefined_value", p, "sparse hole");
        out.push(walk(items[i], p, d));
      }
      ancestors.delete(obj);
      return Object.freeze(out);
    }

    const d = depth + 1;
    if (d > limits.maxValueDepth) throw new ObservationEncodingError("depth_exceeded", path, `> ${limits.maxValueDepth}`);
    if (d > counters.maxDepth) counters.maxDepth = d;
    // **body 也走同一份 exact dictionary reader**（review：文档说 body / attributes / counters 共用，
    // 而这里原来是 `Object.keys()` + `readProp()`——non-enumerable 字段被静默丢、enumerable accessor 被执行
    // 且返回值直接进 canonical body，都不产生 gap）。maxKeys 用剩余 node 预算，超了就是 nodes_exceeded。
    const dict = readExactPlainDict(obj, limits.maxValueNodes - counters.nodes);
    if (!dict.ok) throw new ObservationEncodingError(DICT_FAILURE_CODE[dict.kind], path, dict.reason);
    ancestors.add(obj);
    const entries: (readonly [string, ObservationValue])[] = [];
    // 值只从 descriptor 快照取，**绝不回读 `obj`**：回读一次就把 get trap 请回来了（review P1 实测
    // descriptor 说 "safe"、trap 说 "secret" 时，落进 canonical 的是 "secret"）。
    for (const key of [...dict.keys].sort()) {
      const p = `${path}.${key}`;
      const child = dict.values[key];
      if (child === undefined) throw new ObservationEncodingError("undefined_value", p);
      entries.push([key, walk(child, p, d)] as const);
    }
    ancestors.delete(obj);
    return safeDict(entries);
  };

  // 最外层再兜一次：本函数的契约是**只抛 `ObservationEncodingError`**。上面每处反射都包了 guard，
  // 但「包全了」是要靠人守的，而这条契约有 `offer()` 的 no-throw 压在上面——不能只剩人守（review 点出）。
  try {
    const value = walk(input, "$", 0);
    return { value, nodes: counters.nodes, depth: counters.maxDepth, blobs };
  } catch (e) {
    throw asEncodingError(e);
  }
}

/** 把任何抛出物收敛成 `ObservationEncodingError`；`instanceof` 自己也可能被 trap 劫持，所以再包一层。 */
function asEncodingError(e: unknown): ObservationEncodingError {
  try {
    if (e instanceof ObservationEncodingError) return e;
  } catch {
    // 连类型判断都被劫持了
  }
  return new ObservationEncodingError("unsupported_value", "$", "normalize 内部异常");
}

function readProp(obj: object, key: string | number, path: string): unknown {
  try {
    return (obj as Record<string | number, unknown>)[key];
  } catch {
    // 不带上原异常文本：它来自被观测方的代码，可能夹着凭据或用户数据，而 ObservationEncodingError
    // 的 message 会流进诊断。分类（code）足够定位，正文不进（review P1 的 redaction 边界）。
    throw new ObservationEncodingError("getter_threw", path);
  }
}

/**
 * 参与 `stackDigest` 的 stack 前缀上限（code unit）。
 *
 * 起因（2026-08-27 review 实测）：`err.stack` 是被观测方完全控制的字符串，1 MB / 5 MB 的 stack 都能
 * 生成一条**合法且只有一百多字节**的 canonical record——64 KiB 的 canonical 上限完全没约束到这段工作，
 * 而 `sha256Hex()` 会把它整条 UTF-8 编码再分配 padded buffer（约两倍）。`offer()` 的同步预算被绕开，
 * 且这是**普通 Provider 数据路径**上就会发生的事，不属于 OP2 那类未来敌意 Proxy 风险。
 *
 * 超限不把整条事实变成 gap（stack 只是辅助证据，为它丢事实不划算），改成**有界前缀 digest** 并显式
 * 标 `stackTruncated` + 原始 `stackChars`：仍可跨进程对账，但不再冒充「完整 stack 的指纹」。
 */
export const MAX_STACK_DIGEST_INPUT = 8 * 1024;

function errorToObservation(err: Error, path: string): ObservationError {
  let name: unknown;
  let message: unknown;
  let code: unknown;
  let stack: unknown;
  try {
    name = err.name;
    message = err.message;
    code = (err as { code?: unknown }).code;
    stack = err.stack;
  } catch {
    throw new ObservationEncodingError("getter_threw", path);
  }
  const out: { name: string; message: string; code?: string; stackDigest?: string; stackTruncated?: boolean; stackChars?: number } = {
    name: typeof name === "string" ? name : "Error",
    // **不对不可信的 message 调 `String()`**：它会执行 producer 的 `toString()`，异常还原样逃出
    // （review 实测）。非字符串就只记类型名。
    message: typeof message === "string" ? message : `[${message === null ? "null" : typeof message}]`,
  };
  if (typeof code === "string") out.code = code;
  if (typeof stack === "string" && stack.length > 0) {
    if (stack.length <= MAX_STACK_DIGEST_INPUT) {
      out.stackDigest = sha256Hex(stack);
    } else {
      // 前缀 digest：`slice()` 分配的是有界拷贝，hash 的输入也就有界了
      out.stackDigest = sha256Hex(stack.slice(0, MAX_STACK_DIGEST_INPUT));
      out.stackTruncated = true;
      out.stackChars = stack.length;
    }
  }
  return out;
}

/** canonical JSON 文本：key 按 code unit 排序；number / string 走 `JSON.stringify` 的确定性转义。 */
export function canonicalJson(value: ObservationValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
    case "string":
      return JSON.stringify(value);
    default:
      break;
  }
  if (Array.isArray(value)) return `[${(value as readonly ObservationValue[]).map(canonicalJson).join(",")}]`;
  const obj = value as { readonly [key: string]: ObservationValue };
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] as ObservationValue)}`).join(",")}}`;
}

const utf8 = new TextEncoder();

export function canonicalJsonBytes(value: ObservationValue): Uint8Array {
  return utf8.encode(canonicalJson(value));
}

/**
 * **封顶增量写出**：一超预算立刻停，绝不先生成完整字符串 / 完整 UTF-8 buffer 再回头量
 * （review 实测：任意大的 string 会产生任意大的临时分配，`offer()` 的「同步有界」就成了空话）。
 *
 * 长字符串在 `JSON.stringify()` **之前**就按 code unit 数拒——转义只会让它更长，
 * 所以 `已写 + s.length + 2 > 上限` 时不可能再放得下，用不着先把转义串造出来。
 */
class CappedCanonicalWriter {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;
  constructor(private readonly maxBytes: number) {}

  private push(text: string): void {
    const bytes = utf8.encode(text);
    this.total += bytes.byteLength;
    if (this.total > this.maxBytes) throw new ObservationEncodingError("bytes_exceeded", "$", `> ${this.maxBytes}`);
    this.chunks.push(bytes);
  }

  private pushString(s: string): void {
    // 下界：转义后至少是 s.length + 两个引号，且每个 code unit 至少 1 字节
    if (this.total + s.length + 2 > this.maxBytes) {
      throw new ObservationEncodingError("bytes_exceeded", "$", `字符串 ${s.length} code unit > 剩余预算`);
    }
    this.push(JSON.stringify(s));
  }

  write(value: ObservationValue): void {
    if (value === null) return this.push("null");
    switch (typeof value) {
      case "boolean":
        return this.push(value ? "true" : "false");
      case "number":
        return this.push(JSON.stringify(value));
      case "string":
        return this.pushString(value);
      default:
        break;
    }
    if (Array.isArray(value)) {
      this.push("[");
      const items = value as readonly ObservationValue[];
      for (let i = 0; i < items.length; i++) {
        if (i > 0) this.push(",");
        this.write(items[i] as ObservationValue);
      }
      return this.push("]");
    }
    const obj = value as { readonly [key: string]: ObservationValue };
    this.push("{");
    const keys = Object.keys(obj).sort();
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) this.push(",");
      this.pushString(keys[i] as string);
      this.push(":");
      this.write(obj[keys[i] as string] as ObservationValue);
    }
    this.push("}");
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

export type CanonicalEncoding = NormalizedValue & Readonly<{ bytes: Uint8Array }>;

/** normalize + 封顶 canonical 序列化一站式；只抛 `ObservationEncodingError`。 */
export function encodeCanonical(input: unknown, limits: EncodingLimits = syncEncodingLimits()): CanonicalEncoding {
  try {
    const normalized = normalizeObservationValue(input, limits);
    const writer = new CappedCanonicalWriter(limits.maxBytes);
    writer.write(normalized.value);
    return { ...normalized, bytes: writer.finish() };
  } catch (e) {
    throw asEncodingError(e);
  }
}

/** canonical bytes 的 SHA-256；recordId / index digest / blob digest 统一用它。 */
export function canonicalDigest(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}
