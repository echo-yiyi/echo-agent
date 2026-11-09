// Memory 的领域观测（Memory 行）：module-local fact union + descriptor，与语义 owner 共址。
//
// 事实只在**唯一 emission point** 产生——五种公开 mutation 的最外层 `finishMemoryMutation()`（harness.ts），
// 在 semantic reject、primary storage settle 与 index refresh outcome 都已知之后恰发一次；compose 在
// `renderMemorySystem()` 出数据的那一刻（或沿用冻结那份的那一刻）发一次。这里不 import Sequencer，也不知道 tap 长什么样。
//
// 后台两件事的**门**（观测白盒化 B）：提取没跑（`extract_skipped`）、整理每一层判了什么（`dream_evaluated`），
// 各带一个封闭的原因码，放行的提取不记（它自己是一个子循环 run）。这两条是 run 之外的活动：判的那一刻
// 触发它的 run 可能已经封口（封口后的 run 不再收记录），所以不挂 run，`runId` 属性只是链回那个 run 的引用。
//
// 隐私（OR9）：metadata 档只留 partition / mode / operation / stage / outcome 与 **pathDigest**
// （`HMAC-SHA256(observationPathKey, normalizedPath)`，跨 run 可关联、不可枚举明文）；错误原文只投 reasonCode + digest。
// content 档才带 normalized path 与原文。**digest 放 body 不放 attributes**——它是高基数值。
// 摘要由观测线程算（投影只声明 `digests`，fact-sink.ts）：key 在观测线程里，节点上不算哈希。

import type { CapabilityFactDescriptor, ObservationFactProjection } from "../observability/fact-sink.ts";
import type { ObservationCapturePolicy } from "../observability/types.ts";

export type MemoryOperation = "create" | "replace" | "insert" | "delete" | "rename";

export type MemoryMutationOutcome = "committed" | "rejected" | "failed" | "partial";

/** 失败 / 半提交发生在哪一段：read（读现有内容）/ check（写入校验）/ write（主存储写）/ remove（删）/ remove-source（rename 的第二段） */
export type MemoryMutationStage = "read" | "check" | "write" | "remove" | "remove-source";

/** `refreshIndex()` 的结果：非 indexed 模块 not-applicable；重建失败仍 report 不抛，但要让 outcome 可见。 */
export type MemoryIndexOutcome = "not-applicable" | "ok" | "failed";

/**
 * 提取这次没跑的原因（封闭集）：
 *   · `not_allowed`：收摊中或丢了锁，后台改记忆已关闸；
 *   · `no_scope`：作用域还没绑（还没跑过 run）；
 *   · `no_modules`：一个记忆模块都没有，没地方可写；
 *   · `overlap`：这条 reply 前台自己写过记忆（游标不动，下次连同这段一起看）；
 *   · `epoch_changed`：transcript 被清空或换掉了；
 *   · `empty_range`：游标之后没有新消息（前一次提取已经看过）；
 *   · `too_short`：游标之后用户亲口说的话没攒够；
 *   · `too_few_turns`：轮数没攒满；
 *   · `aborted`：排队等的时候被中止（stop / 丢锁）。
 */
export type ExtractSkipReason = "not_allowed" | "no_scope" | "no_modules" | "overlap" | "epoch_changed" | "empty_range" | "too_short" | "too_few_turns" | "aborted";

/**
 * 整理对一层判了什么（封闭集）。前两个是开整，其余是跳过：
 *   · `budget`：水位到线（某个模块预算用到比例），单独成立；
 *   · `due`：节流四道全满足；
 *   · `in_progress`：这一层有一次整理还在进行（锁没过期）；
 *   · `too_soon`：距上次整理不够间隔；
 *   · `few_writes` / `few_turns` / `few_files`：写入次数 / 轮数 / 文件数没攒够；
 *   · `locked`：别的会话正在整理这一层（试拿锁没拿到）。
 */
