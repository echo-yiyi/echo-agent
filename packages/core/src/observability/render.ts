// 固定渲染结构：`buildRunObservationViewModel()` 与 `renderRunObservation()` 都是**纯函数**——
// 不读 Agent、不查 store、不看当前 exporter / subscriber 状态，也不改原 envelope。同一 record、同一 rendererVersion
// 必然同一输出；golden 锁层级、相对顺序与 redaction，不锁 wall clock / 随机 ID（时间全部相对 acceptedAt）。
//
// 六块：Run 头 / Agent&Session / Assembly&Extensions / Timeline / Final State / Tool Analysis / Observation Health。
// `capturePolicy:"off"` 的空领域字段显示 **not captured by policy**；`finalSnapshot=null` 且有 `run.final_snapshot`
// 的 `capture_limit` gap 显示 **snapshot omitted by capture limit**——两种「空」各有各的文案，不借用。

import { canonicalJson } from "./normalize.ts";
import { pairSpans } from "./materialize.ts";
import type {
  ObservationEnvelope,
  ObservationValue,
  RenderRunObservationOptions,
  RenderedRunObservation,
  RunObservation,
  RunObservationTimelineItem,
  RunObservationViewModel,
} from "./types.ts";

/** renderer 版本：同一 record、同一版本必然同一输出；输出结构变了才 bump。 */
export const RENDERER_VERSION = 1;
const DEFAULT_MAX_TIMELINE = 500;
const LABEL_WIDTH = 20;

/**
 * 结构深度，按四层循环（`docs/design/run-loop-layers.md`：run ⊃ reply ⊃ turn ⊃ attempt）：
 * run 边界 0；reply 与没有 turn 归属的 agent 级事件 1；turn 2；attempt 3；turn 里的 model / tool / 消息 3。
 *
 * model / tool 与 attempt 同层而不是更深：工具批发生在 `attempt_end{landed}` 之后、同一 turn 内，
 * 它们是 turn 的孩子而不是 attempt 的；模型生成确实在 attempt 里，但为它单开第五层只会让缩进吃掉宽度，
 * 而 attempt 行在页面上单次尝试时本来就折起。
 */
const LAYER_DEPTH: Readonly<Record<string, number>> = { "reply.execute": 1, "turn.execute": 2, "attempt.execute": 3 };
function depthOf(env: ObservationEnvelope): number {
  if (env.name.startsWith("run.") || env.name === "observation.gap") return 0;
  const layer = LAYER_DEPTH[env.name];
  if (layer !== undefined) return layer;
  return env.scope.turnId === undefined ? 1 : 3;
}

function finalStateAbsence(o: RunObservation): RunObservationViewModel["finalStateAbsence"] {
  if (o.finalSnapshot !== null) return "captured";
  if (o.capturePolicy === "off") return "not-captured-by-policy";
  if (o.records.some((r) => r.name === "observation.gap" && r.subject?.id === "run.final_snapshot")) return "omitted-by-capture-limit";
  return "not-closed";
}

