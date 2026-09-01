// schedule 的模型可见面:三个内核工具(判据与 skill_activate 同一条——对 agent 自己的
// 能力面动手的才是内核工具)。agent 用它们给自己定闹钟;到点经 inbox 醒来。
//
// ⚠️ description 是模型逐字读的 prompt 资产,这里是初版措辞;治理(版本/指纹)归待拍板。

import { errText } from "../errors.ts";
import { toolError, toolOk, type ModelTool } from "../tools/types.ts";
import { addSchedule, cancelSchedule, listSchedules, type AgentSchedule } from "./harness.ts";
import type { Schedule } from "./types.ts";

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
        const base = { id: newId(), prompt: params.prompt, createdAt: Date.now() };
        let schedule: Schedule;
        if (params.at !== undefined) {
          const at = Date.parse(params.at);
          if (Number.isNaN(at)) return toolError(`Unrecognized timestamp '${params.at}' (use ISO format)`);
          schedule = { ...base, kind: "at", at };
        } else if (params.every_seconds !== undefined) {
          schedule = { ...base, kind: "every", everyMs: Math.floor(params.every_seconds * 1000) };
        } else {
          schedule = { ...base, kind: "cron", cron: params.cron! };
        }
        await addSchedule(ctx, schedule);
        return toolOk(`Created schedule ${base.id} (cancel with schedule_cancel)`);
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
    label: "定时任务列表",
    description: "List all schedules (id, trigger rule, prompt, last fired).",
    parameters: { type: "object", properties: {} },
    async execute() {
      const entries = await listSchedules(ctx);
      if (entries.length === 0) return toolOk("(no schedules)");
      const lines = entries.map(({ schedule: s, lastFiredAt }) => {
        const spec = s.kind === "at" ? `once ${new Date(s.at).toISOString()}` : s.kind === "every" ? `every ${Math.floor(s.everyMs / 1000)}s` : `cron ${s.cron}`;
        const last = lastFiredAt === null ? "never fired" : `last ${new Date(lastFiredAt).toISOString()}`;
        const prompt = s.prompt.length > 60 ? `${s.prompt.slice(0, 60)}…` : s.prompt;
        return `- ${s.id} [${spec}] ${last}:${prompt}`;
      });
      return toolOk(lines.join("\n"));
    },
  };
}

function cancelTool(ctx: AgentSchedule): ModelTool<{ id: string }> {
  return {
    kind: "model",
    name: "schedule_cancel",
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
