// 上下文镜像的观测线程这一半（观测白盒化 §2.2 / §3.3，docs/decisions/proposed/2026-11-03-observation-white-box.md）。
//
// 主线程（`context-mirror.ts`）只交编号与第一次见到的对象；这里按编号攒一份镜像，**用 agent 自己的那几个纯函数**
// 把这次送模的视图重建出来、算构成：
//   · 视图：`buildWorkingMessages`（压缩投影，与 run-turn 同一个函数）再接上每轮注入；
//   · token：`estimateMessage` / `estimateText`（与压缩判断用的同一个估算器——两边的数天然一致）；
//   · 投影的增删：跑一遍 `defaultConvertToLlm`（只在缺省投影下；自定义的只记「是自定义」）。
// 这些全在观测线程里做，主线程不为它们多花一拍。

import { buildWorkingMessages, estimateMessage, estimateText } from "../compaction/view.ts";
import type { CompactionState } from "../compaction/types.ts";
import { defaultConvertToLlm, type AgentMessage, type ProviderMessage } from "../messages.ts";
import type { ContextHandoff, MirrorRef, MirrorRuns } from "./context-mirror.ts";

/**
 * 视图里一块的来历：
 *   · `transcript`：transcript 里的原消息（`source` 是角色）；
 *   · `summary` / `omitted`：压缩折掉的一段，换成摘要 / 只留一句省略说明；
 *   · `cleared_placeholder`：被清掉正文的旧工具结果的占位；
 *   · `injection`：每轮注入（`source` 是 `skill:<名>` / `task`）；
 *   · `message`：hook 改过的视图、压缩阶段自己拼的输入——来历分不出，按角色（`source`）记。
 */
export type ContextPartKind = "transcript" | "summary" | "omitted" | "cleared_placeholder" | "injection" | "message";

export type ContextPart = Readonly<{ kind: ContextPartKind; source?: string; count: number; chars: number; images: number; tokens: number }>;

/** 主线程随编号一起交的、不需要镜像的那几项。 */
export type ContextBuiltMeta = Readonly<{
  purpose: "turn" | "compaction";
  attempt?: number;
  stage?: string;
  hooks: Readonly<{ transformContext?: "kept" | "replaced"; contextBeforeBuild?: "kept" | "patched" }>;
  converter: "default" | "custom";
  /** 这次请求的装备：模型（`provider/id`）、思考档（没设是 null）、目录标的输出上限。 */
  request: Readonly<{ model: string; thinkingLevel: string | null; maxOutputTokens: number | null }>;
}>;

/** `context.built` 的 body（metadata 档）。 */
export type ContextBuiltBody = Readonly<{
  purpose: "turn" | "compaction";
  attempt?: number;
  stage?: string;
  system: Readonly<{ chars: number; tokens: number }> | null;
  parts: readonly ContextPart[];
  /** 视图条数（送进投影之前）。 */
  messages: number;
  tools: Readonly<{ count: number; schemaChars: number; tokens: number; names: readonly string[] }>;
  /** system + 视图 + 工具的估算合计（与压缩同一把尺子，未乘 usage 校准比）。 */
  tokens: number;
  hooks: ContextBuiltMeta["hooks"];
  converter: Readonly<{ kind: "default" | "custom"; outputMessages?: number; dropped?: number; healedOrphans?: number }>;
  request: ContextBuiltMeta["request"];
  /** 镜像里找不到的编号数（那次交接失败过）：这几条不计入构成。 */
  unresolved?: number;
}>;

/** 一条消息的字符数与图片数：与 `estimateMessage` 同一套取法（文本 / 思考按长度，tool_use 按名字加参数 JSON）。 */
function measure(m: AgentMessage): { chars: number; images: number } {
  switch (m.role) {
    case "toolResult":
      return { chars: m.content.length, images: m.images?.length ?? 0 };
    case "user":
    case "assistant":
    case "environment": {
      let chars = 0;
      let images = 0;
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "thinking") chars += b.thinking.length;
        else if (b.type === "image") images += 1;
        else if (b.type === "tool_use") chars += b.name.length + JSON.stringify(b.input).length;
      }
      return { chars, images };
    }
    default:
      return { chars: JSON.stringify(m).length, images: 0 };
  }
}

/** 角色作来历（`message` / `transcript` 块的 source）：user 带上是谁说的。 */
function roleOf(m: AgentMessage): string {
  const r = m as { role: string; source?: unknown };
  return r.role === "user" && typeof r.source === "string" ? `user/${r.source}` : r.role;
}

/** 注入的来历：`skill:<名>` / `task`。 */
function injectionSource(m: AgentMessage): string {
  const e = m as { source?: unknown; ref?: unknown };
  const source = typeof e.source === "string" ? e.source : (m as { role: string }).role;
  return typeof e.ref === "string" ? `${source}:${e.ref}` : source;
}

/** 观测线程的那一半：每个观测 runtime 一份，镜像跟着 runtime 走（收摊即丢）。 */
export class ContextMirrorStore {
  private readonly values = new Map<MirrorRef, unknown>();

