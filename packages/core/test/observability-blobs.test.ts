// 正文存储（观测白盒化 §4，A2）：`content` 档把送进模型的东西存成 blob，记录里只放引用。
//   · 重建：只凭账本 + blob 还原每次调模型的 `{ systemPrompt, messages, tools }`，与 provider 真正收到的逐项深相等；
//   · 先写 blob、后提交引用它的批：提交了的记录不指向不存在的文件；
//   · `metadata` 档一个 blob 都不写；
//   · 同一份正文只存一份、只写一次（到了重写间隔才重写，刷新清扫看的 writtenAt）；
//   · 过期清扫：按引用（引用列表逐层展开）+ 宽限期，删完不留悬空引用。

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams, type Dialect } from "../src/provider/dialect.ts";
import { errorTurn, scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { Provider } from "../src/provider/types.ts";
import type { Context } from "../src/messages.ts";
import { assistantMessage, defaultConvertToLlm, environmentMessage, toolResultMessage, userMessage, type AgentMessage } from "../src/messages.ts";
import { buildWorkingMessages } from "../src/compaction/view.ts";
import type { CompactionState } from "../src/compaction/types.ts";
import { ContextMirror } from "../src/observability/context-mirror.ts";
import { ContextMirrorStore, type ContextBuiltBody, type ContextBuiltMeta } from "../src/observability/context-mirror-host.ts";
import { readContextContent } from "../src/observability/context-content.ts";
import { BLOB_REWRITE_AFTER_MS, BLOB_SWEEP_GRACE_MS, BlobWriter, collectBlobRefs, expandBlobRefs, jsonBlob, textBlob, type EncodedBlob } from "../src/observability/blobs.ts";
import { DocumentObservationReader } from "../src/observability/document-store.ts";
import { expireObservations } from "../src/observability/expiry.ts";
import { openObservationReader } from "../src/observability/query.ts";
import { ObservationCorruptionError } from "../src/observability/store.ts";
import { OBSERVATION_BLOB_REFS, type ObservationBlobRef, type ObservationEnvelope } from "../src/observability/types.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import type { StorageDir } from "../src/storage/types.ts";

const META: ContextBuiltMeta = { purpose: "turn", attempt: 1, hooks: {}, converter: "default", request: { model: "p/m", thinkingLevel: null, maxOutputTokens: null } };
const NO_COMPACTION: CompactionState = { spans: [], clearedBefore: 0 };

/** 内存里的 blob 写入端 + 读回：单测用，不经观测线程。 */
function memoryBlobs(now: () => number = () => Date.now()): { writer: BlobWriter; read: (ref: ObservationBlobRef) => Promise<string | null>; writes: EncodedBlob[]; dir: InMemoryDir } {
  const dir = new InMemoryDir();
  const reader = new DocumentObservationReader(dir, "(test)");
  const writes: EncodedBlob[] = [];
  const writer = new BlobWriter(async (blob, at) => {
    writes.push(blob);
    await dir.write(`observability/blobs/${blob.ref.digest}.json`, JSON.stringify({ schemaVersion: 1, writtenAt: at, text: blob.text }));
  }, now);
  return { writer, read: (ref) => reader.readBlob(ref), writes, dir };
}

/* ─────────────── 观测线程的那一半：正文写进 blob，凭引用还原 ─────────────── */

test("content 档：压缩摘要、清掉的占位、每轮注入、system、工具 schema 都存成 blob，凭引用还原出与送模时同一份视图", async () => {
  const messages: AgentMessage[] = [
    userMessage("最早的问题"),
    assistantMessage([{ type: "text", text: "最早的回答" }], "end_turn"),
    userMessage("读一下 a.ts"),
    assistantMessage([{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }], "tool_use"),
    toolResultMessage("t1", "read", "x".repeat(500), false),
    assistantMessage([{ type: "text", text: "读完了" }], "end_turn"),
  ];
  const state: CompactionState = { spans: [{ from: 0, to: 2, summary: "前面问过一个问题" }], clearedBefore: 5 };
  const injection = environmentMessage("技能正文", "skill", "review");
  const tool: ModelTool = { kind: "model", name: "read", label: "read", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } }, execute: async () => toolOk("x") };
  const mirror = new ContextMirror();
  const store = new ContextMirrorStore();
  const { writer, read } = memoryBlobs();
  const batch = writer.batch();
  const body = store.resolve(mirror.handoff({ systemPrompt: "SYS", transcript: messages, compaction: state, injections: [injection], tools: [tool] }), META, batch);
  await batch.commit();

  const restored = await readContextContent(read, body.content!);
  expect(restored).not.toBeNull();
  expect(restored!.systemPrompt).toBe("SYS");
  expect(restored!.view).toEqual([...buildWorkingMessages(messages, state), injection]);
  expect(restored!.tools).toEqual([{ name: "read", description: "读文件", input_schema: tool.parameters }]);
  // 不给批（metadata 档）：body 里没有 content
  expect(new ContextMirrorStore().resolve(new ContextMirror().handoff({ systemPrompt: "S", transcript: messages, compaction: NO_COMPACTION, injections: [], tools: [] }), META).content).toBeUndefined();
});

