// 身份/框架字段的**校验即物化**（§15.4.1「attributes 只能用低基数安全值」的同族规矩）。
//
// 身份分两种，规矩不同：
//   · **构造期静态 identity**——runtimeId / generation / descriptor.instrumentation / sink owner / capturePolicy。
//     一次性、可提前拿到：构造时校验并**复制成内部 plain data**，之后再也不读 descriptor / ctx。
//     必须在构造期拒：这些字段只进 canonical envelope、不进 ephemeral fact，编码期才拒救不了
//     `/engine`——它根本看不见这些字段，于是同一条事实一边收下、一边成 gap。
//   · **逐记录动态 identity**——name / scope / correlation / subject / owner / instrumentation / generation。
//     每条记录都不同，不能 fail-loud（那会把 producer 的一次失误变成主流程异常），
//     用 `materializeDynamicIdentity()` 返回「违规原因」或「物化后的快照」，由调用方按各自 lane 的失败语义处理
//     （bounded → hole + gap；engine adapter → 丢一条 + 诊断）。**两条路调同一个函数**，才不会一边收一边成 gap。
//
// **只返回「通过」是不够的——必须返回快照**（review 实测的教训，两轮）：
//   ① 校验完还用 producer 的原对象，就留下 check/encode 之间的 TOCTOU 窗口。Proxy 检查时只露
//      `kind`/`id`、编码时再露 `content`，正文照样落盘；`id` getter 第一次返回 `"safe"`、第二次返回 `123`，
//      非法类型也照样落盘，且没有 gap、没有诊断。
//   ② 所以本模块**每个属性只读一次**，读到的值存进局部量、就地校验、再放进输出快照；
//      调用方之后只许编码这份快照，绝不回头碰原对象。输出全部 `Object.freeze`。
//   ③ identity 是**固定 schema**：白名单之外的键一律拒（多余键会原样落进 canonical envelope，
//      等于在身份区开一块不受 capture policy 管的自由字段区）；取值也只按白名单取，绝不遍历 producer 给的键。

import { readExactPlainDict } from "./normalize.ts";
import type { ObservationOwner, ObservationRecordKind } from "./types.ts";
import { OBSERVATION_IDENTITY_LIMITS } from "./types.ts";

const utf8 = new TextEncoder();

export class ObservationIdentityError extends Error {
  readonly code = "observation_identity_invalid";
  constructor(field: string, detail: string) {
    super(`观测身份字段 ${field} 非法：${detail}`);
    this.name = "ObservationIdentityError";
  }
}

/**
 * 逐键 `defineProperty` 造字典。**不能用 `out[key] = v`**：键名是 `__proto__` 时那是原型 setter，
 * 字段静默消失、输出对象原型还被改掉（review 实测）。同款实现见 `admission/model-snapshot.ts`。
 */
function safeDict<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of entries) Object.defineProperty(out, key, { value, enumerable: true, writable: false, configurable: false });
  return out;
}

/** 只报形状与字节数，**不回显原值**（它可能正是要防的东西）。 */
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** 身份串的三条判据：是 string、非空、UTF-8 不超上限。返回 `undefined` = 通过。 */
function identityViolation(v: unknown, field: string): string | undefined {
  if (typeof v !== "string") return `${field} 必须是 string，实际是 ${typeName(v)}`;
  if (v.length === 0) return `${field} 不能为空`;
  const n = utf8.encode(v).byteLength;
  if (n > OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes) {
    return `${field} ${n} 字节 > 上限 ${OBSERVATION_IDENTITY_LIMITS.maxIdentifierBytes}`;
  }
  return undefined;
}

/* ══════════════════ 构造期静态 identity：校验 + 冻结副本 ══════════════════ */

export function assertIdentifier(value: string, field: string): void {
  const v = identityViolation(value, field);
  if (v !== undefined) throw new ObservationIdentityError(field, v.slice(field.length + 1));
}

export function assertOptionalIdentifier(value: string | undefined, field: string): void {
  if (value !== undefined) assertIdentifier(value, field);
}

