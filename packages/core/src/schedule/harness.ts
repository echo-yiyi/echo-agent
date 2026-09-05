// 定时任务的操作方法:agent 的闹钟。
//
// **这个文件里全是方法,没有 interface、没有类**（2026-08-05 用户拍定）:
// 登记表是 agent 的（`agent.schedule.entries` 是 `Map<string, ScheduleEntry>`,
// 装的是**登记条目本体**）。落盘口、闸、回调、活的定时器一起装在一个上下文里——
// 跟 background / mcp 同一个理由:**它需要 agent 侧的回调**,裸 Map 表达不了。
//
// 触发是**投递不是执行**:tick 到期 → deliver(environment 消息, source "schedule")
// → inbox → 回 idle 后 autoConsumeInbox 开新 run。永不直接开 run、不打断正在跑的。
// 要认的账:**进程死,定时器死**——落盘(schedules.json)+ 重启后 startSchedule() 的补跑窗口
// 是机制的另一半。

import { errText, type Diagnostic } from "../errors.ts";
import { environmentMessage, type AgentMessage } from "../messages.ts";
import { systemClock, type Clock } from "./clock.ts";
import type { StorageDir } from "../storage/types.ts";
import type { CapabilityFactSink } from "../observability/fact-sink.ts";
import type { ScheduleFact } from "./observe.ts";
import { cronMatches, latestMatchBefore, validateCron } from "./cron.ts";
import {
  DEFAULT_SCHEDULE_LIMITS,
  ONESHOT_GRACE_MS,
  graceMs,
  type Schedule,
  type ScheduleEntry,
} from "./types.ts";

export const SCHEDULE_KIND = "schedule";
export const SCHEDULE_FILE = "schedules.json";

/**
 * 定时任务要 agent 给的两件：到期投递（**投递不是执行**）、异常上报。
 *
 * `deliver` **可以是异步的，且它 resolve 才算「接受」**——簿记（删掉一次性任务、
 * 刷新 `lastFiredAt`）必须等在它后面。此前是同步 fire-and-forget：
 * inbox 落盘失败时 schedule 这边已经把条目删了，那个事实**两边都不剩**（实测）。
 */
export type ScheduleDeps = {
  deliver?: (m: AgentMessage) => Promise<void> | void;
  report?: (d: Diagnostic) => void;
  /** §15.9 领域观测 sink（module-local、永不抛）：created / cancelled / delivered / bookkeeping-failed / missed 各在唯一 settle 点发一次。 */
  observe?: CapabilityFactSink<ScheduleFact>;
};

/** sink 按契约永不抛；这里再兜一层，观测层的异常不进 schedule 状态机。 */
function observe(ctx: ScheduleDeps, fact: Omit<ScheduleFact, "occurredAt">, at: number): void {
  try {
    ctx.observe?.offer({ ...fact, occurredAt: at });
  } catch {
    // 见上
  }
}

export type ScheduleOptions = {
  maxSchedules?: number;
  minIntervalMs?: number;
  /** tick 间隔,缺省 1000ms。测试给小值,不是产品扩展位。 */
  tickMs?: number;
};

/** 闹钟的一整包:登记表 + 落盘口 + 闸 + 回调 + 活的定时器。 */
export type AgentSchedule = ScheduleDeps &
  ScheduleOptions & {
    entries: Map<string, ScheduleEntry>;
    /** 不传 = 真盘,落 `~/.echo/schedule/schedules.json`;评测/单测显式传 InMemoryDir。 */
    dir: StorageDir;
    /**
     * 时间与定时器来源。缺省真时钟；测试给 `FakeClock` 才能确定性地断言「到点投了一次」。
     */
    clock: Clock;
    /**
     * 活的定时器的**取消函数**。它是这个上下文的一部分——收摊时要调,不留野定时器。
     * 存取消函数而不是 handle：`setInterval` 的返回类型在 node 与浏览器不同,
     * 写进类型就把宿主类型拖进了公共面。
     */
    cancelTick?: (() => void) | null;
    /** 盘上内容是否已读进来。 */
    loaded?: boolean;
  };

