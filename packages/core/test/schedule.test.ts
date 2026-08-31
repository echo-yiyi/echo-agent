// schedule 模块的契约门。对应设计 docs/design/parts/schedule.md。
//
// 锁的不变量:
//   ① cron 子集语义(含日/星期双约束 OR、*/N、区间、步长、0/7 都是周日)
//   ② 创建闸:cron 非法/周期过短/时刻已过/超上限/撞 id 都在创建时拒
//   ③ tick:到期投递(source "schedule" + ref id)、同分钟防重、一次性触发即删、
//      单条坏不杀 tick、变更落盘(schedules.json)
//   ④ 重启接续:同一 dir 建新 harness → 窗口内补跑、超窗对齐不追欠账、
//      过期一次性删除留痕、坏档逐条丢弃不拖垮启动
//   ⑤ deliver 按 (source, ref) 去重(inbox 防积压)
//   ⑥ Agent 接线:三工具注册、schedule_create → tick → inbox → consumeInbox 跑一轮
//   ⑦ FileDir:原子写、递归 list、ENOENT 语义(tmp 目录,不碰 ~/.echo)
//
// 全部零真实等待:tick(now)/start(now) 手动喂时刻,不开 interval(开了立刻 stop)。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import type { AgentMessage } from "../src/messages.ts";
import { environmentMessage } from "../src/messages.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import type { Diagnostic } from "../src/errors.ts";
import type { ScheduleDeps } from "../src/schedule/harness.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { FileDir } from "../src/storage/file-dir.ts";
import { cronMatches, validateCron } from "../src/schedule/cron.ts";
import {
  createAgentSchedule, addSchedule, cancelSchedule, listSchedules, tickSchedule,
  startSchedule, stopSchedule, disposeSchedule, SCHEDULE_FILE, type AgentSchedule,
} from "../src/schedule/harness.ts";
import type { Schedule } from "../src/schedule/types.ts";

const T0 = Date.parse("2026-08-05T09:00:00"); // 本地时区周三 09:00

function fakeHost() {
  const delivered: AgentMessage[] = [];
  const reports: Diagnostic[] = [];
  const host: ScheduleDeps = {
    deliver: (m) => void delivered.push(m),
    report: (d) => reports.push(d),
  };
  return { host, delivered, reports };
}

function harness(dir = new InMemoryDir()) {
  const { host, delivered, reports } = fakeHost();
  const h = createAgentSchedule(dir);
  Object.assign(h, host);
  return { h, dir, delivered, reports };
}

function sched(partial: Partial<Schedule> & { kind: Schedule["kind"] }, id = "j1"): Schedule {
  return { id, prompt: "做点事", createdAt: T0, ...partial } as Schedule;
}

/* ───────────────────────── ① cron ───────────────────────── */

describe("cron 子集", () => {
  test("匹配语义", () => {
    const at = (s: string) => new Date(Date.parse(s));
    expect(cronMatches("* * * * *", at("2026-08-05T09:03:00"))).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-08-05T09:00:00"))).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-08-05T10:00:00"))).toBe(false);
    expect(cronMatches("*/15 * * * *", at("2026-08-05T09:30:00"))).toBe(true);
    expect(cronMatches("*/15 * * * *", at("2026-08-05T09:20:00"))).toBe(false);
    expect(cronMatches("0 9 * * 1-5", at("2026-08-05T09:00:00"))).toBe(true); // 周三
    expect(cronMatches("0 9 * * 0", at("2026-08-09T09:00:00"))).toBe(true); // 周日
    expect(cronMatches("0 9 * * 7", at("2026-08-09T09:00:00"))).toBe(true); // 7 也是周日
    // 日/星期双约束 = OR:8 月 1 日是周六;规则「1 号 或 周三」→ 1 号(周六)也该触发
    expect(cronMatches("0 9 1 * 3", at("2026-08-01T09:00:00"))).toBe(true);
    expect(cronMatches("0 9 1 * 3", at("2026-08-05T09:00:00"))).toBe(true); // 周三(5 号)也触发
    expect(cronMatches("0 9 1 * 3", at("2026-08-04T09:00:00"))).toBe(false); // 4 号周二,都不占
  });

  test("校验:坏表达式给人话拒因", () => {
    expect(validateCron("0 9 * * *")).toBeNull();
    expect(validateCron("0 9 * *")).toContain("五段");
    expect(validateCron("60 * * * *")).toContain("超出");
    expect(validateCron("* * * * 8")).toContain("超出");
    expect(validateCron("*/0 * * * *")).toContain("步长");
    expect(validateCron("5-2 * * * *")).toContain("起点大于终点");
  });
});

