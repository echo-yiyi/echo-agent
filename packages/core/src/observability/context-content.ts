// 一次送模的正文：`context.built` 在 `content` 档带的引用，与凭它们还原的那一份（观测白盒化 §4）。
//
// 纯（不碰 `node:` / `bun:`）：从 `@echo-agent/core/observability` 导出，面板与 `observe show --context` 用它。
// 写的那一半在观测线程（context-mirror-host.ts 的 `ContextMirrorStore.resolve`）。

import { expandBlobRefs } from "./blobs.ts";
import type { AgentMessage } from "../messages.ts";
import type { ObservationBlobRef } from "./types.ts";

/**
 * `context.built` 在 `content` 档带的正文引用：
 *   · `system`：system prompt（`text/plain`；没有 system 或镜像里找不到为 null）；
 *   · `view`：送进投影之前的视图，一个引用列表（逐层展开后每片是一条 `AgentMessage` 的 JSON）；
 *   · `tools`：送模的工具 schema 数组（`toolSchemas` 的输出，JSON）。
 */
export type ContextBuiltContent = Readonly<{ system: ObservationBlobRef | null; view: ObservationBlobRef; tools: ObservationBlobRef }>;

/** 凭 `ContextBuiltContent` 还原的那次送模：system 原文、投影之前的视图、工具 schema。 */
export type ContextContent = Readonly<{ systemPrompt: string | null; view: AgentMessage[]; tools: unknown[] }>;

/**
 * 凭 `content` 引用把那次送进模型的东西还原出来：system 原文、投影之前的视图（再过一遍 `defaultConvertToLlm` 就是线上的
 * messages）、工具 schema。`read` 是 reader 的 `readBlob`；哪一份正文已经不在（过期清扫 / 手动删了）返回 null。
 */
export async function readContextContent(read: (ref: ObservationBlobRef) => Promise<string | null>, content: ContextBuiltContent): Promise<ContextContent | null> {
  const systemPrompt = content.system === null ? null : await read(content.system);
  if (content.system !== null && systemPrompt === null) return null;
  const leaves = await expandBlobRefs(read, content.view);
  if (leaves === null) return null;
  const view: AgentMessage[] = [];
  for (const ref of leaves) {
    const text = await read(ref);
    if (text === null) return null;
    view.push(JSON.parse(text) as AgentMessage);
  }
  const toolsText = await read(content.tools);
  if (toolsText === null) return null;
  return { systemPrompt, view, tools: JSON.parse(toolsText) as unknown[] };
}