test("长视图分块成引用树：5,000 条逐条还原；再来一条只多写这条消息与沿途变了的块，记录里始终只有一个引用", async () => {
  const list: AgentMessage[] = [];
  for (let i = 0; i < 5_000; i++) list.push(i % 2 === 0 ? userMessage(`问 ${i}`) : assistantMessage([{ type: "text", text: `答 ${i}` }], "end_turn"));
  const mirror = new ContextMirror();
  const store = new ContextMirrorStore();
  const { writer, read, writes } = memoryBlobs();
  const resolve = async (): Promise<ContextBuiltBody> => {
    const batch = writer.batch();
    const body = store.resolve(mirror.handoff({ systemPrompt: "S", transcript: list, compaction: NO_COMPACTION, injections: [], tools: [] }), META, batch);
    await batch.commit();
    return body;
  };
  const first = await resolve();
  expect(first.content!.view.mediaType).toBe(OBSERVATION_BLOB_REFS);
  expect((await readContextContent(read, first.content!))!.view).toEqual(list);

  writes.length = 0;
  list.push(userMessage("再问一句"));
  const second = await resolve();
  expect((await readContextContent(read, second.content!))!.view).toEqual(list);
  // 新消息 1 条 + 末尾那块 + 上一层末尾那块 + 顶层（64 × 64 = 4,096 < 5,001：两层）；system、工具、前面的块都不重写
  expect(writes.map((w) => w.ref.mediaType)).toEqual(["application/json", OBSERVATION_BLOB_REFS, OBSERVATION_BLOB_REFS, OBSERVATION_BLOB_REFS]);
});

test("同一份正文在重写间隔之内只写一次；过了间隔再被引用就重写（刷新 writtenAt，清扫的宽限期看它）", async () => {
  let now = 1_000_000;
  const { writer, writes, dir } = memoryBlobs(() => now);
  const put = async (text: string): Promise<void> => {
    const batch = writer.batch();
    batch.add(textBlob(text));
    await batch.commit();
  };
  await put("system 原文");
  await put("system 原文");
  expect(writes).toHaveLength(1);
  now += BLOB_REWRITE_AFTER_MS + 1;
  await put("system 原文");
  expect(writes).toHaveLength(2);
  const file = JSON.parse((await dir.read(`observability/blobs/${textBlob("system 原文").ref.digest}.json`))!) as { writtenAt: number };
  expect(file.writtenAt).toBe(now);

  // 镜像里记住了引用的消息、system、菜单也一样：间隔之内不重写，过了间隔被新记录引用就重写
  const mirror = new ContextMirror();
  const store = new ContextMirrorStore();
  const list = [userMessage("一句话")];
  const resolve = async (): Promise<void> => {
    const batch = writer.batch();
    store.resolve(mirror.handoff({ systemPrompt: "S", transcript: list, compaction: NO_COMPACTION, injections: [], tools: [] }), META, batch);
    await batch.commit();
  };
  writes.length = 0;
  await resolve();
  const firstWrites = writes.length;
  await resolve();
  expect(writes.length).toBe(firstWrites);
  now += BLOB_REWRITE_AFTER_MS + 1;
  writes.length = 0;
  await resolve();
  expect(writes.map((w) => w.ref.digest).sort()).toEqual([textBlob("S").ref.digest, jsonBlob(list[0]).ref.digest, jsonBlob([]).ref.digest, writes.find((w) => w.ref.mediaType === OBSERVATION_BLOB_REFS)!.ref.digest].sort());
});

