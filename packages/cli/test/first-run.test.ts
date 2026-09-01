// 引导设置的判据（`first-run.ts`，D4）：欢迎 → 选 provider → 贴 key → 验证 → 选模型。
// 假 TUI 驱动；终端编码那一层的判据在 `tui-pty.test.ts`（真 PTY 里走一遍应用光标键与 Kitty Ctrl+D）。

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepseekProvider, FileCredentialStore, InMemoryCredentialStore, kimiProvider } from "@echo-agent/core";
import { runFirstRunSetup, type FirstRunChoice, type FirstRunOutcome } from "../src/first-run.ts";
import { fakeTui } from "./fake-tui.ts";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const CTRL_D = String.fromCharCode(4);
const DOWN = `${ESC}[B`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-first-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CHOICES: readonly FirstRunChoice[] = [
  { name: "kimi", provider: kimiProvider() },
  { name: "deepseek", provider: deepseekProvider() },
];

async function flush(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}
/** `FileCredentialStore` 真写盘，要让出宏任务。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const screen = (ui: ReturnType<typeof fakeTui>): string => strip(ui.screen());
const type = (ui: ReturnType<typeof fakeTui>, text: string): void => {
  for (const ch of text) ui.feed(ch);
};

function start(over: Partial<Parameters<typeof runFirstRunSetup>[0]> = {}): {
  ui: ReturnType<typeof fakeTui>;
  done: Promise<FirstRunOutcome>;
} {
  const ui = fakeTui();
  const done = runFirstRunSetup({
    choices: CHOICES,
    credentials: new InMemoryCredentialStore(),
    verify: async () => ({ ok: true }),
    ui,
    ...over,
  });
  return { ui, done };
}

/* ─────────────────────────── 第一屏 ─────────────────────────── */

test("第一眼：欢迎头在上，「选择 provider」编号列表在说明下面，描述列来自目录", async () => {
  const { ui, done } = start();
  await flush();
  const s = screen(ui);
  expect(s).toContain("echo-agent"); // 欢迎头
  expect(s.indexOf("echo-agent")).toBeLessThan(s.indexOf("选择 provider"));
  expect(s.indexOf("选择 provider")).toBeLessThan(s.indexOf("1. Kimi (Moonshot)"));
  expect(s).toContain("2. DeepSeek");
  expect(s).toContain("kimi-k3 / kimi-k2.7-code …"); // 描述**派生自目录**，不是手写的
  expect(s).toContain("→ 1. Kimi (Moonshot)"); // 光标在第一家
  ui.feed(CTRL_D);
  expect(await done).toEqual({ kind: "cancelled" });
});

test("preselect（--provider）把光标停在那一家", async () => {
  const { ui, done } = start({ preselect: "deepseek" });
  await flush();
  expect(screen(ui)).toContain("→ 2. DeepSeek");
  ui.feed(CTRL_D);
  await done;
});

/* ─────────────────────────── 选 provider ─────────────────────────── */

test("↓ + 回车选第二家 → 进它的收 key 阶段", async () => {
  const { ui, done } = start();
  await flush();
  ui.feed(DOWN);
  ui.feed(ENTER);
  expect(screen(ui)).toContain("DeepSeek 的 API key");
  ui.feed(CTRL_D);
  await done;
});

test("数字直选：按 2 直接进 DeepSeek 的收 key 阶段；Kitty 编码的数字（ESC[50u）也认", async () => {
  for (const key of ["2", `${ESC}[50u`]) {
    const { ui, done } = start();
    await flush();
    ui.feed(key);
    expect(screen(ui), `按 ${JSON.stringify(key)} 没进到收 key 阶段`).toContain("DeepSeek 的 API key");
    ui.feed(CTRL_D);
    await done;
  }
});

/* ─────────────────────────── 贴 key → 选模型 ─────────────────────────── */

