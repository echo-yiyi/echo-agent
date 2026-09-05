// `run.closed` 的 preflight（「boundary body 必须按构造有界」/ optional projection fallback）。
//
// 纯函数、不依赖 Runtime admission（review：O2a 要能独立验「超限自动降级、run.closed 仍 stored、下一 admission
// 可继续」）。规则：
//   · outcome 里的 finishReason / errorCode 超过 maxSafeStringBytes → **required safe body 非法**，抛
//     `ObservationEncodingError`；调用方按 required failure 处理（hole + gap + reject）。不静默截断。
//   · capability summary：非法（schemaVersion / counters / flags 超 key 数 / 单项超 1 KiB）的**丢掉**；按 id 排序
//     后超过 maxCapabilitySummaries 的丢掉；丢了几个记 `omittedCapabilitySummaryCount`，并要求一条
//     subject=`run.final_snapshot.capabilities` 的 capture_limit gap。
//   · 整个 body（含 snapshot）在 boundary 预算内则通过；否则 `finalSnapshot:null`，要求一条
//     subject=`run.final_snapshot` 的 capture_limit gap；去掉 snapshot 后 required body 仍非法才抛。
// 预算按 body 量时先扣掉 envelope 头（identity / scope / correlation …）的份额，避免 preflight 过了、
// 带上 envelope 又超。

import { ObservationEncodingError, boundaryEncodingLimits, encodeCanonical, readExactPlainDict, type EncodingLimits } from "./normalize.ts";
import type { CapabilityObservationSummary, EchoObservableState, RunClosedBodyInput, RunClosedOutcomeObservation } from "./types.ts";
import { OBSERVATION_BOUNDARY_LIMITS } from "./types.ts";

export type TerminalProjectionGapSubject = "run.final_snapshot" | "run.final_snapshot.capabilities";

export type TerminalProjection = Readonly<{
  body: RunClosedBodyInput;
  /** 需要 Sequencer 在预留 run.closed 之前依次预留的 optional projection gap。 */
  projectionGaps: readonly TerminalProjectionGapSubject[];
  /** 本次新省略的条数（不含 caller 传进来的存量）。 */
  omittedCapabilitySummaries: number;
}>;

/** envelope 头在 body 之外占的预算。 */
export const TERMINAL_ENVELOPE_RESERVE = { bytes: 4 * 1024, depth: 1, nodes: 64 } as const;

const utf8 = new TextEncoder();

function bodyLimits(): EncodingLimits {
  const b = boundaryEncodingLimits();
  return {
    maxBytes: b.maxBytes - TERMINAL_ENVELOPE_RESERVE.bytes,
    maxValueDepth: b.maxValueDepth - TERMINAL_ENVELOPE_RESERVE.depth,
    maxValueNodes: b.maxValueNodes - TERMINAL_ENVELOPE_RESERVE.nodes,
    maxBlobChunkBytes: 0,
  };
}

function assertSafeString(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ObservationEncodingError("unsupported_value", path, "必须是 string");
  const n = utf8.encode(v).byteLength;
  if (n > OBSERVATION_BOUNDARY_LIMITS.maxSafeStringBytes) {
    throw new ObservationEncodingError("bytes_exceeded", path, `${n} > maxSafeStringBytes ${OBSERVATION_BOUNDARY_LIMITS.maxSafeStringBytes}`);
  }
  return v;
}

const RUN_CLOSED_STATUSES: readonly string[] = ["completed", "aborted", "error"];

/**
 * **required outcome 也要物化**：检查完仍用原对象的话，getter 第一次返回 `"ok"`、之后返回 257 字节，
 * preflight 不抛而 body 里留下超限值（review 实测）。这里每个字段只读一次、验完写进冻结副本，
 * 后续路径只用副本。它是 required safe body，违规**抛**而不是降级。
 */