/** `dir` 必给，理由同 `createAgentMemories`——默认落盘归装配层，能力层不拖 node:。 */
export function createAgentSchedule(dir: StorageDir, opts?: ScheduleOptions & { clock?: Clock }): AgentSchedule {
  const { clock, ...rest } = opts ?? {};
  return { entries: new Map(), dir, cancelTick: null, clock: clock ?? systemClock, ...rest };
}

/* ───────────── 登记表 ───────────── */

/** 创建闸:坏任务在**创建时**拿到明确拒绝,不排一个注定炸的。fail-loud,工具层转 error 结果。 */
export async function addSchedule(ctx: AgentSchedule, schedule: Schedule, at?: number): Promise<void> {
  const now = at ?? ctx.clock.now();
  await ensureLoaded(ctx);
  const max = ctx.maxSchedules ?? DEFAULT_SCHEDULE_LIMITS.maxSchedules;
  const minInterval = ctx.minIntervalMs ?? DEFAULT_SCHEDULE_LIMITS.minIntervalMs;
  if (ctx.entries.has(schedule.id)) throw new Error(`定时任务 '${schedule.id}' 已存在`);
  if (ctx.entries.size >= max) throw new Error(`定时任务已达上限 ${max} 条,先 schedule_cancel 一些`);
  if (schedule.prompt.trim() === "") throw new Error("prompt 不能为空");
  if (schedule.kind === "every" && schedule.everyMs < minInterval) {
    throw new Error(`周期最短 ${Math.floor(minInterval / 1000)} 秒(防空转)`);
  }
  if (schedule.kind === "at" && schedule.at < now - ONESHOT_GRACE_MS) throw new Error("触发时刻已经过去");
  if (schedule.kind === "cron") {
    const err = validateCron(schedule.cron);
    if (err !== null) throw new Error(err);
  }
  ctx.entries.set(schedule.id, { schedule, lastFiredAt: null });
  await save(ctx);
  observe(ctx, { kind: "created", id: schedule.id, scheduleKind: schedule.kind }, now);
}

export async function cancelSchedule(ctx: AgentSchedule, id: string): Promise<boolean> {
  await ensureLoaded(ctx);
  const kind = ctx.entries.get(id)?.schedule.kind;
  const removed = ctx.entries.delete(id);
  if (removed) {
    await save(ctx);
    observe(ctx, { kind: "cancelled", id, ...(kind === undefined ? {} : { scheduleKind: kind }) }, ctx.clock.now());
  }
  return removed;
}

export async function listSchedules(ctx: AgentSchedule): Promise<readonly ScheduleEntry[]> {
  await ensureLoaded(ctx);
  return [...ctx.entries.values()];
}

/* ───────────── 触发 ───────────── */

/**
 * 步进一次:逐条判到期 → 投递 → 簿记落盘。
 * 单条异常不杀整个 tick(逐条 try + report);同一分钟不重复触发(lastFiredAt 的分钟标记)。
 */
export async function tickSchedule(ctx: AgentSchedule, at?: number): Promise<void> {
  // **不许重入**：`deliver` 变成可等之后，一拍还没走完（还卡在投递上）时下一拍就来了，
  // 那时 `lastFiredAt` 还没更新，`isDue` 又判真——同一条会投两次（实测 FakeClock 下必现）。
  // 跳过本拍是对的：条目还在，簿记也没动，下一拍照样判到期。
  const inFlight = ticking.get(ctx);
  if (inFlight !== undefined) return;
  const run = tickOnce(ctx, at).finally(() => {
    if (ticking.get(ctx) === run) ticking.delete(ctx);
  });
  ticking.set(ctx, run);
  await run;
}

/**
 * 在飞的那一拍。**存 promise 不是布尔**——它既是重入守卫，也是收摊时的等待对象：
 * `stopSchedule()` 只取消后续 timer，挡不住**已经开始**的这一拍，而那一拍还会写
 * `schedules.json`。不等它，收摊就可能在 store 关掉之后还有写落下去（实测）。
 */
const ticking = new WeakMap<AgentSchedule, Promise<void>>();

/** 等在飞的那一拍收完。**不吞它的错**由调用方决定——这里只负责「等到静默」。 */
export async function settleTick(ctx: AgentSchedule): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const p = ticking.get(ctx);
    if (p === undefined) return;
    await p.catch(() => undefined);
  }
}

