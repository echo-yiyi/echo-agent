import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "../src/inbox/store.ts";
import { inboxFactDescriptor, type InboxFact } from "../src/inbox/observe.ts";
import { createRecordIdSource, recordPath, serializeRecord } from "../src/inbox/records.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { environmentMessage } from "../src/messages.ts";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, type ScriptedTurn } from "../src/testing.ts";
import type { Provider } from "../src/provider/types.ts";
import type { RunObservationHeader } from "../src/observability/types.ts";

// Inbox 行的观测（2026-09-05）：账本是唯一发点。
//   单测：内存账本 + 假 sink，accept / 去重 / reserve → consumed / ack / release 各出一条什么；
//         FileDir 账本上，别的进程写进目录的 record 由 refresh 发现，事实说清 via=refresh 与发送方 ref。
//   e2e：真 createEcho，deliver → consumeInbox → run 的时间线里有 inbox.consumed（谁的哪条消息触发的），
//         run 之外的 accepted / acked 经 reader.recentActivity() 读得到，acked 带消费它的 runId。

const temps: string[] = [];
const running: Echo[] = [];
afterEach(async () => {
  for (const e of running.splice(0)) await e.stop().catch(() => {});
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true });
});

function collector(): { facts: InboxFact[]; sink: { offer(f: InboxFact): void } } {
  const facts: InboxFact[] = [];
  return { facts, sink: { offer: (f) => facts.push(f) } };
}

test("内存账本：accept → accepted；同 key 再投 → deduplicated；reserve + noteConsumed → consumed；ack → acked 带 runId；release 带 reason", async () => {
  const store = new InboxStore(null);
  const { facts, sink } = collector();
  store.observe = sink;
  const msg = environmentMessage("HR 回你了", "session", "s-peer:m1");
  const a = await store.accept({ message: msg, dedupeKey: "k1" });
  expect(a.kind).toBe("accepted");
  const dup = await store.accept({ message: msg, dedupeKey: "k1" });
  expect(dup).toMatchObject({ kind: "accepted", deduplicated: true });
  expect(await store.accept({ message: msg, dedupeKey: "" })).toMatchObject({ kind: "rejected", reason: "invalid-request" });

  const batch = store.reserveBatch()!;
  store.noteConsumed(batch.reservationId, "run:1");
  await store.ackBatch(batch.reservationId, { runId: "run:1" });
  await store.accept({ message: environmentMessage("再问一句", "session", "s-peer:m2"), dedupeKey: "k2" });
  const second = store.reserveBatch()!;
  store.releaseBatch(second.reservationId, "run-rejected", "run:2");

  expect(facts.map((f) => f.kind)).toEqual(["accepted", "accepted", "rejected", "consumed", "acked", "accepted", "released"]);
  expect(facts[0]).toMatchObject({ via: "deliver", deduplicated: false, records: [{ role: "environment", source: "session", ref: "s-peer:m1", text: "HR 回你了" }] });
  expect(facts[0]!.records[0]!.recordId).toMatch(/^[0-9a-f]{12}-[0-9a-f]{16}$/);
  expect(facts[1]).toMatchObject({ deduplicated: true, records: [{ recordId: facts[0]!.records[0]!.recordId }] });
  expect(facts[2]).toMatchObject({ reason: "invalid-request", errorDigest: "empty-dedupe-key", records: [] });
  expect(facts[3]).toMatchObject({ reservationId: batch.reservationId, runId: "run:1", records: [{ recordId: batch.recordIds[0] }] });
  expect(facts[4]).toMatchObject({ kind: "acked", reservationId: batch.reservationId, runId: "run:1" });
  expect(facts[6]).toMatchObject({ kind: "released", reason: "run-rejected", runId: "run:2", records: [{ ref: "s-peer:m2" }] });
  for (const f of facts) expect(typeof f.occurredAt).toBe("number");
});

test("descriptor：metadata 档只留结构（id / source / ref / 计数），正文与原文只在 content 档；off 不出记录", () => {
  const fact: InboxFact = {
    kind: "rejected",
    records: [{ role: "environment", source: "session", ref: "s-a:m9", text: "秘密正文" }],
    reason: "store-error",
    errorDigest: "abc",
    message: "disk full",
    occurredAt: 1,
  };
  const meta = inboxFactDescriptor.project(fact, "metadata")!;
  expect(meta.name).toBe("inbox.rejected");
  expect(meta.attributes).toEqual({ count: 1, source: "session", ref: "s-a:m9", reason: "store-error" });
  expect(JSON.stringify(meta.body)).not.toContain("秘密正文");
  expect(JSON.stringify(meta.body)).not.toContain("disk full");
  expect(meta.body).toMatchObject({ records: [{ role: "environment", source: "session", ref: "s-a:m9" }], errorDigest: "abc" });
  expect((meta.body as { messageDigest: string }).messageDigest).toMatch(/^[0-9a-f]{64}$/);
  const full = inboxFactDescriptor.project(fact, "content")!;
  expect(full.body).toMatchObject({ records: [{ text: "秘密正文" }], message: "disk full" });
  expect(inboxFactDescriptor.project(fact, "off")).toBeNull();
  const batch = inboxFactDescriptor.project({ kind: "acked", records: [{ role: "user" }, { role: "user" }], reservationId: "rsv:x", runId: "run:7", occurredAt: 2 }, "metadata")!;
  expect(batch.attributes).toEqual({ count: 2, runId: "run:7" });
  expect(batch.scope).toEqual({ activityId: "inbox:rsv:x" });
});

