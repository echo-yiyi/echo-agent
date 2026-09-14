// 观测线程的入口：进程里只有一条，由 thread.ts 起。逻辑都在 thread-host.ts，这里只把消息接进来、发回去。
//
// 线程由主线程在空闲时 `unref`，从不 `terminate`，自己也不 `close()`：Bun 1.3.14 实测，terminate 之后进程的
// `process.on("exit")` 监听不再运行（spike：terminate 0/1，unref 3/3）。

import { parentPort } from "node:worker_threads";
import { ObservationThreadHost } from "./thread-host.ts";
import type { ToObservationThread } from "./worker-protocol.ts";

const port = parentPort;
if (port === null) throw new Error("observation-worker 只能作为 Worker 线程的入口运行");
const host = new ObservationThreadHost((message) => port.postMessage(message));
port.on("message", (message: ToObservationThread) => host.receive(message));