test("readBlob：文件不在返回 null（正文已不在，不是 corruption）；内容对不上引用是 corruption", async () => {
  const dir = new InMemoryDir();
  const reader = new DocumentObservationReader(dir, "(test)");
  const blob = jsonBlob({ b: 1, a: [1, 2] });
  expect(blob.text).toBe('{"a":[1,2],"b":1}'); // canonical：键排序
  expect(await reader.readBlob(blob.ref)).toBeNull();
  await dir.write(`observability/blobs/${blob.ref.digest}.json`, JSON.stringify({ schemaVersion: 1, writtenAt: 1, text: blob.text }));
  expect(await reader.readBlob(blob.ref)).toBe(blob.text);
  await dir.write(`observability/blobs/${blob.ref.digest}.json`, JSON.stringify({ schemaVersion: 1, writtenAt: 1, text: '{"a":[1,2],"b":2}' }));
  expect(await reader.readBlob(blob.ref).catch((e: unknown) => e)).toBeInstanceOf(ObservationCorruptionError);
});

/* ─────────────── 端到端 ─────────────── */

const temps: string[] = [];
const running: Echo[] = [];
afterEach(async () => {
  for (const e of running.splice(0)) await e.stop().catch(() => {});
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true });
});

/** 脚本化 provider（标了 100 万窗口，压缩能算），并截下每次请求真正送到 provider 的上下文。 */
function capturing(turns: ScriptedTurn[]): { provider: Provider; requests: Context[] } {
  const requests: Context[] = [];
  const inner = scriptedDialect(turns);
  const dialect: Dialect = {
    api: inner.api,
    request(model, context, options) {
      requests.push(structuredClone(context));
      return inner.request(model, context, options);
    },
  };
  const provider = createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake", capabilities: { contextWindow: 1_000_000 } }],
    api: createProviderStreams(dialect),
  });
  return { provider, requests };
}

const ping: ModelTool = { kind: "model", name: "ping", label: "ping", description: "回一个 pong", parameters: { type: "object", properties: {} }, execute: async () => toolOk("pong") };

async function echoWith(
  provider: Provider,
  opts: { capture: "metadata" | "content"; store?: StorageDir; transformContext?: (m: AgentMessage[]) => Promise<AgentMessage[]> },
): Promise<{ echo: Echo; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-blobs-"));
  temps.push(dir);
  const stateDir = join(dir, "state");
  const echo = await createEcho({
    provider,
    allowNetwork: false,
    stateDir,
    extensionDirs: [],
    withoutMemory: true,
    agent: {
      tools: [ping],
      compaction: { keepRecentTokens: 8_000 },
      retryPolicy: { maxAttempts: 3, backoffMs: () => 0 },
      ...(opts.transformContext === undefined ? {} : { transformContext: opts.transformContext }),
    },
    observation: { capture: opts.capture, ...(opts.store === undefined ? {} : { store: opts.store }) },
  });
  running.push(echo);
  await echo.start();
  return { echo, stateDir };
}

async function recordsOf(echo: Echo, runId: string): Promise<readonly ObservationEnvelope[]> {
  const lookup = await echo.observations.getRun(runId);
  if (lookup.kind !== "found") throw new Error(`run 没读回来：${lookup.kind}`);
  return lookup.observation.records;
}

/** 一次 run 的 context.built 逐条还原，与截下的请求逐项深相等。 */
async function expectReconstructs(read: (ref: ObservationBlobRef) => Promise<string | null>, built: readonly ObservationEnvelope[], requests: readonly Context[]): Promise<void> {
  expect(built).toHaveLength(requests.length);
  for (let i = 0; i < built.length; i++) {
    const body = built[i]!.body as ContextBuiltBody;
    const restored = await readContextContent(read, body.content!);
    expect(restored).not.toBeNull();
    const sent = requests[i]!;
    expect(restored!.systemPrompt).toBe(sent.systemPrompt ?? null);
    expect(defaultConvertToLlm(restored!.view)).toEqual(sent.messages);
    expect(restored!.tools).toEqual(sent.tools);
  }
}

