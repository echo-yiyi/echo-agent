// stdin 输入源。
//
// `readAll`：**整段读完当一条输入**。管道形态用它（2026-11-03，照 `claude -p` / `codex exec`）：
// `cat task.md | echo-agent` 是一件任务，「不要动 API」这类约束得跟第一句一起到，不能拆成几次独立 run。

/**
 * 把一个可读流读到 EOF，整段按 UTF-8 解码返回（多字节字符跨块也不坏）。
 *
 * `signal` 触发时**不再等 EOF**、立刻带着已读到的部分返回——调用方读完先看 `signal.aborted`，
 * 被中止的半截输入不能当 prompt 用。已经 abort 过的信号同样立刻返回：`addEventListener` 只等将来的 abort，
 * SIGINT 落在启动期间时等这里开始读，abort 早就过去了。
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
