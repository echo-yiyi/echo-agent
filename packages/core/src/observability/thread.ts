// 主线程这一侧的观测线程连接：进程里一条观测线程（observation-worker.ts），所有 runtime 共用，第一次有 runtime 时才起。
//
// 主线程在这里只做三件事：把工作消息交出去（结构化拷贝一次，不等回信）、替观测线程在 runtime 的 `StorageDir` 上执行它要的
// 读写（注入的存储是主线程上的对象）、把订阅项交回订阅方。主循环不为观测等任何东西
// （决策：docs/decisions/implemented/2026-09-14-observation-off-main-loop.md）。
//
// **观测出问题不往外报**：观测本身就是日志，它坏了再去发通知或打日志没有意义（2026-09-14 拍板）。线程起不来、坏掉、
// 存储写不进去，都只让这个 runtime 的观测少记或不记；写入端自己的状态在 `snapshot().health` 里。
//
// **进程什么时候能退出**：交出工作消息时线程 `ref`，线程回报「编号到 n 为止都做完、手上没有要写的」且 n 就是最后发出的那条时
// `unref`——`stop()` 不等观测写完，但进程要等它写完才退。**不无限等**：线程拖着进程期间连续 `STALL_MS` 没有任何进展
// （没收到它的消息、也没有存储操作做完），就放开进程，没写完的观测随进程一起丢。线程从不 `terminate`（observation-worker.ts 头注）。
//
// **存储闸**：runtime 被 `discard`（它的状态根要被删掉）之后，这边立刻拒绝它的一切存储操作——拒在主线程上是同步的，
// 不依赖观测线程先收到消息。

import { Worker } from "node:worker_threads";
import type { StorageDir } from "../storage/types.ts";
import type { ObservationSubscribeOptions } from "./types.ts";
import { reviveError, serializeError, type FromObservationThread, type ObservationWork, type ThreadHealth } from "./worker-protocol.ts";

// 源码跑（Bun 走 `bun` 导出条件）是 .ts，编译产物是 .js：线程入口跟着本文件的扩展名走
const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./observation-worker.ts" : "./observation-worker.js", import.meta.url);

/** 线程拖着进程时，连续这么久没有进展就放开进程（存储卡死时进程不许永远退不出）。 */
export const STALL_MS = 5_000;

type RuntimeEntry = {
  readonly dir: StorageDir;
  /** 状态根要被删：拒绝它的一切存储操作（解锁除外）。 */
  gateClosed: boolean;
  readonly locks: Map<number, () => Promise<void>>;
  readonly listeners: Map<number, ObservationSubscribeOptions["listener"]>;
  /** 已经发了 close / discard：观测线程回 `closed` 时 resolve。 */
  closing: Promise<void> | undefined;
  settleClosing: (() => void) | undefined;
};

type OpenInput = Omit<Extract<ObservationWork, { t: "open" }>, "t" | "rt" | "storageLock">;

export class ObservationThread {
  private static processThread: ObservationThread | undefined;

  /** 这个进程的观测线程。第一次调用时起线程；起不来的线程也返回，只是什么都不记。 */
  static get(): ObservationThread {
    return (ObservationThread.processThread ??= new ObservationThread());
  }

  private readonly worker: Worker | undefined;
  private sent = 0;
  private referenced = false;
  /** 最近一次进展：收到线程的消息，或一次存储操作做完。 */
  private lastProgress = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly requests = new Map<number, Readonly<{ resolve: (value: unknown) => void; reject: (e: Error) => void }>>();
  private nextRequest = 1;
  private nextLock = 1;
  private nextSubscription = 1;
  private failure: Error | undefined;

  private constructor() {
    try {
      const worker = new Worker(WORKER_URL);
      worker.unref();
      worker.on("message", (message: FromObservationThread) => this.receive(message));
      worker.on("error", (e: unknown) => this.fail(e instanceof Error ? e : new Error(String(e))));
      worker.on("exit", (code: number) => this.fail(new Error(`观测线程退出了（exit ${code}）`)));
      this.worker = worker;
    } catch (e) {
      // 起线程同步抛错（环境不支持 Worker 等）：这个进程的观测不记，装配照常
      this.worker = undefined;
      this.failure = e instanceof Error ? e : new Error(String(e));
    }
  }

  /** 登记一个 runtime 并在观测线程里建它。线程不可用时什么都不做。 */
  open(rt: string, dir: StorageDir, input: OpenInput): void {
    this.runtimes.set(rt, { dir, gateClosed: false, locks: new Map(), listeners: new Map(), closing: undefined, settleClosing: undefined });
    this.post({ t: "open", rt, storageLock: dir.lock !== undefined, ...input });
  }

  /**
   * 交出一条工作消息。同步；消息过不了线程（结构化拷贝失败）时抛给调用方——探针那一侧据此改发失败消息。
   * 线程不可用时静默丢弃。
   */
  post(work: ObservationWork): void {
    const worker = this.worker;
    if (this.failure !== undefined || worker === undefined) return;
    const n = this.sent + 1;
    worker.postMessage({ ...work, n });
    this.sent = n;
    if (!this.referenced) {
      worker.ref();
      this.referenced = true;
      this.lastProgress = Date.now();
      this.watchdog ??= setInterval(() => this.checkStall(), 1_000);
      (this.watchdog as { unref?: () => void }).unref?.();
    }
  }

  /** 读之前：等观测线程把这个 runtime 此刻之前交出去的全部写完。收过摊的等收摊写完。永不 reject。 */
  flush(rt: string): Promise<void> {
    const entry = this.runtimes.get(rt);
    if (entry === undefined) return Promise.resolve();
    if (entry.closing !== undefined) return entry.closing;
    return this.request((id) => ({ t: "flush", rt, id })).then(
      () => {},
      () => {},
    );
  }

