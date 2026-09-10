// 记忆的**产生**:每条 reply 结束跑一次提取(2026-09-07 用户拍板)。
//
// 为什么要它:记忆此前只有一条写入路径——前台模型自己想起来——而那段规则里**没有一条讲
// 什么时候写**。实测:自 2026-09-04 那次整理以来 320 轮对话,记忆写入 3 次,且三次全发生在
// 冒烟测试当天。参照物那边有一个专门的提取 agent(fork、受限、`maxTurns: 5`、与主 agent
// 已写记忆的重叠保护),记忆不是靠前台自觉写的。
//
// 形状:隔离子 agent(与 dream 同一段 `runSubagent`)、**全套记忆工具**(它可以先 view 再决定、
// 要覆写就 str_replace、判断错了还有下一轮纠)、`maxTurns` 限死、看 working context。
// 跑在**独立通道**上而不是 admission 的 maintenance——见 channel.ts 头注。
//
// 提示词是**自己写的**(措辞、结构),不抄任何专有产品的文案。

import { memoryPaths, type AnyMemory } from "./types.ts";
import type { MemoryScopeTable } from "./scope.ts";

/** 提取子 agent 的轮数上限:够它"view 一下现有的 → 写两三条",又给成本一个硬上界。 */
export const DEFAULT_EXTRACT_MAX_TURNS = 5;

/**
 * 提取的 prompt。**没有替换口子，也不需要**：什么值得记由各模块的 instructions 定——判据跟着模块走，
 * `memory.builtin: false` 换掉模块时判据一起换掉（2026-09-10）。这里只有机制：先看、写对地方、可以什么都不写。
 *
 * **层与模块的清单必须由 prompt 自带**:`runSubagent` 是独立 context,子 agent 拿不到
 * system prompt——dream 那边同理,它的 prompt 也自己列 regions。
 *
 * 最后一条是这份 prompt 里最要紧的:**什么都不写是正常结果**。被派了活就想产出,
 * 是记忆变脏的主要来源。
 */
export function defaultExtractPrompt(memories: readonly AnyMemory[], table: MemoryScopeTable, transcript: string): string {
  const layers = table.entries.map((e) => `- ${e.def.name}/ — ${e.def.describe}`).join("\n");
  const modules = memories
    .map((m) => {
      const paths = memoryPaths(table, m).map((p) => p.path);
      return paths.length === 0 ? null : `- ${m.name} (${paths.join(", ")}): ${m.instructions ?? ""}`;
    })
    .filter((l): l is string => l !== null)
    .join("\n");
  return [
    "A reply just finished. Read the conversation below and decide whether anything in it is worth keeping after this session ends.",
    "Work in this order:\n" +
      "1. View what is already stored before writing anything — most of what feels new is already there in some form.\n" +
      "2. Pick out only what the module descriptions below say is worth keeping.\n" +
      "3. Write it where it belongs, then stop.",
    "What is worth keeping — and what to leave out — is set by each module's description below. That is the only standard; follow it.",
    "Writing:\n" +
      "- Every file in an indexed module gets a one-line description. That line is all a future session sees when deciding whether to open it — write it to be found by what it is about.\n" +
      "- Merge into an existing entry instead of adding a near-duplicate.\n" +
      "- Absolute dates, never \"yesterday\".\n" +
      "- Credentials, tokens, keys — never, in any module.",
    `Layers — the first path segment picks who will see an entry, widest first:\n${layers}\nPick the widest layer the fact is actually true for.`,
    `Modules:\n${modules}`,
    "Writing nothing is a normal outcome. Most replies produce no memory. Do not invent something to record.",
    `--- conversation ---\n${transcript}`,
  ].join("\n\n");
}
