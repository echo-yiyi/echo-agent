// Schedule 的领域观测（Schedule 行）：唯一 emission point 在 harness.ts——
//   · created / cancelled：`add / cancel` 的 `save()` settle 之后；
//   · delivered：`tickSchedule` / `catchUp` 的 deliver callback 返回之后（投递被接受才算）；
//   · bookkeeping-failed：投递之后簿记 `save()` 抛错；
//   · missed：补跑判定错过（超窗的一次性任务被删、every 跳过欠账对齐到下次）。
// 这些多发生在 run 之外：没有 runId 就是 runtime activity，经 snapshot → subscribe 取得。

import type { CapabilityFactDescriptor, ObservationFactProjection } from "../observability/fact-sink.ts";
import { sha256Hex } from "../observability/hash.ts";
import type { ObservationCapturePolicy } from "../observability/types.ts";
import type { Schedule } from "./types.ts";

export type ScheduleFactKind = "created" | "cancelled" | "delivered" | "bookkeeping-failed" | "missed";

export type ScheduleFact = Readonly<{
  kind: ScheduleFactKind;
  id: string;
  scheduleKind?: Schedule["kind"];
  /** delivered 是 tick 正常到期还是重启补跑；missed 是哪种错过。 */
  via?: "tick" | "catch-up";
  reason?: "expired" | "skipped-backlog";
  message?: string;
  occurredAt: number;
}>;

export const SCHEDULE_INSTRUMENTATION = { name: "echo.schedule", version: "1" } as const;

export const scheduleFactDescriptor: CapabilityFactDescriptor<ScheduleFact> = {
  instrumentation: SCHEDULE_INSTRUMENTATION,
  project(fact: ScheduleFact, policy: ObservationCapturePolicy): ObservationFactProjection | null {
    if (policy === "off") return null;
    const attributes: Record<string, string | number | boolean> = { scheduleId: fact.id };
    if (fact.scheduleKind !== undefined) attributes.scheduleKind = fact.scheduleKind;
    if (fact.via !== undefined) attributes.via = fact.via;
    if (fact.reason !== undefined) attributes.reason = fact.reason;
    return {
      occurredAt: fact.occurredAt,
      kind: "event",
      name: `schedule.${fact.kind}`,
      scope: { activityId: `schedule:${fact.id}` },
      attributes,
      body: {
        id: fact.id,
        ...(fact.scheduleKind === undefined ? {} : { scheduleKind: fact.scheduleKind }),
        ...(fact.via === undefined ? {} : { via: fact.via }),
        ...(fact.reason === undefined ? {} : { reason: fact.reason }),
        ...(fact.message === undefined ? {} : policy === "content" ? { message: fact.message } : { reasonDigest: sha256Hex(fact.message) }),
      },
    };
  },
};
