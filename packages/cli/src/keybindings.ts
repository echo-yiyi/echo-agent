// 应用级键位（P0）。**照 pi**（`docs/review/tui-design.md` §九 D2）：编辑器内的键是 pi-tui 的缺省
// （`TUI_KEYBINDINGS`），一条不改；这里只登记 pi 的 `app.*` 里本轮要接的那几个，
// 名字、缺省键都照抄 pi 仓 `~/Code/pi/packages/coding-agent/src/core/keybindings.ts:92-94`
// （写全路径是因为那是 pi 仓的目录，写短路径文档门会当成本地文件去找）。
//
// ## 为什么是一张表而不是散在 `handleInput` 里判字符
//
// 同一个按键在不同终端下有多种字节形式：Ctrl+C 在传统终端是 `0x03`，pi-tui 探测并启用
// Kitty 键盘协议之后（`dist/terminal.js:120`）变成 `ESC[99;5u`；↓ 既可能是 `ESC[B` 也可能是
// 应用光标键模式的 `ESC O B`。手写 `data === "\x03"` 只认其中一种——2026-08-31 用户在真终端上
// 撞到的「退不出去、方向键不动」就是这个。`KeybindingsManager.matches()` 底下是 `matchesKey()`，
// 三种编码都认。**所以按键判定只许走它**，门在 `test/key-discipline.test.ts`。
//
// ## 与编辑器缺省键的两处重合，都是有意的
//
//   · `ctrl+c`：pi-tui 里是 `tui.input.copy`（复制选区）。我们的壳没有选区，`app.clear` 先截。
//   · `ctrl+d`：pi-tui 里是 `tui.editor.deleteCharForward`。**空输入行时**才当退出（pi 的描述就是
//     「Exit when editor is empty」），有字时放行给编辑器删一个字符。判空在 `app.ts` 里做。

import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type KeybindingDefinition } from "@earendil-works/pi-tui";

/** P0 接的应用级键。加一条要同时改下面的 `declare module`，不然 `matches()` 不认它的名字。 */
export const APP_KEYBINDINGS = {
  "app.interrupt": { defaultKeys: "escape", description: "中断当前这一轮" },
  "app.clear": { defaultKeys: "ctrl+c", description: "清空输入行" },
  "app.exit": { defaultKeys: "ctrl+d", description: "输入行为空时退出" },
  // P2：工具调用默认折叠，Ctrl+O 全局展开 / 收起（pi 的 `app.tools.expand`，`:112`）
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "展开 / 收起工具输出" },
  // P3a：换装备。键照 pi（`app.model.select` `:111`、`app.thinking.cycle` `:99-102`）
  "app.model.select": { defaultKeys: "ctrl+l", description: "打开模型选择器" },
  "app.thinking.cycle": { defaultKeys: "shift+tab", description: "轮换 thinking 档位" },
  // 权限询问的答法。pi 没有这一对——它的权限 UI 是另一套；名字沿用 `app.*` 前缀只是为了归类。
  "app.permission.allow": { defaultKeys: "y", description: "放行待答的权限询问" },
  "app.permission.deny": { defaultKeys: "n", description: "拒绝待答的权限询问" },
} as const satisfies Record<string, KeybindingDefinition>;

/** 让 `KeybindingsManager.matches(data, "app.…")` 在类型上认得这几个名字（pi 也是这么扩的）。 */
declare module "@earendil-works/pi-tui" {
  interface Keybindings {
    "app.interrupt": true;
    "app.clear": true;
    "app.exit": true;
    "app.tools.expand": true;
    "app.model.select": true;
    "app.thinking.cycle": true;
    "app.permission.allow": true;
    "app.permission.deny": true;
  }
}

/**
 * 造一个 manager 并**装成全局的**：pi-tui 的 `Editor` 内部走 `getKeybindings()` 取键表，
 * 不装的话它用库缺省，与我们这张表就是两份真源。返回值给壳子自己判 `app.*` 用。
 */
export function installKeybindings(): KeybindingsManager {
  const manager = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS });
  setKeybindings(manager);
  return manager;
}
