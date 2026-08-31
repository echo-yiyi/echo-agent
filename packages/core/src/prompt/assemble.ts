// 装配器:PromptSection[] → system prompt 字符串。每次 run 由 Agent.assemblePrompt 调一次
// (冻结的是时刻,不是内容)。本文件不认识任何机制的格式——只管排序、丢空段、连接。

import type { PromptSection } from "./types.ts";

export type SectionFailure = (info: { section: string; error: unknown }) => void;

/**
 * stable 在前、volatile 沉底(同 tier 保数组序)→ 逐段渲染 → 空段丢弃 → "\n\n" join。
 * 单段抛错 = 该段隐形 + onFailure 留痕——段是增强面,坏一段不许击穿整个 run。
 * 全空返回 null(与「没有 systemPrompt」同义,不发空字符串)。
 */
export async function assembleSystem(
  sections: readonly PromptSection[],
  onFailure?: SectionFailure,
): Promise<string | null> {
  const ordered = [...sections].sort((a, b) => tierRank(a) - tierRank(b));
  const blocks: string[] = [];
  for (const s of ordered) {
    try {
      const block = (await s.render()).trim();
      if (block !== "") blocks.push(block);
    } catch (error) {
      onFailure?.({ section: s.name, error });
    }
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function tierRank(s: PromptSection): number {
  return s.tier === "stable" ? 0 : 1;
}
