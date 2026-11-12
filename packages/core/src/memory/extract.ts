// 记忆的**产生**:reply 结束时提取(2026-09-07 用户拍板);只看上次提取之后的新内容,
// 用户说的话攒够了才跑(2026-10-30 用户拍板,见 `DEFAULT_EXTRACT_MIN_USER_WORDS`),
// 攒满几轮才跑、退出前补一次(2026-11-03 用户拍板,见 `DEFAULT_EXTRACT_EVERY_TURNS`)。
//
// 为什么要它:记忆此前只有一条写入路径——前台模型自己想起来——而那段规则里**没有一条讲
// 什么时候写**。实测:自 2026-09-04 那次整理以来 320 轮对话,记忆写入 3 次,且三次全发生在
// 冒烟测试当天。参照物那边有一个专门的提取 agent(fork、受限、`maxTurns: 5`、与主 agent
// 已写记忆的重叠保护),记忆不是靠前台自觉写的。
//
// 形状(2026-11-03 起):**从主对话分叉**——与主循环同一份 system、同一份工具菜单、同一段 working context,
// 末尾追加一条提取指令。前缀与主循环最后一次请求逐字相同,厂商的前缀缓存直接接着用;菜单上只有记忆
// 工具能执行,其余点名一律拒(`Agent.runExtract`)。`maxTurns` 限死。
// 跑在**独立通道**上，不经 admission——为什么见 channel.ts 头注。
//
// 提示词是**自己写的**(措辞、结构),不抄任何专有产品的文案。

import { memoryPaths, type AnyMemory } from "./types.ts";
import type { MemoryScopeTable } from "./scope.ts";
import type { AgentMessage } from "../messages.ts";

/**
 * 提取的门槛（2026-10-30 用户拍板）：**自上次提取以来，用户亲口说的话**攒到这么多才跑一次。
 * 计量见 `userProseWords`。没攒够就攒着（游标不动）——下一条有内容的话出现时一并看。
 *
 * 为什么只数用户说的：「谢谢」「继续」这种回复后面，助手可能刚读完一个大文件，按全部新内容算会照样触发。
 * 而攒着不丢：埋头干活那几轮里踩到的坑，会随下一条过门槛的话一起被看到。
 * 数值是首版的估计（滤掉致谢 / 确认这一类），实测后再调。
 */
export const DEFAULT_EXTRACT_MIN_USER_WORDS = 8;

/** 中日韩文字：一个字记一个词（这些文字不靠空格分词）。 */
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;
/** 其余文字按空白分词，只认带字母或数字的词——纯标点不算话。 */
const WORD = /[\p{L}\p{N}]/u;

/**
 * 一段消息里用户亲口说了多少「词」：只数 `human` / `steer` 的用户消息正文（harness 插话、助手回复、
 * 工具输出、环境消息都不算）。中日韩文字一个字一个词，其余按空白分词。
 */
export function userProseWords(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "user" || m.source === "harness") continue;
    for (const b of m.content) {
      if (b.type !== "text") continue;
      const cjk = b.text.match(CJK_CHAR)?.length ?? 0;
      const rest = b.text.replace(CJK_CHAR, " ").split(/\s+/).filter((w) => WORD.test(w)).length;
      n += cjk + rest;
    }
  }
  return n;
}

/**
 * 提取的频率（2026-11-03 用户拍板）：自上次提取以来**攒满这么多轮用户输入**才跑一次（还要同时过
 * `DEFAULT_EXTRACT_MIN_USER_WORDS`）。一轮 = 一条 `human` 用户消息（`humanTurns`）。
 *
 * 为什么：门槛只挡得住致谢、确认，正常提问几乎句句过线（2026-11-03 三方对比实测：5 句脚本 4 次提取、8 次请求）。
 * 攒着不丢：游标不动，攒满的那次从游标看起；**退出前不论攒了几轮都补一次**（`Agent.drainExtract`），
 * 所以没攒满就结束的那一截也会被看到。数值参照物缺省是 1（远端可调），这里先取 3，实测后再调。
 */
export const DEFAULT_EXTRACT_EVERY_TURNS = 3;

/** 一段消息里有几轮用户输入：只数 `human` 用户消息（steer 是同一轮里的插话，harness 插话不是用户说的）。 */
export function humanTurns(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.role === "user" && m.source === "human") n += 1;
  return n;
}

/**
 * 退出前补跑那次提取最多等多久（`Agent.drainExtract`）。到点就照常收摊（提取被中止、游标不动）。
 * 一次提取通常是一到三次模型请求；前缀命中缓存时每次几秒。给退出加的延迟以它为上界。
 */
export const DEFAULT_EXTRACT_DRAIN_MS = 15_000;

/**
 * 提取子 agent 的轮数上限：够它「看一两个要改的文件 → 写两三条 → 收尾」，又给成本一个硬上界。
 * 已存的清单由 prompt 自带（`memoryManifest`），不用一个个 view 去摸——摸的话 5 轮不够（2026-09-14 实测）。
 */
export const DEFAULT_EXTRACT_MAX_TURNS = 5;

/**
 * 一次提取的结局，决定游标推不推（2026-11-12）：
 * - `reviewed`：这段算看过——跑完了，或者没跑完但已写成至少一条（那几条是真的落了盘）。游标推进。
 * - `unfinished`：一条没写成就停了（模型出错、轮数用完）。游标不动、下次重看；连续 `DEFAULT_EXTRACT_UNFINISHED_LIMIT` 次就放弃那段。
 * - `not_run`：没起来，或者被中止（stop / 丢锁）。游标不动，也不算一次没跑完——丢锁之后一个字都不许再写。
 */