  health(rt: string): Promise<ThreadHealth> {
    return this.request((id) => ({ t: "health", rt, id })) as Promise<ThreadHealth>;
  }

  async subscribe(rt: string, options: ObservationSubscribeOptions): Promise<() => void> {
    const entry = this.runtimes.get(rt);
    if (entry === undefined) throw new Error("观测 runtime 已收摊");
    const sub = this.nextSubscription++;
    entry.listeners.set(sub, options.listener);
    try {
      await this.request((id) => ({ t: "subscribe", rt, id, sub, afterSeq: options.afterSeq, ...(options.runId === undefined ? {} : { runId: options.runId }) }));
    } catch (e) {
      entry.listeners.delete(sub);
      throw e;
    }
    return () => {
      if (!entry.listeners.delete(sub)) return;
      this.post({ t: "unsubscribe", rt, sub });
    };
  }

  /** 收摊：观测线程写完手上的再丢掉 runtime。不等。 */
  close(rt: string): void {
    this.finish(rt, "close");
  }

  /** 状态根要被删掉：此刻起拒绝这个 runtime 的一切存储操作，观测线程直接丢掉它。不等。 */
  discard(rt: string): void {
    const entry = this.runtimes.get(rt);
    if (entry !== undefined) entry.gateClosed = true;
    this.finish(rt, "discard");
  }

  private finish(rt: string, t: "close" | "discard"): void {
    const entry = this.runtimes.get(rt);
    if (entry === undefined || entry.closing !== undefined) return;
    entry.closing = new Promise<void>((resolve) => {
      entry.settleClosing = resolve;
    });
    if (this.failure !== undefined || this.worker === undefined) {
      this.closed(rt);
      return;
    }
    this.post({ t, rt });
  }

  private request(build: (id: number) => ObservationWork): Promise<unknown> {
    if (this.failure !== undefined || this.worker === undefined) return Promise.reject(this.failure ?? new Error("观测线程不可用"));
    const id = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try {
        this.post(build(id));
      } catch (e) {
        this.requests.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private receive(message: FromObservationThread): void {
    this.lastProgress = Date.now();
    switch (message.t) {
      case "storage":
        void this.serveStorage(message);
        return;
      case "reply": {
        const request = this.requests.get(message.id);
        this.requests.delete(message.id);
        if (request === undefined) return;
        if (message.ok) request.resolve(message.value);
        else request.reject(reviveError(message.error));
        return;
      }
      case "item": {
        const listener = this.runtimes.get(message.rt)?.listeners.get(message.sub);
        try {
          listener?.(message.item);
        } catch {
          // 订阅方自己的错误不回灌观测线程
        }
        return;
      }
      case "idle":
        if (message.through === this.sent) this.release();
        return;
      case "closed":
        this.closed(message.rt);
        return;
    }
  }

  /** 线程拖着进程、却连续 `STALL_MS` 没有进展：放开进程。之后再交出工作会重新拖住，照样受这条管。 */
  private checkStall(): void {
    if (this.referenced && Date.now() - this.lastProgress >= STALL_MS) this.release();
  }

  private release(): void {
    if (this.referenced) {
      this.worker?.unref();
      this.referenced = false;
    }
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private closed(rt: string): void {
    const entry = this.runtimes.get(rt);
    if (entry === undefined) return;
    this.runtimes.delete(rt);
    entry.gateClosed = true;
    entry.listeners.clear();
    for (const release of entry.locks.values()) void release().catch(() => {});
    entry.locks.clear();
    entry.settleClosing?.();
  }

  private async serveStorage(message: Extract<FromObservationThread, { t: "storage" }>): Promise<void> {
    const entry = this.runtimes.get(message.rt);
    let reply: { ok: true; value: unknown } | { ok: false; error: ReturnType<typeof serializeError> };
    try {
      if (entry === undefined) throw new Error("观测存储已关闭");
      if (message.op === "unlock") {
        const release = entry.locks.get(message.lock);
        entry.locks.delete(message.lock);
        await release?.();
        reply = { ok: true, value: undefined };
      } else {
        if (entry.gateClosed) throw new Error("观测存储已关闭（状态根要被删掉）");
        switch (message.op) {
          case "read":
            reply = { ok: true, value: await entry.dir.read(message.path) };
            break;
          case "write":
            await entry.dir.write(message.path, message.content);
            reply = { ok: true, value: undefined };
            break;
          case "remove":
            reply = { ok: true, value: await entry.dir.remove(message.path) };
            break;
          case "list":
            reply = { ok: true, value: await entry.dir.list(message.prefix) };
            break;
          case "lock": {
            if (entry.dir.lock === undefined) throw new Error("观测存储没有锁原语");
            const release = await entry.dir.lock(message.name);
            const id = this.nextLock++;
            entry.locks.set(id, release);
            reply = { ok: true, value: id };
            break;
          }
        }
      }
    } catch (e) {
      reply = { ok: false, error: serializeError(e) };
    }
    this.lastProgress = Date.now();
    if (this.failure !== undefined || this.worker === undefined) return;
    this.worker.postMessage({ t: "storage-reply", id: message.id, ...reply });
  }

  /** 线程坏了：在途请求全部失败，各 runtime 收摊，之后什么都不发。不往外报（头注）。 */
  private fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
    for (const rt of [...this.runtimes.keys()]) this.closed(rt);
    this.release();
    if (ObservationThread.processThread === this) ObservationThread.processThread = undefined;
  }
}
