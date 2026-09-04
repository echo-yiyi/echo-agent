// schedule 的数据形状。
//
// 写法与 messages/memory 同构:纯数据判别联合,JSON-safe,直接落盘(schedules.json 全量读写)。
// 触发是**投递不是执行**:到期 → host.deliver(environment 消息)→ inbox → 回 idle 后
// autoConsumeInbox 开新 run。调度器永远不直接开 run、不打断正在跑的任务。

type ScheduleBase = {
  /** 寻址键:cancel、inbox 去重的 ref。schedule_create 生成短 id 并返回给模型。 */
  readonly id: string;
  /** 触发时投给 agent 的话——喂给未来的 LLM,不是 shell(所以不做关键词安全匹配)。 */
  readonly prompt: string;
  readonly createdAt: number;
};

/** 一次性:到时刻触发一次,随即删除。 */
export type OneShotSchedule = ScheduleBase & { readonly kind: "at"; readonly at: number };

/** 周期:每 everyMs 一次(下限 60s,防空转)。 */
export type IntervalSchedule = ScheduleBase & { readonly kind: "every"; readonly everyMs: number };

/** 五段 cron(分 时 日 月 星期,本地时区)。 */
export type CronSchedule = ScheduleBase & { readonly kind: "cron"; readonly cron: string };

export type Schedule = OneShotSchedule | IntervalSchedule | CronSchedule;

/** 盘上的一条 = 定义 + 触发簿记。lastFiredAt 落盘:重启后的补跑窗口和下次到期都从它算。 */
export type ScheduleEntry = {
  readonly schedule: Schedule;
  readonly lastFiredAt: number | null;
};

/** 创建闸的缺省值(防自我放大:周期下限防空转、总量上限防囤积)。 */
export const DEFAULT_SCHEDULE_LIMITS = {
  maxSchedules: 50,
  minIntervalMs: 60_000,
} as const;

/** 补跑窗口:错过超过半个周期,「补跑」和「等下一次」语义一样,不补。上下钳位防两端退化。 */
export function graceMs(periodMs: number): number {
  return Math.max(120_000, Math.min(Math.floor(periodMs / 2), 7_200_000));
}

/** 一次性任务的宽限:「5 秒后执行」的创建流程本身可能花掉几秒。 */
export const ONESHOT_GRACE_MS = 120_000;
