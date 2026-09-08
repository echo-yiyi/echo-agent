// Dream:记忆的合并整理。
//
// 两家的共识原样继承:**存储只做机械事,语义整理是 LLM 任务**(Hermes:storage 提供原子
// 编辑原语、LLM 负责信息架构;CC:Dream = fork 受限 agent 去重合并剪枝)。
//
// **按层各整理各的**(2026-09-07 用户拍板,替代"只整理 session 层"):整理哪些模块由模块
// 自己声明 `dream`,整理哪几层就是那些模块声明的层。于是计数、锁、上次时间、水位**每层一份**,
// 落在那一层自己的目录下——不需要一个"本段独占"的层来放状态。
//
// 门控信号:轮次 = turn_end 事件计数、写入 = 写方法的账、文件数 = dir.list、
// 时间与锁 = 各层的 `.dream/state.json`(点开头,memory 工具的 jail 够不到,模型不可见不可写)。
// 判断归 harness(shouldDream,纯判断)、**触发与执行归 core**(Agent 的独立通道,不进 admission)。

import { memoryPaths, type AnyMemory } from "./types.ts";
import type { MemoryDir } from "./types.ts";
import type { MemoryScopeTable } from "./scope.ts";

export type DreamGates = {
  /** 上次整理以来的记忆写入次数 ≥ N 才触发。 */
  minWritesSinceLast?: number;
  /** 上次整理以来的轮数 ≥ N(轮数经 observer() 订阅 turn_end 喂进来)。 */
  minTurnsSinceLast?: number;
  /** indexed 模块的文件总数 ≥ N。 */
  minFiles?: number;
  /** 距上次整理 ≥ N 毫秒(CC 缺省 24h)。 */
  minIntervalMs?: number;
  /**
   * **水位**(2026-09-07 新增):这一层某个模块的预算用掉 ≥ 这个比例就整理。
   *
   * **它不与上面四道做 AND,而是单独成立**:那四道是节流("没必要太频繁"),水位是告警
   * ("再不整理,下一次写入就要被拒了")。AND 连起来等于让节流否决告警——恰好在最需要整理
   * 的时候不整理,模型只好在前台自己收拾,而那正是我们想用后台换掉的事。
   */
  budgetRatio?: number;
};

/** 缺省门:写过 5 次、攒到 10 个文件、距上次 24h(全满足)——**或者**任一模块用到 80%。 */
export const DEFAULT_DREAM_GATES: DreamGates = {
  minWritesSinceLast: 5,
  minFiles: 10,
  minIntervalMs: 24 * 3600_000,
  budgetRatio: 0.8,
};

/** 锁的崩溃恢复:整理 agent 死了没 markDreamed,1 小时后锁自动过期(CC 同款)。 */
export const DREAM_LOCK_STALE_MS = 3600_000;

/**
 * 一层的整理状态住在那一层自己的目录下。**每层一份**——整理是按层各整理各的,
 * 计数与锁跟着范围走;点开头的段模型够不到。
 */
export function dreamStatePath(scope: string): string {
  return `${scope}/.dream/state.json`;
}

export type DreamState = {
  lastAt: number | null;
  /** 非 null = 一次整理进行中(锁);超过 DREAM_LOCK_STALE_MS 视为陈尸,可重新触发。 */
  startedAt: number | null;
  /**
   * 上次整理以来的记忆写入次数与轮数。**落在盘上,不是只在内存**。
   *
   * 只在内存时进程一重启就清零,于是「攒够 N 次写入 / N 轮再整理」这两道门
   * 永远从头数——长期跑的 agent 反而更难触发整理,恰好和门的意图相反。
   * 盘上这份是**真相源**,`AgentMemories` 上的同名字段只是它的镜像。
   */
  writes: number;
  turns: number;
};

const EMPTY_STATE: DreamState = { lastAt: null, startedAt: null, writes: 0, turns: 0 };

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export async function readDreamState(dir: MemoryDir, scope: string): Promise<DreamState> {
  const raw = await dir.read(dreamStatePath(scope));
  if (raw === null) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<DreamState>;
    return {
      lastAt: typeof parsed.lastAt === "number" ? parsed.lastAt : null,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      writes: count(parsed.writes),
      turns: count(parsed.turns),
    };
  } catch {
    return { ...EMPTY_STATE }; // 坏档当空:Dream 是 best-effort,不为它硬失败
  }
}

export async function writeDreamState(dir: MemoryDir, scope: string, state: DreamState): Promise<void> {
  await dir.write(dreamStatePath(scope), JSON.stringify(state));
}

/**
 * 整理任务的缺省 prompt。上层要换语气 / 换策略,整段替换即可(它只是文本)。
 * **只讲 `scope` 那一层、且只讲声明了 `dream` 的模块**——别的不在这次整理的范围里,
 * 列出来只会诱它去写。
 */
export function defaultDreamPrompt(memories: readonly AnyMemory[], table: MemoryScopeTable, scope: string): string {
  const regions = memories
    .filter((m) => m.dream === true)
    .flatMap((m) => memoryPaths(table, m).filter((p) => p.scope === scope).map((p) => ({ m, path: p.path })))
    .map(({ m, path }) => {
      const budget = "budget" in m && typeof m.budget === "number" ? `, budget ${m.budget} characters` : "";
      return `- ${m.name} (${path}${budget}): ${m.instructions ?? ""}`;
    })
    .join("\n");
  return (
    `Consolidate the ${scope}/ layer of your persistent memory (use only the memory tool; view everything before changing anything).\n` +
    `Stay inside ${scope}/: the other layers are not part of this pass.\n` +
    "1. Merge duplicates: the same fact recorded in several places becomes one denser entry; keep the version that carries the evidence.\n" +
    "2. Put entries back where they belong: a fact filed in a behaviour module, a habit buried in a note file — rebuild it in the right module " +
    "and remove it from the old one. Modules have separate budgets, so this is two steps, not a rename.\n" +
    "3. Prune: delete what later facts have overtaken, what was true only once, and what has gone stale.\n" +
    "4. Conflicts: when two entries disagree, keep the one with evidence; if you cannot tell, keep both and say plainly that they conflict.\n" +
    "5. Budget: bring every module within its limit. When merging is not enough and something must go, drop the oldest entry that nothing " +
    "later refers back to.\n" +
    "6. Do not invent: only reorganize what is already there; add no facts that are not in memory.\n" +
    "If a file will not change — another session may be writing it right now — skip it and move on. Do not retry.\n" +
    `Modules in this layer:\n${regions}`
  );
}
