// `observe show <run-id> --context` / `observe last --context`：一个 run 里「送进模型的是什么」，人读文本。
//
// 只看两种记录（观测白盒化 A）：`prompt.assembled`（这个 run 的 system 由哪些段拼成）与 `context.built`
// （每次调模型送进去的构成）。`content` 档的 run 再把原文读出来（blob，`readContextContent`）：system 原文、
// 投影之前的每条消息、工具名单。system 同一份只印一次。

import { readContextContent, type ContextBuiltContent, type ObservationBlobRef, type ObservationEnvelope } from "@echo-agent/core/observability";
import type { RunObservation } from "@echo-agent/core";

type Part = Readonly<{ kind: string; source?: string; count: number; chars: number; images: number; tokens: number }>;
type ContextBody = Readonly<{
  purpose: "turn" | "compaction";
  attempt?: number;
  stage?: string;
  system: Readonly<{ chars: number; tokens: number }> | null;
  parts: readonly Part[];
  messages: number;
  tools: Readonly<{ count: number; schemaChars: number; tokens: number; names: readonly string[] }>;
  tokens: number;
  hooks: Readonly<{ transformContext?: string; contextBeforeBuild?: string }>;
  converter: Readonly<{ kind: string; outputMessages?: number; dropped?: number; healedOrphans?: number }>;
  request: Readonly<{ model: string; thinkingLevel: string | null; maxOutputTokens: number | null }>;
  unresolved?: number;
  content?: ContextBuiltContent;
}>;
type PromptBody = Readonly<{
  sections: readonly Readonly<{ name: string; order: number; owner: string | null; status: string; chars: number }>[];
  variables: readonly string[];
  chars: number;
  text?: ObservationBlobRef;
}>;

const ROLE_ZH: Readonly<Record<string, string>> = { "user/human": "用户", "user/steer": "用户插话", "user/harness": "系统插话", user: "用户", assistant: "模型", toolResult: "工具结果", environment: "环境" };
const roleZh = (s: string | undefined): string => (s === undefined ? "" : (ROLE_ZH[s] ?? s));

function partLabel(p: Part): string {
  switch (p.kind) {
    case "transcript":
      return `历史 · ${roleZh(p.source)}`;
    case "summary":
      return "压缩摘要";
    case "omitted":
      return "压缩省略";
    case "cleared_placeholder":
      return "清掉的工具结果";
    case "injection":
      return `注入 · ${p.source ?? ""}`;
    default:
      return `消息 · ${roleZh(p.source)}`;
  }
}

const num = (n: number): string => n.toLocaleString("en-US");

/** 终端里的显示宽度：中日韩字符与全角符号占两格（`padEnd` 按 code unit 数，中文标签会把后面的列挤歪）。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}
const padDisplay = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - displayWidth(s)));

/** 一行构成：标签左对齐、条数、数值右对齐、占比。 */
function row(label: string, count: number | undefined, value: number, unit: string, total: number): string {
  const pct = total > 0 ? (100 * value) / total : 0;
  const share = pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
  return `  ${padDisplay(label, 20)} ${(count === undefined ? "" : `×${count}`).padStart(6)} ${`${num(value)}${unit}`.padStart(14)}  ${share.padStart(4)}`;
}

/** 一条消息排成人读的字：正文、思考、工具调用参数、图片占位。 */
function messageText(m: Record<string, unknown>): string {
  if (m.role === "toolResult") {
    const images = Array.isArray(m.images) ? m.images.length : 0;
    return `${String(m.content)}${images > 0 ? `\n〔${images} 张图〕` : ""}`;
  }
  if (!Array.isArray(m.content)) return JSON.stringify(m, null, 2);
  return (m.content as Record<string, unknown>[])
    .map((b) => {
      if (b.type === "text") return String(b.text);
      if (b.type === "thinking") return `〔思考〕${String(b.thinking)}`;
      if (b.type === "tool_use") return `〔调用 ${String(b.name)}〕${JSON.stringify(b.input)}`;
      if (b.type === "image") return "〔图片〕";
      return `〔${String(b.type)}〕`;
    })
    .join("\n");
}

function messageLabel(m: Record<string, unknown>, i: number): string {
  const who =
    m.role === "user"
      ? roleZh(`user/${String(m.source)}`)
      : m.role === "environment"
        ? `环境 · ${String(m.source)}${typeof m.ref === "string" ? ` ${m.ref}` : ""}`
        : m.role === "toolResult"
          ? `工具结果 · ${String(m.toolName)}${m.isError === true ? "（出错）" : ""}`
          : roleZh(String(m.role));
  return `#${i + 1} ${who}`;
}

/** 拼好的 system 按段切开（段之间一个空行，空段与失败段不占字）；对不上返回 null。 */
function splitPrompt(text: string, sections: PromptBody["sections"]): { name: string; part: string }[] | null {
  const rendered = sections.filter((s) => s.status === "rendered");
  const sum = rendered.reduce((n, s) => n + s.chars, 0) + Math.max(0, rendered.length - 1) * 2;
  if (sum !== text.length) return null;
  let at = 0;
  return rendered.map((s) => {
    const part = text.slice(at, at + s.chars);
    at += s.chars + 2;
    return { name: s.name, part };
  });
}

