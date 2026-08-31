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
      "给自己定一个闹钟:到点时 prompt 会作为一条新消息唤醒你。三种方式**三选一**:" +
      "at(ISO 时刻,一次性)、every_seconds(周期,最短 60 秒)、cron(五段式,如 '0 9 * * 1-5')。" +
      "适合「稍后检查」「定期巡查」;不适合本次任务内的步骤(直接做就行)。",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "到点时唤醒你的那句话(给未来的你看的)" },
        at: { type: "string", description: "一次性:ISO 时刻,如 2026-08-06T09:00:00" },
        every_seconds: { type: "number", description: "周期:间隔秒数,最短 60" },
        cron: { type: "string", description: "五段 cron:分 时 日 月 星期(本地时区)" },
      },
      required: ["prompt"],
    },
    async execute(params) {
      try {
        const given = [params.at, params.every_seconds, params.cron].filter((v) => v !== undefined);
        if (given.length !== 1) return toolError("at / every_seconds / cron 三选一,给且只给一个");
        const base = { id: newId(), prompt: params.prompt, createdAt: Date.now() };
        let schedule: Schedule;
        if (params.at !== undefined) {
          const at = Date.parse(params.at);
          if (Number.isNaN(at)) return toolError(`认不出的时刻 '${params.at}'(用 ISO 格式)`);
          schedule = { ...base, kind: "at", at };
        } else if (params.every_seconds !== undefined) {
          schedule = { ...base, kind: "every", everyMs: Math.floor(params.every_seconds * 1000) };
        } else {
          schedule = { ...base, kind: "cron", cron: params.cron! };
        }
        await addSchedule(ctx, schedule);
        return toolOk(`已创建定时任务 ${base.id}(取消用 schedule_cancel)`);
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
    description: "列出当前全部定时任务(id、触发规则、要做什么、上次触发)。",
    parameters: { type: "object", properties: {} },
    async execute() {
      const entries = await listSchedules(ctx);
      if (entries.length === 0) return toolOk("(没有定时任务)");
      const lines = entries.map(({ schedule: s, lastFiredAt }) => {
        const spec = s.kind === "at" ? `一次性 ${new Date(s.at).toISOString()}` : s.kind === "every" ? `每 ${Math.floor(s.everyMs / 1000)}s` : `cron ${s.cron}`;
        const last = lastFiredAt === null ? "未触发过" : `上次 ${new Date(lastFiredAt).toISOString()}`;
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
    description: "取消一个定时任务(id 见 schedule_list)。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "任务 id" } },
      required: ["id"],
    },
    async execute(params) {
      const removed = await cancelSchedule(ctx, params.id);
      return removed ? toolOk(`已取消 ${params.id}`) : toolError(`没有 '${params.id}' 这个任务`);
    },
  };
}
