// `normalizeModelSnapshot(model)`：把 `Model` 变成 JSON-like 的冻结快照。
//
// 按**精确 schema** 验形：顶层只认 provider / id / api / name / capabilities / cost / params / thinkingLevelMap，
// 未知字段拒；capabilities / cost 的每个键与标量类型逐个验；thinkingLevelMap 的键必须是 ThinkingLevel、值是自由 JSON-like 字典或 null；params 是自由 JSON-like 字典。
// 值只接受 plain object / array / string / boolean / null / finite number；function、symbol、bigint、`undefined` value、
// 非 finite number、class 实例、accessor、symbol key、non-enumerable、sparse array、循环引用一律 fail-loud——
// 不静默删字段、不保留别名。结果递归 clone + freeze；字典用 defineProperty 逐键定义，`__proto__` 这种键也只是自身属性，
// 改不了克隆对象的原型。

import type { Model, ThinkingLevel } from "../provider/types.ts";
import type { ModelSnapshotValue, RunModelSnapshot } from "./types.ts";

export class ModelSnapshotError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`model 快照拒绝 ${path}：${reason}`);
    this.name = "ModelSnapshotError";
  }
}

const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** 断言 v 是 plain object，且没有 symbol key / accessor / non-enumerable 自身属性；返回它的字符串键（按定义顺序）。 */
function plainKeys(v: unknown, path: string): { obj: Record<string, unknown>; keys: string[] } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ModelSnapshotError(path, "必须是 plain object");
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new ModelSnapshotError(path, `${(v as object).constructor?.name ?? "非 plain"} 实例，不是 plain object`);
  }
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key === "symbol") throw new ModelSnapshotError(path, "有 symbol key");
    const desc = Object.getOwnPropertyDescriptor(v, key)!;
    if (desc.get !== undefined || desc.set !== undefined) throw new ModelSnapshotError(`${path}.${key}`, "accessor 属性");
    if (desc.enumerable !== true) throw new ModelSnapshotError(`${path}.${key}`, "non-enumerable 属性");
    keys.push(key);
  }
  return { obj: v as Record<string, unknown>, keys };
}

/** 逐键 defineProperty 造字典：键名是 `__proto__` 也只是自身属性，克隆对象原型不变。 */
function dict(entries: readonly (readonly [string, ModelSnapshotValue])[]): Record<string, ModelSnapshotValue> {
  const out: Record<string, ModelSnapshotValue> = {};
  for (const [key, value] of entries) Object.defineProperty(out, key, { value, enumerable: true, writable: false, configurable: false });
  return Object.freeze(out);
}

function cloneValue(v: unknown, path: string, stack: object[]): ModelSnapshotValue {
  if (v === null) return null;
  switch (typeof v) {
    case "boolean":
    case "string":
      return v;
    case "number":
      if (!Number.isFinite(v)) throw new ModelSnapshotError(path, `非 finite number（${String(v)}）`);
      return v;
    case "undefined":
      throw new ModelSnapshotError(path, "值是 undefined（要么给值，要么不写这个键）");
    case "function":
      throw new ModelSnapshotError(path, "函数不是数据");
    case "symbol":
      throw new ModelSnapshotError(path, "symbol 不是数据");
    case "bigint":
      throw new ModelSnapshotError(path, "bigint 不是 JSON-like");
    case "object":
      break;
  }
  const obj = v as object;
  if (stack.includes(obj)) throw new ModelSnapshotError(path, "循环引用");
  stack.push(obj);
  try {
    if (Array.isArray(obj)) {
      // 只认真正的 Array（子类拒）；自身键只允许连续索引 + length，且每个索引都是 enumerable 的数据属性——
      // 只按下标遍历会静默放过 accessor 下标、symbol key、额外字符串属性和 Array 子类（实测）
      if (Object.getPrototypeOf(obj) !== Array.prototype) throw new ModelSnapshotError(path, `${obj.constructor?.name ?? "Array 子类"} 实例，不是 plain array`);
      const arr = obj as unknown[];
      const length = arr.length;
      for (const key of Reflect.ownKeys(arr)) {
        if (typeof key === "symbol") throw new ModelSnapshotError(path, "数组有 symbol key");
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
          throw new ModelSnapshotError(`${path}.${key}`, "数组上的额外属性");
        }
        const desc = Object.getOwnPropertyDescriptor(arr, key)!;
        if (desc.get !== undefined || desc.set !== undefined) throw new ModelSnapshotError(`${path}[${key}]`, "accessor 下标");
        if (desc.enumerable !== true) throw new ModelSnapshotError(`${path}[${key}]`, "non-enumerable 下标");
      }
      const out: ModelSnapshotValue[] = [];
      for (let i = 0; i < length; i++) {
        if (!Object.prototype.hasOwnProperty.call(arr, i)) throw new ModelSnapshotError(`${path}[${i}]`, "sparse array（有空洞）");
        out.push(cloneValue(arr[i], `${path}[${i}]`, stack));
      }
      return Object.freeze(out);
    }
    const { obj: plain, keys } = plainKeys(obj, path);
    return dict(keys.map((key) => [key, cloneValue(plain[key], `${path}.${key}`, stack)] as const));
  } finally {
    stack.pop();
  }
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== "string" || v === "") throw new ModelSnapshotError(path, "必须是非空字符串");
  return v;
}
function requireBoolean(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new ModelSnapshotError(path, `必须是 boolean，收到 ${typeof v}`);
  return v;
}
function requireNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ModelSnapshotError(path, "必须是 finite number");
  return v;
}

