// 由 schedule.test.ts 起子进程 `bun test`、带 `TZ=America/New_York` 跑：`bun test` 缺省 UTC，没有夏令时；
// 在同一进程里改 `TZ` 会漏到别的测试文件（Bun 在 `delete process.env.TZ` 之后不再刷新时区），所以单独一个进程。
// 不叫 *.test.ts：不被全仓 `bun test` 收进 UTC 的那个进程。
import { expect, test } from "bun:test";
import { cronMatches, latestMatchBefore, nextMatchAfter } from "../../src/schedule/cron.ts";
import { addSchedule, createAgentSchedule, listSchedules, tickSchedule } from "../../src/schedule/harness.ts";
import { InMemoryDir } from "../../src/storage/in-memory-dir.ts";
import type { AgentMessage } from "../../src/messages.ts";

const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

function fires(expr: string, from: number, n: number): (string | null)[] {
  const out: (string | null)[] = [];
  let t: number | null = from;
  for (let i = 0; i < n && t !== null; i++) {
    t = nextMatchAfter(expr, t);
    out.push(iso(t));
  }
  return out;
}

test("时区确实是 America/New_York", () => {
  expect([new Date(2026, 0, 1).getTimezoneOffset(), new Date(2026, 6, 1).getTimezoneOffset()]).toEqual([300, 240]);
});

test("回拨日（2026-11-01，02:00 EDT → 01:00 EST）：固定时刻只在第一遍触发；通配时刻两遍都走", () => {
  expect(fires("30 1 * * *", new Date(2026, 9, 31, 12, 0).getTime(), 2)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  // 分或时以 * 起头的是通配：01:00 / 01:30 EDT 与 01:00 / 01:30 EST 各一次
  expect(fires("*/30 * * * *", new Date(2026, 10, 1, 0, 45).getTime(), 5)).toEqual([
    "2026-11-01T05:00:00.000Z",
    "2026-11-01T05:30:00.000Z",
    "2026-11-01T06:00:00.000Z",
    "2026-11-01T06:30:00.000Z",
    "2026-11-01T07:00:00.000Z",
  ]);
  // 游标落在第二遍的那一小时里：01:45 这个墙上时刻已经走过，第二遍不再触发
  expect(iso(nextMatchAfter("45 1 * * *", Date.parse("2026-11-01T06:10:00Z")))).toBe("2026-11-02T06:45:00.000Z");
});

test("拨快日（2026-03-08，02:00 EST → 03:00 EDT）：被跳过的固定时刻补在 03:00 EDT、只补一次；通配时刻不补", () => {
  const mar7 = new Date(2026, 2, 7, 12, 0).getTime();
  expect(fires("30 2 * * *", mar7, 2)).toEqual(["2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z"]);
  expect(fires("0,30 2 * * *", mar7, 2)).toEqual(["2026-03-08T07:00:00.000Z", "2026-03-09T06:00:00.000Z"]); // 间隙里两个匹配并成一次
  expect(fires("*/30 * * * *", new Date(2026, 2, 8, 1, 15).getTime(), 3)).toEqual([
    "2026-03-08T06:30:00.000Z",
    "2026-03-08T07:00:00.000Z",
    "2026-03-08T07:30:00.000Z",
  ]);
  expect(iso(nextMatchAfter("30 * * * *", new Date(2026, 2, 8, 1, 30).getTime()))).toBe("2026-03-08T07:30:00.000Z");
});

test("通配任务跨过两次切换都与逐分钟扫描真实时间一致（每个真实分钟看它的本地字段）", () => {
  const brute = (expr: string, after: number): number | null => {
    const start = Math.floor(after / 60_000) * 60_000 + 60_000;
    for (let t = start; t <= start + 3 * 86_400_000; t += 60_000) if (cronMatches(expr, new Date(t))) return t;
    return null;
  };
  const exprs = ["* * * * *", "*/15 * * * *", "30 * * * *", "*/7 1-3 * * *", "* 2 * * *", "*/20 */2 8 3 *"];
  for (const day of ["2026-03-08T04:00:00Z", "2026-11-01T03:00:00Z"]) {
    for (let after = Date.parse(day); after < Date.parse(day) + 6 * 3_600_000; after += 7 * 60_000 + 13_000) {
      for (const expr of exprs) {
        const want = brute(expr, after);
        if (want !== null) expect([expr, iso(after), iso(nextMatchAfter(expr, after))]).toEqual([expr, iso(after), iso(want)]);
      }
    }
  }
});

test("回看「欠着的是哪一次」与「下一次在哪」同一套触发时刻", () => {
  expect(iso(latestMatchBefore("30 2 * * *", Date.parse("2026-03-08T07:00:40Z")))).toBe("2026-03-08T07:00:00.000Z");
  expect(iso(latestMatchBefore("30 1 * * *", Date.parse("2026-11-01T06:40:00Z")))).toBe("2026-11-01T05:30:00.000Z");
});

test("调度器：回拨日固定时刻只投一次；拨快日跳过的那次在间隙之后补投一次、游标记补投的那一刻", async () => {
  const run = async (cron: string, createdAt: number, from: string, to: string) => {
    const delivered: AgentMessage[] = [];
    const h = createAgentSchedule(new InMemoryDir());
    h.deliver = (m) => void delivered.push(m);
    await addSchedule(h, { id: "j", kind: "cron", cron, prompt: "p", createdAt }, createdAt);
    for (let t = Date.parse(from); t <= Date.parse(to); t += 60_000) await tickSchedule(h, t + 5_000); // 每分钟一拍
    return { delivered: delivered.length, cursor: (await listSchedules(h))[0]!.lastFiredAt };
  };
  expect(await run("30 1 * * *", new Date(2026, 9, 31, 12, 0).getTime(), "2026-11-01T04:00:00Z", "2026-11-01T08:00:00Z")).toEqual({
    delivered: 1,
    cursor: Date.parse("2026-11-01T05:30:00Z"),
  });
  expect(await run("30 2 * * *", new Date(2026, 2, 7, 12, 0).getTime(), "2026-03-08T05:00:00Z", "2026-03-08T09:00:00Z")).toEqual({
    delivered: 1,
    cursor: Date.parse("2026-03-08T07:00:00Z"),
  });
});