async function tickOnce(ctx: AgentSchedule, at?: number): Promise<void> {
  const now = at ?? ctx.clock.now();
  requireDeliver(ctx);
  await ensureLoaded(ctx);
  let dirty = false;
  const fired: Schedule[] = [];
  for (const entry of [...ctx.entries.values()]) {
    try {
      if (!isDue(entry, now)) continue;
      // **等接受成功再簿记**：投递抛错时下面几行不执行，条目原样留着，下一 tick 重来。
      await ctx.deliver?.(environmentMessage(renderFire(entry.schedule), SCHEDULE_KIND, entry.schedule.id));
      // deliver 返回 = 投递被接受：这是 delivered 的唯一 emission point（§15.9）
      observe(ctx, { kind: "delivered", id: entry.schedule.id, scheduleKind: entry.schedule.kind, via: "tick" }, now);
      fired.push(entry.schedule);
      if (entry.schedule.kind === "at") {
        ctx.entries.delete(entry.schedule.id); // 一次性:触发即删
      } else {
        ctx.entries.set(entry.schedule.id, { ...entry, lastFiredAt: now });
      }
      dirty = true;
    } catch (e) {
      ctx.report?.({ code: "schedule_fire_failed", message: `${entry.schedule.id}: ${errText(e)}` });
    }
  }
  if (dirty) await saveAfterFire(ctx, fired, now);
}

/** 投递之后的簿记落盘：失败 = 每条已投递的都记一次 bookkeeping-failed（下次 tick 会再投），错照抛。 */
async function saveAfterFire(ctx: AgentSchedule, fired: readonly Schedule[], now: number): Promise<void> {
  try {
    await save(ctx);
  } catch (e) {
    for (const s of fired) observe(ctx, { kind: "bookkeeping-failed", id: s.id, scheduleKind: s.kind, message: errText(e) }, now);
    throw e;
  }
}

/**
 * 开闸:① 补跑(重启期间错过、且还在补跑窗口内的,各补一次;窗口外的对齐到下次)
 * ② setInterval 每 tickMs 步进。幂等。**缺省不自动开**——「agent 会自己醒」是强行为,
 * 显式打开;评测永不开 = 零不确定性。
 */
export async function startSchedule(ctx: AgentSchedule, at?: number): Promise<void> {
  const now = at ?? ctx.clock.now();
  requireDeliver(ctx);
  if (ctx.cancelTick != null) return;
  await catchUp(ctx, now);
  ctx.cancelTick = ctx.clock.setInterval(() => {
    void tickSchedule(ctx).catch(() => {}); // tick 内部已逐条兜底,这里只防万一
  }, ctx.tickMs ?? 1000);
}

/**
 * 只把盘上的条目读进来，**不补跑也不起定时器**。
 *
 * `start()` 的恢复顺序需要它：schedule 数据要先在内存里，而**补跑必须晚于 inbox 恢复**
 * ——补跑会 deliver，而 deliver 要往 inbox 写；inbox 的序号还没从盘上初始化的话，
 * 补跑写出的 `000001` 会**盖掉盘上原有的 000001**（实测：两条最后只剩一条）。
 */
export async function loadSchedule(ctx: AgentSchedule): Promise<void> {
  await ensureLoaded(ctx);
}

export function stopSchedule(ctx: AgentSchedule): void {
  if (ctx.cancelTick != null) {
    ctx.cancelTick();
    ctx.cancelTick = null;
  }
}

/** 收摊:**不留野定时器**;变更即落盘,无脏数据要写。 */
export async function disposeSchedule(ctx: AgentSchedule): Promise<void> {
  stopSchedule(ctx);
  await ctx.dir.close?.();
}

/* ───────────── 私有 ───────────── */

