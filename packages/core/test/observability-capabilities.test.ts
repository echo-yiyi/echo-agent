import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import type { StorageDir } from "../src/storage/types.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import {
  createAgentMemories,
  memoryCreate,
  memoryDelete,
  memoryInsert,
  memoryRename,
  memoryStrReplace,
  type AgentMemories,
} from "../src/memory/harness.ts";
import { renderMemorySystem } from "../src/memory/compose.ts";
import { indexedMemory, residentMemory } from "../src/memory/types.ts";
import { memoryFactDescriptor, type MemoryFact } from "../src/memory/observe.ts";
import { createTasks, linkTasks, removeTask, saveTasks, unlinkTasks, updateTask, type TaskMap } from "../src/task/harness.ts";
import { attachTaskObserver, taskFactDescriptor, type TaskFact } from "../src/task/observe.ts";
import { addSchedule, cancelSchedule, createAgentSchedule, startSchedule, tickSchedule } from "../src/schedule/harness.ts";
import { scheduleFactDescriptor, type ScheduleFact } from "../src/schedule/observe.ts";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import type { Provider } from "../src/provider/types.ts";
import type { ObservationEnvelope } from "../src/observability/types.ts";
import { mkdtempSync } from "node:fs";

// **user 层要隔离**（2026-09-03）：`stateDir` 只管这一段 session 的目录，记忆与技能在 ECHO_HOME 下，
// 不设它就会读到开发机上真的 `~/.echo/skills`——实测过 skill 池莫名多出一条。
process.env["ECHO_HOME"] = mkdtempSync(join(tmpdir(), "echo-home-"));

// O3a 的三条领域行（硬门 9）：fixture **直接调真实的** Memory create / replace / insert / delete / rename、
// Task commit / saveTasks、Schedule tick / catchUp 路径，断言每个成功 / 拒绝 / 失败分支恰有一条事实，
// 没有测试专属 producer。最后一段走真 createEcho：run 内 builtin memory 工具触发的事实能由 getRun(runId) 取得，
// run 外的 Schedule 事实经 snapshot → subscribe 取得。

function collect<T>(): { facts: T[]; offer(f: T): void } {
  const facts: T[] = [];
  return { facts, offer: (f) => void facts.push(f) };
}

/** 可注入故障的字节面：按路径 / 操作抛错，模拟 primary I/O failure。 */
function faultyDir(base: StorageDir, fail: { read?: (p: string) => boolean; write?: (p: string) => boolean; remove?: (p: string) => boolean }): StorageDir {
  return {
    read: (p) => (fail.read?.(p) === true ? Promise.reject(new Error(`EIO read ${p}`)) : base.read(p)),
    write: (p, c) => (fail.write?.(p) === true ? Promise.reject(new Error(`EIO write ${p}`)) : base.write(p, c)),
    remove: (p) => (fail.remove?.(p) === true ? Promise.reject(new Error(`EIO remove ${p}`)) : base.remove(p)),
    list: (p) => base.list(p),
  };
}