test("全流程：选家 → 贴 key（验过按 provider.id 落盘）→ 选模型（缺省 ✓ 预选中）→ 回车用缺省", async () => {
  const file = join(dir, "credentials.json");
  const { ui, done } = start({ credentials: new FileCredentialStore(file) });
  await flush();

  ui.feed("1"); // kimi
  type(ui, "sk-GOOD");
  ui.feed(ENTER);
  await settle();

  const s = screen(ui);
  expect(s).toContain("选择模型");
  expect(s.indexOf("选择模型")).toBeLessThan(s.indexOf("1. Kimi K3")); // 列表在说明下面
  expect(s).toContain("→ 1. Kimi K3 ✓"); // 缺省项带 ✓ 且预选中
  expect(s).toContain("kimi-k3 · 1024k 上下文 · 推理"); // 描述来自目录
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ kimi: { apiKey: "sk-GOOD" } });

  ui.feed(ENTER);
  expect(await done).toMatchObject({ kind: "configured", providerName: "kimi", modelId: "kimi-k3" });
});

test("模型也能数字直选：按 2 → 用第二个模型", async () => {
  const { ui, done } = start();
  await flush();
  ui.feed("1");
  type(ui, "sk-GOOD");
  ui.feed(ENTER);
  await flush();
  ui.feed("2");
  expect(await done).toMatchObject({ kind: "configured", modelId: "kimi-k2.7-code" });
});

test("验不过：停在收 key 阶段、一个字节不落盘、说清原因", async () => {
  const file = join(dir, "credentials.json");
  const { ui, done } = start({
    credentials: new FileCredentialStore(file),
    verify: async () => ({ ok: false, reason: "这把 key 被端点拒了（HTTP 401）" }),
  });
  await flush();
  ui.feed("1");
  type(ui, "sk-BAD");
  ui.feed(ENTER);
  await settle();

  expect(screen(ui)).toContain("验不过，没有保存");
  expect(screen(ui)).toContain("HTTP 401");
  expect(screen(ui)).not.toContain("选择模型");
  expect(existsSync(file)).toBe(false);

  ui.feed(CTRL_D); // key 还留在输入行里：Ctrl+D 有字时是删字，**不许退**
  // 判据不能看屏幕（结算了也不重画）：直接赛 `done` 有没有 settle
  const raced = await Promise.race([done.then(() => "settled"), new Promise((r) => setTimeout(() => r("running"), 50))]);
  expect(raced, "有字时 Ctrl+D 把向导退了").toBe("running");
  ui.feed(String.fromCharCode(3)); // Ctrl+C 清空
  ui.feed(CTRL_D);
  expect(await done).toEqual({ kind: "cancelled" });
});

/* ─────────────────────────── 返回与退出 ─────────────────────────── */

test("Esc：收 key 阶段回到选 provider；选模型阶段也回到选 provider（换一家重来）", async () => {
  const { ui, done } = start();
  await flush();

  ui.feed("2");
  expect(screen(ui)).toContain("DeepSeek 的 API key");
  ui.feed(ESC); // 返回
  expect(screen(ui)).toContain("选择 provider");

  ui.feed("1");
  type(ui, "sk-GOOD");
  ui.feed(ENTER);
  await flush();
  expect(screen(ui)).toContain("选择模型");
  ui.feed(ESC); // 返回
  expect(screen(ui)).toContain("选择 provider");

  ui.feed(CTRL_D);
  await done;
});

test("Ctrl+D：列表阶段直接退出；Kitty 编码（ESC[100;5u）也认", async () => {
  for (const key of [CTRL_D, `${ESC}[100;5u`]) {
    const { ui, done } = start();
    await flush();
    ui.feed(key);
    expect(await done).toEqual({ kind: "cancelled" });
  }
});

test("已经 abort 过的 signal：立刻 cancelled，不挂着等按键", async () => {
  const controller = new AbortController();
  controller.abort();
  const { done } = start({ signal: controller.signal });
  const raced = await Promise.race([done, new Promise((r) => setTimeout(() => r("卡住了"), 200))]);
  expect(raced).toEqual({ kind: "cancelled" });
});