function projectOutcome(raw: unknown): RunClosedOutcomeObservation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ObservationEncodingError("unsupported_value", "$.outcome", "必须是对象");
  }
  const o = raw as Record<string, unknown>;
  const status = o.status; // ← 读一次
  if (typeof status !== "string" || !RUN_CLOSED_STATUSES.includes(status)) {
    throw new ObservationEncodingError("unsupported_value", "$.outcome.status", "非法取值");
  }
  const finishReason = assertSafeString(o.finishReason, "$.outcome.finishReason");
  const errorCode = assertSafeString(o.errorCode, "$.outcome.errorCode");
  const outputDigest = assertSafeString(o.outputDigest, "$.outcome.outputDigest");
  const errorDigest = assertSafeString(o.errorDigest, "$.outcome.errorDigest");
  const outputBytes = o.outputBytes; // ← 读一次
  if (outputBytes !== undefined && (typeof outputBytes !== "number" || !Number.isSafeInteger(outputBytes) || outputBytes < 0)) {
    throw new ObservationEncodingError("unsupported_value", "$.outcome.outputBytes", "必须是非负安全整数");
  }
  return Object.freeze({
    status: status as RunClosedOutcomeObservation["status"],
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(outputBytes === undefined ? {} : { outputBytes }),
    ...(outputDigest === undefined ? {} : { outputDigest }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorDigest === undefined ? {} : { errorDigest }),
  });
}

/* ══════════════════ 校验即物化：只留经 schema 验过的 plain-data 精确副本 ══════════════════ */
//
// 只返回 boolean 是不够的（review 实测）：验完仍 `kept.push(rawCaps[i])` 的话，capability 的 `id` getter
// 第一次返回 `"safe"`、之后返回 `123`，`run.closed` 最终落盘 `capabilities[0].id === 123` 且
// `projectionGaps === []`——canonical schema 非法却被标为完整。所以每个字段**只读一次**、就地校验、
// 写进新对象；返回的副本不含 getter、Proxy 或任何可变引用。

type CapabilityEntry = Readonly<{ id: string; digest: string; summary: CapabilityObservationSummary }>;

/** 逐键 `defineProperty`：`__proto__` 这种键也只是自身属性，改不了输出对象的原型（同 model-snapshot）。 */
function safeDict<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of entries) Object.defineProperty(out, key, { value, enumerable: true, writable: false, configurable: false });
  return out;
}

function takeIdentifier(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function takeCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

function takeEnum<T extends string>(v: unknown, allowed: readonly string[]): T | undefined {
  return typeof v === "string" && allowed.includes(v) ? (v as T) : undefined;
}

const RUNTIME_PHASES: readonly string[] = ["bootstrapping", "ready", "reconfiguring", "failed", "disposing", "disposed"];
const RUNTIME_STATUSES: readonly string[] = [...RUNTIME_PHASES, "degraded"];
const PERSISTENCE_STATUSES: readonly string[] = ["healthy", "degraded", "recovering", "sealed", "lost-lease"];

/** 把 `Record<string, number>` 物化成新对象；键数超限或值非有限数 → undefined。 */
function projectNumberMap(raw: unknown, maxKeys: number): Record<string, number> | undefined {
  // 与 attributes 共用同一份精确字典读取：`new Map([["writes",1]])` 曾被静默投影成 `counters:{}`，
  // 省略计数仍是 0、没有 capture gap，RunObservation 还标 complete（review 实测）。
  const dict = readExactPlainDict(raw, maxKeys);
  if (!dict.ok) return undefined;
  const entries: (readonly [string, number])[] = [];
  for (const k of dict.keys) {
    const v = dict.values[k]; // ← descriptor 快照，绝不回读原容器
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    entries.push([k, v] as const);
  }
  return safeDict(entries);
}

function projectBooleanMap(raw: unknown, maxKeys: number): Record<string, boolean> | undefined {
  const dict = readExactPlainDict(raw, maxKeys);
  if (!dict.ok) return undefined;
  const entries: (readonly [string, boolean])[] = [];
  for (const k of dict.keys) {
    const v = dict.values[k]; // ← descriptor 快照，绝不回读原容器
    if (typeof v !== "boolean") return undefined;
    entries.push([k, v] as const);
  }
  return safeDict(entries);
}

/** **整个函数体都在保护里**：summary 来自各 Capability 的投影，形状不受本模块控制。任何异常只意味着「省略这条」。 */
function projectSummary(raw: unknown): CapabilityObservationSummary | undefined {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const s = raw as Record<string, unknown>;
    if (s.schemaVersion !== 1) return undefined;
    const stateDigest = takeIdentifier(s.stateDigest);
    if (stateDigest === undefined) return undefined;
    const detailBytes = takeCount(s.detailBytes);
    if (detailBytes === undefined) return undefined;
    const detailTruncated = s.detailTruncated;
    if (typeof detailTruncated !== "boolean") return undefined;
    const counters = projectNumberMap(s.counters, OBSERVATION_BOUNDARY_LIMITS.maxCapabilityCounters);
    if (counters === undefined) return undefined;
    const rawFlags = s.flags;
    let flags: Record<string, boolean> | undefined;
    if (rawFlags !== undefined) {
      flags = projectBooleanMap(rawFlags, OBSERVATION_BOUNDARY_LIMITS.maxCapabilityFlags);
      if (flags === undefined) return undefined;
    }
    const out: CapabilityObservationSummary = Object.freeze({
      schemaVersion: 1 as const,
      stateDigest,
      counters: Object.freeze(counters),
      ...(flags === undefined ? {} : { flags: Object.freeze(flags) }),
      detailBytes,
      detailTruncated,
    });
    const l = bodyLimits();
    // 单项字节上限，量的是**副本**
    encodeCanonical(out, { maxBytes: OBSERVATION_BOUNDARY_LIMITS.maxCapabilitySummaryBytes, maxValueDepth: l.maxValueDepth, maxValueNodes: l.maxValueNodes, maxBlobChunkBytes: 0 });
    return out;
  } catch {
    return undefined;
  }
}

