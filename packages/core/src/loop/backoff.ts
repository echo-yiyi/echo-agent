// 重试退避的两个小件，loop（同一 turn 的下一个 attempt）与压缩摘要器（`compaction/pipeline.ts`）共用——
// 重试预算只有一份 `RetryPolicy`，等待方式也只有一种：受 signal 管。

export function clampDelay(ms: number, cap?: number): number {
  return cap === undefined ? ms : Math.min(ms, cap);
}

/**
 * 可中止的退避：signal 一到就提前 resolve（不 reject——由调用方循环顶部的判断收场），timer 同时清掉。
 * 裸 `setTimeout` 会把 abort / deadline 拖到整段 backoff 走完（缺省最长 30s），还撑着 event loop。
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
