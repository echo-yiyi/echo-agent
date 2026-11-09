// 「记忆看得清」（观测白盒化 B）：记忆后台两件事的门、记忆段是新读的还是沿用的、写进去的到底是什么。
//   · 提取没跑：每道门一个封闭原因码（`memory.extract.skipped`），run 之外的活动，`runId` 属性链回触发它的 run；
//   · 整理：每一层判了什么（`memory.dream.evaluated`），开整带那次整理的 runId；判断与 `shouldDream` 同一份；
//   · `memory.compose` 带 `reused`：同一段会话第二个 run 沿用冻结的那份；
//   · content 档：写成的整份与写之前的那份存成 blob。

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { openObservationReader } from "../src/observability/query.ts";
import type { ObservationBlobRef, ObservationEnvelope } from "../src/observability/types.ts";
import type { Provider } from "../src/provider/types.ts";
import { bindMemoryScopes, createAgentMemories, dreamGate, shouldDream, type AgentMemories, type MemoryHarnessOptions } from "../src/memory/harness.ts";
import { memoryScopeTable, type MemoryScopeDef } from "../src/memory/scope.ts";
import { agentMemory, notesMemory, userMemory } from "../src/memory/types.ts";
import { writeDreamState, type DreamState } from "../src/memory/dream.ts";
import type { DreamDecision } from "../src/memory/observe.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";

// 记忆与技能在 ECHO_HOME 下：隔离开，绝不碰开发机上真的 ~/.echo
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-obs-memory-"));

const temps: string[] = [];
const running: Echo[] = [];
afterEach(async () => {
  for (const e of running.splice(0)) await e.stop().catch(() => {});
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true });
});

function scripted(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

async function echoWithMemory(turns: ScriptedTurn[], opts: { capture?: "metadata" | "content"; builtin?: boolean } = {}): Promise<{ echo: Echo; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "echo-obs-memory-"));
  temps.push(root);
  const stateDir = join(root, "state");
  const echo = await createEcho({
    provider: scripted(turns),
    allowNetwork: false,
    stateDir,
    extensionDirs: [],
    ...(opts.builtin === false ? { memory: { builtin: false } } : {}),
    observation: { capture: opts.capture ?? "metadata" },
  });
  running.push(echo);
  await echo.start();
  return { echo, stateDir };
}

/** run 之外的记录：提取的门在回复收尾之后异步判，等到条件成立（有界轮询）。 */
async function activityUntil(echo: Echo, stateDir: string, done: (records: readonly ObservationEnvelope[]) => boolean): Promise<readonly ObservationEnvelope[]> {
  let records: readonly ObservationEnvelope[] = [];
  for (let i = 0; i < 150; i++) {
    await echo.observations.flush();
    const reader = await openObservationReader({ stateRoot: stateDir });
    records = [...(await reader.recentActivity({ limit: 200 }))].reverse(); // 时间正序
    await reader.close();
    if (done(records)) return records;
    await new Promise((r) => setTimeout(r, 20));
  }
  return records;
}

const skippedOf = (records: readonly ObservationEnvelope[]): ObservationEnvelope[] => records.filter((r) => r.name === "memory.extract.skipped");

