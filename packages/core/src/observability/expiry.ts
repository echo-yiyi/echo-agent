// 观测的过期：留多久、留多少归产品，core 只给这一个执行入口（决策：docs/decisions/implemented/2026-09-14-observation-off-main-loop.md）。
//
// **agent 里没有任何过期代码**：不挂 run 生命周期、不挂 lease、不在启动或停止时跑。产品自己决定什么时候、在哪儿调——
// 定时器、另起一个进程、空闲时都行，也可以在活着的 agent 旁边调：删不删只看盘上的事实（document-store.ts 的 `DocumentObservationExpiry`）。

import { FileDir } from "../storage/file-dir.ts";
import type { StorageDir } from "../storage/types.ts";
import { DocumentObservationExpiry, OBSERVATION_STORE_DIR, observationStorePath, type ObservationExpiryResult } from "./document-store.ts";
import type { RunObservationHeader } from "./types.ts";

export type { ObservationExpiryResult } from "./document-store.ts";

/** 过期规则的返回值：要删的 run，与 run 之外记录的回收线。都不给 = 这一次什么都不删。 */
export type ObservationExpiryDecision = Readonly<{
  /** 要删掉的 run。盘上还没封口的不删（列在结果的 `openRuns`）。 */
  runs?: readonly string[];
  /** 早于这个时刻（毫秒时间戳，比记录的 observedAt）的 run 之外记录可以回收。不给 = run 之外的记录不删。 */
  activityBefore?: number;
}>;

/** 产品给的过期规则：拿到全部 run 的 header（按 acceptedAt 倒序）与此刻，返回要删什么。 */
export type ObservationExpiryRule = (runs: readonly RunObservationHeader[], now: number) => ObservationExpiryDecision;

/** `expireObservations()` 的参数：一个会话的状态根目录，或装配时给 `observation.store` 的那个存储。 */
export type ExpireObservationsOptions = Readonly<
  { rule: ObservationExpiryRule; now?: number } & ({ stateRoot: string; store?: undefined } | { store: StorageDir; stateRoot?: undefined })
>;

/**
 * 按产品的规则过期一个状态根里的观测文档：读全部 run 的 header、调一次规则、按结果删。
 * 规则或存储抛错原样抛给调用方——这是产品自己调的函数，不是 agent 的流程。
 */
export async function expireObservations(options: ExpireObservationsOptions): Promise<ObservationExpiryResult> {
  const expiry =
    options.store !== undefined
      ? new DocumentObservationExpiry(options.store, `(store)/${OBSERVATION_STORE_DIR}`)
      : new DocumentObservationExpiry(new FileDir(options.stateRoot), observationStorePath(options.stateRoot));
  const headers = (await expiry.readAllRunIndex()).map((e) => e.header);
  return expiry.remove(options.rule(headers, options.now ?? Date.now()));
}
