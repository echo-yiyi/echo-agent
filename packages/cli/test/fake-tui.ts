// 假 TUI：只记「谁被挂上去、渲染成什么、输入监听器是谁」。
//
// **一次 `feed()` = 终端的一次数据到达**：真终端逐键送达（文本一段、回车一段），
// 粘贴才是一整块。所以测试里回车要单独喂——把 `"文本\r"` 当一块喂等于模拟了一次不存在的输入。
//
// 抽成独立文件是因为 `extension.test.ts` 也要用它（2026-08-31）：
// 复制一份就等于两处各有一个「假终端」，行为一旦分家，两边的判据就不再可比。

import type { TUI } from "@earendil-works/pi-tui";

export function fakeTui(): TUI & { screen: () => string; feed: (data: string) => void; renders: () => number } {
  let root: { render(width: number): string[]; handleInput?(data: string): void; focused?: boolean } | null = null;
  const listeners: ((data: string) => unknown)[] = [];
  let renders = 0;
  const ui = {
    mode: "main" as never,
    children: [] as never[],
    // **要给 `rows` / `columns`**：pi-tui 的 `Editor.render()` 按 `terminal.rows * 0.3` 算可见行数
    // （`dist/components/editor.js:386-387`）。空对象 → `NaN` → 一行正文都不画，屏幕上只剩两条边框
    // （写 P0 时当场撞到）。数值随便，但得是数。
    terminal: { rows: 24, columns: 80 } as never,
    fullRedraws: 0,
    addChild: (c: never) => {
      root = c as unknown as typeof root;
    },
    removeChild: () => undefined,
    clear: () => undefined,
    getShowHardwareCursor: () => false,
    setShowHardwareCursor: () => undefined,
    getClearOnShrink: () => false,
    setClearOnShrink: () => undefined,
    setFocus: (c: unknown) => {
      // **不能是 no-op**：真 TUI 会把 `focused` 置上，组件据此决定要不要输出 CURSOR_MARKER。
      // 假 TUI 若不照做，「有可见光标」这条判据就永远测不出来。
      if (root !== null && "focused" in root) root.focused = c === root;
    },
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
    start: () => undefined,
    stop: () => undefined,
    renderNow: () => undefined,
    requestRender: () => {
      renders += 1;
    },
    addInputListener: (l: (data: string) => unknown) => {
      listeners.push(l);
      return () => listeners.splice(listeners.indexOf(l), 1);
    },
    removeInputListener: () => undefined,
    onTerminalColorSchemeChange: () => () => undefined,
    setTerminalColorSchemeNotifications: () => undefined,
    render: () => [],
    invalidate: () => undefined,
    screen: () => (root?.render(80) ?? []).join("\n"),
    feed: (data: string) => {
      // 真 TUI 的口径：监听器返回 `{consume:true}` 就**不再往组件送**（Ctrl+C 就是这么被吃掉的）
      for (const l of listeners) {
        const r = l(data) as { consume?: boolean } | undefined;
        if (r?.consume === true) return;
      }
      root?.handleInput?.(data);
    },
    renders: () => renders,
  };
  return ui as unknown as TUI & { screen: () => string; feed: (data: string) => void; renders: () => number };
}
