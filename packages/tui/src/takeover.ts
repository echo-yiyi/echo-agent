// 接管确认（2026-11-15 拍板）：续的那一段正被一个**还活着**的进程占着时，**装配之前**问一次要不要接管。
//
// 什么时候会问到：另一个终端正开着这一段；或者沙箱刚异常退出、旧进程的心跳还没过期（多半已经没了，只是还判不出来）。
// 接管 = 叠一代锁，原来那个进程在下一次刷心跳前发现、停手。不接管 = 照旧报「已被另一个写者持有」。
//
// 样子与工作区信任（`trust.ts`）同一套。**缺省选中「不接管」**：手快按回车的结果是不动别人，不是把另一个终端顶下去。
// 持有者那一句经 `clean()` 洗过——锁记录里的字段同样可以被写进终端控制序列。

import { decodeKittyPrintable, isKeyRelease, matchesKey, ProcessTerminal, SelectList, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import type { Product } from "@echo-agent/base";
import { bannerLines } from "./app.ts";
import { clean, wrap } from "./text.ts";
import { bold, dim, SELECT_LIST_THEME } from "./theme.ts";

/** 同 `app.ts`：壳不认识任何产品，没人给就显示一个中性名字。 */
const UNNAMED_PRODUCT: Pick<Product, "name" | "version"> = { name: "echo", version: "0.0.0" };

export type TakeoverPromptOptions = Readonly<{
  product?: Pick<Product, "name" | "version">;
  /** 要续的那一段。 */
  sessionId: string;
  /** 此刻占着它的是谁（给人看的一句），或锁坏了的原因。 */
  holder: string;
  /** 注入用：测试给假的 TUI。 */
  ui?: TUI;
  signal?: AbortSignal;
}>;

/** 单行显示：洗掉控制序列，换行压成空格。 */
function oneLine(text: string): string {
  return clean(text).replaceAll("\n", " ");
}

/** `true` = 接管，`false` = 不接管。Esc、Ctrl+D、被中止都是 `false`。 */
export async function runTakeoverPrompt(opts: TakeoverPromptOptions): Promise<boolean> {
  const ui: TUI = opts.ui ?? new TuiMainScreen(new ProcessTerminal(), false, process.cwd());
  const banner = bannerLines(opts.product ?? UNNAMED_PRODUCT, process.cwd());

  let resolveDone: (takeover: boolean) => void = () => {};
  let settled = false;
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (takeover: boolean): void => {
    if (settled) return;
    settled = true;
    resolveDone(takeover);
  };

  const CHOICES = [
    { value: "keep", label: "1. 不接管：留给它" },
    { value: "take", label: "2. 接管：在这里续上，原来那个进程停手" },
  ];
  const list = new SelectList(CHOICES, 10, SELECT_LIST_THEME);
  list.setSelectedIndex(0);
  list.onSelect = (item): void => finish(item.value === "take");
  list.onCancel = (): void => finish(false);

  const root = {
    focused: true,
    render: (width: number): string[] => {
      const lines = [
        ...banner,
        "",
        bold(`会话 ${oneLine(opts.sessionId)} 正被另一个进程占着`),
        dim(oneLine(opts.holder)),
        "",
        "如果它是刚异常退出的旧进程（沙箱重启、终端被关），接管就能接着用。",
        "如果另一个终端正开着它，接管后那边会停下、不再写入。",
        "",
        ...list.render(width),
        "",
        dim("↑/↓ 选 · 数字直选 · 回车确认 · Esc 不接管"),
      ];
      return lines.flatMap((l) => wrap(l, width));
    },
    handleInput: (data: string): void => {
      if (isKeyRelease(data)) return;
      if (matchesKey(data, "ctrl+d")) {
        finish(false);
        return;
      }
      const printable = decodeKittyPrintable(data) ?? data;
      if (printable === "1" || printable === "2") {
        finish(printable === "2");
        return;
      }
      list.handleInput(data);
      ui.requestRender();
    },
    invalidate: (): void => list.invalidate(),
  };

  const onAbort = (): void => finish(false);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted === true) onAbort();

  ui.addChild(root);
  ui.setFocus(root);
  ui.start();
  try {
    return await done;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    ui.stop();
  }
}
