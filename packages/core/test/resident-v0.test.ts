import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectStateLock } from "../src/storage/file-lock.ts";

// **Runtime V0 Gate**（AGENT-CORE §13.9 的 12 条 resident integration）。
//
// 与本仓其余测试的区别只有一条，但那一条是全部意义：**这里真的起第二个进程**。
// 此前所有写着「换个进程」的用例换的是**实例**——同一个 `InMemoryDir` 传给新 `Agent`，
// 内存里的游标、锁状态、定时器全都还在。真进程销毁之后，只有盘上那些字节还在，
// 「恢复」才是被证明的，不是被假设的。
//
// 宿主是 `fixtures/resident-host.ts`（一个真程序，不是测试），本文件只负责起它、比对报告。
// 三段：
//   a     —— 全新进程建状态、干净收摊
//   crash —— 投进一条 inbox、**不消费**、硬退出（不 stop）
//   c     —— 新进程恢复一切
//
// §13.9 明说 Distribution Gate 的 `node run.mjs`（单次调用）**不是** Runtime V0 Gate，
// 所以那条不能替代本文件。

const HOST = join(import.meta.dir, "fixtures", "resident-host.ts");

type Report = {
  phase: string;
  seen: { systemPrompt: string; roles: string[]; tools: string[]; texts: string[] }[];
  sessionId?: string;
  messages?: number;
  tools?: { tool: string; isError: boolean; content: string }[];
  activeSkills?: string[];
  taskCount?: number;
  skills?: string[];
  dreamed?: boolean;
  woke?: boolean;
  scheduleIds?: string[];
};

/**
 * 起一次宿主。**必须给子进程自己的超时**：`spawnSync` 是同步阻塞，宿主卡死时
 * 外层 `test(..., 120_000)` 抢不进来，整个测试会挂到 runner 超时才死，还看不出是谁卡的。
 */