export type DreamDecision = "budget" | "due" | "in_progress" | "too_soon" | "few_writes" | "few_turns" | "few_files" | "locked";

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
      /** committed 的写入（create / replace / insert）：写成的整份内容与写之前的那份。只是引用，`content` 档才存成 blob。 */
      content?: string;
      before?: string;
      occurredAt: number;
    }>
  | Readonly<{
      kind: "compose";
      /**
       * true = 沿用会话里冻结的那份（`MemorySystemFreeze`），没重读盘——这时没有组装，模块数 / 块数 / 字数都没有
       * （这一段在 system 里多大，看同一个 run 的 `prompt.assembled` 里 `memory` 那段）。
       */
      reused: boolean;
      regions?: number;
      blocks?: number;
      /** 组装出的各块正文的字符数合计（不含段标题与说明）。 */
      chars?: number;
      occurredAt: number;
    }>
  | Readonly<{
      kind: "extract_skipped";
      reason: ExtractSkipReason;
      /** 退出前那次补跑（不看攒了几轮）。 */
      force: boolean;
      /** 触发它的那个 run（reply 收尾时排进提取通道的那一个）。 */
      triggeredBy?: string;
      occurredAt: number;
    }>
  | Readonly<{
      kind: "dream_evaluated";
      /** 哪一层（`user` / `project` …）。 */
      layer: string;
      decision: DreamDecision;
      /** 开整时那次整理子循环的 runId。 */
      dreamRunId?: string;
      triggeredBy?: string;
      occurredAt: number;
    }>;

export const MEMORY_INSTRUMENTATION = { name: "echo.memory", version: "1" } as const;

/** Memory 的 descriptor：project 是纯函数。 */
export const memoryFactDescriptor: CapabilityFactDescriptor<MemoryFact> = {
  instrumentation: MEMORY_INSTRUMENTATION,
  project(fact: MemoryFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
    if (policy === "off") return null;
    const content = policy === "content";
    if (fact.kind === "compose") {
      const counts = { ...(fact.regions === undefined ? {} : { regions: fact.regions }), ...(fact.blocks === undefined ? {} : { blocks: fact.blocks }) };
      return {
        occurredAt: fact.occurredAt,
        kind: "event",
        name: "memory.compose",
        scope: {},
        attributes: { reused: fact.reused, ...counts },
        body: { reused: fact.reused, ...counts, ...(fact.chars === undefined ? {} : { chars: fact.chars }) },
      };
    }
    if (fact.kind === "extract_skipped") {
      const link: Record<string, string> = fact.triggeredBy === undefined ? {} : { runId: fact.triggeredBy };
      return {
        occurredAt: fact.occurredAt,
        kind: "event",
        name: "memory.extract.skipped",
        scope: {},
        attributes: { reason: fact.reason, force: fact.force, ...link },
        body: { reason: fact.reason, force: fact.force, ...link },
      };
    }
    if (fact.kind === "dream_evaluated") {
      // 链到哪：开整了链到那次整理的 run，没开整链回触发它的 run
      const link = fact.dreamRunId ?? fact.triggeredBy;
      return {
        occurredAt: fact.occurredAt,
        kind: "event",
        name: "memory.dream.evaluated",
        scope: {},
        attributes: { layer: fact.layer, decision: fact.decision, ...(link === undefined ? {} : { runId: link }) },
        body: {
          layer: fact.layer,
          decision: fact.decision,
          ...(fact.dreamRunId === undefined ? {} : { dreamRunId: fact.dreamRunId }),
          ...(fact.triggeredBy === undefined ? {} : { triggeredBy: fact.triggeredBy }),
        },
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
      ...(fact.chars === undefined ? {} : { chars: fact.chars }),
      ...(fact.stage === undefined ? {} : { stage: fact.stage }),
      ...(fact.indexOutcome === undefined ? {} : { indexOutcome: fact.indexOutcome }),
      ...(fact.reasonCode === undefined ? {} : { reasonCode: fact.reasonCode }),
    };
    // metadata 只投 digest：`AgentToolResult` 的错误原文常内嵌明文 path，不能借 rejected / failed body 带回来
    const digests: Record<string, { text: string; keyed?: true }> =
      fact.operation === "rename" ? { fromPathDigest: { text: fact.path, keyed: true }, toPathDigest: { text: fact.toPath ?? "", keyed: true } } : { pathDigest: { text: fact.path, keyed: true } };
    if (fact.message !== undefined) digests.reasonDigest = { text: fact.message };
    if (content) {
      body.path = fact.path;
      if (fact.toPath !== undefined) body.toPath = fact.toPath;
      if (fact.message !== undefined) body.message = fact.message;
    }
    // content 档：写成的整份与写之前的那份存成 blob（记录里只放引用，正文可能比一条记录的上限大）
    const blobs: Record<string, string> = {};
    if (content && fact.content !== undefined) blobs.content = fact.content;
    if (content && fact.before !== undefined) blobs.before = fact.before;
    return {
      occurredAt: fact.occurredAt,
      kind: "event",
      name: `memory.mutation.${fact.outcome}`,
      scope: {},
      attributes,
      body,
      digests,
      ...(Object.keys(blobs).length === 0 ? {} : { blobs }),
    };
  },
};
