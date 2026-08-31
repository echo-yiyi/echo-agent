// 从 markdown 文本导入 prompt 段。**core 不读盘**——产品层读文件(或从网络/配置拿),
// 把文本喂进来;一个 md 文件 = 一段。
//
// 格式:frontmatter 给元数据,正文即内容。
//   ---
//   name: company-policy
//   tier: stable        ← 可省,缺省 stable
//   ---
//   正文…(原样进 system,这是产品自己的受信文本,不消毒——消毒的是第三方/模型可控数据)

import { parseFrontmatter } from "./markdown.ts";
import type { PromptSection, PromptTier } from "./types.ts";

export function sectionFromMarkdown(markdown: string, fallbackName?: string): PromptSection {
  const { meta, body } = parseFrontmatter(markdown);
  const name = meta["name"] !== undefined && meta["name"] !== "" ? meta["name"] : fallbackName;
  if (name === undefined || name === "") {
    throw new Error("prompt 段缺名字:frontmatter 写 name:,或调用时给 fallbackName(通常用文件名)");
  }
  const rawTier = meta["tier"] ?? "stable";
  if (rawTier !== "stable" && rawTier !== "volatile") {
    throw new Error(`prompt 段 '${name}' 的 tier 只能是 stable / volatile,收到 '${rawTier}'`);
  }
  const tier: PromptTier = rawTier;
  const content = body.trim();
  return { name, tier, render: () => content }; // 内容在导入时定死:导入的段天然字节稳定
}
