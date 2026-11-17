// 从进程外往一段会话的 inbox 投递（2026-11-16，`session/ingress.ts`）：同一台机器上别的进程（运维后台、脚本）
// 让常驻的 agent 做事。协议与 `agent.ingress` 同一份；收方扫盘时同一个 dedupeKey 还没处理完的只收一条。

import { expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/create-agent.ts";
import { openSessionIngress } from "../src/session/ingress.ts";
import { SessionService, setSessionStatus } from "../src/session/service.ts";
import { InboxStore } from "../src/inbox/store.ts";
import { writeInboxRecord } from "../src/inbox/foreign.ts";
import { createRecordIdSource, recordPath } from "../src/inbox/records.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn } from "../src/testing.ts";
import { userMessage, type AgentMessage } from "../src/messages.ts";

/** 预置一段说过话的会话——一句话没说的段不落 meta，就找不到它。 */
async function seed(root: string, id: string): Promise<void> {
  const svc = new SessionService(new FileDir(join(root, id)));
  await svc.createOrResume(id, { workspace: "/repo", product: "echo-agent" });
  await svc.append(id, [{ kind: "message", message: userMessage("开场") }]);
  await svc.settle();
}

async function inboxFiles(root: string, id: string): Promise<string[]> {
  return (await readdir(join(root, id, "inbox")).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
}

test("openSessionIngress：投进去的一条落在那段会话的 inbox；同一个 dedupeKey 还没处理完再投，返回原来那条；空 key、形状不对的拒；会话不存在或关了打开就抛，打开后被关了拒成 runtime-disposed", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-ingress-"));
  await seed(root, "s-ops");
  const inbox = await openSessionIngress({ sessionsRoot: root, sessionId: "s-ops" });

  const first = await inbox.deliverDurable({ message: userMessage("把群公告改成明天停机"), dedupeKey: "ops:1" });
  expect(first).toMatchObject({ kind: "accepted", dedupeKey: "ops:1", deduplicated: false });
  expect(await inboxFiles(root, "s-ops")).toHaveLength(1);
  const again = await inbox.deliverDurable({ message: userMessage("把群公告改成明天停机"), dedupeKey: "ops:1" });
  expect(again).toEqual({ kind: "accepted", recordId: first.kind === "accepted" ? first.recordId : "", dedupeKey: "ops:1", deduplicated: true });
  expect(await inboxFiles(root, "s-ops")).toHaveLength(1); // 没写第二份

  expect(await inbox.deliverDurable({ message: userMessage("x"), dedupeKey: "" })).toEqual({ kind: "rejected", reason: "invalid-request", errorDigest: "empty-dedupe-key" });
  expect(await inbox.deliverDurable({ message: { role: "bogus" } as unknown as AgentMessage, dedupeKey: "ops:2" })).toEqual({ kind: "rejected", reason: "invalid-request", errorDigest: "message-shape" });

  await expect(openSessionIngress({ sessionsRoot: root, sessionId: "s-none" })).rejects.toThrow("没有会话 s-none");
  await expect(openSessionIngress({ sessionsRoot: root, sessionId: "../escape" })).rejects.toThrow();
  await setSessionStatus(new FileDir(join(root, "s-ops")), "s-ops", "closed");
  await expect(openSessionIngress({ sessionsRoot: root, sessionId: "s-ops" })).rejects.toThrow("会话 s-ops 已经关了");
  expect(await inbox.deliverDurable({ message: userMessage("关了之后"), dedupeKey: "ops:3" })).toEqual({ kind: "rejected", reason: "runtime-disposed", errorDigest: "session-closed" });
});

test("跑着的 agent 不重启就收下别处投来的用户消息、当成用户的话跑一轮；处理完之后同一个 dedupeKey 再投是新的一条（2026-11-16）", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-ingress-"));
  await seed(root, "s-ops");
  const provider = createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect([textTurn("公告改好了"), textTurn("又改了一遍")])),
  });
  const agent = await createAgent({ provider, sessionId: "s-ops", sessionsRoot: root, allowNetwork: false, withoutMemory: true });
  await agent.start();
  try {
    const inbox = await openSessionIngress({ sessionsRoot: root, sessionId: "s-ops" });
    const replied = async (text: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (agent.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes(text)) && agent.state.status === "idle") return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`等不到回复：${text}`);
    };

    expect(await inbox.deliverDurable({ message: userMessage("把群公告改成明天停机"), dedupeKey: "ops:notice" })).toMatchObject({ kind: "accepted", deduplicated: false });
    await replied("公告改好了");
    const asked = agent.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("把群公告改成明天停机"));
    expect(asked.map((m) => (m as { source: string }).source)).toEqual(["human"]); // 用户的话，不是环境消息

    // 上一条已经处理完（ack 了）：同一个 key 再投就是新的一条
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await inboxFiles(root, "s-ops")).length > 0) await new Promise((r) => setTimeout(r, 25));
    expect(await inbox.deliverDurable({ message: userMessage("再改一遍"), dedupeKey: "ops:notice" })).toMatchObject({ kind: "accepted", deduplicated: false });
    await replied("又改了一遍");
  } finally {
    await agent.stop();
  }
}, 30_000);

test("refresh：同一个 dedupeKey 还有没处理完的，别处写进来的重复那条不收、从盘上删掉；先前那条 ack 之后同一个 key 再来是新的一条（2026-11-16）", async () => {
  const dir = new InMemoryDir();
  const store = new InboxStore(dir);
  await store.restore();
  const writerA = createRecordIdSource();
  const writerB = createRecordIdSource();

  // 两个写者几乎同时投同一个 key：一次 refresh 里只收一条
  const a = await writeInboxRecord(dir, writerA, userMessage("改公告"), "ops:1");
  const b = await writeInboxRecord(dir, writerB, userMessage("改公告"), "ops:1");
  expect(await store.refresh()).toBe(1);
  expect(store.pendingCount).toBe(1);
  // 两个写者同一毫秒写下的谁排前由 id 的随机尾巴定：只断言恰好留下一条
  const onDisk = await Promise.all([a, b].map(async (id) => (await dir.read(recordPath(id))) !== null));
  expect(onDisk.filter(Boolean)).toHaveLength(1);
  const kept = onDisk[0] ? a : b;

  // 那条还没处理完，别处重试又写了一份：不收
  const c = await writeInboxRecord(dir, writerB, userMessage("改公告"), "ops:1");
  expect(await store.refresh()).toBe(0);
  expect(await dir.read(recordPath(c))).toBeNull();

  // 处理完（ack）之后同一个 key 再来：新的一条
  const batch = store.reserveBatch()!;
  expect(batch.recordIds).toEqual([kept]);
  await store.ackBatch(batch.reservationId);
  await writeInboxRecord(dir, writerA, userMessage("再改一遍"), "ops:1");
  expect(await store.refresh()).toBe(1);
});