function runPhase(stateDir: string, phase: string, sessionId?: string): { ok: boolean; report: Report | null; out: string } {
  // `sessionId`：要**续**哪一段。缺省每次启动新建会话（2026-09-01 用户拍板），跨进程恢复对话是显式动作
  const r = Bun.spawnSync(["bun", HOST, stateDir, phase, ...(sessionId === undefined ? [] : [sessionId])], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
  const line = out.split("\n").find((l) => l.startsWith("__REPORT__"));
  return {
    ok: r.exitCode === 0,
    report: line === undefined ? null : (JSON.parse(line.slice("__REPORT__".length)) as Report),
    out,
  };
}

/** 盘上的 inbox record 数。`inbox/acks/` 是 ack marker 目录，不算入站事实。 */
function inboxRecordCount(dir: string): number {
  return readdirSync(join(dir, "inbox")).filter((name) => /^[0-9]{6}\.json$/.test(name)).length;
}

test(
  "Runtime V0：三个真进程走完 §13.9 的 resident integration",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "echo-resident-"));

    /* ─── ①②③④ 全新进程：只配 provider，自动建会话，模型调用 + 工具调用真的成功 ─── */
    const a = runPhase(dir, "a");
    expect(a.ok, `phase a 挂了：\n${a.out}`).toBe(true);
    const ra = a.report!;
    expect(ra.sessionId).toMatch(/^s-/); // 自动创建的会话（第 3 条）：缺省每次启动新建一段（2026-09-01）

    // 第 4 条要的是「**由 Agent** 创建」——判据是工具真的被调用**且成功**，
    // 不是宿主自己调 harness 函数。工具报错会被循环转成 error result 咽掉，
    // 所以这里必须看 `isError`（只断言「调用发生过」是没有区分力的）。
    const called = Object.fromEntries((ra.tools ?? []).map((t) => [t.tool, t.isError]));
    for (const name of ["memory", "TaskCreate", "skill_activate", "skill_create", "schedule_create"]) {
      expect(called[name], `${name} 没被成功调用（undefined = 压根没调）`).toBe(false);
    }
    // 四件里 Task 与 Skill 是 2026-08-23 才归 Agent 自己装的：此前只有 `@echo/coding-agent`
    // 注册，默认装配出来的 agent 工具面只有 memory + schedule 四件，这两条根本走不通。
    expect(ra.taskCount, "任务没真的建出来").toBe(1);
    expect(ra.activeSkills, "skill 没真的激活").toEqual(["写提交信息"]);
    // 工具面本身也断言一次：**默认装配就该有这些，不靠产品层补**。
    // `skill_create` 2026-08-24 起在面上（OSS-1c）：默认装配有了落盘的 `onCreate`
    //（写状态根 `skills/<name>/SKILL.md`，`start()` 时发现回来），
    // 「返回成功、重启即消失」那个反对理由不再成立。
    expect(ra.seen[0]!.tools).toEqual(
      [
        "TaskCreate",
        "TaskGet",
        "TaskList",
        "TaskUpdate",
        "memory",
        "schedule_cancel",
        "schedule_create",
        "schedule_list",
        "skill_activate",
        "skill_create",
        // 2026-09-02 起 `echo:compaction` 在默认装配里：压缩之后模型靠它取回原文
        "transcript_read",
      ].sort(),
    );

    // 落盘是真的：记忆文件、索引、闹钟、会话 entries
    expect(existsSync(join(dir, "memory", "项目.md"))).toBe(true);
    expect(existsSync(join(dir, "schedules.json"))).toBe(true);
    expect(readdirSync(join(dir, "sessions", ra.sessionId!, "entries")).length).toBeGreaterThan(0);

    // ⑥ **Dream 是 Agent 自己起的**：宿主没调任何整理相关的东西，只是把门喂饱
    // （10 个记忆文件 / 10 次写入）。判据是盘上的 `lastAt` 被提交，不是「dream 跑过」。
    expect(ra.dreamed, "门满足了，Agent 却没自己整理").toBe(true);
    expect(readdirSync(join(dir, "memory")).length).toBeGreaterThanOrEqual(10);

    // ⑪ 干净 stop 之后锁必须还回去
    expect(existsSync(join(dir, ".lock")), "stop() 之后锁没释放").toBe(false);

    /* ─── ⑤ 闹钟到点 → Inbox → **Agent 自己醒来** ─── */
    // 「不是测试直接调 loop」是这一条的全部意义：宿主只 `schedule_create` 了一个
    // 1.2 秒之后的 `at`，然后等；开新一轮的是 agent 自己。
    // **不注入假时钟**——`at` 不限过去未来，tick 每秒一拍，真时钟下就能测。
    const wake = runPhase(dir, "wake");
    expect(wake.ok, `phase wake 挂了：\n${wake.out}`).toBe(true);
    expect(wake.report!.woke, "闹钟到点了，Agent 没醒").toBe(true);

    // **闹钟本身也要跨进程恢复**：A 建的那条（`every 60s`）必须在 wake 进程里还认得出来。
    // 只验「wake 自己新建的 `at` 会触发」是不够的——那条从头到尾没离开过本进程，
    // 把 `loadSchedule()` 摘掉它照样绿（判据没有区分力）。
    const madeInA = ra.scheduleIds ?? [];
    expect(madeInA.length, "A 进程没建出闹钟").toBe(1);
    expect(wake.report!.scheduleIds ?? [], "A 建的闹钟没跨进程恢复").toContain(madeInA[0]!);

    /* ─── ⑧⑨ **干净跨进程重启**：不需要任何人工干预就恢复 ─── */
    // 顺序是特意的：第 8 条说的是「启动新的进程与新的 Agent 实例，**自动**恢复」，
    // 那就必须由**干净重启**来证——放在 crash 之后证等于把「人工删了锁」也算进「自动」，
    // 那是把运维步骤冒充成产品能力。crash 的戏份挪到下面，只证第 10 条与单写契约。
    const c = runPhase(dir, "c", ra.sessionId!);
    expect(c.ok, `phase c 挂了：\n${c.out}`).toBe(true);
    const rc = c.report!;
    expect(rc.sessionId).toBe(ra.sessionId); // ⑧ 显式续 A 的那一段——缺省不续（2026-09-01），续是宿主给 id 的动作
    expect(rc.messages ?? 0).toBeGreaterThan(4);

    // ⑨ **第二轮模型调用真的用得上第一轮的东西**——判据落在模型收到的 Context 上，
    // 不是「盘上有」。「东西回来了」与「东西进了 context」是两件事，此前只验过前者。
    const last = rc.seen.at(-1)!;
    // Memory：A 进程写的那条，出现在 C 进程的 system 里
    expect(last.systemPrompt, "A 进程写的记忆没进 C 进程的 system").toContain("项目笔记");
    // Session：第一轮的对话回到了 context
    expect(last.texts.join("\n"), "第一轮的对话没进 context").toContain("把「用户在做 Echo」记进记忆");
    // Skill：目录段进 system（激活是运行态、不跨进程；宿主每次启动重新交 skill）
    expect(last.systemPrompt, "skill 目录没进 system").toContain("写提交信息");

    // Task：A 进程建的那条，回到盘上**并且**进了 C 进程的 context（2026-08-24 §5D.7 落地前，
    // 这里只验得到前半句）。**进的是消息末尾的注入，不是 system**——清单每轮都在变，
    // 放 system 等于每轮打掉 prompt cache，所以下面那条 `not.toContain` 是**设计要求**，
    // 不再是「还没做」的记号：它红了说明清单跑进 system 段去了。
    expect(rc.taskCount, "A 进程建的任务没跨进程回来").toBe(1);
    // Skill：A 进程 `skill_create` 落盘的那个，C 进程 `start()` 从状态根发现回来。
    // **这才是跨进程**——`create-agent.test.ts` 里同一进程换实例那条只证「跨装配」。
    expect(rc.skills ?? [], "A 进程创建的 skill 没跨进程回来").toContain("review-checklist");
    expect(last.texts.join("\n"), "跨进程回来的任务没进模型的 context").toContain("把 M6 做完");
    expect(last.systemPrompt, "任务清单跑进 system 了——每轮变的东西不许进 system 段").not.toContain("任务清单");

    // ⑪ 再次干净收摊
    expect(existsSync(join(dir, ".lock"))).toBe(false);

    /* ─── ⑩ 崩溃：未消费的入站事实留存 + 任务改完即落盘 ─── */
    const crash = runPhase(dir, "crash");
    expect(crash.ok, `phase crash 挂了：\n${crash.out}`).toBe(true);
    // 只数 record 文件：`inbox/acks/` 是 batch-ack marker 的目录（§14.2.4），不是入站事实
    expect(inboxRecordCount(dir), "崩溃前投进来的那条不在盘上").toBe(1);
    // **任务是「工具回执说成功之后就崩」的那条**：此前 `saveTasks` 只在 `dispose()` 里调，
    // 干净 stop 掩盖了这个缺口——崩溃时那条任务会丢。
    expect(readFileSync(join(dir, "tasks.json"), "utf8"), "崩溃前建的任务没落盘").toContain("崩溃前建的");

    /* ─── 单写契约：崩溃留下的锁**不许被自动抢占**（这一步是运维，不是产品能力）─── */
    // 2026-08-18 那条 P0 的直接后果：自动 stale takeover 会双授，已取消。
    // 代价就是这里——新进程必须**拒绝启动**，等人来清。**这不叫「自动恢复」**，
    // 所以第 8 条不由这条路证明（它已经由上面的干净重启证过了）。
    expect(existsSync(join(dir, ".lock")), "崩溃应当留下锁").toBe(true);
    const blocked = runPhase(dir, "c", ra.sessionId!);
    expect(blocked.ok, "陈尸锁在，新进程却启动了——单写者当场破").toBe(false);
    expect(blocked.out).toContain("已被另一个写者持有");

    // 人工清锁的前提是**看得见是谁占着**——这就是 `inspectStateLock` 存在的理由
    const who = await inspectStateLock(join(dir, ".lock"));
    expect(who.state).toBe("valid");
    expect(who.state === "valid" && who.record.holder).toBe("agent:default");
    rmSync(join(dir, ".lock")); // ← 显式运维步骤

    /* ─── ⑩ 清锁之后：那条入站事实被 Agent 自己吃掉 ─── */
    const replay = runPhase(dir, "c", ra.sessionId!);
    expect(replay.ok, `replay 挂了：\n${replay.out}`).toBe(true);
    expect(
      replay.report!.seen[0]!.texts.join("\n"),
      "崩溃时未消费的那条没被重放",
    ).toContain("后台任务跑完了");
    expect(inboxRecordCount(dir), "消费完盘上还留着").toBe(0);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  },
  120_000,
);
