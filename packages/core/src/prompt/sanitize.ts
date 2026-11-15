// 不可信文本进上下文的公共防线。catalog 描述、skill 正文、记忆渲染**同源消费这一份**
// ——两份消毒函数必然漂移,漂移的那份就是洞。

/** 超限截断留标记——截断要被看见,不许静默吞。 */
export function truncateMarked(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…[truncated]`;
}

/** 折叠一切行边界为空格(\n \r \v \f 及 Unicode 行分隔符)。用于把模型或第三方写的文本
 *  嵌进单行(目录行、索引行)——带换行的一条数据能伪装成 system 的新段落。 */
export function singleLine(text: string): string {
  return text.replace(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g, " ").trim();
}

/**
 * 正文里冒充闭合标签 `</tag …>` 的字样(含大小写与内部空白变体),把 `<` 换成全角 `＜`:字面还看得出来,但不再是标签。
 * 用标签定界的地方(项目说明、环境消息)都用它——闭合标签只能由我们写在最后,正文提前收不了尾。
 */
export function neutralizeClosingTag(body: string, tag: string): string {
  const re = new RegExp(`<\\s*/\\s*${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^>]*>?`, "gi");
  return body.replace(re, (m) => `＜${m.slice(1)}`);
}

/** 只中和反引号(→ ˋ U+02CB)、保换行。用于放进围栏的多行不可信内容——围栏本身靠它不被逃逸。 */
export function fenceSafe(text: string): string {
  return text.replaceAll("`", "ˋ");
}
