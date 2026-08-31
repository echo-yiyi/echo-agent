// markdown 文本的公共解析:frontmatter。记忆文件的索引行、prompt 段导入都用它。

/**
 * 极简 frontmatter:首行 "---" 到下一个独占行 "---" 之间的 `key: value`(值一律当字符串)。
 * 刻意不是完整 YAML——skill 加载器留在 core 外是因为要兼容**外部生态**的标准 YAML;
 * 这里解析的文件(记忆、prompt 段)是我们自己的工具和产品写的,格式我们定,子集够用且零依赖。
 */
export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  if (!content.startsWith("---\n") && content !== "---") return { meta: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: content };
  const head = content.slice(4, end);
  const body = content.slice(content.indexOf("\n", end + 1) + 1);
  const meta: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key === "") continue;
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}
