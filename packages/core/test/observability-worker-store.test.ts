import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationRuntime } from "../src/observability/runtime.ts";
import { sealAgentAssemblyObservation } from "../src/observability/assembly.ts";
import { observationDatabasePath } from "../src/observability/sqlite-store.ts";
import { ObservationCorruptionError, type CommitBatchInput } from "../src/observability/store.ts";
import { encodeCanonical } from "../src/observability/normalize.ts";
import { WorkerObservationStore } from "../src/observability/worker-store.ts";
import { systemClock } from "../src/schedule/clock.ts";
import type { RunModelBinding } from "../src/admission/types.ts";

// 观测库写入端在 Worker 线程（2026-09-14）。判据落在主线程上看得见的三件事：
//   · 库被别的连接锁住、写入端在 worker 里同步干等时，主线程的定时器照常跳，`run.closed` 按有界等待到期返回并降级；
//   · 锁放开之后，那批记录照样落盘；
//   · worker 抛的 corruption 回到主线程仍是 `ObservationCorruptionError`（Sequencer 靠 instanceof 决定 seal）。
// 把写入端换回主线程上的 `SqliteCanonicalObservationStore`，第一条就红：干等期间主线程一拍都不跳，`run.closed` 要等锁超时。

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-worker-"));
  temps.push(dir);
  return observationDatabasePath(join(dir, "state"));
}

const BINDING: RunModelBinding = {
  bindingId: "b1",
  source: { kind: "user" },
  purpose: "foreground",
  catalogRevision: "standalone:1",
  provider: { id: "scripted", entryId: "echo:models", generation: "builtin" },
  model: { provider: "scripted", id: "only", api: "fake" },
  streamFunction: () => {
    throw new Error("unused");
  },
  thinkingLevel: "off",
  retryPolicy: { maxAttempts: 1, backoffMs: () => 0 } as unknown as RunModelBinding["retryPolicy"],
};
const IDENTITY = { agentId: "a", agentInstanceId: "a#1", sessionId: null };

async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

test("库被别的连接锁住：写入端在 worker 里干等，主线程照常跳、run.closed 到期降级返回；锁放开后照样落盘", async () => {
  const path = await dbPath();
  // 写入端的 busy_timeout 给到 3 秒：锁不放，提交就在 worker 里同步等满 3 秒
  const store = await WorkerObservationStore.open({ path, busyTimeoutMs: 3_000 });
  const rt = new ObservationRuntime({
    runtimeId: "rt:locked",
    runtimeGeneration: "boot",
    capturePolicy: "metadata",
    store,
    clock: systemClock,
    assembly: sealAgentAssemblyObservation([]),
    limits: { boundaryDeadlineMs: 300 },
  });
  const locker = new Database(path);
  locker.run("BEGIN EXCLUSIVE"); // 别的连接拿走写锁：写入端的 BEGIN IMMEDIATE 只能等

  let lastTick = Date.now();
  let longestStall = 0;
  const ticker = setInterval(() => {
    const now = Date.now();
    longestStall = Math.max(longestStall, now - lastTick);
    lastTick = now;
  }, 10);
  try {
    const started = Date.now();
    rt.acceptRun({ runId: "run:locked", source: { kind: "user" }, ...IDENTITY, modelBinding: BINDING });
    rt.startRun("run:locked", IDENTITY, "permit-executor");
    await rt.closeRun({ runId: "run:locked", outcome: { kind: "completed" }, finalState: null }, IDENTITY);
    const elapsed = Date.now() - started;
    // 定时器一拍都没跳过时，上面的回调里量不到停顿：返回这一刻再补量一次
    longestStall = Math.max(longestStall, Date.now() - lastTick);

    // 到期返回：是 300ms 的有界等待说了算，不是 3 秒的锁等待
    expect(elapsed).toBeLessThan(1_500);
    // 干等期间主线程没被占住：10ms 一拍的定时器，最长的一次间隔远小于锁等待
    expect(longestStall).toBeLessThan(500);
    expect(rt.persistenceOf("run:locked")).toBe("degraded");
    expect(rt.sequencer.persistenceState.status).toBe("degraded");

    // 锁放开：worker 里那次等待拿到锁，这批记录落盘，封口进 RunIndex
    locker.run("ROLLBACK");
    expect(await until(() => rt.persistenceOf("run:locked") === "stored", 5_000)).toBe(true);
    const index = await store.readRunIndex("run:locked");
    expect(index?.terminalRecordId).toBeDefined();
  } finally {
    clearInterval(ticker);
    locker.close();
    await rt.dispose();
  }
}, 20_000);

test("开关一次写入端之后，进程退出时 process.on(\"exit\") 的监听照常运行（worker 线程没加载 node:fs / node:worker_threads）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-worker-exit-"));
  temps.push(dir);
  const marker = join(dir, "exit-ran");
  const script = join(dir, "open-close.ts");
  const workerStore = join(import.meta.dir, "../src/observability/worker-store.ts");
  await Bun.write(
    script,
    [
      `import { appendFileSync } from "node:fs";`,
      `import { WorkerObservationStore } from ${JSON.stringify(workerStore)};`,
      `process.on("exit", () => appendFileSync(${JSON.stringify(marker)}, "ran"));`,
      `const store = await WorkerObservationStore.open({ path: ${JSON.stringify(join(dir, "state", "obs.sqlite"))} });`,
      `await store.readCommittedPrefix("rt");`,
      `await store.close();`,
    ].join("\n"),
  );
  const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), 10_000);
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  clearTimeout(killer);
  expect(stderr).toBe("");
  expect(proc.exitCode).toBe(0);
  expect(await Bun.file(marker).exists()).toBe(true);
}, 20_000);

test("worker 抛的 corruption 回到主线程仍是 ObservationCorruptionError；expect().resolves / .rejects 里连续等写入端不挂", async () => {
  const store = await WorkerObservationStore.open({ path: await dbPath() });
  const bytes = (v: unknown): Uint8Array => encodeCanonical(v).bytes;
  const batch = (seq: number, body: unknown, expected: number): CommitBatchInput => ({
    runtimeId: "rt",
    expectedCommittedPrefix: expected,
    nextCommittedPrefix: seq,
    records: [{ recordId: `rt:${seq}`, runtimeId: "rt", seq, canonicalEnvelopeBytes: bytes(body) }],
    runIndexMutations: [],
  });
  try {
    // bun test 的 expect 在原生代码里阻塞等 promise，跨线程消息从第二条起派发不出来；写入端靠定时器兜底取回信
    await expect(store.commitBatchIfAbsent(batch(1, { n: 1 }, 0))).resolves.toBe("committed");
    await expect(store.readCommittedPrefix("rt")).resolves.toBe(1);
    // 同 recordId 不同 bytes：worker 里判 corruption，主线程拿到的是同一个类
    await expect(store.commitBatchIfAbsent(batch(1, { tampered: true }, 0))).rejects.toBeInstanceOf(ObservationCorruptionError);
    expect(await store.readCommittedPrefix("rt")).toBe(1);
  } finally {
    await store.close();
  }
  // 关闭之后再调：立刻 reject，不挂
  await expect(store.readCommittedPrefix("rt")).rejects.toThrow("已关闭");
}, 10_000);
