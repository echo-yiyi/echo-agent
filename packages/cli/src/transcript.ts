// Transcript：把一次会话渲染成终端里的一段文档。
//
// **它只是投影**——不持有会话真相，不回写 Agent。真相在 `agent.messages` 与事件流里，
// 这里存的是「已经渲染成什么样」的一份可增量更新的行缓冲。
//
// pi-tui 的 `Component` 契约小得只有三件：`render(width) → string[]`、可选 `handleInput`、`invalidate()`。
// 所以不需要框架，也不需要 React——差分渲染、光标、宽字符对齐那些真正难的部分归 pi-tui。
//
// ## 投影边界 = 清洗边界（review 三轮 P1）
//
// **进到这里的每一段动态文本都是不可信的**：模型正文、工具名与详情、错误消息里可能带终端控制序列。
// 上一版原样写进终端，实测 `OSC 52` 能改用户剪贴板、`CSI 2J` 能清屏、裸 `BEL`/`CR` 能打乱布局——
// 也就是说「模型说了什么」可以变成「模型对你的终端做了什么」。
//
// 所以四类条目（user / assistant / tool / notice）的文本一律在**入口**过一遍 `clean()`，
// 而不是在 render 里各自记得清洗——render 里还要拼我们自己的 SGR，
// 那时再清洗就会把自己的颜色一起洗掉（要求里「必须在添加 SGR 之前清洗」说的就是这个顺序）。

import { stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** 一条已经落定或正在流式生长的条目。 */
export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "tool"; name: string; detail: string; state: "running" | "done" | "failed" }
  | { kind: "notice"; text: string };

/**
 * 颜色。**用 `String.fromCharCode(27)` 拼，不把 ESC 字节敲进源码**——
 * 理由与仓库里「不许敲真 NUL 字节」那条相同：控制字符让整份文件在 review 与 diff 里不可读，
 * 而运行时输入一个字节都没变。
 */
const ESC = String.fromCharCode(27);
const sgr =
  (open: number, close: number) =>
  (text: string): string =>
    `${ESC}[${open}m${text}${ESC}[${close}m`;
const COLORS = {
  dim: sgr(2, 22),
  user: sgr(36, 39),
  tool: sgr(33, 39),
  fail: sgr(31, 39),
  ok: sgr(32, 39),
};

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
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  return wrapTextWithAnsi(text, width);
}

/** 按条目形状逐字段清洗。**新增一种条目就必须在这里加一支**——漏一支就是一个没洗的洞。 */
function sanitizeEntry(entry: TranscriptEntry): TranscriptEntry {
  switch (entry.kind) {
    case "user":
    case "notice":
      return { ...entry, text: clean(entry.text) };
    case "assistant":
      return { ...entry, text: clean(entry.text) };
    case "tool":
      return { ...entry, name: clean(entry.name), detail: clean(entry.detail) };
  }
}

export class Transcript {
  private readonly entries: TranscriptEntry[] = [];
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  /**
   * 追加一条。返回它的下标，流式那条之后要按下标续写。
   *
   * **入口即清洗**（四类条目一个不漏，见文件头）：调用方不必记得洗，也没有「忘了洗」这条路。
   */
  push(entry: TranscriptEntry): number {
    this.entries.push(sanitizeEntry(entry));
    this.invalidate();
    return this.entries.length - 1;
  }

  /**
   * 用**权威 partial** 覆盖流式条目的正文。
   *
   * 注意是「覆盖」不是「累加」：`message_update` 事件本身就带着此刻的完整 `message`
   * （`events.ts` 的 `{ delta, message }`），自己再攒一份 delta 等于在 TUI 里维护第二份真相——
   * 重试、丢包、provider 修正定稿时两边就会分叉（review 实测：屏幕停在旧 partial）。
   */
  setAssistantText(index: number, text: string): void {
    const entry = this.entries[index];
    if (entry?.kind !== "assistant") return;
    entry.text = clean(text);
    this.invalidate();
  }

  /**
   * 收尾：**无条件以定稿为准**，包括定稿为空的情形（只带 tool_use 的那一轮、错误轮）。
   *
   * 上一版只在「流式正文为空」时才采用定稿，于是「先流出旧 partial、再被权威定稿修正」这一路
   * 屏幕会永远停在旧 partial（review 实测）。**定稿权威**这条不能有例外，否则 TUI 与 Agent 的
   * transcript 会分叉，而分叉了没人会发现。
   */
  finishAssistant(index: number, final: string): void {
    const entry = this.entries[index];
    if (entry?.kind !== "assistant") return;
    entry.text = clean(final);
    entry.streaming = false;
    this.invalidate();
  }

  updateTool(index: number, patch: Partial<Extract<TranscriptEntry, { kind: "tool" }>>): void {
    const entry = this.entries[index];
    if (entry?.kind !== "tool") return;
    Object.assign(entry, {
      ...patch,
      ...(patch.name === undefined ? {} : { name: clean(patch.name) }),
      ...(patch.detail === undefined ? {} : { detail: clean(patch.detail) }),
    });
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedLines;
    const lines: string[] = [];
    for (const entry of this.entries) {
      switch (entry.kind) {
        case "user":
          for (const line of wrap(entry.text, width - 2)) lines.push(COLORS.user(`› ${line}`));
          break;
        case "assistant":
          // **空的 assistant 条目不占地方**：只带 tool_use 的那一轮正文是空的，
          // 照直渲染会在工具行前面留出两行空白（实测），看着像丢了东西
          if (entry.text === "" && !entry.streaming) continue;
          for (const line of wrap(entry.text, width)) lines.push(line);
          if (entry.streaming) lines.push(COLORS.dim("…"));
          break;
        case "tool": {
          const mark = entry.state === "running" ? "⋯" : entry.state === "done" ? "✓" : "✗";
          const paint = entry.state === "failed" ? COLORS.fail : entry.state === "done" ? COLORS.ok : COLORS.tool;
          const head = `${mark} ${entry.name}`;
          lines.push(paint(head) + (entry.detail === "" ? "" : COLORS.dim(`  ${entry.detail}`)));
          break;
        }
        case "notice":
          for (const line of wrap(entry.text, width)) lines.push(COLORS.dim(line));
          break;
      }
      lines.push("");
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