test("重建（content 档）：工具、两个 run、撞窗应急压缩（摘要调用撞 429 重试）——每次调模型都能只凭账本 + blob 还原成 provider 收到的那一份", async () => {
  const { provider, requests } = capturing([
    toolTurn("c1", "ping", {}),
    textTurn("first"),
    errorTurn("context_overflow", "prompt too long", false), // 第二个 run：撞窗
    errorTurn("rate_limit", "限流", true), // 摘要调用第 1 次：429
    textTurn("<summary>前面读过一大段 x</summary>"), // 摘要调用第 2 次
    textTurn("ok"), // 压缩之后重跑
  ]);
  const { echo, stateDir } = await echoWith(provider, { capture: "content" });
  const r1 = await echo.send("x".repeat(12_000));
  const r2 = await echo.send("second");
  expect(requests).toHaveLength(6);

  const records = [...(await recordsOf(echo, r1.runId)), ...(await recordsOf(echo, r2.runId))];
  const built = records.filter((e) => e.name === "context.built");
  const bodies = built.map((e) => e.body as ContextBuiltBody);
  // 覆盖到了：压缩阶段的调用、它的重试、同一个 turn 压缩之后的第二次 attempt
  expect(bodies.map((b) => [b.purpose, b.attempt])).toEqual([
    ["turn", 1],
    ["turn", 1],
    ["turn", 1],
    ["compaction", 1],
    ["compaction", 2],
    ["turn", 2],
  ]);
  await expectReconstructs((ref) => echo.observations.readBlob(ref), built, requests);

  // prompt.assembled 的原文：就是这个 run 送出去的 system
  const assembled = records.filter((e) => e.name === "prompt.assembled");
  expect(assembled).toHaveLength(2);
  expect(await echo.observations.readBlob((assembled[0]!.body as { text: ObservationBlobRef }).text)).toBe(requests[0]!.systemPrompt!);

  // 离线 reader 读同一份
  await echo.stop();
  const reader = await openObservationReader({ stateRoot: stateDir });
  await expectReconstructs((ref) => reader.readBlob(ref), built, requests);
  await reader.close();
});

test("重建（content 档）：transformContext 改过的视图按改后的样子存", async () => {
  const { provider, requests } = capturing([textTurn("好")]);
  const { echo } = await echoWith(provider, { capture: "content", transformContext: async (m) => [...m, userMessage("（hook 加的一句）", "harness")] });
  const r = await echo.send("go");
  const built = (await recordsOf(echo, r.runId)).filter((e) => e.name === "context.built");
  expect((built[0]!.body as ContextBuiltBody).hooks).toEqual({ transformContext: "replaced" });
  await expectReconstructs((ref) => echo.observations.readBlob(ref), built, requests);
  expect(JSON.stringify(requests[0]!.messages)).toContain("hook 加的一句");
});

test("metadata 档一个 blob 都不写：记录里没有 content、没有原文引用", async () => {
  const { provider } = capturing([toolTurn("c1", "ping", {}), textTurn("好")]);
  const { echo, stateDir } = await echoWith(provider, { capture: "metadata" });
  const r = await echo.send("go");
  const records = await recordsOf(echo, r.runId);
  expect(records.filter((e) => e.name === "context.built").every((e) => (e.body as ContextBuiltBody).content === undefined)).toBe(true);
  expect((records.find((e) => e.name === "prompt.assembled")!.body as { text?: unknown }).text).toBeUndefined();
  let refs = 0;
  for (const e of records) collectBlobRefs(e.body, () => (refs += 1));
  expect(refs).toBe(0);
  await echo.observations.flush();
  expect(await readdir(join(stateDir, "observability", "blobs")).catch(() => [])).toEqual([]);
});

/** 记下每次写的路径，按先后。 */
class RecordingDir extends InMemoryDir {
  readonly order: string[] = [];
  override async write(path: string, content: string): Promise<void> {
    await super.write(path, content);
    this.order.push(path);
  }
}

