# TUI 键位照 pi：编辑器内用 pi-tui 缺省，应用级照 pi 的 `app.*`

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-01 · 落地 main `eff6dec`（`packages/tui/src/keybindings.ts` / `app.ts`，P0 其余交付物同一提交）· 来源 [产品级 TUI 设计方案](../../design/tui.md) §二、§九 D2（2026-09-08 从那张表转录成条）

## 决定

编辑器内的键用 pi-tui 的缺省；应用级的键照 pi 的 `app.*`（pi 仓 coding-agent 包里的 keybindings 表）。不自创键位；pi 没有的键不加。

## 理由

我们用的就是 pi 的 TUI 库，库的缺省键就是 pi 的键，用户在别的工具里已经学过这一套。原稿自创的一套（Enter 换行 / Ctrl+D 提交 / 双击 Ctrl+C 退出）和库缺省三处相撞。

## 落地

`eff6dec`：`APP_KEYBINDINGS` 登记应用级键，`installKeybindings()` 把它与库缺省合起来。按键判定只走 `matchesKey()` 一族、不比较字节——门在 `packages/tui/test/key-discipline.test.ts`（递归扫 `packages/cli/src/`）与 `packages/cli/test/tui-pty.test.ts`（真 PTY 送 Kitty / 应用光标键编码）。

## 验收

`packages/cli/src/` 里 `fromCharCode` 只出现在拼 ANSI 输出常量的行上；真 PTY 下 Kitty 编码的 Ctrl+C / Ctrl+D 与应用光标键 ↓ 的行为与传统编码一致。两道门都在 `bun test` 里。
