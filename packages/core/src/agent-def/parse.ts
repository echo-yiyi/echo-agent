// agent 定义的文件形状：一个 markdown、frontmatter 带字段、正文就是 identity。
// 照 skill 的样子（`docs/decisions/proposed/2026-09-07-role-agent.md`）：
//
//   ---
//   name: reviewer
//   description: 只读审查，不改代码
//   tools: [read_file, grep, glob, bash]
//   model: kimi-k3
//   ---
//   你是代码审查员。……
//
// **值一律当字符串**是 `parseFrontmatter` 的既定口径（它刻意不是完整 YAML，见那个文件）。
// 这里只多认一种形状：方括号列表——因为 `tools` 天然是个列表，让人写 `tools: a, b` 或
// 每行一条都要么歧义、要么得引进 YAML。列表语法就这一条，够用且没有第二种读法。

import { parseFrontmatter } from "../prompt/markdown.ts";
import type { AgentDefinition } from "./types.ts";

/** `[a, b, c]` → `["a","b","c"]`；不带方括号的按单元素算；空列表 `[]` → `[]`。 */
export function parseNameList(raw: string): readonly string[] {
  const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s !== "");
}

export type ParsedAgentFile = {
  /** frontmatter 的 `name`；没写就用文件名（由调用方给 `fallbackName`）。 */
  readonly name: string;
  readonly definition: AgentDefinition;
};

/**
 * 解析一份 agent 定义文件。**坏档判红**（pre-release，不静默降级）：
 * 没有名字、正文与三项全空，都是「这个文件写了等于没写」，说出来比当它不存在好——
 * 人明明放了个文件在那里，系统一声不吭地忽略它是最难查的一类问题。
 */
export function parseAgentFile(content: string, fallbackName: string): ParsedAgentFile {
  const { meta, body } = parseFrontmatter(content);
  const name = (meta["name"] ?? fallbackName).trim();
  if (name === "") throw new Error("agent 定义缺 name，文件名也取不出名字");
  const identity = body.trim();
  const definition: AgentDefinition = {
    ...(identity !== "" ? { identity } : {}),
    ...(meta["tools"] !== undefined ? { tools: parseNameList(meta["tools"]) } : {}),
    ...(meta["model"] !== undefined && meta["model"] !== "" ? { model: meta["model"] } : {}),
    ...(meta["description"] !== undefined && meta["description"] !== "" ? { description: meta["description"] } : {}),
  };
  if (definition.identity === undefined && definition.tools === undefined && definition.model === undefined) {
    throw new Error(`agent 定义 '${name}' 三项（正文 identity / tools / model）全空：写了等于没写`);
  }
  return { name, definition };
}