/** RunObservation → ViewModel。确定性；`includeBody` 之类的展示选项不在这里，ViewModel 永远带 body。 */
export function buildRunObservationViewModel(observation: RunObservation): RunObservationViewModel {
  const spans = pairSpans(observation.records);
  const timeline: RunObservationTimelineItem[] = observation.records.map((env) => {
    const pair = spans.get(env.seq);
    return {
      seq: env.seq,
      relativeMs: env.occurredAt - observation.acceptedAt,
      kind: env.kind,
      name: env.name,
      depth: depthOf(env),
      ...(pair === undefined ? {} : { durationMs: pair.durationMs }),
      attributes: env.attributes,
      body: env.body,
    };
  });
  return {
    schemaVersion: 1,
    rendererVersion: RENDERER_VERSION,
    header: {
      schemaVersion: 1,
      runId: observation.runId,
      ...(observation.submissionId === undefined ? {} : { submissionId: observation.submissionId }),
      source: observation.source,
      runtimeId: observation.runtimeId,
      agentId: observation.agentId,
      agentInstanceId: observation.agentInstanceId,
      sessionId: observation.sessionId,
      runtimeGeneration: observation.runtimeGeneration,
      capturePolicy: observation.capturePolicy,
      acceptedAt: observation.acceptedAt,
      startedAt: observation.startedAt,
      endedAt: observation.endedAt,
      status: observation.status,
      integrity: observation.integrity,
      persistence: observation.persistence,
    },
    identity: {
      agentId: observation.agentId,
      agentInstanceId: observation.agentInstanceId,
      sessionId: observation.sessionId,
      runtimeGeneration: observation.runtimeGeneration,
      assemblyDigest: observation.agentAssembly.digest,
      activeEntries: observation.activeEntries,
    },
    assembly: observation.agentAssembly,
    modelBinding: observation.modelBinding,
    outcome: observation.outcome,
    timeline,
    finalState: observation.finalSnapshot?.state ?? null,
    finalStateAbsence: finalStateAbsence(observation),
    summary: observation.summary,
    health: {
      canonicalGaps: observation.gaps,
      persistence: observation.persistence,
      // metadata / off 都经过采集边界的投影与 redaction；只有 content 才可能带原文
      redacted: observation.capturePolicy !== "content",
    },
  };
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  if (Math.abs(ms) < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

function label(s: string): string {
  return s.length >= LABEL_WIDTH ? `${s} ` : s.padEnd(LABEL_WIDTH);
}

function short(digest: string): string {
  return digest.length > 12 ? digest.slice(0, 12) : digest;
}

function attrsOf(item: RunObservationTimelineItem): string {
  const parts: string[] = [];
  for (const key of Object.keys(item.attributes).sort()) {
    const v = item.attributes[key];
    if (v === undefined) continue;
    parts.push(`${key}=${typeof v === "string" ? v : String(v)}`);
  }
  return parts.join(" ");
}

function renderText(vm: RunObservationViewModel, options: RenderRunObservationOptions): string {
  const h = vm.header;
  const lines: string[] = [];
  // 没封口的 run 不说 running：离线读者只知道没有终态记录，不知道进程还在不在（2026-09-06）
  const duration = h.endedAt === null ? "no terminal record" : fmtMs(h.endedAt - h.acceptedAt);
  lines.push(`Run ${h.runId} · ${h.status} · observation ${h.integrity} · ${duration}`);
  lines.push(`${label("Agent/Session")}agent ${h.agentId} · instance ${h.agentInstanceId} · session ${h.sessionId ?? "none"} · generation ${h.runtimeGeneration} · capture ${h.capturePolicy}`);
  lines.push(`${label("Assembly/Extensions")}assembly ${short(vm.assembly.digest)} · model ${vm.modelBinding.providerId}/${vm.modelBinding.modelId} (catalog ${vm.modelBinding.catalogRevision})`);
  if (vm.assembly.slots.length === 0) {
    lines.push(`${label("")}${vm.assembly.digest === "not-captured" ? "assembly not captured" : "no builtin slots"}`);
  }
  for (const slot of vm.assembly.slots) lines.push(`${label("")}${slot.slot} ← ${slot.entryId}@${slot.entryGeneration}`);
  if (vm.identity.activeEntries.length === 0) lines.push(`${label("")}active entries: not captured (O2b)`);

  lines.push("Timeline");
  const max = Math.max(1, Math.floor(options.maxTimelineRecords ?? DEFAULT_MAX_TIMELINE));
  const shown = vm.timeline.slice(0, max);
  for (const item of shown) {
    const t = `+${fmtMs(item.relativeMs)}`.padEnd(10);
    const indent = "  ".repeat(item.depth);
    const dur = item.durationMs === undefined ? "" : ` ${fmtMs(item.durationMs)}`;
    const attrs = attrsOf(item);
    lines.push(`  ${t}${indent}${item.name}${item.kind === "span_start" ? " …" : ""}${dur}${attrs.length > 0 ? `  ${attrs}` : ""}`);
    if (options.includeBody === true && item.body !== undefined) lines.push(`  ${"".padEnd(10)}${indent}  body ${canonicalJson(item.body)}`);
  }
  if (vm.timeline.length > shown.length) lines.push(`  … ${vm.timeline.length - shown.length} more records`);

  const fs = vm.finalState;
  const finalLine =
    fs !== null
      ? `status ${fs.agent.status} · iteration ${fs.agent.iteration} · messages ${fs.agent.messageCount} · runtime ${fs.runtime.phase}/${fs.runtime.status} · capabilities ${fs.capabilities.length}${fs.omittedCapabilitySummaryCount > 0 ? ` (+${fs.omittedCapabilitySummaryCount} omitted)` : ""}`
      : vm.finalStateAbsence === "not-captured-by-policy"
        ? "not captured by policy"
        : vm.finalStateAbsence === "omitted-by-capture-limit"
          ? "snapshot omitted by capture limit"
          : "not closed";
  lines.push(`${label("Final State")}${finalLine}`);
  const outcome = vm.outcome;
  lines.push(`${label("Outcome")}${outcome === null ? "not closed" : `${outcome.status}${outcome.finishReason === undefined ? "" : ` (${outcome.finishReason})`}${outcome.error === undefined ? "" : ` error ${outcome.error.code ?? outcome.error.name}`}`}`);

  const tools = vm.summary.tools;
  if (tools.length === 0) {
    lines.push(`${label("Tool Analysis")}${h.capturePolicy === "off" ? "not captured by policy" : "no tool calls recorded"}`);
  } else {
    tools.forEach((t, i) => {
      lines.push(
        `${label(i === 0 ? "Tool Analysis" : "")}${t.toolId} calls=${t.calls} ok=${t.successes} err=${t.errors} denied=${t.denied} total=${fmtMs(t.totalDurationMs)} args=${t.argsBytes}B result=${t.resultBytes}ch`,
      );
    });
  }
  const m = vm.summary.model;
  lines.push(`${label("Model")}calls=${m.calls} in=${m.inputTokens} out=${m.outputTokens} total=${fmtMs(m.totalDurationMs)}`);

  const gaps = vm.health.canonicalGaps;
  const gapText = gaps.length === 0 ? "gaps 0" : `gaps ${gaps.length} [${gaps.map((g) => `${g.reason}(${g.afterSeq},${g.beforeSeq})`).join(" ")}]`;
  lines.push(`${label("Observation Health")}integrity ${h.integrity} · ${gapText} · persistence ${vm.health.persistence} · redacted ${vm.health.redacted ? "yes" : "no"} · records ${vm.summary.recordCount}`);
  return `${lines.join("\n")}\n`;
}

/** text / json 两种固定格式；json 是 ViewModel 的 canonical JSON。 */
export function renderRunObservation(observation: RunObservation, options: RenderRunObservationOptions): RenderedRunObservation {
  const vm = buildRunObservationViewModel(observation);
  if (options.format === "json") {
    return { rendererVersion: RENDERER_VERSION, format: "json", mediaType: "application/json", content: canonicalJson(vm as unknown as ObservationValue) };
  }
  return { rendererVersion: RENDERER_VERSION, format: "text", mediaType: "text/plain", content: renderText(vm, options) };
}
