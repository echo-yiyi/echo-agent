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

/** 只中和反引号(→ ˋ U+02CB)、保换行。用于放进围栏的多行不可信内容——围栏本身靠它不被逃逸。 */
export function fenceSafe(text: string): string {
  return text.replaceAll("`", "ˋ");
}
