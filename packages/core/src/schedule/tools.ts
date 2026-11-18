// schedule 的模型可见面:三个内核工具(判据与 skill_activate 同一条——对 agent 自己的
// 能力面动手的才是内核工具)。agent 用它们给自己定闹钟;到点经 inbox 醒来。
//
// ⚠️ description 是模型逐字读的 prompt 资产,这里是初版措辞;治理(版本/指纹)归待拍板。

import { errText } from "../errors.ts";
import { toolError, toolOk, type ModelTool } from "../tools/types.ts";
import { addSchedule, cancelSchedule, listSchedules, nextFireAt, scheduleStatus, type AgentSchedule, type ScheduleStatus } from "./harness.ts";
import type { Schedule, ScheduleEntry } from "./types.ts";

/**
 * 一条定时任务交给宿主的样子（2026-11-17）：`schedule_create` / `schedule_list` 结果的 metadata，时刻是毫秒时间戳。
 * 模型读的是正文里同样的几项（时刻写成本地时区、带偏移的 ISO）。
 */
export type ScheduleView = Readonly<{
  id: string;
  kind: Schedule["kind"];
  /** 一次性是触发时刻（ISO），周期是秒数，cron 是表达式。 */
  rule: string;
  prompt: string;
  status: ScheduleStatus;
  nextFireAt: number | null;
  lastFiredAt: number | null;
}>;

function viewOf(entry: ScheduleEntry, now: number): ScheduleView {
  const s = entry.schedule;
  return {
    id: s.id,
    kind: s.kind,
    rule: s.kind === "at" ? localIso(s.at) : s.kind === "every" ? String(Math.floor(s.everyMs / 1000)) : s.cron,
    prompt: s.prompt,
    status: scheduleStatus(entry, now),
    nextFireAt: nextFireAt(entry),
    lastFiredAt: entry.lastFiredAt,
  };
}

/** 触发规则的一句话：一次性带时刻，周期带秒数，cron 说明按本地时区。 */
function ruleText(v: ScheduleView): string {
  return v.kind === "at" ? `once at ${v.rule}` : v.kind === "every" ? `every ${v.rule}s` : `cron '${v.rule}' (local time)`;
}

/**
 * 本地时区、带偏移的 ISO 时刻（2026-11-17）。cron 按本地时区解释、不带偏移的 `at` 也按本地时区解析——
 * 回显 UTC 的话模型对不上它说的「9 点」。
 */
