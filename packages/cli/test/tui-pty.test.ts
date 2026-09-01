// 真 PTY 里的按键判据（`docs/review/tui-design.md` §二「按键处理的纪律」第二条门）。
//
// 假 TUI 证明不了这件事：`fake-tui.ts` 的 `feed()` 直接把字符串交给 `handleInput`，
// 终端编码这一层（raw mode、StdinBuffer 切包、Kitty 协议探测）全绕过了。
// 这里起一个真的 pty（`pty-driver.py`），把**另一种字节形式**的同一个键送进去：
//   · `ESC[100;5u`  Kitty 协议的 Ctrl+D          · `ESC[99;5u`  Kitty 协议的 Ctrl+C
// 断言的是**行为**（退没退出），不是屏幕字节——差分渲染下旧帧还在缓冲里，
// 抓屏会把「清掉了」误判成「还在」。
//
// 2026-08-31 用户在真终端撞到的就是这一类：方向键不动、Ctrl+C 退不出去。

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "bin", "echo-agent.ts");
const DRIVER = join(import.meta.dir, "pty-driver.py");
const REPO = join(import.meta.dir, "..", "..", "..");

const ESC = 27;
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const KEYS = {
  ctrlD: [4],
  kittyCtrlD: [ESC, ...ascii("[100;5u")],
  kittyCtrlC: [ESC, ...ascii("[99;5u")],
  enter: [13],
};

type Step =
  | { kind: "wait"; text: string; timeout?: number }
  | { kind: "send"; bytes: number[] }
  | { kind: "exit"; timeout?: number };
type Result = { steps: (Step & { ok: boolean; code?: number })[]; tail: string };

/** 起一个干净的 home：两个 key 环境变量清掉，`ECHO_HOME` 指到临时目录。 */
function isolatedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["MOONSHOT_API_KEY"];
  delete env["ECHO_LLM_API_KEY"];
  env["ECHO_HOME"] = home;
  env["TERM"] = "xterm-256color";
  return env;
}

async function drive(home: string, steps: Step[]): Promise<Result> {
  // **没有 python3 就红，不跳过**：跳过的门等于没有门，而这条门守的正是假 TUI 看不见的那一层。
  if (Bun.which("python3") === null) throw new Error("真 PTY 测试需要 python3（标准库的 pty 模块）；Bun 1.3 自己没有 pty");
  const ext = join(home, "ext");
  mkdirSync(ext, { recursive: true });
  const proc = Bun.spawn(["python3", DRIVER], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(
    JSON.stringify({
      cmd: ["bun", BIN, "--state-dir", join(home, "state"), "--no-memory", "--extensions", ext],
      cwd: REPO,
      env: isolatedEnv(home),
      steps,
    }),
  );
  proc.stdin.end();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`pty-driver 自己失败了（exit ${code}）：${err}`);
  return JSON.parse(out) as Result;
}

function withHome(run: (home: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), "echo-pty-"));
    try {
      await run(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

/** 有凭据 → 起主界面。key 是假的，但 `--no-memory` 且不发 prompt，不会碰网络。 */
function configured(home: string): void {
  writeFileSync(join(home, "credentials.json"), JSON.stringify({ kimi: { apiKey: "sk-pty-test" } }));
  chmodSync(join(home, "credentials.json"), 0o600);
}

const oks = (r: Result): boolean[] => r.steps.map((s) => s.ok);

test(
  "传统编码的 Ctrl+D 在真 PTY 里退出主界面（这条是 PTY 驱动本身的对照：它红了下面两条就没有意义）",
  withHome(async (home) => {
    configured(home);
    const r = await drive(home, [
      { kind: "wait", text: "已接上", timeout: 15 },
      { kind: "send", bytes: KEYS.ctrlD },
      { kind: "exit", timeout: 5 },
    ]);
    expect([oks(r), r.tail.slice(-300)]).toEqual([[true, true, true], r.tail.slice(-300)]);
    expect(r.steps.at(-1)!.code).toBe(0);
  }),
  30_000,
);

test(
  "Kitty 编码：Ctrl+D 有字时不退出、Ctrl+C 清空、清空后 Ctrl+D 退出——三个键都用 `ESC[…;5u` 形式",
  withHome(async (home) => {
    configured(home);
    const r = await drive(home, [
      { kind: "wait", text: "已接上", timeout: 15 },
      { kind: "send", bytes: ascii("abc") },
      { kind: "send", bytes: KEYS.kittyCtrlD }, // 有字：向前删一个（光标在末尾，等于没事），**不许退出**
      { kind: "exit", timeout: 1 }, // 预期等不到退出
      { kind: "send", bytes: KEYS.kittyCtrlC }, // 清空
      { kind: "send", bytes: KEYS.kittyCtrlD }, // 空了：退出
      { kind: "exit", timeout: 5 },
    ]);
    // 第 4 步「等退出」必须**等不到**——等到了就是「有字时 Ctrl+D 也退」，正是要挡的那种。
    // 上一版（比较字节 `0x04`）在这里的表现是：第 4 步等不到（对的），第 7 步也等不到（错的）——Kitty 形式它根本不认。
    expect([oks(r), r.tail.slice(-300)]).toEqual([[true, true, true, false, true, true, true], r.tail.slice(-300)]);
    expect(r.steps.at(-1)!.code).toBe(0);
  }),
  30_000,
);

test(
  "没有凭据也照样进主界面（配置是运行态，不阻塞启动）；配置段里 Kitty 编码的 Ctrl+D 退出",
  withHome(async (home) => {
    // **不写 credentials.json**——这正是要验的：缺 key 不是启动前置
    const r = await drive(home, [
      { kind: "wait", text: "已接上", timeout: 15 }, // 主界面起来了
      { kind: "wait", text: "还没有可用的凭据", timeout: 5 }, // 配置段就在它里面
      { kind: "send", bytes: KEYS.kittyCtrlD },
      { kind: "exit", timeout: 5 },
    ]);
    expect([oks(r), r.tail.slice(-300)]).toEqual([[true, true, true, true], r.tail.slice(-300)]);
    expect(r.steps.at(-1)!.code).toBe(0); // 用户选择退出：正常退出
  }),
  30_000,
);
