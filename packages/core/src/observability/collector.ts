// `/testing` 的 in-memory collector（§15.6，OR14）：Eval / Evolve 与 `/engine` 纯 loop fixture 用它同时收
// AgentEvent 投影与内建 Capability fact。
//
// 只会接收：有界、no-throw、不执行用户 callback；overflow 只进 collector 自己的诊断。
// 输出是 ephemeral `EngineObservationFact`，没有 canonical identity——删掉它或让它坏掉都不改 Agent outcome。

import type { Diagnostic } from "../errors.ts";
import type { EngineObservationFact, EngineObservationTap } from "./engine-tap.ts";
import { ObservationEncodingError, encodeCanonical, projectionEncodingLimits } from "./normalize.ts";
import { redactedLabel } from "./redact.ts";
import type { ObservationCapturePolicy } from "./types.ts";

export type EngineObservationCollector = Readonly<{
  tap: EngineObservationTap;
  /** 只读快照（拷贝），按到达顺序。 */
  snapshot(): readonly EngineObservationFact[];
  /** 超过 capacity 被丢的条数。 */
  readonly overflowCount: number;
  /** 单条超出 `OBSERVATION_SYNC_LIMITS`（整条 fact 的 bytes / depth / nodes）被拒的条数。 */
  readonly rejectedCount: number;
  readonly diagnostics: readonly Diagnostic[];
  clear(): void;
}>;

export const DEFAULT_COLLECTOR_CAPACITY = 10_000;

/**
 * 诊断自己的上限。被拒的 fact **不进 `facts`**，所以永远撞不到 capacity——如果每次拒收都追加一条诊断，
 * 一场长评测里 `diagnostics` 就是无界增长（实测 rejected 5000 → diagnostics 5000），
 * 「bounded / 不影响宿主」的承诺当场作废（review P1）。
 * 于是：每类原因只留**第一条**样本，其余只累加计数；这个上限是给未知新类别兜底的。
 */
export const DEFAULT_COLLECTOR_DIAGNOSTIC_CAPACITY = 64;

export function createInMemoryEngineObservationCollector(
  opts: Readonly<{ capturePolicy: ObservationCapturePolicy; capacity?: number; diagnosticCapacity?: number }>,
): EngineObservationCollector {
  const capacity = opts.capacity ?? DEFAULT_COLLECTOR_CAPACITY;
  const diagnosticCapacity = opts.diagnosticCapacity ?? DEFAULT_COLLECTOR_DIAGNOSTIC_CAPACITY;
  const facts: EngineObservationFact[] = [];
  let diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  let overflow = 0;
  let rejected = 0;
  /** 同一 code 只留第一条样本；重复只累加计数，绝不逐条追加。 */
  const noteOnce = (code: string, message: string): void => {
    if (reported.has(code) || diagnostics.length >= diagnosticCapacity) return;
    reported.add(code);
    diagnostics.push({ code, message });
  };
  const tap: EngineObservationTap = {
    capturePolicy: opts.capturePolicy,
    offer(fact: EngineObservationFact): void {
      try {
        if (facts.length >= capacity) {
          overflow += 1;
          noteOnce("collector_overflow", `超过 capacity ${capacity}，后续 fact 丢弃（只报第一次，见 overflowCount）`);
          return;
        }
        // 「bounded」不只是条数：单条也按与 canonical 路径共享的 projection 预算量（bytes / depth / nodes），
        // 否则同一事实在评测面能进、在 Runtime 面成 gap，两面语义分叉（review P1）。
        let encoded: EngineObservationFact;
        try {
          encoded = encodeCanonical(fact, projectionEncodingLimits()).value as unknown as EngineObservationFact;
        } catch (e) {
          if (!(e instanceof ObservationEncodingError)) throw e;
          rejected += 1;
          // 只报 code 分类，不带 path / 原文——path 可能含被观测方的对象键
          noteOnce("collector_fact_rejected", `单条超出 projection 预算（首例 ${fact.name}：${e.code}，见 rejectedCount）`);
          return;
        }
        facts.push(encoded);
      } catch (e) {
        noteOnce("collector_internal", redactedLabel(e));
      }
    },
  };
  return {
    tap,
    snapshot: () => [...facts],
    get overflowCount() {
      return overflow;
    },
    get rejectedCount() {
      return rejected;
    },
    get diagnostics() {
      return [...diagnostics];
    },
    clear: () => {
      facts.length = 0;
      diagnostics = [];
      reported.clear();
      overflow = 0;
      rejected = 0;
    },
  };
}
