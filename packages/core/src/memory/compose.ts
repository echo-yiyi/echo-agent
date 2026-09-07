// 记忆的行为:组装(进 system)与写入校验。与 messages.ts 的 defaultConvertToLlm 同一个模式:
// **缺省分发函数按 mode 分发,可整体替换**;认不出的种类组装隐形(安全缺省——下游忘了处理,
// 坏结果只是那份记忆不进 system,而不是 system 被污染)、写入拒绝(写进未知区不是安全缺省)。
//
// 硬化两条:索引行单行化(description 是模型写的,一行数据不许伪装成多行 system);
// 消毒原语从 ../prompt/sanitize.ts 同源消费,不自持第二份。


import { composeMemoryRegion, listMemories, type AgentMemories } from "./harness.ts";
import { parseFrontmatter } from "../prompt/markdown.ts";
import { singleLine, truncateMarked } from "../prompt/sanitize.ts";
import { splitScopePath, type MemoryScope } from "./scope.ts";
import {
  MEMORY_INDEX_FILE,
  memoryPaths,
  type AnyMemory,
  type CheckWrite,
  type ComposeMemory,
  type IndexedMemory,
  type MemoryDir,
  type ResidentMemory,
} from "./types.ts";

/* ───────────────────────── 索引条目渲染 ───────────────────────── */

const INDEX_LINE_CAP = 200;

export type IndexEntry = { path: string; description: string };

