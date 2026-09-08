// Memory 的领域观测（Memory 行）：module-local fact union + descriptor，与语义 owner 共址。
//
// 事实只在**唯一 emission point** 产生——五种公开 mutation 的最外层 `finishMemoryMutation()`（harness.ts），
// 在 semantic reject、primary storage settle 与 index refresh outcome 都已知之后恰发一次；compose 在
// `renderMemorySystem()` 出数据的那一刻发一次。这里不 import Sequencer，也不知道 tap 长什么样。
//
// 隐私（OR9）：metadata 档只留 partition / mode / operation / stage / outcome 与 **pathDigest**
// （`HMAC-SHA256(observationPathKey, normalizedPath)`，跨 run 可关联、不可枚举明文）；错误原文只投 reasonCode + digest。
// content 档才带 normalized path 与原文。**digest 放 body 不放 attributes**——它是高基数值。

import type { CapabilityFactDescriptor, ObservationFactProjection } from "../observability/fact-sink.ts";
import { hmacSha256Hex, sha256Hex } from "../observability/hash.ts";
import type { ObservationCapturePolicy } from "../observability/types.ts";

export type MemoryOperation = "create" | "replace" | "insert" | "delete" | "rename";

export type MemoryMutationOutcome = "committed" | "rejected" | "failed" | "partial";

/** 失败 / 半提交发生在哪一段：read（读现有内容）/ check（写入校验）/ write（主存储写）/ remove（删）/ remove-source（rename 的第二段） */
export type MemoryMutationStage = "read" | "check" | "write" | "remove" | "remove-source";

/** `refreshIndex()` 的结果：非 indexed 模块 not-applicable；重建失败仍 report 不抛，但要让 outcome 可见。 */
export type MemoryIndexOutcome = "not-applicable" | "ok" | "failed";

export type MemoryFact =
  | Readonly<{
      kind: "mutation";
      operation: MemoryOperation;
      outcome: MemoryMutationOutcome;
      /** normalized memory path（rename 是 from）。只进 digest / content。 */
      path: string;
      /** rename 的目标。 */
      toPath?: string;
      partition?: string;
      mode?: string;
      /** committed 时写入后的字符数。 */
      chars?: number;
      stage?: MemoryMutationStage;
      indexOutcome?: MemoryIndexOutcome;
      /** rejected / failed / partial 的低基数分类；原文只在 content 档出现。 */
      reasonCode?: string;
      message?: string;
      occurredAt: number;
    }>
  | Readonly<{
      kind: "compose";
      regions: number;
      blocks: number;
      chars: number;
      occurredAt: number;
    }>;

export const MEMORY_INSTRUMENTATION = { name: "echo.memory", version: "1" } as const;

export type MemoryFactDescriptorOptions = Readonly<{
  /** observation SQLite 首建时生成的 32 字节 key（`ObservationRuntime.pathDigestKey`）；测试可给固定 key。 */
  pathDigestKey: Uint8Array | string;
}>;

/** descriptor 工厂：key 在构造期钉住，之后 project 是纯函数。 */
export function memoryFactDescriptor(opts: MemoryFactDescriptorOptions): CapabilityFactDescriptor<MemoryFact> {
  const key = opts.pathDigestKey;
  const digest = (path: string): string => hmacSha256Hex(key, path);
  return {
    instrumentation: MEMORY_INSTRUMENTATION,
    project(fact: MemoryFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
      if (policy === "off") return null;
      const content = policy === "content";
      if (fact.kind === "compose") {
        return {
          occurredAt: fact.occurredAt,
          kind: "event",
          name: "memory.compose",
          scope: {},
          attributes: { regions: fact.regions, blocks: fact.blocks },
          body: { regions: fact.regions, blocks: fact.blocks, chars: fact.chars },
        };
      }
      const attributes: Record<string, string | number | boolean> = { operation: fact.operation, outcome: fact.outcome };
      if (fact.partition !== undefined) attributes.partition = fact.partition;
      if (fact.mode !== undefined) attributes.mode = fact.mode;
      if (fact.stage !== undefined) attributes.stage = fact.stage;
      if (fact.indexOutcome !== undefined) attributes.indexOutcome = fact.indexOutcome;
      if (fact.reasonCode !== undefined) attributes.reasonCode = fact.reasonCode;
      const body: Record<string, unknown> = {
        operation: fact.operation,
        outcome: fact.outcome,
        ...(fact.partition === undefined ? {} : { partition: fact.partition }),
        ...(fact.mode === undefined ? {} : { mode: fact.mode }),
        ...(fact.operation === "rename" ? { fromPathDigest: digest(fact.path), toPathDigest: digest(fact.toPath ?? "") } : { pathDigest: digest(fact.path) }),
        ...(fact.chars === undefined ? {} : { chars: fact.chars }),
        ...(fact.stage === undefined ? {} : { stage: fact.stage }),
        ...(fact.indexOutcome === undefined ? {} : { indexOutcome: fact.indexOutcome }),
        ...(fact.reasonCode === undefined ? {} : { reasonCode: fact.reasonCode }),
        // metadata 只投 digest：`AgentToolResult` 的错误原文常内嵌明文 path，不能借 rejected / failed body 带回来
        ...(fact.message === undefined ? {} : { reasonDigest: sha256Hex(fact.message) }),
      };
      if (content) {
        body.path = fact.path;
        if (fact.toPath !== undefined) body.toPath = fact.toPath;
        if (fact.message !== undefined) body.message = fact.message;
      }
      return {
        occurredAt: fact.occurredAt,
        kind: "event",
        name: `memory.mutation.${fact.outcome}`,
        scope: {},
        attributes,
        body,
      };
    },
  };
}