/** 外层 entry 同样物化：id / digest 各读一次并验形，summary 换成物化副本。 */
function projectCapabilityEntry(c: unknown): CapabilityEntry | undefined {
  try {
    if (c === null || typeof c !== "object" || Array.isArray(c)) return undefined;
    const e = c as Record<string, unknown>;
    const id = takeIdentifier(e.id);
    if (id === undefined) return undefined;
    const digest = takeIdentifier(e.digest);
    if (digest === undefined) return undefined;
    const summary = projectSummary(e.summary);
    if (summary === undefined) return undefined;
    return Object.freeze({ id, digest, summary });
  } catch {
    return undefined;
  }
}

/** runtime / agent 两块是可选投影的**必需结构**：任一不合法 → 整份 snapshot 丢掉（由调用方开 gap）。 */
function projectObservableState(raw: unknown, kept: readonly CapabilityEntry[], omittedTotal: number): EchoObservableState | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const st = raw as Record<string, unknown>;

  const rt = st.runtime;
  if (rt === null || typeof rt !== "object" || Array.isArray(rt)) return undefined;
  const r = rt as Record<string, unknown>;
  // 枚举要按白名单验，不能只验「非空字符串」——否则 phase:"banana" / status:"kumquat" /
  // observationPersistence:"papaya" 全都能进 final snapshot 且 projectionGaps=[]（review 实测）。
  const phase = takeEnum(r.phase, RUNTIME_PHASES);
  const status = takeEnum(r.status, RUNTIME_STATUSES);
  const persistence = takeEnum(r.observationPersistence, PERSISTENCE_STATUSES);
  const generation = takeIdentifier(r.generation);
  const activeEntryCount = takeCount(r.activeEntryCount);
  if (phase === undefined || status === undefined || persistence === undefined || generation === undefined || activeEntryCount === undefined) return undefined;

  const ag = st.agent;
  if (ag === null || typeof ag !== "object" || Array.isArray(ag)) return undefined;
  const a = ag as Record<string, unknown>;
  const agentStatus = takeIdentifier(a.status);
  const iteration = takeCount(a.iteration);
  const messageCount = takeCount(a.messageCount);
  if (agentStatus === undefined || iteration === undefined || messageCount === undefined) return undefined;
  const activeRunId = a.activeRunId;
  const activeTurnId = a.activeTurnId;
  if (activeRunId !== null && takeIdentifier(activeRunId) === undefined) return undefined;
  if (activeTurnId !== null && takeIdentifier(activeTurnId) === undefined) return undefined;

  return Object.freeze({
    runtime: Object.freeze({
      phase: phase as EchoObservableState["runtime"]["phase"],
      status: status as EchoObservableState["runtime"]["status"],
      observationPersistence: persistence as EchoObservableState["runtime"]["observationPersistence"],
      generation,
      activeEntryCount,
    }),
    agent: Object.freeze({
      status: agentStatus,
      activeRunId: activeRunId as string | null,
      activeTurnId: activeTurnId as string | null,
      iteration,
      messageCount,
    }),
    capabilities: Object.freeze(kept),
    omittedCapabilitySummaryCount: omittedTotal,
  }) as EchoObservableState;
}

/**
 * 可选 snapshot 的投影。**任何问题都返回 `undefined`（= 整份丢掉）**，绝不抛：
 * 容器不是数组（`capabilities:null`）、长度超扫描上限、必需结构不合法、中途 getter 抛错——
 * 全都只意味着「这份可选投影不要了」，由调用方换成 `finalSnapshot:null` + capture gap。
 */
