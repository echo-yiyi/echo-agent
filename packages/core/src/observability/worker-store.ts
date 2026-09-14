// 观测库的写入端跑在 Worker 线程：agent 所在的主线程不调用 `bun:sqlite`（2026-09-14 用户拍板）。
//
// 为什么：`bun:sqlite` 的每个调用都是同步的。放在主线程上，磁盘卡住（WAL 检查点的 fsync、网络盘、休眠刚醒）或库被别的
// 连接锁住（busy_timeout 期间同步干等）时，停下的是整条事件循环——agent 循环、模型流、工具回调、定时器全停，
// `run.closed` 的有界等待也失效（到期的定时器触发不了）。挪进 Worker 后卡住的只有那条线程：主线程照跑，
// Sequencer 按既有语义降级（ring 满了记 `buffer_overflow` 缺口，boundary 到期记 `canonical_flush_timeout`）。
//
// 形状：与 `SqliteCanonicalObservationStore` 同一组方法（`CanonicalObservationStore` + live 查询要的读方法 + path key + 关库），
// 每个方法 = 发一条消息、等回信；worker 那端跑的就是 `SqliteCanonicalObservationStore` 本身（`sqlite-worker.ts`），
// 两端的消息形状在 `worker-protocol.ts`。探针落点（投影、编码、预留 seq）不经过这里：它在主线程同步做完、不碰磁盘（sequencer.ts）。
//
// 错误跨线程只剩 name / message / code：已知的两类（`ObservationCorruptionError`、`ObservationStoreOpenError`）在这边还原成
// 同一个类——Sequencer 靠 `instanceof ObservationCorruptionError` 决定 seal 还是 read-after-error。
//
// **回信有两条取法**：端口的 message 事件，以及有请求在途时一个短定时器用 `receiveMessageOnPort` 同步取。只靠事件不够——
// Bun 1.3.14 实测：`bun test` 的 `await expect(p).resolves / .rejects` 在原生代码里阻塞等 promise，这期间定时器照跑，
// 但跨线程消息（Worker 自己的 postMessage 与 MessageChannel 端口都一样）从第二条起派发不出来，于是任何经过观测库的
// `expect(agent.start()).rejects` 永远等不到回信。定时器兜底让这种写法照常工作；两条路谁先取到，按 id 只结算一次。
// 在途请求的这个定时器同时负责保活：有请求在途时进程不先退出，没有时不拖住退出。

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { receiveMessageOnPort } from "node:worker_threads";
import { ObservationCorruptionError, type CanonicalObservationStore, type CommitBatchInput, type CommitBatchResult } from "./store.ts";
import { MEMORY_PATH, ObservationStoreOpenError, type SqliteObservationOpenOptions } from "./sqlite-store.ts";
import type { ListRunIndexOptions, SerializedStoreError, StoreWorkerMethod, StoreWorkerReply, StoreWorkerRequest } from "./worker-protocol.ts";
import type { RunIndexEntryV1 } from "./types.ts";

function reviveStoreError(e: SerializedStoreError): Error {
  const cause = e.cause === undefined ? undefined : reviveStoreError(e.cause);
  switch (e.name) {
    case "ObservationCorruptionError":
      return new ObservationCorruptionError(e.message);
    case "ObservationStoreOpenError":
      return new ObservationStoreOpenError(e.message, cause === undefined ? undefined : { cause });
    default: {
      const err = new Error(e.message, cause === undefined ? undefined : { cause });
      err.name = e.name;
      if (e.code !== undefined) (err as Error & { code?: string }).code = e.code;
      return err;
    }
  }
}

// 源码跑（Bun 走 `bun` 导出条件）是 .ts，编译产物是 .js：worker 入口跟着本文件的扩展名走
const STORE_WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./sqlite-worker.ts" : "./sqlite-worker.js", import.meta.url).href;

type Pending = Readonly<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;

/** Bun 的 Worker 与 MessagePort 有 `unref`（实测），类型声明里没有：补在这里。 */
type Unrefable<T> = T & { unref(): void };

/** 请求去掉 `id`（链路自己编号）；按联合的每一支分别去掉。 */
type OutgoingRequest = StoreWorkerRequest extends infer R ? (R extends StoreWorkerRequest ? Omit<R, "id"> : never) : never;

/** 有请求在途时，定时器多久同步取一次回信（事件派发不出来时的兜底，见头注）。 */
const REPLY_POLL_MS = 5;

/**
 * 与 worker 的一条请求 / 回信链路，走一对 MessagePort。worker 与端口都 `unref`（空闲时不拖住进程退出）；
 * 有请求在途时开兜底定时器，它既取回信也保活。worker 出错或退出：在途的全部 reject，之后的请求立刻 reject——
 * 不会有谁永远挂着等一个死线程。
 */
