// 工作区信任（2026-11-03 拍板）：约定目录 `<cwd>/extensions` 里有扩展、而这个工作区还不受信时，**装配之前**问一次。
//
// 为什么要问：装配会 import 那些文件、执行里面的代码。克隆一个陌生仓库、在里面起 `echo-coding`，
// 不问就等于直接跑了仓库作者写的代码。行为参照 Claude Code 公开文档里「信任这个文件夹」那一步与 codex 的 trusted projects：
// 第一次在某个目录里起来时确认一次，信任就记住。
//
// 样子与引导设置（`first-run.ts`）同一套：欢迎头在上、说明与将加载的文件居中、带光标的编号列表在下。
// **缺省选中「不信任」**：手快按回车的结果是这次不加载，不是执行。文件名经 `clean()` 洗过——
// 陌生仓库里的文件名同样可以带终端控制序列，这一屏偏偏不能被它改写。

import { decodeKittyPrintable, isKeyRelease, matchesKey, ProcessTerminal, SelectList, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { relative } from "node:path";
import type { Product } from "@echo-agent/base";
import { bannerLines } from "./app.ts";
import { clean, wrap } from "./text.ts";
import { bold, dim, SELECT_LIST_THEME } from "./theme.ts";

/** 同 `app.ts`：壳不认识任何产品，没人给就显示一个中性名字。 */
const UNNAMED_PRODUCT: Pick<Product, "name" | "version"> = { name: "echo", version: "0.0.0" };
/** 文件清单最多列几行；再多就只报个数——这一屏要放得下选项。 */
const MAX_LISTED = 20;

export type TrustPromptOptions = Readonly<{
  product?: Pick<Product, "name" | "version">;
  /** 问的是哪个工作区（realpath）。 */
  workspace: string;
  /** 信任了就会被加载的扩展文件（绝对路径）。 */
  files: readonly string[];
  /** 注入用：测试给假的 TUI。 */
  ui?: TUI;
  signal?: AbortSignal;
}>;

/** 单行显示：洗掉控制序列，换行压成空格。 */
function oneLine(text: string): string {
  return clean(text).replaceAll("\n", " ");
}

/** `true` = 信任（装配层记住并加载），`false` = 不信任（这次不加载）。Esc、Ctrl+D、被中止都是 `false`。 */
export async function runTrustPrompt(opts: TrustPromptOptions): Promise<boolean> {
  const ui: TUI = opts.ui ?? new TuiMainScreen(new ProcessTerminal(), false, process.cwd());
  const banner = bannerLines(opts.product ?? UNNAMED_PRODUCT, process.cwd());
  const listed = opts.files.slice(0, MAX_LISTED).map((f) => `  ${oneLine(relative(process.cwd(), f))}`);
  const more = opts.files.length - listed.length;

  let resolveDone: (trusted: boolean) => void = () => {};
  let settled = false;
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (trusted: boolean): void => {
    if (settled) return;
    settled = true;
    resolveDone(trusted);
  };

  const CHOICES = [
    { value: "skip", label: "1. 不信任：这次不加载" },
    { value: "trust", label: "2. 信任这个文件夹：加载这些扩展，以后不再问" },
  ];
  const list = new SelectList(CHOICES, 10, SELECT_LIST_THEME);
  list.setSelectedIndex(0);
  list.onSelect = (item): void => finish(item.value === "trust");
  list.onCancel = (): void => finish(false);

  const root = {
    focused: true,
    render: (width: number): string[] => {
      const lines = [
        ...banner,
        "",
        bold("信任这个文件夹里的扩展吗？"),
        dim(oneLine(opts.workspace)),
        "",
        `启动时会加载并执行下面 ${opts.files.length} 个文件里的代码：`,
        ...listed,
        ...(more > 0 ? [dim(`  …还有 ${more} 个`)] : []),
        "",
        dim("只信任你自己写的、或审过的代码。不信任也照样能用，只是这次不加载它们。"),
        "",
        ...list.render(width),
        "",
        dim("↑/↓ 选 · 数字直选 · 回车确认 · Esc 不信任"),
      ];
      // 每一行按宽度折：文件名、工作区路径都可能比终端宽，pi-tui 的渲染门对超宽行直接抛
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
  // 已经 abort 过的信号不会补发事件（`first-run.ts` 同一条）：注册完主动看一眼
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