function promptBlock(rec: ObservationEnvelope): string[] {
  const b = rec.body as PromptBody;
  const lines = [`system 组装 · ${b.sections.length} 段 · ${num(b.chars)} 字（按 order 从上到下）`];
  for (const s of b.sections) {
    const size = s.status === "rendered" ? `${num(s.chars)} 字` : s.status === "empty" ? "空" : "失败";
    lines.push(`  ${padDisplay(s.name, 22)} ${padDisplay(s.owner ?? "（未登记）", 22)} ${size.padStart(10)}`);
  }
  if (b.variables.length > 0) lines.push(`  用到的变量：${b.variables.map((v) => `{{${v}}}`).join(" ")}`);
  return lines;
}

function contextBlock(rec: ObservationEnvelope, index: number): string[] {
  const b = rec.body as ContextBody;
  const what = b.purpose === "compaction" ? `压缩阶段 ${b.stage ?? ""} 的调用 · 第 ${b.attempt ?? 1} 次` : `turn ${rec.scope.turnId ?? "?"} · 第 ${b.attempt ?? 1} 次`;
  const lines = [`── 调模型 #${index} · ${what} · 估算 ${num(b.tokens)} tokens · ${b.messages} 条消息 ──`];
  if (b.system !== null) lines.push(row("system", undefined, b.system.tokens, " tok", b.tokens));
  if (b.tools.count > 0) lines.push(row("工具菜单", b.tools.count, b.tools.tokens, " tok", b.tokens));
  for (const p of b.parts) lines.push(row(partLabel(p), p.count, p.tokens, " tok", b.tokens));
  lines.push(`  模型 ${b.request.model} · 思考 ${b.request.thinkingLevel ?? "未设"} · 输出上限 ${b.request.maxOutputTokens ?? "未标"}`);
  const notes: string[] = [];
  if (b.hooks.transformContext === "replaced") notes.push("transformContext 换了整份视图");
  if (b.hooks.contextBeforeBuild === "patched") notes.push("contextBeforeBuild 改了消息");
  if (b.converter.kind === "custom") notes.push("自定义 convertToLlm（增删不记）");
  else {
    const c = b.converter;
    notes.push(`投影送出 ${c.outputMessages ?? "?"} 条${c.dropped ? ` · 丢 ${c.dropped} 条` : ""}${c.healedOrphans ? ` · 补了 ${c.healedOrphans} 个落单的工具结果` : ""}`);
  }
  if (b.unresolved !== undefined) notes.push(`${b.unresolved} 条交接时丢了，没算进构成`);
  lines.push(`  ${notes.join("；")}`);
  return lines;
}

/**
 * 一个 run 的「送进模型的是什么」。`read` 取正文（`SessionObservationReaders.readBlob` 绑好这个 run）；
 * 不是 `content` 档的 run 只有构成，末尾说一句原文在哪一档才有。
 */
export async function renderRunContext(observation: RunObservation, read: (ref: ObservationBlobRef) => Promise<string | null>): Promise<string> {
  const out: string[] = [];
  const h = observation;
  out.push(`${h.runId} · 送进模型的是什么 · 档 ${h.capturePolicy}`);
  const shownSystems = new Map<string, number>();
  let calls = 0;
  let anyContent = false;
  for (const rec of observation.records) {
    if (rec.name === "prompt.assembled") {
      out.push("", ...promptBlock(rec));
      const ref = (rec.body as PromptBody).text;
      if (ref !== undefined) {
        anyContent = true;
        const text = await read(ref);
        if (text === null) out.push("  （原文已不在：被过期清扫或手动删掉了）");
        else {
          const parts = splitPrompt(text, (rec.body as PromptBody).sections);
          for (const p of parts ?? [{ name: "system", part: text }]) out.push("", `  ┌ ${p.name}`, indent(p.part));
          shownSystems.set(ref.digest, 0);
        }
      }
      continue;
    }
    if (rec.name !== "context.built") continue;
    calls += 1;
    out.push("", ...contextBlock(rec, calls));
    const content = (rec.body as ContextBody).content;
    if (content === undefined) continue;
    anyContent = true;
    const restored = await readContextContent(read, content);
    if (restored === null) {
      out.push("  （原文已不在：被过期清扫或手动删掉了）");
      continue;
    }
    if (restored.systemPrompt !== null && content.system !== null) {
      const seen = shownSystems.get(content.system.digest);
      if (seen === undefined) {
        out.push("", `  ┌ system（${num(restored.systemPrompt.length)} 字）`, indent(restored.systemPrompt));
        shownSystems.set(content.system.digest, calls);
      } else out.push(`  system：${seen === 0 ? "同上面拼好的那一份" : `同调模型 #${seen}`}`);
    }
    restored.view.forEach((m, i) => {
      out.push("", `  ┌ ${messageLabel(m as unknown as Record<string, unknown>, i)}`, indent(messageText(m as unknown as Record<string, unknown>)));
    });
    const names = restored.tools.map((t) => String((t as { name?: unknown }).name));
    out.push("", `  工具：${names.length === 0 ? "（无）" : names.join(", ")}`);
  }
  if (calls === 0) out.push("", "这个 run 没有调模型的记录（off 档不记，或 run 在调模型之前就结束了）。");
  else if (!anyContent) out.push("", "原文只在 content 档记：用 --observe content 跑，这里就能看到送进去的每一个字。");
  return `${out.join("\n")}\n`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  │ ${l}`)
    .join("\n");
}
