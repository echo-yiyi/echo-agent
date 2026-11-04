// stdin 输入源。
//
//   · `readAll`：**整段读完当一条输入**。管道形态用它（2026-11-03，照 `claude -p` / `codex exec`）：
//     `cat task.md | echo-agent` 是一件任务，「不要动 API」这类约束得跟第一句一起到，不能拆成几次独立 run。
//   · `linesOf`：**逐行**产出，一行一条。给自己写输入源、要「一行一次」语义的调用方。
//
// 为什么不用 `readline` 的交互面：那一层给的是 REPL（提示符、历史、补全），TUI 要那些是 TUI 自己的事。

import { createInterface } from "node:readline";

/**
 * 把一个可读流读到 EOF，整段按 UTF-8 解码返回（多字节字符跨块也不坏）。
 *
 * `signal` 触发时**不再等 EOF**、立刻带着已读到的部分返回——调用方读完先看 `signal.aborted`，
 * 被中止的半截输入不能当 prompt 用。已经 abort 过的信号同样立刻返回：`addEventListener` 只等将来的 abort，
 * SIGINT 落在启动期间时等这里开始读，abort 早就过去了（`linesOf` 踩过同一个坑）。
 */
export function readAll(stream: NodeJS.ReadableStream = process.stdin, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted === true) return Promise.resolve("");
  return new Promise<string>((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = "";
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: string | Uint8Array): void => {
      text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    };
    const onEnd = (): void => {
      cleanup();
      resolve(text + decoder.decode());
    };
    const onError = (e: unknown): void => {
      cleanup();
      reject(e);
    };
    const onAbort = (): void => {
      cleanup();
      stream.pause(); // 不再读：别让一个没人要的 stdin 拖着进程不退
      resolve(text);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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