export function localIso(ms: number): string {
  const offsetMin = -new Date(ms).getTimezoneOffset();
  const wall = new Date(ms + offsetMin * 60_000).toISOString().slice(0, 19);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function makeScheduleTools(ctx: AgentSchedule): ModelTool[] {
  return [createTool(ctx), listTool(ctx), cancelTool(ctx)];
}

function newId(): string {
  return `sch-${crypto.randomUUID().slice(0, 8)}`;
}

function createTool(ctx: AgentSchedule): ModelTool<{ prompt: string; at?: string; every_seconds?: number; cron?: string }> {
  return {
    kind: "model",
    name: "schedule_create",
    deferred: true, // 冷门：不上菜单，模型 tool_search 取过再用（2026-09-02，缺省那一批）
    label: "定时任务",
    description:
      "Set an alarm for yourself: when it fires, prompt is delivered to you as a new message. Give exactly one of: " +
      "at (ISO timestamp, once), every_seconds (repeating, at least 60), cron (five fields, e.g. '0 9 * * 1-5'). " +
      "Use it to check back later or to run periodic checks, not for steps of the current task (just do those).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The message that wakes you up (written for your future self)" },
        at: { type: "string", description: "Once: ISO timestamp, e.g. 2026-08-06T09:00:00" },
        every_seconds: { type: "number", description: "Repeating: interval in seconds, at least 60" },
        cron: { type: "string", description: "Five-field cron: minute hour day month weekday (local time zone)" },
      },
      required: ["prompt"],
    },
    async execute(params) {
      try {
        const given = [params.at, params.every_seconds, params.cron].filter((v) => v !== undefined);
        if (given.length !== 1) return toolError("Give exactly one of at / every_seconds / cron");
        // 创建时刻用调度器自己的时钟：下次触发与状态都按它算，回显的才对得上（2026-11-17）
        const base = { id: newId(), prompt: params.prompt, createdAt: ctx.clock.now() };
        let schedule: Schedule;
        if (params.at !== undefined) {
          const at = Date.parse(params.at);
          if (Number.isNaN(at)) return toolError(`Unrecognized timestamp '${params.at}' (use ISO format)`);
          schedule = { ...base, kind: "at", at };
        } else if (params.every_seconds !== undefined) {
          // 非有限数（`"1h"` 这类字符串 → NaN，`1e400` → Infinity）此前绕过 60 秒下限闸、落盘成 `everyMs: null`，
          // 重启后每一拍都到期（review 2026-09-07）。在这里判形，闸那边同样按 fail-closed 写。
          const everyMs = Math.floor(Number(params.every_seconds) * 1000);
          if (!Number.isFinite(everyMs)) return toolError(`every_seconds must be a finite number of seconds (at least 60), got '${String(params.every_seconds)}'`);
          schedule = { ...base, kind: "every", everyMs };
        } else {
          schedule = { ...base, kind: "cron", cron: params.cron! };
        }
        await addSchedule(ctx, schedule);
        // 回显解析出来的规则与下次触发时刻（2026-11-17）：不带偏移的 at 按本地时区解析，模型要看得出是不是它想的那一刻
        const view = viewOf({ schedule, lastFiredAt: null }, ctx.clock.now());
        const next = view.nextFireAt === null ? "none within five years" : localIso(view.nextFireAt);
        return toolOk(`Created schedule ${base.id}: ${ruleText(view)}; next fire ${next}. Cancel with schedule_cancel.`, { schedule: view });
      } catch (e) {
        return toolError(errText(e));
      }
    },
  };
}

function listTool(ctx: AgentSchedule): ModelTool<Record<string, never>> {
  return {
    kind: "model",
    name: "schedule_list",
    deferred: true, // 冷门：不上菜单，模型 tool_search 取过再用（2026-09-02，缺省那一批）
    label: "定时任务列表",
    description: "List all schedules: id, trigger rule, status (waiting / due: fires on the next tick / missed: past its grace window, will be skipped), next fire time, last fired, prompt.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const entries = await listSchedules(ctx);
      if (entries.length === 0) return toolOk("(no schedules)", { schedules: [] });
      const now = ctx.clock.now();
      const views = entries.map((e) => viewOf(e, now));
      const lines = views.map((v) => {
        const next = v.nextFireAt === null ? "next none" : `next ${localIso(v.nextFireAt)}`;
        const last = v.lastFiredAt === null ? "never fired" : `last ${localIso(v.lastFiredAt)}`;
        const prompt = v.prompt.length > 60 ? `${v.prompt.slice(0, 60)}…` : v.prompt;
        return `- ${v.id} [${ruleText(v)}] ${v.status}, ${next}, ${last}: ${prompt}`;
      });
      return toolOk(lines.join("\n"), { schedules: views });
    },
  };
}

function cancelTool(ctx: AgentSchedule): ModelTool<{ id: string }> {
  return {
    kind: "model",
    name: "schedule_cancel",
    deferred: true, // 冷门：不上菜单，模型 tool_search 取过再用（2026-09-02，缺省那一批）
    label: "取消定时任务",
    description: "Cancel a schedule (ids from schedule_list).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Schedule id" } },
      required: ["id"],
    },
    async execute(params) {
      const removed = await cancelSchedule(ctx, params.id);
      return removed ? toolOk(`Cancelled ${params.id}`) : toolError(`No schedule '${params.id}'`);
    },
  };
}