describe("Memory：五种 mutation 各恰发一条，typed outcome 不靠解析字符串", () => {
  function memoriesWith(dir: StorageDir): { ctx: AgentMemories; facts: MemoryFact[] } {
    const sink = collect<MemoryFact>();
    const ctx = createAgentMemories(dir, {
      memories: [residentMemory("agent", { budget: 60 }), indexedMemory("memory", { budget: 2_000, fileBudget: 100 })],
    });
    ctx.observe = sink;
    return { ctx, facts: sink.facts };
  }

  test("committed：create / str_replace / insert / delete / rename 各一条；indexed 分区 indexOutcome=ok；rename 不双发 create", async () => {
    const { ctx, facts } = memoriesWith(new InMemoryDir());
    expect((await memoryCreate(ctx, "memory/a.md", "hello")).isError).toBe(false);
    expect((await memoryStrReplace(ctx, "memory/a.md", "hello", "hi")).isError).toBe(false);
    expect((await memoryInsert(ctx, "memory/a.md", 1, "more")).isError).toBe(false);
    expect((await memoryRename(ctx, "memory/a.md", "memory/b.md")).isError).toBe(false);
    expect((await memoryDelete(ctx, "memory/b.md")).isError).toBe(false);
    expect(facts.map((f) => (f.kind === "mutation" ? `${f.operation}:${f.outcome}` : f.kind))).toEqual([
      "create:committed",
      "replace:committed",
      "insert:committed",
      "rename:committed",
      "delete:committed",
    ]);
    const rename = facts[3];
    expect(rename).toMatchObject({ kind: "mutation", operation: "rename", path: "memory/a.md", toPath: "memory/b.md", partition: "memory", mode: "indexed", indexOutcome: "ok" });
    expect(facts[0]).toMatchObject({ chars: 5, indexOutcome: "ok" });
    // resident 分区：indexOutcome not-applicable
    expect((await memoryCreate(ctx, "agent.md", "resident")).isError).toBe(false);
    expect(facts[5]).toMatchObject({ operation: "create", outcome: "committed", partition: "agent", mode: "resident", indexOutcome: "not-applicable" });
  });

  test("rejected：语义拒绝各有 reasonCode，原文保持从前的报文", async () => {
    const { ctx, facts } = memoriesWith(new InMemoryDir());
    await memoryCreate(ctx, "memory/a.md", "x");
    facts.length = 0;
    // thunk 而不是 promise：逐个顺序跑，`facts.at(-1)` 才对应当前这一条
    const cases: [() => Promise<{ isError: boolean; content: string }>, string, string][] = [
      [() => memoryStrReplace(ctx, "memory/a.md", "nope", "y"), "old_str_not_found", "old_str not found"],
      [() => memoryStrReplace(ctx, "memory/a.md", "", "y"), "empty_old_str", "str_replace needs old_str"],
      [() => memoryInsert(ctx, "memory/a.md", -1, "y"), "bad_line", "insert_line must be an integer"],
      [() => memoryInsert(ctx, "memory/a.md", 99, "y"), "line_out_of_range", "out of range"],
      [() => memoryInsert(ctx, "memory/zzz.md", 0, "y"), "not_found", "does not exist"],
      [() => memoryDelete(ctx, "memory/zzz.md"), "not_found", "does not exist"],
      [() => memoryDelete(ctx, "memory/"), "not_a_file", "not a directory"],
      [() => memoryCreate(ctx, "memory/INDEX.md", "x"), "index_file_protected", "system-maintained index"],
      [() => memoryCreate(ctx, "elsewhere/x.md", "x"), "outside_regions", "not inside any memory region"],
      [() => memoryCreate(ctx, "agent.md", "a".repeat(61)), "budget_exceeded", "would exceed its budget"],
      [() => memoryRename(ctx, "memory/a.md", "agent.md"), "cross_region", "must stay within one region"],
      [() => memoryRename(ctx, "memory/nope.md", "memory/c.md"), "not_found", "does not exist"],
      [() => memoryCreate(ctx, "../escape.md", "x"), "invalid_path", "Invalid path"],
    ];
    for (const [run, code, text] of cases) {
      const before = facts.length;
      const r = await run();
      expect(facts.length).toBe(before + 1);
      expect(r.isError).toBe(true);
      expect(r.content).toContain(text);
      const f = facts.at(-1);
      expect(f).toMatchObject({ kind: "mutation", outcome: "rejected", reasonCode: code, message: r.content });
    }
    await memoryCreate(ctx, "memory/c.md", "x");
    facts.length = 0;
    const r = await memoryRename(ctx, "memory/a.md", "memory/c.md");
    expect(r.content).toContain("already exists");
    expect(facts).toEqual([expect.objectContaining({ operation: "rename", outcome: "rejected", reasonCode: "target_exists" })]);
    expect(facts.length).toBe(1);
  });

  test("failed：primary I/O 抛错且数据未变 → failed + stage；partial：rename 目标已建、源删失败 → partial(remove-source)", async () => {
    const base = new InMemoryDir();
    const { ctx: seed } = memoriesWith(base);
    await memoryCreate(seed, "memory/a.md", "x");

    const writeFails = memoriesWith(faultyDir(base, { write: (p) => p === "memory/b.md" }));
    const w = await memoryCreate(writeFails.ctx, "memory/b.md", "y");
    expect(w.isError).toBe(true);
    expect(writeFails.facts).toEqual([expect.objectContaining({ operation: "create", outcome: "failed", stage: "write" })]);

    const readFails = memoriesWith(faultyDir(base, { read: (p) => p === "memory/a.md" }));
    const r = await memoryStrReplace(readFails.ctx, "memory/a.md", "x", "y");
    expect(r.isError).toBe(true);
    expect(readFails.facts).toEqual([expect.objectContaining({ operation: "replace", outcome: "failed", stage: "read" })]);

    const removeFails = memoriesWith(faultyDir(base, { remove: (p) => p === "memory/a.md" }));
    const d = await memoryDelete(removeFails.ctx, "memory/a.md");
    expect(d.isError).toBe(true);
    expect(removeFails.facts).toEqual([expect.objectContaining({ operation: "delete", outcome: "failed", stage: "remove" })]);

    const rn = await memoryRename(removeFails.ctx, "memory/a.md", "memory/moved.md");
    expect(rn.isError).toBe(true);
    expect(rn.content).toContain("failed to remove the source");
    expect(removeFails.facts[1]).toMatchObject({ operation: "rename", outcome: "partial", stage: "remove-source", indexOutcome: "ok" });
    expect(await base.read("memory/moved.md")).toBe("x"); // 目标确实建了：partial 不是谎报
    expect(removeFails.facts.length).toBe(2);
  });

  test("index refresh 失败：主 mutation 仍 committed，indexOutcome=failed 可见（report 照旧、不抛）", async () => {
    const base = new InMemoryDir();
    const diags: string[] = [];
    const { ctx, facts } = memoriesWith(faultyDir(base, { write: (p) => p.endsWith("/INDEX.md") }));
    ctx.report = (d) => void diags.push(d.code);
    const r = await memoryCreate(ctx, "memory/a.md", "x");
    expect(r.isError).toBe(false);
    expect(facts).toEqual([expect.objectContaining({ operation: "create", outcome: "committed", indexOutcome: "failed" })]);
    expect(diags).toContain("memory_index_rebuild_failed");
  });

  test("compose：renderMemorySystem 出数据时发一条 compose 计数", async () => {
    const { ctx, facts } = memoriesWith(new InMemoryDir());
    await memoryCreate(ctx, "agent.md", "who I am");
    facts.length = 0;
    const text = await renderMemorySystem(ctx);
    expect(text).toContain("who I am");
    expect(facts).toEqual([expect.objectContaining({ kind: "compose", regions: 2, blocks: 1 })]);
  });

  test("descriptor：metadata 只有 pathDigest（HMAC）与 reasonDigest，无明文 path / message；content 才有；off 不投影；rename 有 from/to digest", () => {
    const d = memoryFactDescriptor({ pathDigestKey: "k".repeat(32) });
    const fact: MemoryFact = { kind: "mutation", operation: "rename", outcome: "rejected", path: "memory/a.md", toPath: "memory/b.md", partition: "memory", mode: "indexed", reasonCode: "target_exists", message: "Target 'memory/b.md' already exists", occurredAt: 1 };
    const meta = d.project(fact, "metadata")!;
    expect(meta.name).toBe("memory.mutation.rejected");
    expect(meta.attributes).toEqual({ operation: "rename", outcome: "rejected", partition: "memory", mode: "indexed", reasonCode: "target_exists" });
    const body = meta.body as Record<string, unknown>;
    expect(typeof body.fromPathDigest).toBe("string");
    expect(typeof body.toPathDigest).toBe("string");
    expect(body.fromPathDigest).not.toBe(body.toPathDigest);
    expect(JSON.stringify(meta)).not.toContain("memory/a.md");
    expect(JSON.stringify(meta)).not.toContain("already exists");
    expect(typeof body.reasonDigest).toBe("string");
    const content = d.project(fact, "content")!.body as Record<string, unknown>;
    expect(content.path).toBe("memory/a.md");
    expect(content.message).toContain("already exists");
    expect(d.project(fact, "off")).toBeNull();
    // 同一 key 同一 path → 同一 digest（跨 run 可关联）；不同 key → 不同 digest
    const again = memoryFactDescriptor({ pathDigestKey: "k".repeat(32) }).project(fact, "metadata")!.body as Record<string, unknown>;
    expect(again.fromPathDigest).toBe(body.fromPathDigest);
    const other = memoryFactDescriptor({ pathDigestKey: "z".repeat(32) }).project(fact, "metadata")!.body as Record<string, unknown>;
    expect(other.fromPathDigest).not.toBe(body.fromPathDigest);
  });
});