test("FileDir 账本：别的进程（另一段会话的 session_send）写进目录的 record，refresh 发现 → accepted via=refresh，带发送方 ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-inbox-obs-"));
  temps.push(dir);
  const fs = new FileDir(dir);
  const store = new InboxStore(fs);
  await store.restore();
  const { facts, sink } = collector();
  store.observe = sink;
  // 与 session/sessions.ts 的 deliver() 同一条路：只写文件，不碰对方的内存账本
  const newId = createRecordIdSource();
  const recordId = newId();
  await fs.write(recordPath(recordId), serializeRecord({ recordId, dedupeKey: "session:s-peer:m1", message: environmentMessage("你那边好了吗", "session", "s-peer:m1"), acceptedAt: Date.now() }));
  expect(await store.refresh()).toBe(1);
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({ kind: "accepted", via: "refresh", deduplicated: false, records: [{ recordId, source: "session", ref: "s-peer:m1", text: "你那边好了吗" }] });

  // 重启：盘上还没消费的那批 → restored
  const again = new InboxStore(new FileDir(dir));
  const c2 = collector();
  again.observe = c2.sink;
  await again.restore();
  expect(c2.facts.map((f) => f.kind)).toEqual(["restored"]);
  expect(c2.facts[0]!.records.map((r) => r.recordId)).toEqual([recordId]);
});

/** 等 inbox 触发的那条 run 封口（listRuns 只见已 COMMIT 的 header）。 */
async function waitForInboxRun(echo: Echo): Promise<RunObservationHeader> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const page = await echo.observations.listRuns({ limit: 5 });
    const run = page.items.find((h) => h.source.kind === "inbox" && h.status !== "running");
    if (run !== undefined) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("inbox 触发的 run 5s 内没有封口");
}

function scripted(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

test("e2e：deliver → consumeInbox：run 里有 inbox.consumed（谁的消息触发的）；run 之外的 accepted / acked 从 recentActivity 读，acked 带 runId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "echo-inbox-e2e-"));
  temps.push(dir);
  const echo = await createEcho({ provider: scripted([textTurn("收到，我去看。")]), stateDir: join(dir, "s1"), allowNetwork: false, extensionDirs: [], withoutMemory: true });
  running.push(echo);
  await echo.agent.start();
  await echo.agent.ingress.deliverDurable({ message: environmentMessage("你那边好了吗", "session", "s-peer:m1"), dedupeKey: "session:s-peer:m1" });
  // 装配层开着自动消费：投递被接受后 agent 自己起 run；显式再叫一次也无妨（没东西就返回 null）
  await echo.agent.consumeInbox();
  const run = await waitForInboxRun(echo);
  expect(run.status).toBe("completed");
  const lookup = await echo.observations.getRun(run.runId);
  if (lookup.kind !== "found") throw new Error(lookup.kind);
  const consumed = lookup.observation.records.find((r) => r.name === "inbox.consumed");
  expect(consumed).toBeDefined();
  expect(consumed!.scope.runId).toBe(run.runId);
  expect(consumed!.attributes).toMatchObject({ count: 1, source: "session", ref: "s-peer:m1", runId: run.runId });
  expect(consumed!.body).toMatchObject({ records: [{ role: "environment", source: "session", ref: "s-peer:m1" }] });
  expect(JSON.stringify(consumed!.body)).not.toContain("你那边好了吗"); // metadata 档没有正文

  await echo.stop();
  const { openObservationReader } = await import("../src/index.ts");
  const reader = await openObservationReader({ stateRoot: join(dir, "s1") });
  try {
    const activity = await reader.recentActivity({ limit: 20 });
    const names = activity.map((r) => r.name);
    expect(names).toContain("inbox.accepted");
    expect(names).toContain("inbox.acked");
    for (const r of activity) expect(r.scope.runId).toBeUndefined();
    const acked = activity.find((r) => r.name === "inbox.acked")!;
    expect(acked.attributes).toMatchObject({ count: 1, runId: run.runId });
    expect(names.indexOf("inbox.acked")).toBeLessThan(names.indexOf("inbox.accepted")); // 新的在前
  } finally {
    await reader.close();
  }
});
