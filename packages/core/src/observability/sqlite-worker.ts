// 观测库写入端的 Worker 线程入口（另一端是 `worker-store.ts`）：`bun:sqlite` 只在这条线程上被调用。
//
// 线程起来后收到的第一条消息是一个 MessagePort，之后的请求与回信都走这个端口（为什么走端口见 worker-store.ts）。
// 请求按到达顺序一条一条处理（串成一条 promise 链）：SQLite 连接只有一条，事务之间不交错。
// 每条请求恰好回一封信；抛出的错误收成 name / message / code 带回主线程。
// 回信里的字节拷成独立的 buffer 并 transfer 过去：只搬这几段，不连带 SQLite 返回的底层大 buffer。

import { SqliteCanonicalObservationStore } from "./sqlite-store.ts";
// 只 import 协议文件：worker 线程不许经任何路径加载 `node:worker_threads`（原因见 worker-protocol.ts）
import { STORE_WORKER_METHODS, serializeStoreError, type StoreWorkerReply, type StoreWorkerRequest } from "./worker-protocol.ts";

let store: SqliteCanonicalObservationStore | null = null;
let queue: Promise<void> = Promise.resolve();

function detachBytes(value: unknown, transfer: ArrayBuffer[]): unknown {
  if (value instanceof Uint8Array) {
    const copy = value.slice();
    transfer.push(copy.buffer as ArrayBuffer);
    return copy;
  }
  if (Array.isArray(value)) return value.map((v) => detachBytes(v, transfer));
  return value;
}

async function handle(request: StoreWorkerRequest): Promise<unknown> {
  switch (request.op) {
    case "open": {
      if (store !== null) throw new Error("observation store worker 已经 open 过");
      store = await SqliteCanonicalObservationStore.open(request.options);
      return store.readPathDigestKey();
    }
    case "call": {
      if (store === null) throw new Error("observation store worker 还没 open 或已关闭");
      if (!(STORE_WORKER_METHODS as readonly string[]).includes(request.method)) throw new Error(`observation store worker 不认识的方法：${String(request.method)}`);
      const method = store[request.method] as (...args: unknown[]) => Promise<unknown>;
      return await method.apply(store, [...request.args]);
    }
    case "close": {
      const s = store;
      store = null;
      s?.close();
      return undefined;
    }
  }
}

self.addEventListener(
  "message",
  (event) => {
    const port = (event as MessageEvent<MessagePort>).data;
    port.addEventListener("message", (e) => {
      const request = (e as MessageEvent<StoreWorkerRequest>).data;
      queue = queue.then(async () => {
        let reply: StoreWorkerReply;
        const transfer: ArrayBuffer[] = [];
        try {
          reply = { id: request.id, ok: true, value: detachBytes(await handle(request), transfer) };
        } catch (err) {
          reply = { id: request.id, ok: false, error: serializeStoreError(err) };
        }
        port.postMessage(reply, transfer);
      });
    });
    port.start();
  },
  { once: true },
);