test("先写 blob、后提交引用它的批：每个批文件写下去的那一刻，它引用到的正文（连同引用列表展开出来的）都已经在盘上", async () => {
  const store = new RecordingDir();
  const { provider } = capturing([toolTurn("c1", "ping", {}), textTurn("好"), textTurn("再来")]);
  const { echo } = await echoWith(provider, { capture: "content", store });
  await echo.send("go");
  await echo.send("again");
  await echo.observations.flush();

  const reader = new DocumentObservationReader(store, "(test)");
  const blobAt = (digest: string): number => store.order.indexOf(`observability/blobs/${digest}.json`);
  let checked = 0;
  for (let i = 0; i < store.order.length; i++) {
    const path = store.order[i]!;
    if (!path.startsWith("observability/batches/")) continue;
    const batch = JSON.parse((await store.read(path))!) as { records: { envelope: string }[] };
    const refs: ObservationBlobRef[] = [];
    for (const r of batch.records) collectBlobRefs(JSON.parse(r.envelope), (ref) => refs.push(ref));
    for (const ref of refs) {
      for (const leaf of [ref, ...((await expandBlobRefs((x) => reader.readBlob(x), ref)) ?? [])]) {
        const at = blobAt(leaf.digest);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBeLessThan(i);
        checked += 1;
      }
    }
  }
  expect(checked).toBeGreaterThan(10);
});

test("过期清扫：删掉一个 run 后，剩下的记录引用到的正文一份不少；宽限期内的不删；全删且过了宽限期，正文一份不剩", async () => {
  const { provider } = capturing([toolTurn("c1", "ping", {}), textTurn("first"), textTurn("second")]);
  const { echo, stateDir } = await echoWith(provider, { capture: "content" });
  const r1 = await echo.send("go");
  await echo.observations.flush(); // r1 的记录先落成批：两个 run 不同批，删 r1 才删得干净
  const r2 = await echo.send("again");
  await echo.stop();
  const blobFiles = async (): Promise<string[]> => (await readdir(join(stateDir, "observability", "blobs")).catch(() => [])).sort();
  const before = await blobFiles();
  expect(before.length).toBeGreaterThan(0);

  // 宽限期内：r1 删了、它独有的正文（那几次的视图引用列表）已经没人引用，也不删
  const now = Date.now();
  const fresh = await expireObservations({ stateRoot: stateDir, rule: () => ({ runs: [r1.runId], activityBefore: now }), now });
  expect(fresh.removedRuns).toEqual([r1.runId]);
  expect(fresh.removedBatches).toBeGreaterThan(0);
  expect(fresh.removedBlobs).toBe(0);
  expect(await blobFiles()).toEqual(before);

  // 过了宽限期：删掉的只是 r1 独有的；r2 的每个引用（逐层展开）都还读得到
  const later = now + BLOB_SWEEP_GRACE_MS + 60_000;
  const swept = await expireObservations({ stateRoot: stateDir, rule: () => ({ activityBefore: now }), now: later });
  expect(swept.removedBlobs).toBeGreaterThan(0);
  const reader = await openObservationReader({ stateRoot: stateDir });
  const lookup = await reader.getRun(r2.runId);
  if (lookup.kind !== "found") throw new Error(lookup.kind);
  let resolved = 0;
  for (const e of lookup.observation.records) {
    const refs: ObservationBlobRef[] = [];
    collectBlobRefs(e.body, (ref) => refs.push(ref));
    for (const ref of refs) {
      expect(await reader.readBlob(ref)).not.toBeNull();
      const leaves = await expandBlobRefs((x) => reader.readBlob(x), ref);
      expect(leaves).not.toBeNull();
      for (const leaf of leaves!) expect(await reader.readBlob(leaf)).not.toBeNull();
      resolved += 1;
    }
  }
  expect(resolved).toBeGreaterThan(0);
  await reader.close();

  // 全删：正文一份不剩
  const all = await expireObservations({ stateRoot: stateDir, rule: () => ({ runs: [r2.runId], activityBefore: later }), now: later });
  expect(all.removedRuns).toEqual([r2.runId]);
  expect(await blobFiles()).toEqual([]);
});
