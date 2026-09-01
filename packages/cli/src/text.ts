// 文本的两件基础事：**清洗**与**折行**。`transcript.ts`（列表）与 `messages.ts`（各类消息组件）都要，
// 单独放一个文件是为了不让两边互相 import。
//
// ## 投影边界 = 清洗边界（review 三轮 P1）
//
// **进到界面里的每一段动态文本都是不可信的**：模型正文、工具名与详情、工具结果、错误消息里
// 可能带终端控制序列。上一版原样写进终端，实测 `OSC 52` 能改用户剪贴板、`CSI 2J` 能清屏、
// 裸 `BEL`/`CR` 能打乱布局——也就是说「模型说了什么」可以变成「模型对你的终端做了什么」。
// 所以所有动态文本在**入口**过一遍 `clean()`（`Transcript.push` / `setAssistantContent` / `updateTool`），
// 而不是在 render 里各自记得清洗——render 里还要拼我们自己的 SGR，那时再清洗就会把自己的颜色一起洗掉。

import { stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * 洗掉终端控制序列。**两遍，缺一不可**：
 *   ① `stripTerminalSequences()`（pi-tui 公开面）去掉 ANSI / OSC / APC ——实测它**留下**裸 `BEL` 与 `CR`；
 *   ② 再删剩余的 C0（U+0000–U+001F、U+007F）与 C1（U+0080–U+009F）。
 * 顺序不能反：先删 C0 会把 `ESC` 从序列里挖走，剩下的 `[2J` 就变成可见文本了。
 *
 * **保留 `\n`**（换行是内容，折行要用），**tab 展开成 4 空格**（真正的 tab stop 要按列跟踪，
 * 折行器给不了那个信息；不展开则 tab 会被当控制字符删掉，代码缩进整个丢失）。
 */
export function clean(text: string): string {
  const stripped = stripTerminalSequences(text).replaceAll("\t", "    ");
  let out = "";
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") {
      out += ch;
      continue;
    }
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * 折行。**直接用 pi-tui 的 `wrapTextWithAnsi`**，不自己按 code point 数格子：
 * 上一版逐 code point 累加宽度，家庭 emoji `👨‍👩‍👧‍👦` 会被拆成 8 段（人、ZWJ、人、ZWJ…，实测），
 * 组合符也会与基字符分家。宽度与 grapheme 边界是 pi-tui 已经解决的问题，这里没有第二份实现的理由。
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  return wrapTextWithAnsi(text, width);
}