test("提取没跑的原因逐条入账：话太少 → too_short；轮数没攒满 → too_few_turns；前台这条自己写过记忆 → overlap。run 之外的活动，runId 链回触发它的那个 run", async () => {
  const { echo, stateDir } = await echoWithMemory([
    textTurn("你好"),
    textTurn("好的，记住了你的偏好"),
    toolTurn("m1", "memory", { command: "create", path: "user/memory/style.md", file_text: "---\ndescription: 回答风格\n---\n\n回答尽量简短。" }),
    textTurn("记下了"),
  ]);
  const r1 = await echo.send("hi");
  const r2 = await echo.send("我想让你以后回答问题都尽量简短一些谢谢");
  const r3 = await echo.send("把这个偏好记下来");
  const records = await activityUntil(echo, stateDir, (rs) => skippedOf(rs).length >= 3);
  const skipped = skippedOf(records);
  expect(skipped.map((r) => [r.attributes.reason, r.attributes.runId])).toEqual([
    ["too_short", r1.runId],
    ["too_few_turns", r2.runId],
    ["overlap", r3.runId],
  ]);
  for (const r of skipped) {
    expect(r.scope.runId).toBeUndefined(); // 不挂 run：判的那一刻 run 可能已封口
    expect(r.owner).toMatchObject({ status: "known", entryId: "echo:memory" });
    expect(r.attributes.force).toBe(false);
  }
  // 收摊：卸完 extension 之后的兜底补跑看见模块已空——那是收摊顺序，不记成「没有记忆模块」
  await echo.stop();
  const after = await activityUntil(echo, stateDir, () => true);
  expect(skippedOf(after).filter((r) => r.attributes.reason === "no_modules")).toEqual([]);
});

test("一个记忆模块都没有（memory.builtin: false）→ no_modules：不为此起一次模型调用", async () => {
  const { echo, stateDir } = await echoWithMemory([textTurn("好")], { builtin: false });
  const r = await echo.send("我想让你以后回答问题都尽量简短一些谢谢");
  const records = await activityUntil(echo, stateDir, (rs) => skippedOf(rs).length >= 1);
  expect(skippedOf(records).map((x) => [x.attributes.reason, x.attributes.runId])).toEqual([["no_modules", r.runId]]);
});

test("整理每一层判了什么：回到 idle 后每层一条 memory.dream.evaluated（层、结论、链回触发它的 run）", async () => {
  const { echo, stateDir } = await echoWithMemory([textTurn("好")]);
  const r = await echo.send("hi");
  const records = await activityUntil(echo, stateDir, (rs) => rs.some((x) => x.name === "memory.dream.evaluated"));
  const evaluated = records.filter((x) => x.name === "memory.dream.evaluated");
  expect(evaluated.length).toBeGreaterThan(0);
  for (const e of evaluated) {
    expect(typeof e.attributes.layer).toBe("string");
    // 新会话：没写过、没整理过——写入数这道没过（缺省门：5 次写入、10 个文件、24 小时，或水位 80%）
    expect(e.attributes.decision).toBe("few_writes");
    expect(e.attributes.runId).toBe(r.runId);
    expect(e.scope.runId).toBeUndefined();
  }
});

/* ── 整理的门：与 shouldDream 同一份判断，第一道没过的就是原因 ── */

const ONE_LAYER: readonly MemoryScopeDef[] = [{ name: "session", order: 1, describe: "only this session", anchor: { kind: "home" }, prefix: "" }];

function memories(opts?: MemoryHarnessOptions): AgentMemories {
  const h = createAgentMemories({ memories: [agentMemory, userMemory, notesMemory], ...opts });
  bindMemoryScopes(h, memoryScopeTable(ONE_LAYER.map((def) => ({ def, dir: new InMemoryDir() }))));
  return h;
}

function state(over: Partial<DreamState>): DreamState {
  return { lastAt: null, startedAt: null, writes: 0, turns: 0, writesAtLastPass: 0, ...over } as DreamState;
}