/** 一个文件的索引行素材:frontmatter description 优先,退化为正文首个非空行。 */
function entryOf(path: string, content: string): IndexEntry {
  const { meta, body } = parseFrontmatter(content);
  const description =
    meta["description"] !== undefined && meta["description"] !== ""
      ? meta["description"]
      : (body.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  return { path, description: truncateMarked(singleLine(description), INDEX_LINE_CAP) };
}

/**
 * 渲染一份 indexed 记忆**某一层**的全部索引条目。条目里的 path 带作用域前缀——
 * 模型照着索引 view 哪个文件、往哪一层写,都只看这一个路径。
 * `override` 给写入校验用:某文件按「即将写入的内容」参与计算,不必先写盘再验。
 */
export async function indexEntries(
  m: IndexedMemory,
  dir: MemoryDir,
  scope: MemoryScope,
  override?: { path: string; content: string },
): Promise<IndexEntry[]> {
  const paths = (await dir.list(`${scope}/${m.path}`)).filter((p) => !p.endsWith(`/${MEMORY_INDEX_FILE}`)); // 索引不索引自己
  const seen = new Set<string>();
  const out: IndexEntry[] = [];
  for (const p of paths) {
    seen.add(p);
    if (override !== undefined && p === override.path) {
      out.push(entryOf(p, override.content));
      continue;
    }
    const content = await dir.read(p);
    if (content === null) continue;
    out.push(entryOf(p, content));
  }
  if (override !== undefined && !seen.has(override.path)) out.push(entryOf(override.path, override.content));
  return out;
}

export function renderIndex(entries: IndexEntry[]): string {
  return entries.map((e) => `- ${e.path} — ${e.description}`).join("\n");
}

/* ───────────────────────── 缺省分发:组装 ───────────────────────── */

/**
 * 一个分区**每一层各出一段**,按 user → project → session,都渲染、不去重、各带自己的路径
 * (「切法」第 2 条):模型改哪一份就写哪个路径,靠的就是段标题上那个路径。空的那层不出段。
 */
export const defaultComposeMemory: ComposeMemory = async (m, dir) => {
  switch (m.mode) {
    case "resident": {
      const r = m as ResidentMemory;
      const blocks: string[] = [];
      for (const { path } of memoryPaths(r)) {
        const text = ((await dir.read(path)) ?? "").trim();
        if (text === "") continue;
        blocks.push(`## ${r.name} (${path})\n${truncateMarked(text, r.budget)}`);
      }
      return blocks.join("\n\n");
    }
    case "indexed": {
      const im = m as IndexedMemory;
      const blocks: string[] = [];
      for (const { scope, path } of memoryPaths(im)) {
        // 索引是落盘真文件(写方法每次重建);还没有(比如目录是人手预置的)就现场扫一遍补上口径
        const stored = await dir.read(`${path}${MEMORY_INDEX_FILE}`);
        const index = stored !== null && stored.trim() !== "" ? stored.trim() : renderIndex(await indexEntries(im, dir, scope));
        if (index === "") continue;
        // 组装侧也 cap:文件可能绕过工具落进来(人手放的),超预算截尾并留标记
        blocks.push(`## ${im.name} (${path} — index; view a listed path to read that file)\n${truncateMarked(index, im.budget)}`);
      }
      return blocks.join("\n\n");
    }
    default:
      return ""; // 自定义种类:缺省隐形
  }
};

/* ───────────────────────── 占位组装(归 prompt 组装层) ───────────────────────── */

/**
 * 记忆整段进 system 的**占位**拼法:使用规则 + 各分区块。
 * 怎么拼 prompt 是 prompt 组装层的设计(专门一轮);在那之前 agent 用这个缺省顶着,
 * 那轮落地后由组装管线接管——MemoryHarness 只出数据(list/composeRegion),不拥有拼法。
 */
export async function renderMemorySystem(ctx: AgentMemories): Promise<string> {
  const regions = listMemories(ctx);
  if (regions.length === 0) return "";
  const rules = regions
    .filter((m) => m.instructions !== undefined && m.instructions !== "")
    .map((m) => {
      const paths = memoryPaths(m).map((p) => p.path);
      return `- ${m.name} (${paths.length > 0 ? paths.join(", ") : "?"}): ${m.instructions}`;
    });
  const blocks: string[] = [];
  for (const m of regions) {
    const block = await composeMemoryRegion(ctx, m);
    if (block !== "") blocks.push(block);
  }
  // compose counts：这次进 system 的分区数 / 非空块数 / 字符数（sink 永不抛，兜一层不让观测影响 prompt）
  try {
    ctx.observe?.offer({ kind: "compose", regions: regions.length, blocks: blocks.length, chars: blocks.reduce((n, b) => n + b.length, 0), occurredAt: Date.now() });
  } catch {
    // 观测层的异常不进 prompt 组装
  }
  return [
    "# Memory",
    "You have persistent memory that survives across sessions, read and written through the memory tool. Regions:",
    rules.join("\n"),
    "The first path segment picks who will see an entry: user/ every session of this user · project/ every session in this workspace · session/ only this session. " +
      "Pick the widest scope the fact is actually true for, and write the whole path — there is no scope argument.",
    "Before writing, check for an existing entry to merge into. Delete what is outdated. When a region is over budget, consolidate before adding. " +
      "Do not record progress on the current task — that is the session's job; record reusable lessons. Never store secrets or credentials.",
    ...blocks,
  ].join("\n\n");
}

/* ───────────────────────── 缺省分发:写入校验 ───────────────────────── */

export const defaultCheckWrite: CheckWrite = async (m, dir, path, next) => {
  switch (m.mode) {
    case "resident": {
      const r = m as ResidentMemory;
      if (next.length > r.budget) {
        return {
          ok: false,
          reason:
            `Region '${r.name}' would exceed its budget: ${next.length} characters after this write, limit ${r.budget}. ` +
            `Keep this region small and dense: merge duplicates and delete stale entries with str_replace/delete first, then write.`,
        };
      }
      return { ok: true };
    }
    case "indexed": {
      const im = m as IndexedMemory;
      if (next.length > im.fileBudget) {
        return { ok: false, reason: `File too large: ${next.length} characters, limit ${im.fileBudget}. Split or condense it, then write.` };
      }
      // 预算按层各算一份:同一分区在 user / project / session 各有各的索引
      const at = splitScopePath(path);
      if (at === null) throw new Error(`记忆路径缺作用域前缀:'${path}'`);
      const entries = await indexEntries(im, dir, at.scope, { path, content: next });
      const size = renderIndex(entries).length;
      if (size > im.budget) {
        return {
          ok: false,
          reason:
            `The '${im.name}' index at ${at.scope}/ is full: ${size} characters, limit ${im.budget}. ` +
            `Consolidate first (merge similar files, delete stale ones), then add the new one.`,
        };
      }
      return { ok: true };
    }
    default: {
      // CustomMemories 为空时这里被收窄成 never;有自定义种类合入后就是活分支
      const mode = (m as { mode?: unknown }).mode;
      return {
        ok: false,
        reason: `Unknown memory kind '${String(mode)}': the default check refuses to write (a host supporting custom kinds must replace checkWrite)`,
      };
    }
  }
};
