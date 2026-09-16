// 产品的观测过期：**规则归产品，时机归装配层，core 一行都不管**（决策：
// docs/decisions/implemented/2026-09-14-observation-off-main-loop.md）。
//
// 为什么扫的是会话根而不是「这一段」：缺省每次启动都新建一段会话，新目录里没有旧 run——
// 只清自己这一段等于什么都不清，旧会话的观测会永远留着。所以规则按会话根下**每一段**各跑一次。
//
// 为什么可以在别人跑着的时候删：`expireObservations()` 只凭盘上的事实删（已封口的 run、head 之前的批），
// 不取锁、不问写入端（observability.md §5）。

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expireObservations, observationStorePath, type ObservationExpiryRule } from "@echo-agent/core";

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 「只留最近 `days` 天」：更早**且已封口**的 run 删掉，run 之外的记录同一条线回收。
 * 没封口的不删（`expireObservations()` 把它们列进 `openRuns`）——那是还在跑的，或者进程没来得及封口的。
 */
export function retainRecentDays(days: number): ObservationExpiryRule {
  const span = Math.max(1, Math.floor(days)) * DAY_MS;
  return (runs, now) => {
    const cutoff = now - span;
    return { runs: runs.filter((r) => r.acceptedAt < cutoff).map((r) => r.runId), activityBefore: cutoff };
  };
}

/**
 * 按规则清一遍会话根下每一段的观测。**调用方不等它**（观测的任何功能都不许让主流程多等一拍），
 * 某一段坏了或正被删就跳过那一段，不影响别的段，也绝不抛给调用方。
 */
export async function expireSessionObservations(
  input: Readonly<{ sessionsRoot: string; rule: ObservationExpiryRule; now?: number }>,
): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(input.sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return; // 会话根还不存在：没有可清的
  }
  for (const name of names) {
    const stateRoot = join(input.sessionsRoot, name);
    try {
      if (!existsSync(observationStorePath(stateRoot))) continue; // 这一段还没记过观测
      await expireObservations({ stateRoot, rule: input.rule, ...(input.now === undefined ? {} : { now: input.now }) });
    } catch {
      // 这一段的观测坏了 / 正在被别人删：跳过，别让清理成为启动的一种失败
    }
  }
}
