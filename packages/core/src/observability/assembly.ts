// 最小 sealed AgentAssembly / RunModelBinding 观测快照（§15.5.1，O2a 范围）。
//
// **只封 `createAgent()` 今天直接构造的 builtin 槽**（store / lock / session / memory / schedule / tasks / models …），
// 不实现外部 Entry / Fiber / Service——那是 O2b。O2b 接上正式 Entry owner 后往**同一 schema** 里填值，
// 不改形状；slot ID 与 contribution digest 不漂移（O2a 硬门）。
//
// 快照里只有 entry / generation / slot / owner / digest，**绝不序列化 concrete service**、凭据、路径正文。

import { canonicalDigest, encodeCanonical } from "./normalize.ts";
import type { Model } from "../provider/types.ts";
import type { AgentAssemblyObservationSnapshot, RunModelBindingObservationSnapshot } from "./types.ts";

export type BuiltinSlotContribution = Readonly<{
  /** 槽名：与 `createAgent()` 的构造槽一一对应（如 "store" / "lock" / "session" / "memory"）。 */
  slot: string;
  /** builtin Entry id（§14 命名：`echo:agent` / `echo:memory` / `echo:tasks` …）。 */
  entryId: string;
  entryGeneration: string;
  /** 只放安全 metadata（实现种类、非敏感配置摘要输入）；**不放对象本体、凭据、路径正文**。 */
  safeConfig: unknown;
}>;

function slotDigest(c: BuiltinSlotContribution): string {
  return canonicalDigest(encodeCanonical({ slot: c.slot, entryId: c.entryId, entryGeneration: c.entryGeneration, safeConfig: c.safeConfig }).bytes);
}

/** 按 slot 名排序后封口；同一组贡献无论注入顺序如何，digest 相同。 */
export function sealAgentAssemblyObservation(contributions: readonly BuiltinSlotContribution[]): AgentAssemblyObservationSnapshot {
  const seen = new Set<string>();
  for (const c of contributions) {
    if (seen.has(c.slot)) throw new Error(`AgentAssembly 槽重复：${c.slot}`);
    seen.add(c.slot);
  }
  const slots = [...contributions]
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))
    .map((c) => ({
      slot: c.slot,
      entryId: c.entryId,
      entryGeneration: c.entryGeneration,
      owner: { status: "known", entryId: c.entryId, entryGeneration: c.entryGeneration, via: "assembly" } as const,
      digest: slotDigest(c),
    }));
  const digest = canonicalDigest(encodeCanonical(slots.map((s) => ({ slot: s.slot, digest: s.digest }))).bytes);
  return { digest, slots };
}

/**
 * run 冻结的模型绑定：provider / model id、目录 revision 与**安全**配置 digest。
 * `Model` 本身不含凭据（凭据在 CredentialStore），`getApiKey()` / resolver / stream function 一律不进。
 */
export function snapshotRunModelBinding(model: Model, catalogRevision: string): RunModelBindingObservationSnapshot {
  const configDigest = canonicalDigest(
    encodeCanonical({
      api: model.api,
      params: model.params ?? null,
      thinkingLevelMap: model.thinkingLevelMap ?? null,
      capabilities: model.capabilities ?? null,
      cost: model.cost ?? null,
    }).bytes,
  );
  return { providerId: model.provider, modelId: model.id, catalogRevision, configDigest };
}