describe("Task：state commit 与 store settle 两种真相分开", () => {
  test("create / update / link / unlink / remove 各在 Map swap 后恰发一条 state 事实；拒绝的写不发", () => {
    const tasks: TaskMap = new Map();
    const sink = collect<TaskFact>();
    attachTaskObserver(tasks, sink);
    const created = createTasks(tasks, [{ title: "a" }, { title: "b" }]);
    expect(created.ok).toBe(true);
    expect(createTasks(tasks, [{ title: "" }]).ok).toBe(false); // 拒绝：不发
    expect(updateTask(tasks, "1", { status: "in_progress" }).ok).toBe(true);
    expect(linkTasks(tasks, "1", "2").ok).toBe(true);
    expect(linkTasks(tasks, "2", "1").ok).toBe(false); // 成环拒绝：不发
    expect(unlinkTasks(tasks, "1", "2")).toBe(true);
    expect(removeTask(tasks, "2")).toBe(true);
    expect(sink.facts.map((f) => (f.kind === "state" ? `${f.operation}:${f.ids.join(",")}` : f.kind))).toEqual(["create:1,2", "update:1", "link:1,2", "unlink:1,2", "remove:2"]);
    expect(sink.facts[1]).toMatchObject({ before: "pending", after: "in_progress", total: 2 });
    expect(sink.facts[4]).toMatchObject({ before: "pending", total: 1 });
  });

  test("saveTasks：只在真实 write settle 后发 saved / failed；state commit 不发 store 事实", async () => {
    const tasks: TaskMap = new Map();
    const sink = collect<TaskFact>();
    attachTaskObserver(tasks, sink);
    createTasks(tasks, [{ title: "a" }]);
    expect(sink.facts.filter((f) => f.kind === "store")).toEqual([]);
    let stored = "";
    await saveTasks(tasks, { read: async () => stored, write: async (t) => void (stored = t) });
    expect(sink.facts.at(-1)).toMatchObject({ kind: "store", outcome: "saved", count: 1, bytes: new TextEncoder().encode(stored).byteLength });
    await expect(
      saveTasks(tasks, {
        read: async () => null,
        write: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(sink.facts.at(-1)).toMatchObject({ kind: "store", outcome: "failed", count: 1, message: "disk full" });
    const p = taskFactDescriptor.project(sink.facts.at(-1)!, "metadata")!;
    expect(p.name).toBe("task.store.failed");
    expect(JSON.stringify(p.body)).not.toContain("disk full");
    expect((p.body as Record<string, unknown>).reasonDigest).toBeDefined();
  });
});

describe("Schedule：created / cancelled / delivered / missed / bookkeeping-failed 各在唯一 settle 点", () => {
  test("add → created；到期 tick → delivered(tick)；cancel → cancelled", async () => {
    const clock = new FakeClock(10_000_000);
    const sink = collect<ScheduleFact>();
    const delivered: string[] = [];
    const ctx = createAgentSchedule(new InMemoryDir(), { clock });
    ctx.deliver = async (m) => void delivered.push(m.role);
    ctx.observe = sink;
    await addSchedule(ctx, { id: "s1", kind: "at", at: clock.now() + 1_000, prompt: "ping", createdAt: clock.now() });
    expect(sink.facts).toEqual([expect.objectContaining({ kind: "created", id: "s1", scheduleKind: "at" })]);
    clock.advance(1_000);
    await tickSchedule(ctx);
    expect(delivered.length).toBe(1);
    expect(sink.facts.at(-1)).toMatchObject({ kind: "delivered", id: "s1", via: "tick" });
    await addSchedule(ctx, { id: "s2", kind: "every", everyMs: 60_000, prompt: "p", createdAt: clock.now() });
    expect(await cancelSchedule(ctx, "s2")).toBe(true);
    expect(sink.facts.at(-1)).toMatchObject({ kind: "cancelled", id: "s2", scheduleKind: "every" });
    expect(await cancelSchedule(ctx, "nope")).toBe(false);
    expect(sink.facts.length).toBe(4);
  });

  test("重启补跑：过期的一次性 → missed(expired)；超窗的 every → missed(skipped-backlog)；错过的 cron → delivered(catch-up)", async () => {
    const dir = new InMemoryDir();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    await dir.write(
      "schedules.json",
      JSON.stringify([
        { schedule: { id: "old-at", kind: "at", at: now - 3_600_000, prompt: "p", createdAt: now - 7_200_000 }, lastFiredAt: null },
        { schedule: { id: "stale-every", kind: "every", everyMs: 60_000, prompt: "p", createdAt: now - 3_600_000 }, lastFiredAt: null },
        { schedule: { id: "missed-cron", kind: "cron", cron: "0 11 * * *", prompt: "p", createdAt: now - 7_200_000 }, lastFiredAt: null },
      ]),
    );
    const clock = new FakeClock(now);
    const sink = collect<ScheduleFact>();
    const ctx = createAgentSchedule(dir, { clock, tickMs: 60_000 });
    ctx.deliver = async () => {};
    ctx.observe = sink;
    await startSchedule(ctx);
    ctx.cancelTick?.();
    const kinds = sink.facts.map((f) => `${f.id}:${f.kind}:${f.reason ?? f.via ?? ""}`);
    expect(kinds).toContain("old-at:missed:expired");
    expect(kinds).toContain("stale-every:missed:skipped-backlog");
    expect(kinds).toContain("missed-cron:delivered:catch-up");
    expect(sink.facts.length).toBe(3);
  });

  test("投递之后簿记落盘失败 → bookkeeping-failed（每条已投递的一次），错照抛", async () => {
    const clock = new FakeClock(10_000_000);
    const sink = collect<ScheduleFact>();
    const base = new InMemoryDir();
    const ctx = createAgentSchedule(base, { clock });
    ctx.deliver = async () => {};
    ctx.observe = sink;
    await addSchedule(ctx, { id: "s1", kind: "at", at: clock.now() + 1_000, prompt: "p", createdAt: clock.now() });
    ctx.dir = faultyDir(base, { write: () => true });
    clock.advance(1_000);
    await expect(tickSchedule(ctx)).rejects.toThrow("EIO write");
    expect(sink.facts.map((f) => f.kind)).toEqual(["created", "delivered", "bookkeeping-failed"]);
    expect(scheduleFactDescriptor.project(sink.facts[2]!, "metadata")!.name).toBe("schedule.bookkeeping-failed");
  });
});

describe("完整 Runtime：run 内的 Memory 事实由 getRun 取得，run 外的 Schedule 事实由 snapshot → subscribe 取得", () => {
  const temps: string[] = [];
  const running: Echo[] = [];
  afterEach(async () => {
    for (const echo of running.splice(0)) await echo.stop().catch(() => {});
    for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
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

  test("builtin memory 工具在 run 里 create → memory.mutation.committed 带 runId、owner echo:memory；Task / Schedule 事实 runtime-scoped 可订阅", async () => {
    const root = await mkdtemp(join(tmpdir(), "echo-obs-cap-"));
    temps.push(root);
    const echo = await createEcho({
      provider: scripted([toolTurn("c1", "memory", { command: "create", path: "memory/note.md", file_text: "remember this" }), textTurn("saved")]),
      allowNetwork: false,
      stateDir: join(root, "state"),
      extensionDirs: [],
    });
    running.push(echo);
    await echo.agent.start();
    const result = await echo.send("remember");
    expect(result.outcome.kind).toBe("completed");
    const lookup = await echo.observations.getRun(result.runId);
    if (lookup.kind !== "found") throw new Error(`expected found, got ${lookup.kind}`);
    const memoryFacts = lookup.observation.records.filter((r) => r.name.startsWith("memory.mutation."));
    expect(memoryFacts.length).toBe(1);
    expect(memoryFacts[0]).toMatchObject({
      name: "memory.mutation.committed",
      scope: { runId: result.runId, turnId: "t1" },
      owner: { status: "known", entryId: "echo:memory" },
      attributes: { operation: "create", outcome: "committed", partition: "memory", mode: "indexed", indexOutcome: "ok" },
    });
    expect(JSON.stringify(memoryFacts[0])).not.toContain("note.md"); // metadata：只有 digest
    // compose 也在 run 里（prompt 组装那一拍）
    expect(lookup.observation.records.some((r) => r.name === "memory.compose")).toBe(true);

    // run 之外：直接调 Task / Schedule 的真实 API → runtime-scoped 记录（无 runId），经 subscribe 回放取得
    const seen: ObservationEnvelope[] = [];
    const snap = await echo.observations.snapshot();
    const unsubscribe = await echo.observations.subscribe({ afterSeq: snap.throughSeq, listener: (r) => void ("recordId" in r && seen.push(r)) });
    try {
      expect(createTasks(echo.agent.tasks, [{ title: "t" }]).ok).toBe(true);
      const schedule = echo.agent.schedule!;
      await addSchedule(schedule, { id: "s1", kind: "every", everyMs: 60_000, prompt: "p", createdAt: Date.now() });
      // bounded lane 按 maxBatchDelayMs 批量 COMMIT 后才 live 扇出：等到两条都到（有界轮询，不碰内部）
      for (let i = 0; i < 100 && !(seen.some((r) => r.name === "task.state.committed") && seen.some((r) => r.name === "schedule.created")); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // 装了记忆：这段时间里可能正有一次 Dream run 在跑（它自己的边界记录带 runId 是对的）；
      // 但 run 之外调的 Task / Schedule 事实**不得**挂任何 runId
      const names = seen.map((r) => `${r.name}${r.scope.runId === undefined ? "" : "@run"}`);
      expect(names).toContain("task.state.committed");
      expect(names).toContain("schedule.created");
      expect(seen.find((r) => r.name === "schedule.created")?.owner).toMatchObject({ status: "known", entryId: "echo:scheduler" });
      expect(seen.find((r) => r.name === "task.state.committed")?.owner).toMatchObject({ status: "known", entryId: "echo:tasks" });
    } finally {
      unsubscribe();
    }
  });
});