/* ───────────────────────── ② 创建闸 ───────────────────────── */

describe("创建闸", () => {
  test("坏任务创建时拒:非法 cron / 周期过短 / 时刻已过 / 撞 id / 超上限", async () => {
    const { h } = harness();
    await expect(addSchedule(h, sched({ kind: "cron", cron: "bad" } as never))).rejects.toThrow("五段");
    await expect(addSchedule(h, sched({ kind: "every", everyMs: 5000 } as never))).rejects.toThrow("最短");
    await expect(addSchedule(h, sched({ kind: "at", at: Date.now() - 600_000 } as never))).rejects.toThrow("已经过去");
    await addSchedule(h, sched({ kind: "every", everyMs: 60_000 } as never, "dup"));
    await expect(addSchedule(h, sched({ kind: "every", everyMs: 60_000 } as never, "dup"))).rejects.toThrow("已存在");

    const small = createAgentSchedule(new InMemoryDir(), { maxSchedules: 1 });
    Object.assign(small, fakeHost().host);
    await addSchedule(small, sched({ kind: "every", everyMs: 60_000 } as never, "a"));
    await expect(addSchedule(small, sched({ kind: "every", everyMs: 60_000 } as never, "b"))).rejects.toThrow("上限");
  });
});

/* ───────────────────────── ③ tick ───────────────────────── */

describe("tick", () => {
  test("every:到期投递(带 source/ref),未到期不投;触发后按 lastFiredAt 推进", async () => {
    const { h, delivered } = harness();
    await addSchedule(h, sched({ kind: "every", everyMs: 60_000 } as never));
    await tickSchedule(h, T0 + 30_000);
    expect(delivered.length).toBe(0);
    await tickSchedule(h, T0 + 61_000);
    expect(delivered.length).toBe(1);
    const m = delivered[0] as { role: string; source: string; ref?: string };
    expect(m.role).toBe("environment");
    expect(m.source).toBe("schedule");
    expect(m.ref).toBe("j1");
    await tickSchedule(h, T0 + 90_000); // 距上次仅 29s,不到下个周期
    expect(delivered.length).toBe(1);
  });

  test("at:一次性触发即删且落盘;cron:同分钟不重复", async () => {
    const { h, dir, delivered } = harness();
    await addSchedule(h, sched({ kind: "at", at: T0 + 5_000 } as never, "once"), T0);
    await addSchedule(h, sched({ kind: "cron", cron: "* * * * *" } as never, "everymin"));
    await tickSchedule(h, T0 + 6_000);
    expect(delivered.map((m) => (m as { ref?: string }).ref).sort()).toEqual(["everymin", "once"]);
    await tickSchedule(h, T0 + 20_000); // 同一分钟:cron 不重复;once 已删
    expect(delivered.length).toBe(2);
    expect((await listSchedules(h)).map((e) => e.schedule.id)).toEqual(["everymin"]);
    expect(await dir.read(SCHEDULE_FILE)).not.toContain("once"); // 删除已落盘
    await tickSchedule(h, T0 + 65_000); // 下一分钟:cron 再触发
    expect(delivered.length).toBe(3);
  });

  test("单条坏不杀 tick:前一条投递炸了,后一条照常", async () => {
    const dir = new InMemoryDir();
    const delivered: AgentMessage[] = [];
    const reports: Diagnostic[] = [];
    const host: ScheduleDeps = {
      deliver: (m) => {
        if ((m as { ref?: string }).ref === "boom") throw new Error("投递炸了");
        delivered.push(m);
      },
      report: (d) => reports.push(d),
    };
    const h = createAgentSchedule(dir);
    Object.assign(h, host);
    await addSchedule(h, sched({ kind: "every", everyMs: 60_000 } as never, "boom"));
    await addSchedule(h, sched({ kind: "every", everyMs: 60_000 } as never, "fine"));
    await tickSchedule(h, T0 + 61_000);
    expect(delivered.map((m) => (m as { ref?: string }).ref)).toEqual(["fine"]);
    expect(reports.some((r) => r.code === "schedule_fire_failed")).toBe(true);
  });

  test("没有 deliver 就 tick = 装配错误,fail-loud（到期了没人收）", async () => {
    const h = createAgentSchedule(new InMemoryDir());
    await expect(tickSchedule(h)).rejects.toThrow("没有 deliver");
  });
});