class StoreWorkerLink {
  private readonly pending = new Map<number, Pending>();
  private readonly port: Unrefable<MessagePort>;
  private nextId = 1;
  private exited: Error | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly worker: Unrefable<Worker>) {
    const { port1, port2 } = new MessageChannel();
    this.port = port1 as Unrefable<MessagePort>;
    worker.postMessage(port2, [port2]);
    worker.unref();
    this.port.addEventListener("message", (event) => this.settle((event as MessageEvent<StoreWorkerReply>).data));
    this.port.start();
    this.port.unref();
    worker.addEventListener("error", (event) => this.fail(new Error(`observation store worker 出错：${(event as ErrorEvent).message}`)));
    worker.addEventListener("close", () => this.fail(new Error("observation store worker 已退出")));
  }

  request(message: OutgoingRequest): Promise<unknown> {
    if (this.exited !== null) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.poll ??= setInterval(() => this.drain(), REPLY_POLL_MS);
      try {
        this.port.postMessage({ ...message, id } as StoreWorkerRequest);
      } catch (e) {
        this.pending.delete(id);
        this.stopPollIfIdle();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * 结束链路：先让 worker 关库（`close` 请求），再结束线程、关端口；之后的请求一律 reject。线程已经死了就只收尾。
   * 关库失败照样抛，但线程一定结束。线程由主线程 terminate，不让 worker 自己 `self.close()`——后者 Bun 1.3.14 实测会让
   * 进程退出时的 `process.on("exit")` 监听不再触发（3 次 0 次）。
   */
  async shutdown(): Promise<void> {
    if (this.exited !== null) return;
    try {
      await this.request({ op: "close" });
    } finally {
      this.fail(new Error("observation store 已关闭"));
      this.worker.terminate();
      this.port.close();
    }
  }

  /** 同步把端口上已经到了的回信全部取出来结算。 */
  private drain(): void {
    for (;;) {
      const got = receiveMessageOnPort(this.port as never) as { message: StoreWorkerReply } | undefined;
      if (got === undefined) return;
      this.settle(got.message);
    }
  }

  private settle(reply: StoreWorkerReply): void {
    const p = this.pending.get(reply.id);
    if (p === undefined) return;
    this.pending.delete(reply.id);
    this.stopPollIfIdle();
    if (reply.ok) p.resolve(reply.value);
    else p.reject(reviveStoreError(reply.error));
  }

  private stopPollIfIdle(): void {
    if (this.pending.size > 0 || this.poll === null) return;
    clearInterval(this.poll);
    this.poll = null;
  }

  private fail(error: Error): void {
    if (this.exited !== null) return;
    this.exited = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.stopPollIfIdle();
  }
}

/**
 * `createAgent()` 装配的观测库写入端：SQLite 连接住在 Worker 线程，这里每个方法都是一次跨线程往返。
 * 裁决（同事务全见或全不见、幂等重提、corruption fail-loud）全部是 worker 里 `SqliteCanonicalObservationStore` 的，这里不重复。
 */
export class WorkerObservationStore implements CanonicalObservationStore {
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly link: StoreWorkerLink,
    readonly path: string,
    private readonly pathDigestKey: Uint8Array,
  ) {}

  /**
   * 在主线程建好库文件所在目录（异步，只在启动时），再起线程、在线程里 open + PRAGMA 验证 + migrate。
   * 任一失败：线程关掉，错误原样抛（fail-loud，不进 READY）。目录不交给 worker 建：worker 线程不许加载 `node:fs`（worker-protocol.ts）。
   */
  static async open(options: SqliteObservationOpenOptions): Promise<WorkerObservationStore> {
    if (options.path !== MEMORY_PATH) {
      try {
        await mkdir(dirname(options.path), { recursive: true });
      } catch (e) {
        throw new ObservationStoreOpenError(`create observation database directory failed: ${options.path}`, { cause: e });
      }
    }
    const link = new StoreWorkerLink(new Worker(STORE_WORKER_URL) as Unrefable<Worker>);
    try {
      const key = await link.request({ op: "open", options: { ...options, createDirectory: false } });
      if (!(key instanceof Uint8Array)) throw new ObservationCorruptionError("observation store worker 没有返回 path_digest_key");
      return new WorkerObservationStore(link, options.path, key);
    } catch (e) {
      // 线程收尾的失败不盖过 open 的原错
      await link.shutdown().catch(() => {});
      throw e;
    }
  }

  /** open 时读回的 path key（随库首建、永不改写），之后不再过线程。 */
  readPathDigestKey(): Uint8Array {
    return this.pathDigestKey;
  }

  commitBatchIfAbsent(input: CommitBatchInput): Promise<CommitBatchResult> {
    return this.call("commitBatchIfAbsent", [input]) as Promise<CommitBatchResult>;
  }

  readRecordBytes(recordId: string): Promise<Uint8Array | null> {
    return this.call("readRecordBytes", [recordId]) as Promise<Uint8Array | null>;
  }

  readRunIndex(runId: string): Promise<RunIndexEntryV1 | null> {
    return this.call("readRunIndex", [runId]) as Promise<RunIndexEntryV1 | null>;
  }

  readCommittedPrefix(runtimeId: string): Promise<number> {
    return this.call("readCommittedPrefix", [runtimeId]) as Promise<number>;
  }

  readRecordsAfter(runtimeId: string, afterSeq: number, limit: number): Promise<readonly Uint8Array[]> {
    return this.call("readRecordsAfter", [runtimeId, afterSeq, limit]) as Promise<readonly Uint8Array[]>;
  }

  readRunRecords(runtimeId: string, runId: string, firstSeq: number, lastSeq: number): Promise<readonly Uint8Array[]> {
    return this.call("readRunRecords", [runtimeId, runId, firstSeq, lastSeq]) as Promise<readonly Uint8Array[]>;
  }

  listRunIndex(opts: ListRunIndexOptions): Promise<readonly RunIndexEntryV1[]> {
    return this.call("listRunIndex", [opts]) as Promise<readonly RunIndexEntryV1[]>;
  }

  /** 在线程里关连接，再结束线程。幂等（single-flight）。关库本身失败照样抛，但线程一定结束。 */
  close(): Promise<void> {
    return (this.closing ??= this.link.shutdown());
  }

  private call(method: StoreWorkerMethod, args: readonly unknown[]): Promise<unknown> {
    return this.link.request({ op: "call", method, args });
  }
}