/**
 * 校验并**复制**成冻结的 plain data。只校验不复制是不够的：adapter 构造后把
 * `instrumentation.name` 改成 9,000 字节，`/engine` 照收而 Runtime 成 gap（review 实测）。
 */
export function freezeInstrumentation(v: Readonly<{ name: string; version: string }>, field: string): Readonly<{ name: string; version: string }> {
  const name = v.name;
  const version = v.version;
  assertIdentifier(name, `${field}.name`);
  assertIdentifier(version, `${field}.version`);
  return Object.freeze({ name, version });
}

export function freezeOwner(owner: ObservationOwner, field: string): ObservationOwner {
  switch (owner.status) {
    case "known": {
      const entryId = owner.entryId;
      const entryGeneration = owner.entryGeneration;
      const via = owner.via;
      assertIdentifier(entryId, `${field}.entryId`);
      assertIdentifier(entryGeneration, `${field}.entryGeneration`);
      if (via !== "assembly" && via !== "registry" && via !== "fiber") throw new ObservationIdentityError(`${field}.via`, `非法取值`);
      return Object.freeze({ status: "known" as const, entryId, entryGeneration, via });
    }
    case "unknown": {
      const reason = owner.reason;
      assertIdentifier(reason, `${field}.reason`);
      return Object.freeze({ status: "unknown" as const, reason });
    }
    case "not-applicable":
      return Object.freeze({ status: "not-applicable" as const });
    default:
      throw new ObservationIdentityError(field, `status 非法`);
  }
}

/* ══════════════════ 逐记录动态 identity：校验即物化 ══════════════════ */

/**
 * 各 identity 容器的**完整键集**。scope 用 envelope 的全集：`/engine` 的 fact scope 是它的子集，
 * 两边因此仍是同一把尺。
 */
const SCOPE_KEYS: readonly string[] = [
  "runtimeId",
  "agentId",
  "agentInstanceId",
  "sessionId",
  "runId",
  "turnId",
  "activityId",
  "submissionId",
  "toolCallId",
  "permissionId",
  "reloadId",
];
const CORRELATION_ID_KEYS: readonly string[] = ["traceId", "spanId", "parentSpanId", "causationId"];
const CORRELATION_KEYS: readonly string[] = [...CORRELATION_ID_KEYS, "links"];
const SUBJECT_KEYS: readonly string[] = ["kind", "id"];
const LINK_KEYS: readonly string[] = ["runtimeId", "recordId"];
const OWNER_KEYS: readonly string[] = ["status", "entryId", "entryGeneration", "via", "reason"];
const INSTRUMENTATION_KEYS: readonly string[] = ["name", "version"];
const GENERATION_KEYS: readonly string[] = ["runtime", "agentAssembly"];
const DISPOSE_OWNER_KEYS: readonly string[] = ["kind", "id"];

export type MaterializedLink = Readonly<{ runtimeId: string; recordId: string }>;

export type MaterializedIdentity = Readonly<{
  name: string;
  scope?: Readonly<Record<string, string>>;
  correlation?: Readonly<{
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    causationId?: string;
    links?: readonly MaterializedLink[];
  }>;
  subject?: Readonly<{ kind: string; id: string }>;
  owner?: ObservationOwner;
  instrumentation?: Readonly<{ name: string; version: string }>;
  generation?: Readonly<{ runtime: string; agentAssembly?: string }>;
  disposeOwner?: Readonly<{ kind: "agent" | "fiber"; id: string }>;
}>;

export type IdentityMaterialization =
  | Readonly<{ ok: true; identity: MaterializedIdentity }>
  | Readonly<{ ok: false; violation: string }>;

/** 一条观测记录里**两条路共有**的框架部分。engine fact 与 canonical envelope 都由它决定收不收。 */
export type MaterializedFrame = Readonly<{
  kind: ObservationRecordKind;
  occurredAt: number;
  sourceSeq?: number;
  attributes: Readonly<Record<string, string | number | boolean>>;
  identity: MaterializedIdentity;
}>;