export type ExtractPass = "reviewed" | "unfinished" | "not_run";

/**
 * 提取**连续**几次一条没写成就停了（`ExtractPass` 的 `unfinished`），就放弃那段、游标照推（2026-11-12）。
 *
 * 为什么要放弃：卡住的那段本身已经攒够轮数，游标不动的话之后每条 reply 都会再跑一次，要看的范围一次比一次大——
 * 越大越容易再撞轮数上限，自己越卡越死。为什么不第一次就放弃：模型一时出错、或这一次恰好没写完，重看一次多半就过了。
 */
export const DEFAULT_EXTRACT_UNFINISHED_LIMIT = 2;

/** 提取 prompt 的第一句。脚本化模型的测试靠它认出一次模型调用是提取子循环发的。 */
export const EXTRACT_PROMPT_OPENING = "A reply just finished.";

/**
 * 这次要看的那一段：在主对话末尾占几条消息，从哪句用户原话开始（没有用户原话就是 null），
 * 以及是不是从这场对话的开头看起（游标为 0：这场对话还没复盘过）。
 */
export type ExtractRange = Readonly<{ messages: number; firstUserText: string | null; fromStart: boolean }>;

/** 引用用户原话时最多带多少字：够模型在上文里认出那一句，又不把长消息整段重抄一遍。 */
const QUOTE_CHARS = 120;

/**
 * 提取的 prompt：接在主对话后面的那条指令。**没有替换口子，也不需要**：什么值得记由各模块的 instructions 定——
 * 判据跟着模块走，`memory.builtin: false` 换掉模块时判据一起换掉（2026-09-10）。这里只有机制：先看、写对地方、可以什么都不写。
 *
 * **对话不再抄进 prompt**（2026-11-03）：提取从主对话分叉，对话就在上文里；prompt 只说清看哪一段——条数加第一句用户原话
 * 的开头，两样一起给，因为 provider 换算消息时会拆合（一次多个工具调用就是好几条），单给条数模型数不准。
 * 层、模块与「此刻存着什么」仍由 prompt 自带：system 里的记忆段是会话开头冻结的那一版，之后写的它看不到；
 * `stored` 是 `memoryManifest()` 的输出（与前台记忆段同一种呈现）。
 *
 * 最后一条是这份 prompt 里最要紧的:**什么都不写是正常结果**。被派了活就想产出,
 * 是记忆变脏的主要来源。
 */
export function defaultExtractPrompt(memories: readonly AnyMemory[], table: MemoryScopeTable, range: ExtractRange, stored: string): string {
  const layers = table.entries.map((e) => `- ${e.def.name}/ — ${e.def.describe}`).join("\n");
  const modules = memories
    .map((m) => {
      const paths = memoryPaths(table, m).map((p) => p.path);
      return paths.length === 0 ? null : `- ${m.name} (${paths.join(", ")}): ${m.instructions ?? ""}`;
    })
    .filter((l): l is string => l !== null)
    .join("\n");
  const quote = range.firstUserText === null ? "" : ` It begins with the user message that starts: «${quoteStart(range.firstUserText)}».`;
  const last = `the last ${range.messages} message${range.messages === 1 ? "" : "s"} above`;
  const scope = range.fromStart
    ? `Memory has not been reviewed in this conversation yet; review it from the start — ${last}.`
    : `Memory was last reviewed partway through this conversation; review only what came after that — ${last}.`;
  return [
    `${EXTRACT_PROMPT_OPENING} Pause the task above: you are now reviewing memory, not continuing the work. ${scope}${quote} Decide whether anything in it is worth keeping after this session ends.`,
    "Only the memory tool works here. Calls to any other tool are refused — do not try them.",
    "Work in this order:\n" +
      "1. Check what is already stored — it is listed under \"Stored now\" below (resident modules in full, indexed modules by their index). Most of what feels new is already there in some form.\n" +
      "2. Pick out only what the module descriptions below say is worth keeping.\n" +
      "3. Write it where it belongs, then stop. View a file only when you are about to change it: overwriting, inserting into or deleting a file you have not viewed is refused.",
    "What is worth keeping — and what to leave out — is set by each module's description below. That is the only standard; follow it.",
    "Writing:\n" +
      "- Every file in an indexed module gets a one-line description. That line is all a future session sees when deciding whether to open it — write it to be found by what it is about.\n" +
      "- Each indexed module's INDEX.md is rebuilt by the system after every write — never write it yourself.\n" +
      "- Merge into an existing entry instead of adding a near-duplicate.\n" +
      "- Absolute dates, never \"yesterday\".\n" +
      "- Credentials, tokens, keys — never, in any module.",
    `Layers — the first path segment picks who will see an entry, widest first:\n${layers}\nPick the widest layer the fact is actually true for.`,
    `Modules:\n${modules}`,
    `Stored now:\n${stored === "" ? "(nothing stored yet)" : stored}`,
    "Writing nothing is a normal outcome. Most replies produce no memory. Do not invent something to record.",
  ].join("\n\n");
}

function quoteStart(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}…` : flat;
}

/** 这一段消息里第一条用户原话的正文（`human` / `steer`），给提取 prompt 引用；没有就是 null。 */
export function firstUserText(messages: readonly AgentMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== "user" || m.source === "harness") continue;
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (text !== "") return text;
  }
  return null;
}
