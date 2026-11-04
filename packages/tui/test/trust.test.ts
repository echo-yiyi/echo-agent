// 工作区信任确认（`trust.ts`，2026-11-03）的判据：列出将加载的文件、缺省是「不信任」、只有明确选信任才是 true。
// 假 TUI 驱动；装配层怎么用这个结果（记住、加载、提示）的判据在 `packages/cli/test/cli.test.ts`。

import { expect, test } from "bun:test";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runTrustPrompt } from "../src/trust.ts";
import { fakeTui } from "../src/testing.ts";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const DOWN = `${ESC}[B`;
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

const FILES = [join(process.cwd(), "extensions", "deploy.ts"), join(process.cwd(), "extensions", "helper", "index.ts")];

function open(files: readonly string[] = FILES, signal?: AbortSignal): { ui: ReturnType<typeof fakeTui>; result: Promise<boolean> } {
  const ui = fakeTui();
  const result = runTrustPrompt({ workspace: "/work/repo", files, ui, ...(signal !== undefined ? { signal } : {}) });
  return { ui, result };
}

test("列出工作区与将加载的每个文件（相对路径），两个选项；缺省停在「不信任」——直接回车是不加载", async () => {
  const { ui, result } = open();
  await flush();
  const screen = strip(ui.screen());
  expect(screen).toContain("信任这个文件夹里的扩展吗？");
  expect(screen).toContain("/work/repo");
  expect(screen).toContain(join("extensions", "deploy.ts"));
  expect(screen).toContain(join("extensions", "helper", "index.ts"));
  expect(screen).toContain("1. 不信任");
  expect(screen).toContain("2. 信任这个文件夹");
  ui.feed(ENTER);
  expect(await result).toBe(false);
});

test("选「信任」才是 true：数字 2 直选，或 ↓ 再回车", async () => {
  const a = open();
  await flush();
  a.ui.feed("2");
  expect(await a.result).toBe(true);

  const b = open();
  await flush();
  b.ui.feed(DOWN);
  b.ui.feed(ENTER);
  expect(await b.result).toBe(true);
});

test("Esc、Ctrl+D、数字 1、被中止：都是不信任", async () => {
  for (const key of [ESC, String.fromCharCode(4), "1"]) {
    const { ui, result } = open();
    await flush();
    ui.feed(key);
    expect(await result).toBe(false);
  }
  const controller = new AbortController();
  controller.abort(); // 已经 abort 过的信号也要立刻收摊
  expect(await open(FILES, controller.signal).result).toBe(false);
});

test("文件名里的终端控制序列被洗掉：陌生仓库的文件名改写不了这一屏", async () => {
  const { ui, result } = open([join(process.cwd(), "extensions", `evil${ESC}[2J${ESC}[Hx.ts`)]);
  await flush();
  const raw = ui.screen();
  expect(raw).not.toContain(`${ESC}[2J`);
  expect(raw).not.toContain(`${ESC}[H`);
  ui.feed(ESC);
  expect(await result).toBe(false);
});

test("文件很多：只列前 20 个，其余报个数；窄终端上每行都不超宽", async () => {
  const many = Array.from({ length: 25 }, (_, i) => join(process.cwd(), "extensions", `ext-${String(i).padStart(2, "0")}-with-a-rather-long-name.ts`));
  const { ui, result } = open(many);
  await flush();
  const screen = strip(ui.screen());
  expect(screen).toContain("ext-19-");
  expect(screen).not.toContain("ext-20-");
  expect(screen).toContain("还有 5 个");
  for (const line of ui.lines(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
  ui.feed(ESC);
  await result;
});
