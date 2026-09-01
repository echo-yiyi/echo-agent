// 固定配色（P0）。**不是主题系统**——不切换、不加载、不给扩展改；就是一份常量。
//
// 之所以需要它：pi-tui 的 `Editor` 与 `Markdown` 的构造函数都要求一份主题对象
// （`dist/components/editor.d.ts:72`、`dist/components/markdown.d.ts:64`），主题不是可选项。
// 「不做主题系统」的意思是不做上面那三件事，不是不给主题。P2 的 `MarkdownTheme` 也放这里。
//
// **`fromCharCode(27)` 只许出现在本仓这一类行上**（拼 ANSI **输出**序列）；按键**输入**的判定
// 一律走 `matchesKey()`，见 `keybindings.ts` 与 `test/key-discipline.test.ts`。

import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

const ESC = String.fromCharCode(27);

/** SGR 包一层：`open` 开、`close` 关。只做这一件事，不猜终端支不支持真彩。 */
const sgr =
  (open: string, close: string) =>
  (s: string): string =>
    `${ESC}[${open}m${s}${ESC}[${close}m`;

export const dim = sgr("2", "22");
export const bold = sgr("1", "22");
export const cyan = sgr("36", "39");
export const yellow = sgr("33", "39");
export const red = sgr("31", "39");
export const green = sgr("32", "39");
export const italic = sgr("3", "23");
export const underline = sgr("4", "24");
export const strike = sgr("9", "29");

/** 输入行的主题。边框走 dim；补全列表（P0 不接）给一套能看的缺省，免得将来接上时是空白。 */
export const EDITOR_THEME: EditorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};

/**
 * 助手正文的 Markdown 主题（P2）。`Markdown` 组件要求全部 14 个字段（`dist/components/markdown.d.ts`），
 * 这里就是一份写死的常量——能看、够用，不做切换。代码块本体不上色（`codeBlock: s => s`）：
 * 没有语法高亮的情况下整块染一个色只会让它更难读。
 */
export const MARKDOWN_THEME: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: cyan,
  codeBlock: (s) => s,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic,
  strikethrough: strike,
  underline,
};