  /** 交接里的 `handoff` + `meta` → `context.built` 的 body。 */
  resolve(handoff: ContextHandoff, meta: ContextBuiltMeta): ContextBuiltBody {
    for (const f of handoff.fresh) this.values.set(f.ref, f.value);
    let unresolved = 0;
    const get = (ref: MirrorRef): unknown => {
      const v = this.values.get(ref);
      if (v === undefined) unresolved += 1;
      return v;
    };
    const expand = (runs: MirrorRuns): AgentMessage[] => {
      const out: AgentMessage[] = [];
      for (const [start, count] of runs) {
        for (let i = 0; i < count; i++) {
          const m = get(start + i);
          if (m !== undefined) out.push(m as AgentMessage);
        }
      }
      return out;
    };

    // 视图：没被 hook 改过就用同一个投影函数重建，能分清每一块的来历；改过的按给出的顺序，来历只分角色
    const blocks: { m: AgentMessage; kind: ContextPartKind; source?: string }[] = [];
    if (handoff.view.kind === "rebuild") {
      const transcript = expand(handoff.view.transcript);
      const state = get(handoff.view.compaction) as CompactionState | undefined;
      const inTranscript = new Set<AgentMessage>(transcript);
      const spans = state?.spans ?? [];
      let span = 0;
      for (const m of state === undefined ? transcript : buildWorkingMessages(transcript, state)) {
        if (inTranscript.has(m)) blocks.push({ m, kind: "transcript", source: roleOf(m) });
        else if (m.role === "toolResult") blocks.push({ m, kind: "cleared_placeholder" });
        else blocks.push({ m, kind: spans[span++]?.summary === null ? "omitted" : "summary" });
      }
      for (const ref of handoff.view.injections) {
        const m = get(ref) as AgentMessage | undefined;
        if (m !== undefined) blocks.push({ m, kind: "injection", source: injectionSource(m) });
      }
    } else {
      for (const m of expand(handoff.view.messages)) blocks.push({ m, kind: "message", source: roleOf(m) });
    }

    // 构成：同一种来历（同一个 source）并成一块，按第一次出现的顺序
    const parts = new Map<string, { kind: ContextPartKind; source?: string; count: number; chars: number; images: number; tokens: number }>();
    for (const b of blocks) {
      const key = `${b.kind}\u0000${b.source ?? ""}`;
      let p = parts.get(key);
      if (p === undefined) {
        p = { kind: b.kind, ...(b.source === undefined ? {} : { source: b.source }), count: 0, chars: 0, images: 0, tokens: 0 };
        parts.set(key, p);
      }
      const size = measure(b.m);
      p.count += 1;
      p.chars += size.chars;
      p.images += size.images;
      p.tokens += estimateMessage(b.m);
    }

    const systemText = handoff.system === null ? null : (get(handoff.system.ref) as string | undefined);
    const system = handoff.system === null ? null : { chars: handoff.system.chars, tokens: systemText === undefined ? 0 : estimateText(systemText) };

    const schemas = handoff.tools.map((ref) => get(ref)).filter((s): s is { name: string } => typeof s === "object" && s !== null);
    const schemaJson = schemas.length === 0 ? "" : JSON.stringify(schemas);
    const tools = { count: schemas.length, schemaChars: schemaJson.length, tokens: estimateText(schemaJson), names: schemas.map((s) => String(s.name)) };

    const view = blocks.map((b) => b.m);
    const converter = meta.converter === "default" ? { kind: "default" as const, ...convertStats(view) } : { kind: "custom" as const };
    const partList = [...parts.values()];
    const tokens = (system?.tokens ?? 0) + partList.reduce((n, p) => n + p.tokens, 0) + tools.tokens;
    return {
      purpose: meta.purpose,
      ...(meta.attempt === undefined ? {} : { attempt: meta.attempt }),
      ...(meta.stage === undefined ? {} : { stage: meta.stage }),
      system,
      parts: partList,
      messages: view.length,
      tools,
      tokens,
      hooks: meta.hooks,
      converter,
      request: meta.request,
      ...(unresolved === 0 ? {} : { unresolved }),
    };
  }
}

/**
 * 缺省投影做了什么：送出去几条、丢了几条（出错 / 中止的回复、认不出的种类、空回复）、给几个落单的 tool_use 补了结果。
 * 丢没丢按「单独投它一条是不是空」判——与投影自己的规则同一个函数，不另写一份。
 */
function convertStats(view: readonly AgentMessage[]): { outputMessages: number; dropped: number; healedOrphans: number } {
  const out = defaultConvertToLlm([...view]) as ProviderMessage[];
  let dropped = 0;
  const recorded = new Set<string>();
  for (const m of view) {
    if ((defaultConvertToLlm([m]) as ProviderMessage[]).length === 0) {
      dropped += 1;
      continue;
    }
    if (m.role === "toolResult") recorded.add(m.toolCallId);
  }
  let healedOrphans = 0;
  for (const pm of out) {
    if (pm.role !== "user") continue;
    for (const b of pm.content) if (b.type === "tool_result" && !recorded.has(b.tool_use_id)) healedOrphans += 1;
  }
  return { outputMessages: out.length, dropped, healedOrphans };
}