export type FrameMaterialization =
  | Readonly<{ ok: true; frame: MaterializedFrame }>
  | Readonly<{ ok: false; violation: string }>;

const RECORD_KINDS: readonly string[] = ["event", "span_start", "span_end", "snapshot", "health"];

/**
 * **两条路共用的 frame 物化**：`/engine` adapter 与 Sequencer 都调它，同一条记录因此得到同一裁决。
 * 之前只有 Sequencer 校验 `kind`，于是 descriptor 返回 `kind:"bogus"` 时 engine collector 收下、
 * Runtime 成 gap（review 实测）。attributes 也在这里验形与物化——它是 envelope 的固定 schema 的一部分。
 */
export function materializeRecordFrame(input: unknown): FrameMaterialization {
  const fail = (violation: string): FrameMaterialization => ({ ok: false, violation });
  try {
    if (input === null || typeof input !== "object") return fail(`draft 必须是对象，实际是 ${typeName(input)}`);
    const d = input as Record<string, unknown>;

    const kind = d.kind; // ← 读一次
    if (typeof kind !== "string" || !RECORD_KINDS.includes(kind)) return fail(`kind 非法取值`);
    const occurredAt = d.occurredAt;
    if (typeof occurredAt !== "number" || !Number.isFinite(occurredAt)) return fail(`occurredAt 必须是有限数`);
    const sourceSeq = d.sourceSeq;
    if (sourceSeq !== undefined && (typeof sourceSeq !== "number" || !Number.isSafeInteger(sourceSeq) || sourceSeq < 0)) {
      return fail(`sourceSeq 必须是非负安全整数`);
    }

    // 走**共用的精确字典读取**：只判「是 object 且非 array」再 `Object.keys()` 的话，
    // `new Map([["toolName","secret"]])` 会得到 `[]`——非法容器在进 normalizer 之前就被洗成合法空字典
    // （review 实测 `ok:true` 而 attributes 是 `{}`）。原型、symbol 键、accessor、non-enumerable 一并拒。
    const attrs = readExactPlainDict(d.attributes, OBSERVATION_IDENTITY_LIMITS.maxAttributeKeys);
    if (!attrs.ok) return fail(`attributes ${attrs.reason}`);
    const attrEntries: (readonly [string, string | number | boolean])[] = [];
    for (const k of attrs.keys) {
      const v = attrs.values[k]; // ← descriptor 快照，绝不回读原容器
      if (typeof v === "string") {
        // **不套身份串那把尺**：attribute 装的是 toolName / customEventType 这类展示值，
        // 空串合法、长度上限也自成一条（review：套 identity 限制等于一条没写进契约的 ABI）。
        const n = utf8.encode(v).byteLength;
        if (n > OBSERVATION_IDENTITY_LIMITS.maxAttributeStringBytes) {
          return fail(`attributes 有字符串值 ${n} 字节 > 上限 ${OBSERVATION_IDENTITY_LIMITS.maxAttributeStringBytes}`);
        }
        attrEntries.push([k, v] as const);
      } else if (typeof v === "number") {
        if (!Number.isFinite(v)) return fail(`attributes 含非有限数`);
        attrEntries.push([k, v] as const);
      } else if (typeof v === "boolean") {
        attrEntries.push([k, v] as const);
      } else {
        return fail(`attributes 的值只许 string / 有限 number / boolean，实际有 ${typeName(v)}`);
      }
    }
    const attributes = safeDict(attrEntries);

    const id = materializeDynamicIdentity(input);
    if (!id.ok) return fail(id.violation);

    return {
      ok: true,
      frame: Object.freeze({
        kind: kind as ObservationRecordKind,
        occurredAt,
        ...(sourceSeq === undefined ? {} : { sourceSeq }),
        attributes: Object.freeze(attributes),
        identity: id.identity,
      }),
    };
  } catch {
    return fail("frame 读取失败");
  }
}

/**
 * 容器验形 + 键集封闭。
 * **不回显多余键的名字**：它由 producer 控制，而这条说明会进诊断——回显等于给了一条新的外泄通道。只报个数。
 */
