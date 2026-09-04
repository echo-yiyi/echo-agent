// Clock —— 时间与定时器的端口（D3 的第四类）。**纯的**，能进 engine 面。
//
// 立端口的理由不是「时间可能有多种实现」，而是**确定性测试**：`schedule/harness.ts` 原先
// 直接 `setInterval` + `Date.now()`，于是「到点了会不会投递」这类判据只能靠 sleep 去撞，
// 要么慢要么飘。有了 fake clock 才谈得上「拨到那一刻，断言恰好投了一次」。
//
// **不暴露 timer handle**：`setInterval` 的返回值在 node 是 `NodeJS.Timeout`、在浏览器是
// `number`——把它写进接口就等于把宿主类型拖进 engine 面。
// 所以 `setInterval` 返回的是**取消函数**，谁都不用知道底下是什么。

export interface Clock {
  /** 当前时刻（毫秒）。 */
  now(): number;
  /** 每 `ms` 调一次 `fn`；返回取消它的函数。**幂等取消**：多调几次不该炸。 */
  setInterval(fn: () => void, ms: number): () => void;
}

/**
 * 真时钟。`Date.now` 与 `setInterval` 都是 Web standard，node 与浏览器都有——
 * 所以这个默认实现本身是纯的，不必降到根入口。
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
};

/**
 * 假时钟：时间只在 `advance()` 时前进，定时器只在被拨过去时触发。
 *
 * 这是 §13.12.1 说 Clock「非补不可」的那个理由——没有它，schedule 的判据只能写成
 * 「sleep 一会儿再看」，那种测试在 CI 上必然变成 flake 源。
 */
export class FakeClock implements Clock {
  private current: number;
  private seq = 0;
  private readonly timers = new Map<number, { fn: () => void; every: number; next: number }>();

  constructor(startAt = 0) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  setInterval(fn: () => void, ms: number): () => void {
    // 0 或负间隔会让 advance 陷入死循环——判红而不是自作主张改成 1
    if (!(ms > 0)) throw new Error(`FakeClock.setInterval 的间隔必须为正，收到 ${ms}`);
    const id = ++this.seq;
    this.timers.set(id, { fn, every: ms, next: this.current + ms });
    return () => {
      this.timers.delete(id);
    };
  }

  /**
   * 把时间往前拨。**按到期顺序逐个触发**，而不是先跳到终点再一次性补——
   * 后者会让「每次 tick 都该看到一次」这类断言失真。
   */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let due: { id: number; at: number } | null = null;
      for (const [id, t] of this.timers) {
        if (t.next <= target && (due === null || t.next < due.at)) due = { id, at: t.next };
      }
      if (due === null) break;
      const timer = this.timers.get(due.id);
      if (timer === undefined) break;
      this.current = due.at;
      timer.next = due.at + timer.every;
      timer.fn();
    }
    this.current = target;
  }

  /** 还挂着几个定时器。用来断言「stop 之后没留野定时器」。 */
  get pending(): number {
    return this.timers.size;
  }
}
