// 第三方异常进入 public / persisted 面之前的投影（§15.11 的采集边界规矩）。
//
// 起因（review 实测）：`SinkHealth.lastErrorDigest` 里出现过整条
// `Authorization: Bearer sk-secret-…`——第三方 listener 抛出的 Error.message 被原样存进了可查询的 health。
// 字段名叫 digest，就不能装原文。
//
// 三条硬规矩，缺一条这层就是新的逃逸口：
//   ① **本模块所有导出都是 total function**——redaction 自己抛错，等于在隔离层里又开一个口子
//      （`{ toString() { throw } }` 与 message getter 抛错的 Error 都实测能穿出去）。
//   ② **绝不调用不可信的 `toString()`**：陌生对象只记 `[object]`，不给它执行机会。
//   ③ **`name` 不是可信分类**——第三方能把它设成任意字符串（实测 `AuthorizationBearerSecret@…` 进了诊断）。
//      只有白名单里的标准名直出，其余一律回落 `Error`，原名折进 hash 材料，分辨力不丢。

import { sha256Hex } from "./hash.ts";

/** 允许直出的错误分类。白名单之外的 `name` 由第三方控制，不当分类用。 */
const KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "ObservationEncodingError",
  "ObservationCorruptionError",
  "ObservationStoreUnavailableError",
]);

/**
 * 白名单里最长那个名字的长度。**查表之前先用它挡一道**：`Set.has(rawName)` 要对整个字符串算哈希，
 * 而 `rawName` 由第三方控制——实测 5,000 万字符的伪造 name 光这一次 `has()` 就约 29ms，且随长度线性增长
 * （2026-08-27 review P1）。比它长的必然不在表里，连查都不用查。
 */
const MAX_KNOWN_ERROR_NAME_LENGTH = (() => {
  let max = 0;
  for (const n of KNOWN_ERROR_NAMES) if (n.length > max) max = n.length;
  return max;
})();

/** 参与同步 hash 的材料上限：`offer()` 在同步 critical section 里调它，不能被一个巨型 message 拖住。 */
export const MAX_REDACT_HASH_INPUT = 4 * 1024;

/** 超过这个幅度的 bigint 只记 `[bigint]`，不转十进制（`toString(10)` 超线性）。64 位十进制够覆盖常见抛出物。 */
const MAX_REDACT_BIGINT = 10n ** 64n;

const UNAVAILABLE_DIGEST = "0".repeat(64);

export type RedactedError = Readonly<{
  /** 低基数分类：白名单命中才直出，否则恒为 `"Error"`。 */
  name: string;
  /** 材料的 SHA-256：同一个错误跨进程可比对，正文不可还原。 */
  digest: string;
}>;

function safeRead(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** 只把**自己能确定形状**的值变成字符串；陌生对象绝不 `String(v)`（那会执行它的 toString）。 */
function safeMaterial(e: unknown): string {
  switch (typeof e) {
    case "string":
      return e;
    case "number":
    case "boolean":
      return String(e);
    case "bigint":
      // `toString(10)` 对大 bigint 是超线性的：实测 100,000 位光 redactError() 就约 142ms（review P1）。
      // 先按幅度拒——幅度比较是常数级的，转十进制才是那个坑。
      return e < MAX_REDACT_BIGINT && e > -MAX_REDACT_BIGINT ? `${e.toString(10)}n` : "[bigint]";
    case "undefined":
      return "undefined";
    case "symbol":
      return "[symbol]";
    case "function":
      return "[function]";
    default:
      break;
  }
  if (e === null) return "null";
  return "[object]";
}

/**
 * 按剩余预算取前缀再拼。**不能先拼完整串再 `slice()`**：`message` / `stack` 都由第三方控制，
 * 5 MB 的 message 会先在这里分配一份完整拷贝，同步预算就白设了（同 normalize 的 `MAX_STACK_DIGEST_INPUT`）。
 */
function appendBounded(parts: string[], used: number, piece: string): number {
  const room = MAX_REDACT_HASH_INPUT - used;
  if (room <= 0) return used;
  if (piece.length <= room) {
    parts.push(piece);
    return used + piece.length;
  }
  parts.push(piece.slice(0, room));
  return MAX_REDACT_HASH_INPUT;
}

export function redactError(e: unknown): RedactedError {
  let name = "Error";
  const parts: string[] = [];
  let used = 0;
  let isError = false;
  try {
    isError = e instanceof Error; // 同 toSafeError：Proxy 的 getPrototypeOf trap 能让它抛
  } catch {
    isError = false;
  }
  try {
    if (isError) {
      const rawName = safeRead(e as object, "name");
      if (typeof rawName === "string" && rawName.length <= MAX_KNOWN_ERROR_NAME_LENGTH && KNOWN_ERROR_NAMES.has(rawName)) {
        name = rawName;
      } else if (typeof rawName === "string") {
        // 逐段追加，**不先拼 `name:${rawName}\n`**：rawName 由第三方控制，模板字符串会先造一份完整拷贝，
        // 预算就又应用晚了（review P1 同一处的第二个洞）。不当分类，但折进 hash：不同的伪造名仍可区分。
        used = appendBounded(parts, used, "name:");
        used = appendBounded(parts, used, rawName);
        used = appendBounded(parts, used, "\n");
      }
      const message = safeRead(e as object, "message");
      used = appendBounded(parts, used, typeof message === "string" ? message : safeMaterial(message));
      const stack = safeRead(e as object, "stack");
      if (typeof stack === "string") {
        used = appendBounded(parts, used, "\n");
        used = appendBounded(parts, used, stack);
      }
    } else {
      used = appendBounded(parts, used, safeMaterial(e));
    }
  } catch {
    // 走到这里说明连 safeRead / 拼接都出了事；宁可少一点材料，也不能把异常放出去
  }
  const material = parts.join("");
  let digest = UNAVAILABLE_DIGEST;
  try {
    digest = sha256Hex(material);
  } catch {
    // 同上：hash 失败也只降级成固定 digest
  }
  return { name, digest };
}

/** 诊断里的人读短写：`TypeError@1a2b3c4d`。够定位、够对账，不含正文，且永不抛。 */
export function redactedLabel(e: unknown): string {
  const r = redactError(e);
  return `${r.name}@${r.digest.slice(0, 8)}`;
}

/**
 * 把任意抛出物变成一个可以安全 reject 的 `Error`。**永不抛**——
 * `errText()` 对陌生对象会走 `String(e)`，那条路能执行不可信 `toString()` 并把异常甩进
 * 「不该抛」的同步路径（`appendBoundary()` 的契约是返回 rejected Promise，不是同步 throw）。
 */
export function toSafeError(e: unknown, fallbackMessage: string): Error {
  try {
    // `instanceof` 会走原型链——带 `getPrototypeOf` trap 的 Proxy 能让它当场抛（review 实测），
    // 所以它也必须在 try 里面。这是「total function」这句话的边界，不是形式主义。
    if (e instanceof Error) return e;
  } catch {
    // 连类型判断都被劫持了，那就当它不是 Error
  }
  try {
    return new Error(`${fallbackMessage}：${redactedLabel(e)}`);
  } catch {
    return new Error(fallbackMessage);
  }
}