const EMPTY_VALUES: Readonly<Record<string, unknown>> = Object.freeze(Object.create(null) as Record<string, unknown>);

type ContainerRead = Readonly<{ violation?: string; values: Readonly<Record<string, unknown>> }>;

/**
 * identity 容器：**先整份物化，再判白名单**。
 *
 * 走与 body / attributes 同一份精确字典读取——原来只查 symbol 键与未登记字段、**不查原型**，
 * `new Map([["runId","r1"]])` 的 `Object.keys()` 是 `[]`，非法容器就被洗成合法空 scope 一路放行。
 *
 * 返回值把「违规说明」与「已物化的合法字段」**分开**：坏字段不该连坐好字段。
 * `{ runId:"r1", nope:"x" }`、「另一个字段是 accessor / non-enumerable」这几种输入，
 * 上一版都会在校验阶段整份丢掉，`scope.runId` 跟着没了，gap 只能退成 runtime-scoped
 * （2026-08-27 review P1 实测）。
 */
function readContainer(v: unknown, field: string, allowed: readonly string[]): ContainerRead {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return { violation: `${field} 必须是对象，实际是 ${typeName(v)}`, values: EMPTY_VALUES };
  }
  const d = readExactPlainDict(v, OBSERVATION_IDENTITY_LIMITS.maxAttributeKeys);
  if (!d.ok) return { violation: `${field} 必须是 plain object：${d.reason}`, values: d.values };
  let extra = 0;
  for (const k of d.keys) if (!allowed.includes(k)) extra += 1;
  if (extra > 0) {
    return { violation: `${field} 含 ${extra} 个未登记字段（identity 是固定 schema，多余键一律拒）`, values: d.values };
  }
  return { values: d.values };
}

/** 从**已物化的快照**按白名单取值、校验、写进 out。返回违规说明或 undefined。 */
function takeStrings(
  src: Readonly<Record<string, unknown>>,
  field: string,
  keys: readonly string[],
  required: readonly string[],
  out: Record<string, string>,
): string | undefined {
  for (const k of keys) {
    const v = src[k]; // 快照是 null 原型的 plain data，读它不触发任何 trap
    if (v === undefined && !required.includes(k)) continue;
    const bad = identityViolation(v, `${field}.${k}`);
    if (bad !== undefined) return bad;
    out[k] = v as string;
  }
  return undefined;
}

const EMPTY_SCOPE: Readonly<Record<string, string>> = Object.freeze({});

/** 从已物化的快照里挑出**合法的** `runId`；挑不出就是 runtime-scoped。 */
function pickRunId(values: Readonly<Record<string, unknown>>): string | undefined {
  const v = values.runId;
  return typeof v === "string" && identityViolation(v, "scope.runId") === undefined ? v : undefined;
}

export type ScopeMaterialization =
  | Readonly<{ ok: true; scope: Readonly<Record<string, string>> }>
  | Readonly<{ ok: false; violation: string; runId?: string }>;

/**
 * 把**调用方供给的** scope 物化成稳定 plain snapshot（同 identity 的「校验即物化」）。
 *
 * 起因（2026-08-27 review P1，实测两个洞）：fact sink 原来只是 `ctx.scope?.() ?? {}` 外面包个 catch。
 * ① 供给抛错时被换成 `{}`，事实随后**当作 runtime-scoped 正常记下去**——gaps=0、diags=[]，
 *    原 run 仍可能显示 complete，run 归属就这么静默丢了。
 * ② 供给返回 Proxy 时，后面 `typeof callScope.runId === "string"` 这类读取在外层 try **之外**，
 *    get trap 一抛，`CapabilityFactSink.offer()` 的 never-throw 契约当场破。
 *
 * 所以 scope 必须**先物化再用**：一次读取、白名单键、值只许身份串，之后只碰快照。
 * 物化失败**不是**「当作没有 scope」，而是这条事实的 run 归属不可知——canonical 路径必须为它开 gap。
 *
 * 失败时尽量带回 `runId`：**整份容器先物化**，`runId` 从那份快照里挑，所以
 * `{ runId:"r1", nope:"x" }`、「别的字段是 accessor / non-enumerable」这几种输入的 gap 仍挂得到正确的 run。
 * 只有连键集都读不出来（非对象 / 非 plain 容器 / ownKeys trap 抛错）才退成 runtime-scoped——
 * 上一版说的是「只有供给自身炸掉才退化」，那句不成立，已按实情改口（§15.9）。
 */