/* ───────────────────────── ④ 重启接续 ───────────────────────── */

describe("重启接续(同一 dir 建新 harness)", () => {
  test("every 超窗不追欠账(对齐下次);窗口内交给首次 tick 补", async () => {
    const dir = new InMemoryDir();
    const a = harness(dir);
    await addSchedule(a.h, sched({ kind: "every", everyMs: 3_600_000 } as never, "hourly")); // 每小时,窗口 30min
    await tickSchedule(a.h, T0 + 3_600_001);
    expect(a.delivered.length).toBe(1);

    // 停机 2 小时(超窗):start 对齐,不补、tick 也不立即触发
    const b = harness(dir);
    await startSchedule(b.h, T0 + 3 * 3_600_000 + 60_000);
    stopSchedule(b.h);
    await tickSchedule(b.h, T0 + 3 * 3_600_000 + 120_000);
    expect(b.delivered.length).toBe(0);

    // 停机 70 分钟后错过 10 分钟(窗口内):首次 tick 正常补一次
    const c = harness(dir);
    await tickSchedule(c.h, T0 + 3 * 3_600_000 + 60_000 + 3_600_000 + 600_000);
    expect(c.delivered.length).toBe(1);
  });

  test("过期一次性任务:start 时删除并留痕", async () => {
    const dir = new InMemoryDir();
    const a = harness(dir);
    await addSchedule(a.h, sched({ kind: "at", at: T0 + 60_000 } as never, "missed"), T0);
    const b = harness(dir);
    await startSchedule(b.h, T0 + 3_600_000); // 错过近一小时,超 120s 宽限
    stopSchedule(b.h);
    expect(b.delivered.length).toBe(0);
    expect(b.reports.some((r) => r.code === "schedule_expired")).toBe(true);
    expect((await listSchedules(b.h)).length).toBe(0);
  });

  test("cron 补跑:错过窗口内最近一次匹配,start 补投一次", async () => {
    const dir = new InMemoryDir();
    const a = harness(dir);
    await addSchedule(a.h, sched({ kind: "cron", cron: "0 * * * *" } as never, "hourly-cron")); // 每小时整点
    // 停机跨过 10:00,10:20 启动(错过 20 分钟 < 2h 扫描窗)
    const b = harness(dir);
    await startSchedule(b.h, Date.parse("2026-08-05T10:20:00"));
    stopSchedule(b.h);
    expect(b.delivered.length).toBe(1);
  });

  test("坏档逐条丢弃,不拖垮启动", async () => {
    const dir = new InMemoryDir();
    await dir.write(
      SCHEDULE_FILE,
      JSON.stringify([
        { schedule: { kind: "cron", id: "bad", prompt: "x", cron: "not valid", createdAt: T0 }, lastFiredAt: null },
        { schedule: { kind: "every", id: "good", prompt: "x", everyMs: 60_000, createdAt: T0 }, lastFiredAt: null },
      ]),
    );
    const { h, reports } = harness(dir);
    expect((await listSchedules(h)).map((e) => e.schedule.id)).toEqual(["good"]);
    expect(reports.some((r) => r.code === "schedule_bad_entry")).toBe(true);

    const broken = new InMemoryDir();
    await broken.write(SCHEDULE_FILE, "{ 不是 JSON");
    const { h: h2 } = harness(broken);
    expect((await listSchedules(h2)).length).toBe(0); // 按空表启动,不炸
  });
});

