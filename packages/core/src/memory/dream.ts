// Dream:记忆的合并整理。设计见 docs/design/parts/memory.md。
//
// 两家的共识原样继承:**存储只做机械事,语义整理是 LLM 任务**(Hermes:storage 提供原子
// 编辑原语、LLM 负责信息架构;CC:Dream = fork 受限 agent 去重合并剪枝)。
// 门控信号全部换成**我们自己的原生机制**(2026-08-05 用户拍定):
//   轮次 = turn_end 事件计数、写入 = MemoryDir 包装层的账、文件数 = dir.list、
//   时间与锁 = .dream/state.json(点开头,memory 工具的 jail 够不到,模型不可见不可写)。
// 判断归 harness(shouldDream,纯判断)、**触发与执行归 core**——`Agent` 回到 idle 时自查门控,
// 满足就自己跑一轮只带 memory 工具的整理(2026-08-19 归属变更,此前写的是「调度归装配方、执行归 subagent」)。
// 计数(writes/turns)也落在这个 state.json 里:只在内存的话进程一重启就归零。

import type { AnyMemory, MemoryDir } from "./types.ts";

export type DreamGates = {
  /** 上次整理以来的记忆写入次数 ≥ N 才触发。 */
  minWritesSinceLast?: number;
  /** 上次整理以来的轮数 ≥ N(轮数经 observer() 订阅 turn_end 喂进来)。 */
  minTurnsSinceLast?: number;
  /** indexed 分区的文件总数 ≥ N。 */
  minFiles?: number;
  /** 距上次整理 ≥ N 毫秒(CC 缺省 24h)。 */
  minIntervalMs?: number;
};

/** 缺省门:写过 5 次、攒到 10 个文件、距上次 24h——全满足才做,宁少勿频。 */
export const DEFAULT_DREAM_GATES: DreamGates = {
  minWritesSinceLast: 5,
  minFiles: 10,
  minIntervalMs: 24 * 3600_000,
};

/** 锁的崩溃恢复:整理 agent 死了没 markDreamed,1 小时后锁自动过期(CC 同款)。 */
export const DREAM_LOCK_STALE_MS = 3600_000;

export const DREAM_STATE_PATH = ".dream/state.json";

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

export async function readDreamState(dir: MemoryDir): Promise<DreamState> {
  const raw = await dir.read(DREAM_STATE_PATH);
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

export async function writeDreamState(dir: MemoryDir, state: DreamState): Promise<void> {
  await dir.write(DREAM_STATE_PATH, JSON.stringify(state));
}

/** 整理任务的缺省 prompt。上层要换语气 / 换策略,整段替换即可(它只是文本)。 */
export function defaultDreamPrompt(memories: readonly AnyMemory[]): string {
  const regions = memories
    .filter((m) => typeof m.path === "string" && m.path !== "")
    .map((m) => {
      const budget = "budget" in m && typeof m.budget === "number" ? `,预算 ${m.budget} 字符` : "";
      return `- ${m.name}(${String(m.path)}${budget}):${m.instructions ?? ""}`;
    })
    .join("\n");
  return (
    "整理你的持久记忆(只用 memory 工具,先 view 全貌再动手):\n" +
    "1. 去重:同一件事记了多处的,合并成信息密度更高的一条;\n" +
    "2. 淘汰:过时、被后来事实推翻、明显一次性的,删掉;\n" +
    "3. 矛盾:两条冲突时保留有据可查的那条,存疑就都留并标注;\n" +
    "4. 预算:每个分区收敛到预算内,resident 分区尤其要小而致密;\n" +
    "5. 不发明:只重组已有内容,不添加记忆里没有的新事实。\n" +
    `分区一览:\n${regions}`
  );
}