/** 按字段表验一个子对象：未知键拒；每个已知键用各自的验形器。 */
function schema<T extends Record<string, ModelSnapshotValue>>(
  v: unknown,
  path: string,
  fields: Readonly<Record<string, (v: unknown, path: string) => ModelSnapshotValue>>,
  required: readonly string[] = [],
): T {
  const { obj, keys } = plainKeys(v, path);
  // own-property 判定：`key in fields` 会把 Object.prototype 上的 toString / constructor 当成合法字段（实测混过）
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(fields, key)) throw new ModelSnapshotError(`${path}.${key}`, "未知字段");
  for (const key of required) if (!keys.includes(key)) throw new ModelSnapshotError(`${path}.${key}`, "必填");
  return dict(keys.map((key) => [key, fields[key]!(obj[key], `${path}.${key}`)] as const)) as T;
}

/** `Model` → JSON-like 冻结快照。精确 schema；`params` 自由字典递归 clone。 */
export function normalizeModelSnapshot(model: Model): RunModelSnapshot {
  const { obj: m, keys } = plainKeys(model, "model");
  const known = new Set(["provider", "id", "api", "name", "capabilities", "cost", "params", "thinkingLevelMap"]);
  for (const key of keys) if (!known.has(key)) throw new ModelSnapshotError(`model.${key}`, "未知字段");
  const entries: (readonly [string, ModelSnapshotValue])[] = [
    ["provider", requireString(m["provider"], "model.provider")],
    ["id", requireString(m["id"], "model.id")],
    ["api", requireString(m["api"], "model.api")],
  ];
  if (keys.includes("name")) entries.push(["name", requireString(m["name"], "model.name")]);
  if (keys.includes("capabilities")) {
    entries.push([
      "capabilities",
      schema(m["capabilities"], "model.capabilities", {
        reasoning: requireBoolean,
        vision: requireBoolean,
        contextWindow: requireNumber,
        maxOutputTokens: requireNumber,
      }),
    ]);
  }
  if (keys.includes("cost")) {
    entries.push([
      "cost",
      schema(m["cost"], "model.cost", { input: requireNumber, output: requireNumber, cacheRead: requireNumber, cacheWrite: requireNumber }, ["input", "output"]),
    ]);
  }
  if (keys.includes("params")) {
    const cloned = cloneValue(m["params"], "model.params", []);
    if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) throw new ModelSnapshotError("model.params", "必须是 plain object");
    entries.push(["params", cloned]);
  }
  if (keys.includes("thinkingLevelMap")) {
    const { obj: map, keys: levels } = plainKeys(m["thinkingLevelMap"], "model.thinkingLevelMap");
    const mapped: (readonly [string, ModelSnapshotValue])[] = [];
    for (const level of levels) {
      if (!THINKING_LEVELS.has(level)) throw new ModelSnapshotError(`model.thinkingLevelMap.${level}`, "不是 ThinkingLevel");
      // 值是要合并进请求体的参数字典（与 `params` 同一种自由 JSON-like），`null` = 这一档不发参数
      const value = map[level] === null ? null : cloneValue(map[level], `model.thinkingLevelMap.${level}`, []);
      if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
        throw new ModelSnapshotError(`model.thinkingLevelMap.${level}`, "必须是 plain object | null");
      }
      mapped.push([level, value]);
    }
    entries.push(["thinkingLevelMap", dict(mapped)]);
  }
  return dict(entries) as unknown as RunModelSnapshot;
}