/** 补跑:错过不超过窗口的补一次;超过的不补,但把 every 的基线对齐到 now(否则 tick 会立即触发追欠账)。 */
async function catchUp(ctx: AgentSchedule, now: number): Promise<void> {
  await ensureLoaded(ctx);
  let dirty = false;
  const fired: Schedule[] = [];
  for (const entry of [...ctx.entries.values()]) {
    const s = entry.schedule;
    try {
      if (s.kind === "at") {
        if (s.at <= now && now - s.at > ONESHOT_GRACE_MS) {
          // 错过太久的一次性任务:不补、删除并留痕(永远不会再触发,留着是死条目)
          ctx.entries.delete(s.id);
          ctx.report?.({ code: "schedule_expired", message: `一次性任务 '${s.id}' 错过触发窗口,已删除` });
          observe(ctx, { kind: "missed", id: s.id, scheduleKind: s.kind, via: "catch-up", reason: "expired" }, now);
          dirty = true;
        }
        continue; // 窗口内的交给首次 tick 正常触发
      }
      if (s.kind === "every") {
        const due = (entry.lastFiredAt ?? s.createdAt) + s.everyMs;
        if (due <= now && now - due > graceMs(s.everyMs)) {
          ctx.entries.set(s.id, { ...entry, lastFiredAt: now }); // 超窗:跳过欠账,对齐下次
          observe(ctx, { kind: "missed", id: s.id, scheduleKind: s.kind, via: "catch-up", reason: "skipped-backlog" }, now);
          dirty = true;
        }
        continue; // 窗口内的交给首次 tick(isDue 为真)正常触发
      }
      // cron:往回找最近匹配分钟;错过且在 2h 扫描窗内 → 补一次
      const missed = latestMatchBefore(s.cron, now);
      if (missed !== null && (entry.lastFiredAt === null || entry.lastFiredAt < missed) && now - missed >= 60_000) {
        // 补跑同样：接受成功才记 fired，否则下次启动还会补
        await ctx.deliver?.(environmentMessage(renderFire(s), SCHEDULE_KIND, s.id));
        observe(ctx, { kind: "delivered", id: s.id, scheduleKind: s.kind, via: "catch-up" }, now);
        fired.push(s);
        ctx.entries.set(s.id, { ...entry, lastFiredAt: now });
        dirty = true;
      }
    } catch (e) {
      ctx.report?.({ code: "schedule_catchup_failed", message: `${s.id}: ${errText(e)}` });
    }
  }
  if (dirty) await saveAfterFire(ctx, fired, now);
}

async function ensureLoaded(ctx: AgentSchedule): Promise<void> {
  if (ctx.loaded === true) return;
  ctx.loaded = true;
  const raw = await ctx.dir.read(SCHEDULE_FILE);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw) as ScheduleEntry[];
    for (const entry of parsed) {
      // 逐条校验,坏条目丢弃留痕——单个坏任务不拖垮启动
      const s = entry?.schedule;
      if (s === undefined || typeof s.id !== "string" || typeof s.prompt !== "string") continue;
      if (s.kind === "cron" && validateCron(s.cron) !== null) {
        ctx.report?.({ code: "schedule_bad_entry", message: `'${s.id}' cron 非法,已丢弃` });
        continue;
      }
      ctx.entries.set(s.id, { schedule: s, lastFiredAt: entry.lastFiredAt ?? null });
    }
  } catch {
    ctx.report?.({
      code: "schedule_bad_file",
      message: `${SCHEDULE_FILE} 解析失败,按空表启动(原文件将在下次写入时被覆盖)`,
    });
  }
}

async function save(ctx: AgentSchedule): Promise<void> {
  await ctx.dir.write(SCHEDULE_FILE, JSON.stringify([...ctx.entries.values()], null, 2));
}

/** 没有 deliver 就 start/tick = 到期了没人收——**fail-loud**,不许静默空转。 */
function requireDeliver(ctx: AgentSchedule): void {
  if (ctx.deliver === undefined) {
    throw new Error("定时任务没有 deliver:先把 AgentSchedule 交给 Agent(opts.schedule)再 start/tick");
  }
}

/* ───────────── 到期判定(纯逻辑) ───────────── */

function isDue(entry: ScheduleEntry, now: number): boolean {
  const s = entry.schedule;
  switch (s.kind) {
    case "at":
      return entry.lastFiredAt === null && now >= s.at;
    case "every":
      return now >= (entry.lastFiredAt ?? s.createdAt) + s.everyMs;
    case "cron": {
      if (!cronMatches(s.cron, new Date(now))) return false;
      // 同一分钟不重复:上次触发落在同一分钟就不再触发
      const marker = Math.floor(now / 60_000);
      return entry.lastFiredAt === null || Math.floor(entry.lastFiredAt / 60_000) !== marker;
    }
  }
}

function renderFire(s: Schedule): string {
  return `[Schedule fired: ${s.id}]\n${s.prompt}`;
}
