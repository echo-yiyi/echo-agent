// 按键处理的纪律，做成门（`docs/design/tui.md` §二「按键处理的纪律」）。
//
// 事实：同一个按键在不同终端下有多种字节形式。pi-tui 探测并启用 Kitty 键盘协议之后
// （`dist/terminal.js:120`），Ctrl+C 到达是 `ESC[99;5u` 而不是 `0x03`；↓ 可能是应用光标键的
// `ESC O B` 而不是 `ESC[B`。手写 `data.includes(String.fromCharCode(3))` 只认一种——
// 2026-08-31 用户在真终端上撞到的「退不出去、方向键不动」就是这个。
//
// **为什么是门不是纪律**：假 TUI 测不出来（`fake-tui.ts` 的 `feed()` 直接把字符串交给
// `handleInput`，绕过了终端编码这一层），review 也盯不住每一处 `===`。所以两条：
//   ① 本文件：`packages/cli/src/` 里 `fromCharCode` 只许出现在拼 ANSI **输出**常量的那种行上；
//   ② `tui-pty.test.ts`：真 PTY 里把 Kitty / 应用光标键编码送进去，行为与传统编码一致。

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** `src/` 下所有 `.ts`，**递归**——上一版只读顶层，`observe/` 那几个文件在门外（review 2026-09-07）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 允许的形状：注释行，或者 `const ESC = String.fromCharCode(27);` 这种拼 ANSI 输出的常量定义。 */
const ALLOWED = /^(?:\/\/.*|\*.*|\/\*\*.*|const \w+ = String\.fromCharCode\(27\);)$/;

function offenders(source: string): string[] {
  return source
    .split("\n")
    .map((line, i) => [line.trim(), i + 1] as const)
    .filter(([line]) => line.includes("fromCharCode") && !ALLOWED.test(line))
    .map(([line, no]) => `${no}: ${line}`);
}

test("packages/cli/src 里 `fromCharCode` 只用于拼 ANSI 输出，按键判定不比较字节", () => {
  const report: string[] = [];
  for (const file of walk(SRC)) {
    const hits = offenders(readFileSync(file, "utf8"));
    if (hits.length > 0) report.push(`${relative(SRC, file)}\n  ${hits.join("\n  ")}`);
  }
  expect(report, "按键判定要走 matchesKey() / KeybindingsManager.matches()，不许比较字节").toEqual([]);
});

// 上一条门只要 src 干净就恒绿——**恒绿的门等于没有门**。用已知正反例证明判据真能分辨。
test("上一条门的判据真能分辨（3 正例抓到 / 3 反例放行）", () => {
  const caught = (line: string): boolean => offenders(line).length > 0;
  // 正例：这三种都是「比较字节」，都要抓
  expect(caught("if (data.includes(String.fromCharCode(3))) quit();")).toBe(true);
  expect(caught('if (data === String.fromCharCode(27) + "[B") cursor++;')).toBe(true);
  expect(caught("const CTRL_C = String.fromCharCode(3);")).toBe(true); // 定义成常量再比较也一样
  // 反例：拼 ANSI 输出的常量、注释，都放行
  expect(caught("const ESC = String.fromCharCode(27);")).toBe(false);
  expect(caught("// 上一版 `data.includes(String.fromCharCode(3))` 在 Kitty 终端里不成立")).toBe(false);
  expect(caught(" * 颜色。**用 `String.fromCharCode(27)` 拼，不把 ESC 字节敲进源码**")).toBe(false);
});