test("dreamGate：进行中 / 太早 / 写入不够 / 轮数不够 / 文件不够 / 水位 / 全满足，各给一个原因；shouldDream 就是它的 run", async () => {
  const cases: [DreamDecision, MemoryHarnessOptions["dream"], Partial<DreamState>, boolean][] = [
    ["in_progress", { minWritesSinceLast: 0 }, { startedAt: Date.now() }, false],
    ["too_soon", { minIntervalMs: 60_000 }, { lastAt: Date.now(), writes: 9, writesAtLastPass: 9 }, false],
    ["few_writes", { minWritesSinceLast: 5 }, { writes: 2 }, false],
    ["few_turns", { minWritesSinceLast: 0, minTurnsSinceLast: 5 }, { turns: 1 }, false],
    ["few_files", { minWritesSinceLast: 0, minFiles: 3 }, {}, false],
    ["budget", { budgetRatio: 0, minWritesSinceLast: 99 }, { writes: 1 }, true],
    ["due", { minWritesSinceLast: 1, minFiles: 0 }, { writes: 1 }, true],
  ];
  for (const [decision, gates, s, run] of cases) {
    const mem = memories({ dream: gates });
    await writeDreamState(mem.dir, "session", state(s));
    expect([decision, await dreamGate(mem, "session")]).toEqual([decision, { run, decision }]);
    expect(await shouldDream(mem, "session")).toBe(run);
  }
});

/* ── 记忆段：新读还是沿用 ── */

test("memory.compose 带 reused：同一段会话第一个 run 读盘组装，第二个 run 沿用冻结的那份（没有组装，也就没有块数与字数）", async () => {
  const { echo } = await echoWithMemory([textTurn("一"), textTurn("二")]);
  const r1 = await echo.send("hi");
  const r2 = await echo.send("again");
  const composeOf = async (runId: string): Promise<ObservationEnvelope> => {
    const lookup = await echo.observations.getRun(runId);
    if (lookup.kind !== "found") throw new Error(lookup.kind);
    return lookup.observation.records.find((r) => r.name === "memory.compose")!;
  };
  const first = await composeOf(r1.runId);
  const second = await composeOf(r2.runId);
  expect(first.attributes.reused).toBe(false);
  expect(typeof first.attributes.blocks).toBe("number");
  expect(second.attributes.reused).toBe(true);
  expect(second.attributes.blocks).toBeUndefined();
  expect((second.body as { chars?: number }).chars).toBeUndefined();
});

/* ── content 档：写进去的到底是什么 ── */

test("content 档：记忆写入存下写成的整份与写之前的那份（blob）；metadata 档一份都不存", async () => {
  // 用户层在 ECHO_HOME 下、本文件各测试共用：换一个文件名，别撞上前面测试写过的那份
  const create = { command: "create", path: "user/memory/content-style.md", file_text: "---\ndescription: 回答风格\n---\n\n回答尽量简短。" };
  const replace = { command: "str_replace", path: "user/memory/content-style.md", old_str: "尽量简短", new_str: "简短、先给结论" };
  const turns = [toolTurn("m1", "memory", create), toolTurn("m2", "memory", replace), textTurn("改好了")];
  const { echo } = await echoWithMemory(turns, { capture: "content" });
  const r = await echo.send("记一下回答风格");
  const lookup = await echo.observations.getRun(r.runId);
  if (lookup.kind !== "found") throw new Error(lookup.kind);
  const writes = lookup.observation.records.filter((x) => x.name === "memory.mutation.committed");
  expect(writes.map((w) => w.attributes.operation)).toEqual(["create", "replace"]);
  const read = (ref: unknown): Promise<string | null> => echo.observations.readBlob(ref as ObservationBlobRef);
  const [c, rp] = writes.map((w) => w.body as { content?: unknown; before?: unknown });
  expect(await read(c!.content)).toBe(create.file_text);
  expect(c!.before).toBeUndefined(); // 新建：没有之前的那份
  expect(await read(rp!.before)).toBe(create.file_text);
  expect(await read(rp!.content)).toBe(create.file_text.replace("尽量简短", "简短、先给结论"));

  const plain = await echoWithMemory([toolTurn("m1", "memory", { ...create, path: "user/memory/plain-style.md" }), textTurn("好")]);
  const p = await plain.echo.send("记一下");
  const pl = await plain.echo.observations.getRun(p.runId);
  if (pl.kind !== "found") throw new Error(pl.kind);
  const pw = pl.observation.records.find((x) => x.name === "memory.mutation.committed")!;
  expect((pw.body as { content?: unknown }).content).toBeUndefined();
});
