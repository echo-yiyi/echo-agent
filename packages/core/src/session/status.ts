// 一段 session 的**运行**状态：`status.json`。设计见 docs/design/sessions.md §6。
//
// 与 `meta.json` 里的 `status`（active / closed）分两份，因为它们回答的是两个问题：
//   meta.status  —— 这段还算不算数（显式关掉的不再收信、不进缺省清单）。**持久**，容器退出不改它。
//   status.json  —— 它此刻在忙吗（idle / working）。**易失**，只有持有 lease 的那个进程写。
// 合成一份交出去时有一条硬规矩（`sessionRow()`）：**lease 不在手上，`phase` 一律作废**——
// 进程崩在 working 时盘上会永远停在 working，把它读成「正在忙」就是拿一份死状态当真。
//
// **纯的**：只依赖 `StorageDir`，不碰 `node:`。

import type { StorageDir } from "../storage/types.ts";

/** 运行状态在 session 目录里的文件名。 */
export const STATUS_FILE = "status.json";

/** 运行状态。`working` 覆盖 generating / acting / compacting——对外只分「能不能马上答话」。 */
export type SessionPhase = "idle" | "working";

/** `status.json` 的内容。`updatedAt` 只用来看它有多陈——判活仍以 lease 为准。 */
export type SessionStatusFile = {
  readonly phase: SessionPhase;
  readonly updatedAt: number;
};

/**
 * 读一段 session 的运行状态。**读不出来就是 `null`**（没写过、坏了、还没落盘），
 * 不猜一个缺省——「不知道」和「空闲」是两件事，猜了就会让别人以为它能马上答话。
 */
export async function readSessionPhase(store: StorageDir): Promise<SessionStatusFile | null> {
  const raw = await store.read(STATUS_FILE);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 运行状态是提示，不是账本：坏了当没有，不判红
  }
  const v = parsed as Record<string, unknown> | null;
  if (v === null || typeof v !== "object") return null;
  if (v["phase"] !== "idle" && v["phase"] !== "working") return null;
  if (typeof v["updatedAt"] !== "number") return null;
  return { phase: v["phase"], updatedAt: v["updatedAt"] };
}

/** 写运行状态。调用方负责串行与失败处理——本函数只管形状。 */
export async function writeSessionPhase(store: StorageDir, phase: SessionPhase, now: number = Date.now()): Promise<void> {
  const body: SessionStatusFile = { phase, updatedAt: now };
  await store.write(STATUS_FILE, JSON.stringify(body));
}
