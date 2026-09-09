// stdin 输入源：**逐行**产出。这是 `echo-agent start` 的缺省输入，也是最小的那一个。
//
// 为什么不用 `readline`：那一层给的是交互式 REPL（提示符、历史、补全），
// 而 Runner 要的是「一行进来当一次输入」——管道、`echo x | echo-agent`、
// 测试里的字符串流全都要能用。TUI 要提示符和历史，那是 TUI 自己的事。

import { createInterface } from "node:readline";

/**
 * 把一个可读流按行切成 `AsyncIterable<string>`。
 *
 * `signal` 触发时**关掉底层接口**让迭代自然结束——只靠 `run()` 里的 `aborted` 检查是不够的：
 * 那个检查发生在**取到下一行之后**，而这里可能永远等不到下一行（交互式 stdin 就是这样），
 * 于是进程挂着不退。这是 Ctrl-C 之后到底能不能退出的分界。
 */
export async function* linesOf(
  stream: NodeJS.ReadableStream = process.stdin,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  // 读成函数，别在两处写 `signal?.aborted === true`：第一次检查之后 TS 会把第二次判成恒假，
  // 而运行时它恰恰是会变的——中断就发生在两次之间。
  const aborted = (): boolean => signal?.aborted === true;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  // **已经 abort 过的信号不会补发事件**：`addEventListener` 只等**将来**的 abort。
  // SIGINT 落在 `createAgent()` 期间时就是这个形状——等这里开始读，abort 早就过去了，
  // readline 会永久等下一行（2026-08-24 review 的 P2，用预先 abort 的 signal 复现）。
  if (aborted()) {
    rl.close();
    return;
  }
  const close = (): void => rl.close();
  signal?.addEventListener("abort", close, { once: true });
  try {
    for await (const line of rl) {
      if (aborted()) return;
      yield line;
    }
  } finally {
    signal?.removeEventListener("abort", close);
    rl.close();
  }
}
