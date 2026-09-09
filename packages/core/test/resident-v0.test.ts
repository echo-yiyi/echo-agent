import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectStateLock } from "../src/storage/file-lock.ts";

// **Runtime V0 Gate**（12 条 resident integration）。
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
// Distribution Gate 的 `node run.mjs`（单次调用）**不是** Runtime V0 Gate，
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
  // `sessionId`：要**续**哪一段。缺省每次启动新建会话，跨进程恢复是显式动作；
  // 2026-09-03 起状态根 = session 目录，所以**共享 tasks / inbox / schedule 也必须点名同一段**。
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
/** inbox 归 session（状态根 = session 目录，2026-09-03），所以要点名是哪一段的。 */
function inboxRecordCount(home: string, sessionId: string): number {
  return readdirSync(join(home, "sessions", sessionId, "inbox")).filter((name) => /^[0-9a-f]{12}-[0-9a-f]{16}\.json$/.test(name)).length;
}

test(
  "Runtime V0：三个真进程走完 12 条 resident integration",
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
    // 四件里 Task 与 Skill 是 2026-08-23 才归 Agent 自己装的：此前只有 `echo-coding`
    // 注册，默认装配出来的 agent 工具面只有 memory + schedule 四件，这两条根本走不通。
    expect(ra.taskCount, "任务没真的建出来").toBe(1);
    expect(ra.activeSkills, "skill 没真的激活").toEqual(["写提交信息"]);
    // 工具面本身也断言一次：**默认装配就该有这些，不靠产品层补**。
    // `skill_create` 2026-08-24 起在面上（OSS-1c）：默认装配有了落盘的 `onCreate`
    //（写状态根 `skills/<name>/SKILL.md`，`start()` 时发现回来），
    // 「返回成功、重启即消失」那个反对理由不再成立。
    // 2026-09-02 渐进式披露：第一眼的菜单只有常驻的 + `tool_search`；`TaskGet` / `schedule_*` / `skill_create` /
    // `transcript_read`（`echo:compaction`）标了 `deferred`，模型经 tool_search 取过 schema 才上菜单——
    // 宿主脚本里第一轮就是 tool_search，所以后面的轮次能调 skill_create / schedule_create（上面 `called` 已证）
    // 2026-09-05 `ask_user`（提问）常驻：菜单上多它一件
    // 2026-09-09 `ask_user` 只在「有人能答」时才装：这个 fixture 没给 questions 策略，所以菜单上没有它
    expect(ra.seen[0]!.tools).toEqual(["TaskCreate", "TaskList", "TaskUpdate", "memory", "skill_activate", "subagent", "tool_search"].sort());
    // 取过之后：后面某一轮的菜单里延迟的两件已经在，tool_search 仍在（还有别的延迟工具没取）；
    // 没取过的（transcript_read）任何一轮都不在菜单上
    expect(ra.seen.some((s) => ["skill_create", "schedule_create", "tool_search"].every((n) => s.tools.includes(n)))).toBe(true);
    expect(ra.seen.every((s) => !s.tools.includes("transcript_read"))).toBe(true);

    // 落盘是真的：记忆文件、索引、闹钟、会话 entries
    // 缺省作用域 user / project / role（2026-09-08：session 那一层退场，作用域改由产品声明）。
    // 这一段没点角色，所以真正落盘的是 user 层：`<home>/memory/`，跨 session 共享。
    // 闹钟与 entries 仍在这一段自己的目录里。
    expect(existsSync(join(dir, "memory", "memory", "项目.md"))).toBe(true);
    expect(existsSync(join(dir, "memory", "memory", "笔记0.md"))).toBe(true);
    expect(existsSync(join(dir, "sessions", ra.sessionId!, "schedules.json"))).toBe(true);
    expect(readdirSync(join(dir, "sessions", ra.sessionId!, "entries")).length).toBeGreaterThan(0);

    // ⑥ **Dream 是 Agent 自己起的**：宿主没调任何整理相关的东西，只是把门喂饱
    // （同一层 10 个记忆文件 / 11 次写入）。判据是盘上的 `lastAt` 被提交，不是「dream 跑过」。
    // 门**按层各算各的**（2026-09-08），喂的是 user 层，提交的也是 user 层那份状态。
    expect(ra.dreamed, "门满足了，Agent 却没自己整理").toBe(true);
    expect(readdirSync(join(dir, "memory", "memory")).length).toBeGreaterThanOrEqual(10);

    // ⑪ 干净 stop 之后锁必须还回去
    expect(existsSync(join(dir, "sessions", ra.sessionId!, ".lock")), "stop() 之后锁没释放").toBe(false);

    /* ─── ⑤ 闹钟到点 → Inbox → **Agent 自己醒来** ─── */
    // 「不是测试直接调 loop」是这一条的全部意义：宿主只 `schedule_create` 了一个
    // 1.2 秒之后的 `at`，然后等；开新一轮的是 agent 自己。
    // **不注入假时钟**——`at` 不限过去未来，tick 每秒一拍，真时钟下就能测。
    const wake = runPhase(dir, "wake", ra.sessionId!); // 闹钟归 session：要验「A 建的那条还在」就得续 A 那一段
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

    // Task：A 进程建的那条，回到盘上**并且**进了 C 进程的 context（2026-08-24 落地前，
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
    expect(existsSync(join(dir, "sessions", ra.sessionId!, ".lock"))).toBe(false);

    /* ─── ⑩ 崩溃：未消费的入站事实留存 + 任务改完即落盘 ─── */
    // 任务与 inbox 也归 session：要验「崩溃前那条还在、重启后被吃掉」，crash 就得续同一段
    const crash = runPhase(dir, "crash", ra.sessionId!);
    expect(crash.ok, `phase crash 挂了：\n${crash.out}`).toBe(true);
    // 只数 record 文件：`inbox/acks/` 是 batch-ack marker 的目录，不是入站事实
    expect(inboxRecordCount(dir, ra.sessionId!), "崩溃前投进来的那条不在盘上").toBe(1);
    // **任务是「工具回执说成功之后就崩」的那条**：此前 `saveTasks` 只在 `dispose()` 里调，
    // 干净 stop 掩盖了这个缺口——崩溃时那条任务会丢。
    expect(readFileSync(join(dir, "sessions", ra.sessionId!, "tasks.json"), "utf8"), "崩溃前建的任务没落盘").toContain("崩溃前建的");

    /* ─── 单写契约：崩溃留下的锁**不许被自动抢占**（这一步是运维，不是产品能力）─── */
    // 2026-08-18 那条 P0 的直接后果：自动 stale takeover 会双授，已取消。
    // 代价就是这里——新进程必须**拒绝启动**，等人来清。**这不叫「自动恢复」**，
    // 所以第 8 条不由这条路证明（它已经由上面的干净重启证过了）。
    expect(existsSync(join(dir, "sessions", ra.sessionId!, ".lock")), "崩溃应当留下锁").toBe(true);
    const blocked = runPhase(dir, "c", ra.sessionId!);
    expect(blocked.ok, "陈尸锁在，新进程却启动了——单写者当场破").toBe(false);
    expect(blocked.out).toContain("已被另一个写者持有");

    // 人工清锁的前提是**看得见是谁占着**——这就是 `inspectStateLock` 存在的理由
    const who = await inspectStateLock(join(dir, "sessions", ra.sessionId!, ".lock"));
    expect(who.state).toBe("valid");
    // holder = `${产品}:${会话 id}`（2026-09-07，替代 `agent:${agentId}`）：
    // 锁文件旁边看一眼就知道是谁占着**哪一段**——从前那个 id 几乎恒为 "default"，说不出是哪段
    expect(who.state === "valid" && who.record.holder).toBe(`default:${ra.sessionId!}`);
    rmSync(join(dir, "sessions", ra.sessionId!, ".lock")); // ← 显式运维步骤

    /* ─── ⑩ 清锁之后：那条入站事实被 Agent 自己吃掉 ─── */
    const replay = runPhase(dir, "c", ra.sessionId!);
    expect(replay.ok, `replay 挂了：\n${replay.out}`).toBe(true);
    expect(
      replay.report!.seen[0]!.texts.join("\n"),
      "崩溃时未消费的那条没被重放",
    ).toContain("后台任务跑完了");
    expect(inboxRecordCount(dir, ra.sessionId!), "消费完盘上还留着").toBe(0);
    expect(existsSync(join(dir, "sessions", ra.sessionId!, ".lock"))).toBe(false);
  },
  120_000,
);
