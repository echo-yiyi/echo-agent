// 从 markdown 文本导入 prompt 段。**core 不读盘**——产品层读文件(或从网络/配置拿),
// 把文本喂进来;一个 md 文件 = 一段,注册进 `AgentPrompt` registry,与代码字面量的段同机制。
//
// 格式:frontmatter 给元数据,正文即内容。
//   ---
//   name: company-policy
//   order: 10          ← 可省,缺省 0(产品的 md 多半就是 identity)
//   ---
//   正文…(原样进 system,这是产品自己的受信文本,不消毒——消毒的是第三方/模型可控数据;
//        可以写 {{workspace}} 之类的变量,装配时插值)

import { parseFrontmatter } from "./markdown.ts";
import type { PromptSection } from "./types.ts";

/**
 * 把一个 markdown 文本变成一段 prompt：frontmatter 给 `name`（可用 `fallbackName` 兜底，通常是文件名）
 * 与 `order`（整数，缺省 0），正文原样进 system（可含 `{{变量}}`）。产品层读完文件喂进来，
 * 再经 `AgentPrompt.section()` 注册——与代码字面量的段同一条路。缺名字、写 `tier:`、非整数 order 都抛。
 */
export function sectionFromMarkdown(markdown: string, fallbackName?: string): PromptSection {
  const { meta, body } = parseFrontmatter(markdown);
  const name = meta["name"] !== undefined && meta["name"] !== "" ? meta["name"] : fallbackName;
  if (name === undefined || name === "") {
    throw new Error("prompt 段缺名字:frontmatter 写 name:,或调用时给 fallbackName(通常用文件名)");
  }
  if (meta["tier"] !== undefined) {
    throw new Error(`prompt 段 '${name}' 写了 tier:——已改为数字 order:(约定带见 PROMPT_ORDER)`);
  }
  const rawOrder = meta["order"];
  let order = 0;
  if (rawOrder !== undefined && rawOrder !== "") {
    order = Number(rawOrder);
    if (!Number.isInteger(order)) {
      throw new Error(`prompt 段 '${name}' 的 order 必须是整数,收到 '${rawOrder}'`);
    }
  }
  const content = body.trim();
  return { name, order, render: () => content }; // 内容在导入时定死:导入的段天然字节稳定(变量除外)
}