export function materializeScope(raw: unknown): ScopeMaterialization {
  try {
    if (raw === undefined || raw === null) return { ok: true, scope: EMPTY_SCOPE };
    const c = readContainer(raw, "scope", SCOPE_KEYS);
    const runId = pickRunId(c.values);
    const withRunId = (violation: string): ScopeMaterialization =>
      runId === undefined ? { ok: false, violation } : { ok: false, violation, runId };
    if (c.violation !== undefined) return withRunId(c.violation);
    const out: Record<string, string> = {};
    const sv = takeStrings(c.values, "scope", SCOPE_KEYS, [], out);
    if (sv !== undefined) return withRunId(sv);
    return { ok: true, scope: Object.freeze(out) };
  } catch {
    // readContainer / takeStrings 里的反射被 trap 劫持；本函数是 total function
    return { ok: false, violation: "scope 读取失败" };
  }
}

export function materializeDynamicIdentity(input: unknown): IdentityMaterialization {
  const fail = (violation: string): IdentityMaterialization => ({ ok: false, violation });
  try {
    if (input === null || typeof input !== "object") return fail(`draft 必须是对象，实际是 ${typeName(input)}`);
    const d = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    const name = d.name;
    const nameV = identityViolation(name, "name");
    if (nameV !== undefined) return fail(nameV);
    out.name = name;

    const scope = d.scope;
    if (scope !== undefined) {
      const c = readContainer(scope, "scope", SCOPE_KEYS);
      if (c.violation !== undefined) return fail(c.violation);
      const materialized: Record<string, string> = {};
      const sv = takeStrings(c.values, "scope", SCOPE_KEYS, [], materialized);
      if (sv !== undefined) return fail(sv);
      out.scope = Object.freeze(materialized);
    }

    const correlation = d.correlation;
    if (correlation !== undefined) {
      const cc = readContainer(correlation, "correlation", CORRELATION_KEYS);
      if (cc.violation !== undefined) return fail(cc.violation);
      const c = cc.values;
      const materialized: Record<string, unknown> = {};
      const idv = takeStrings(c, "correlation", CORRELATION_ID_KEYS, [], materialized as Record<string, string>);
      if (idv !== undefined) return fail(idv);
      const links = c.links; // ← 已物化的快照值
      if (links !== undefined) {
        if (!Array.isArray(links)) return fail(`correlation.links 必须是数组，实际是 ${typeName(links)}`);
        // **length 也只读一次**：Proxy 能让它第一次返回 4、之后返回 5，硬上限就形同虚设（review 实测）。
        const count = links.length;
        if (count > OBSERVATION_IDENTITY_LIMITS.maxLinks) {
          return fail(`correlation.links ${count} 条 > 上限 ${OBSERVATION_IDENTITY_LIMITS.maxLinks}`);
        }
        // 只数条数不够：129 字节的 link.runtimeId 照样会落盘。逐成员验形 + 键集封闭 + 物化。
        const outLinks: MaterializedLink[] = [];
        for (let i = 0; i < count; i++) {
          const at = `correlation.links[${i}]`;
          if (!(i in links)) return fail(`${at} 是稀疏洞`);
          const link = links[i]; // ← 读一次
          const lc = readContainer(link, at, LINK_KEYS);
          if (lc.violation !== undefined) return fail(lc.violation);
          const m: Record<string, string> = {};
          const lv = takeStrings(lc.values, at, LINK_KEYS, LINK_KEYS, m);
          if (lv !== undefined) return fail(lv);
          outLinks.push(Object.freeze({ runtimeId: m.runtimeId!, recordId: m.recordId! }));
        }
        materialized.links = Object.freeze(outLinks);
      }
      out.correlation = Object.freeze(materialized);
    }

    const subject = d.subject;
    if (subject !== undefined) {
      const c = readContainer(subject, "subject", SUBJECT_KEYS);
      if (c.violation !== undefined) return fail(c.violation);
      const m: Record<string, string> = {};
      const sv = takeStrings(c.values, "subject", SUBJECT_KEYS, SUBJECT_KEYS, m);
      if (sv !== undefined) return fail(sv);
      out.subject = Object.freeze({ kind: m.kind!, id: m.id! });
    }

    const owner = d.owner;
    if (owner !== undefined) {
      const oc = readContainer(owner, "owner", OWNER_KEYS);
      if (oc.violation !== undefined) return fail(oc.violation);
      const o = oc.values;
      const status = o.status; // ← 已物化的快照值
      if (status === "not-applicable") {
        out.owner = Object.freeze({ status: "not-applicable" as const });
      } else if (status === "unknown") {
        const m: Record<string, string> = {};
        const ov = takeStrings(o, "owner", ["reason"], ["reason"], m);
        if (ov !== undefined) return fail(ov);
        out.owner = Object.freeze({ status: "unknown" as const, reason: m.reason! });
      } else if (status === "known") {
        const m: Record<string, string> = {};
        const ov = takeStrings(o, "owner", ["entryId", "entryGeneration"], ["entryId", "entryGeneration"], m);
        if (ov !== undefined) return fail(ov);
        const via = o.via; // ← 已物化的快照值
        if (via !== "assembly" && via !== "registry" && via !== "fiber") return fail(`owner.via 非法取值`);
        out.owner = Object.freeze({ status: "known" as const, entryId: m.entryId!, entryGeneration: m.entryGeneration!, via });
      } else {
        return fail(`owner.status 非法取值`);
      }
    }

    const instrumentation = d.instrumentation;
    if (instrumentation !== undefined) {
      const c = readContainer(instrumentation, "instrumentation", INSTRUMENTATION_KEYS);
      if (c.violation !== undefined) return fail(c.violation);
      const m: Record<string, string> = {};
      const iv = takeStrings(c.values, "instrumentation", INSTRUMENTATION_KEYS, INSTRUMENTATION_KEYS, m);
      if (iv !== undefined) return fail(iv);
      out.instrumentation = Object.freeze({ name: m.name!, version: m.version! });
    }

    const generation = d.generation;
    if (generation !== undefined) {
      const c = readContainer(generation, "generation", GENERATION_KEYS);
      if (c.violation !== undefined) return fail(c.violation);
      const m: Record<string, string> = {};
      const gv = takeStrings(c.values, "generation", GENERATION_KEYS, ["runtime"], m);
      if (gv !== undefined) return fail(gv);
      out.generation = Object.freeze({ ...m } as { runtime: string; agentAssembly?: string });
    }

    const disposeOwner = d.disposeOwner;
    if (disposeOwner !== undefined) {
      const c = readContainer(disposeOwner, "disposeOwner", DISPOSE_OWNER_KEYS);
      if (c.violation !== undefined) return fail(c.violation);
      const dRec = c.values;
      const kind = dRec.kind; // ← 已物化的快照值
      if (kind !== "agent" && kind !== "fiber") return fail(`disposeOwner.kind 非法取值`);
      const m: Record<string, string> = {};
      const dv = takeStrings(dRec, "disposeOwner", ["id"], ["id"], m);
      if (dv !== undefined) return fail(dv);
      out.disposeOwner = Object.freeze({ kind, id: m.id! });
    }

    return { ok: true, identity: Object.freeze(out) as MaterializedIdentity };
  } catch {
    // getter 抛错之类：当作违规，绝不把异常放回调用方（它可能正在 `offer()` 的 no-throw 路径上）
    return fail("identity 读取失败");
  }
}