function tryProjectSnapshot(
  snapshot: NonNullable<RunClosedBodyInput["finalSnapshot"]>,
): Readonly<{ snapshot: NonNullable<RunClosedBodyInput["finalSnapshot"]>; omitted: number }> | undefined {
  try {
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
    const throughSeq = takeCount(snapshot.throughSeq);
    const at = takeCount(snapshot.at);
    if (throughSeq === undefined || at === undefined) return undefined;
    const state = snapshot.state;
    if (state === null || typeof state !== "object") return undefined;
    const rawCaps = (state as { capabilities?: unknown }).capabilities;
    if (!Array.isArray(rawCaps)) return undefined;
    // **length 只读一次**：Proxy 能让它检查时返回 1,024、循环时返回 1,025，硬上限被绕过，
    // 更大的数组还会把同步封口路径重新拖成无界扫描（review 实测）。
    const capCount = rawCaps.length;
    if (capCount > OBSERVATION_BOUNDARY_LIMITS.maxCapabilityScan) return undefined;
    const prior = takeCount((state as { omittedCapabilitySummaryCount?: unknown }).omittedCapabilitySummaryCount);
    if (prior === undefined) return undefined;

    // **逐下标走，不用 `.filter()`**：稀疏洞会被 filter 静默跳过——omitted 归零、没有 capture gap，
    // 于是真实省略被伪装成 complete。每条都物化成副本，之后不再碰原 entry。
    let omitted = 0;
    const kept: CapabilityEntry[] = [];
    for (let i = 0; i < capCount; i++) {
      const projected = i in rawCaps ? projectCapabilityEntry(rawCaps[i]) : undefined;
      if (projected === undefined) {
        omitted += 1;
        continue;
      }
      kept.push(projected);
    }
    kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (kept.length > OBSERVATION_BOUNDARY_LIMITS.maxCapabilitySummaries) {
      omitted += kept.length - OBSERVATION_BOUNDARY_LIMITS.maxCapabilitySummaries;
      kept.length = OBSERVATION_BOUNDARY_LIMITS.maxCapabilitySummaries;
    }
    const projectedState = projectObservableState(state, kept, prior + omitted);
    if (projectedState === undefined) return undefined;
    return { snapshot: Object.freeze({ throughSeq, at, state: projectedState }), omitted };
  } catch {
    return undefined;
  }
}

export function preflightTerminalProjection(input: RunClosedBodyInput): TerminalProjection {
  // required safe body：物化并校验，违规是真失败——不降级、不截断。之后只用这份冻结副本，
  // 绝不回头读 `input.outcome`（那正是 getter 变脸能钻的空子）。
  const outcome = projectOutcome(input.outcome);
  const finalSnapshot = input.finalSnapshot; // ← 读一次
  const limits = bodyLimits();

  if (finalSnapshot === null) {
    const bare: RunClosedBodyInput = { outcome, finalSnapshot: null };
    encodeCanonical(bare, limits); // required safe body 非法 → 抛
    return { body: bare, projectionGaps: [], omittedCapabilitySummaries: 0 };
  }

  const projected = tryProjectSnapshot(finalSnapshot);
  if (projected !== undefined) {
    const withSnapshot: RunClosedBodyInput = { outcome, finalSnapshot: projected.snapshot };
    try {
      encodeCanonical(withSnapshot, limits);
      // **任何**省略都要有 gap 覆盖，包括 caller 传进来的存量——否则会出现「snapshot 自报省略了 5 条，
      // 而 RunIndex 仍 complete」这种自相矛盾的记录（review P1）。
      const anyOmission = projected.snapshot.state.omittedCapabilitySummaryCount > 0;
      return {
        body: withSnapshot,
        projectionGaps: anyOmission ? ["run.final_snapshot.capabilities"] : [],
        omittedCapabilitySummaries: projected.omitted,
      };
    } catch (e) {
      if (!(e instanceof ObservationEncodingError)) throw e;
    }
  }
  // 可选 snapshot 整体省略：投影本身失败（容器损坏 / 扫描超限）或编完仍超预算，都走这条。
  // required body 仍非法才抛——只有那时才是真的封不了口。
  const stripped: RunClosedBodyInput = { outcome, finalSnapshot: null };
  encodeCanonical(stripped, limits);
  return { body: stripped, projectionGaps: ["run.final_snapshot"], omittedCapabilitySummaries: projected?.omitted ?? 0 };
}
