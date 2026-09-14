// 观测库写入端主线程（`worker-store.ts`）与 Worker 线程（`sqlite-worker.ts`）共用的消息协议。
//
// **worker 线程不许经任何路径加载 `node:fs` 或 `node:worker_threads`**（这个文件因此也不 import 它们）：Bun 1.3.14 实测，
// worker 线程里加载过其中任一个，这个 worker 被 terminate 之后，进程退出时 `process.on("exit")` 的监听不再运行（3 次 0 次；
// 不加载则 3/3）。主线程加载它们没有影响。所以库目录由主线程建（`WorkerObservationStore.open`），`sqlite-store.ts` 只在
// 需要建目录时才动态加载 `node:fs`。判据：`observability-worker-store.test.ts` 起子进程开关一次库、看 exit 监听有没有运行。

import type { RunIndexCursor, SqliteObservationOpenOptions } from "./sqlite-store.ts";

/** 主线程能让 worker 调的存储方法：封闭名单，两端共用。 */
export const STORE_WORKER_METHODS = [
  "commitBatchIfAbsent",
  "readRecordBytes",
  "readRunIndex",
  "readCommittedPrefix",
  "readRecordsAfter",
  "readRunRecords",
  "listRunIndex",
] as const;

/** `STORE_WORKER_METHODS` 里的一个方法名。 */
export type StoreWorkerMethod = (typeof STORE_WORKER_METHODS)[number];

/** 主线程 → worker 的一条请求。`open` 回 path key；`call` 回方法返回值；`close` 关库后回 undefined。 */
export type StoreWorkerRequest =
  | Readonly<{ id: number; op: "open"; options: SqliteObservationOpenOptions }>
  | Readonly<{ id: number; op: "call"; method: StoreWorkerMethod; args: readonly unknown[] }>
  | Readonly<{ id: number; op: "close" }>;

/** 跨线程的错误：只带得过去这几项。`cause` 同形嵌套。 */
export type SerializedStoreError = Readonly<{ name: string; message: string; code?: string; cause?: SerializedStoreError }>;

/** worker → 主线程的回信，按 `id` 对上请求。 */
export type StoreWorkerReply = Readonly<{ id: number; ok: true; value: unknown }> | Readonly<{ id: number; ok: false; error: SerializedStoreError }>;

/** 在 worker 那端把任意抛出值收成可跨线程的形状。 */
export function serializeStoreError(e: unknown): SerializedStoreError {
  if (!(e instanceof Error)) return { name: "Error", message: String(e) };
  const code = (e as { code?: unknown }).code;
  return {
    name: e.name,
    message: e.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(e.cause === undefined ? {} : { cause: serializeStoreError(e.cause) }),
  };
}

/** `listRunIndex` 的参数形状，两端共用。 */
export type ListRunIndexOptions = Readonly<{ limit: number; after?: RunIndexCursor }>;