/* ───────────────────────── ⑤ deliver 去重 ───────────────────────── */

describe("Agent.deliver 按 (source, ref) 去重", () => {
  test("同源同 ref 未消费不重复入队;不同 ref 照常", async () => {
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    const sizes: number[] = [];
    agent.subscribe((e) => {
      if (e.type === "queue_update" && e.queue === "inbox") sizes.push(e.size);
    });
    agent.deliver(environmentMessage("到点了", "schedule", "j1"));
    agent.deliver(environmentMessage("到点了", "schedule", "j1")); // 重复:静默丢,连事件都不发
    agent.deliver(environmentMessage("到点了", "schedule", "j2"));
    await new Promise((r) => setTimeout(r, 5)); // 落盘/账本与 queue_update 都是异步的
    // 判据是**「重复那条连事件都不发」**：三次投递只有两个 queue_update。
    // 事件里的 size 是「队列此刻多大」的快照，不是「第 N 条进来时多大」——O2c 之后账本的 accept 是异步的，
    // 并发投递会让两个事件都读到最终值，这不影响订阅方看到的队列大小。
    expect(sizes).toHaveLength(2);
    expect(sizes.at(-1)).toBe(2);
  });
});

/* ───────────────────────── ⑥ Agent 集成 ───────────────────────── */

describe("Agent 接线", () => {
  test("三工具注册(source schedule);模型建任务 → tick → inbox → consumeInbox 跑一轮", async () => {
    const dir = new InMemoryDir();
    const schedule = createAgentSchedule(dir);
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: scriptedStreamFn([
        toolTurn("t1", "schedule_create", { prompt: "检查 CI", every_seconds: 60 }),
        textTurn("已安排"),
        textTurn("好的我去检查 CI"),
      ]),
      schedule,
    });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    expect(agent.state.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["schedule_create", "schedule_list", "schedule_cancel"]),
    );
    expect(agent.tools.has("schedule_create")).toBe(true);

    await agent.prompt("每分钟检查一下 CI");
    const entries = await listSchedules(schedule);
    expect(entries.length).toBe(1);
    expect(await dir.read(SCHEDULE_FILE)).toContain("检查 CI"); // 已落盘

    // 到期 → 投递 → 消费(不开 interval,手动 tick)
    await tickSchedule(schedule, Date.now() + 61_000);
    const result = await agent.consumeInbox();
    expect(result?.outcome.kind).toBe("completed");
    const last = agent.messages.find((m) => m.role === "environment");
    expect(JSON.stringify(last)).toContain("检查 CI");
  });

  test("dispose 链停掉定时器(不留野 interval)", async () => {
    const schedule = createAgentSchedule(new InMemoryDir(), { tickMs: 5 });
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), schedule });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    await startSchedule(schedule);
    await agent.dispose(); // 内含 stopSchedule(schedule)——测试进程能退出本身就是断言
  });
});

/* ───────────────────────── ⑦ FileDir ───────────────────────── */

describe("FileDir(tmp 目录,不碰 ~/.echo)", () => {
  test("写读删列 + 递归相对路径 + ENOENT 语义", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-filedir-"));
    try {
      const dir = new FileDir(root);
      expect(await dir.read("nope.md")).toBeNull();
      await dir.write("agent.md", "你好");
      await dir.write("memory/deep/a.md", "内容");
      expect(await dir.read("agent.md")).toBe("你好");
      expect(await dir.list("")).toEqual(["agent.md", "memory/deep/a.md"]);
      expect(await dir.list("memory/")).toEqual(["memory/deep/a.md"]);
      expect(await dir.remove("agent.md")).toBe(true);
      expect(await dir.remove("agent.md")).toBe(false);
      await dir.write("agent.md", "覆写一");
      await dir.write("agent.md", "覆写二"); // 原子替换:读到的永远是完整内容
      expect(await dir.read("agent.md")).toBe("覆写二");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
