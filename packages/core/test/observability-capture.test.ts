import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolError, toolOk, type ModelTool } from "../src/tools/types.ts";
import type { Provider } from "../src/provider/types.ts";
import type { ObservationCapturePolicy, RunObservation } from "../src/observability/types.ts";

// `createEcho({ observation: { capture } })`（2026-09-04 用户拍板）：采集档从写死的 metadata 变成调用方的选择。
// 判据：content 档下 tool.execute 的 span_start 带 params、span_end 带结果正文 / 报错正文，model.generate 的 span_end 带回复文本，
// 且 token 级 delta 逐条成记录；metadata 档（缺省）这些正文字段一律不存在；off 档只剩 run 边界。

const temps: string[] = [];
const running: Echo[] = [];

afterEach(async () => {
  for (const echo of running.splice(0)) await echo.stop().catch(() => {});
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

function scripted(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

const search: ModelTool = {
  kind: "model",
  name: "search_docs",
  label: "search_docs",
  description: "找工具",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  execute: async (params) => ((params as { query: string }).query === "miss" ? toolError("No deferred tool matches. Deferred tools: (none)") : toolOk("web_fetch")),
};

async function runWith(capture: ObservationCapturePolicy | undefined, turns: ScriptedTurn[]): Promise<RunObservation> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-capture-"));
  temps.push(dir);
  const echo = await createEcho({
    provider: scripted(turns),
    allowNetwork: false,
    stateDir: join(dir, "state"),
    extensionDirs: [],
    withoutMemory: true,
    agent: { tools: [search] },
    ...(capture !== undefined ? { observation: { capture } } : {}),
  });
  running.push(echo);
  await echo.agent.start();
  const result = await echo.send("找一下");
  expect(result.observationPersistence).toBe("stored");
  const lookup = await echo.observations.getRun(result.runId);
  if (lookup.kind !== "found") throw new Error(`run 没找到：${lookup.kind}`);
  return lookup.observation;
}

const TURNS: ScriptedTurn[] = [toolTurn("c1", "search_docs", { query: "miss" }), toolTurn("c2", "search_docs", { query: "fetch" }), textTurn("找到 web_fetch。")];

test("content：工具 params、结果正文、报错正文与模型回复都在记录里，delta 逐条成记录", async () => {
  const o = await runWith("content", TURNS);
  expect(o.capturePolicy).toBe("content");
  const starts = o.records.filter((r) => r.kind === "span_start" && r.name === "tool.execute");
  expect(starts.map((r) => (r.body as { params: unknown }).params)).toEqual([{ query: "miss" }, { query: "fetch" }]);
  const ends = o.records.filter((r) => r.kind === "span_end" && r.name === "tool.execute").map((r) => r.body as { isError: boolean; content: string });
  expect(ends).toHaveLength(2);
  expect(ends[0]).toMatchObject({ isError: true, content: "No deferred tool matches. Deferred tools: (none)" });
  expect(ends[1]).toMatchObject({ isError: false, content: "web_fetch" });
  const generate = o.records.filter((r) => r.kind === "span_end" && r.name === "model.generate").map((r) => r.body as { text: string; toolUseBlocks?: unknown[] });
  expect(generate.at(-1)?.text).toBe("找到 web_fetch。");
  expect(generate[0]?.toolUseBlocks).toEqual([expect.objectContaining({ name: "search_docs" })]);
  expect(o.records.some((r) => r.name === "model.generate.delta")).toBe(true);
});

test("metadata（缺省）：同一段跑法没有任何正文字段，只有形状与计数", async () => {
  const o = await runWith(undefined, TURNS);
  expect(o.capturePolicy).toBe("metadata");
  const bodies = o.records.filter((r) => r.name === "tool.execute" || r.name === "model.generate").map((r) => r.body as Record<string, unknown>);
  expect(bodies.length).toBeGreaterThan(0);
  for (const b of bodies) {
    expect(b).not.toHaveProperty("params");
    expect(b).not.toHaveProperty("content");
    expect(b).not.toHaveProperty("text");
    expect(b).not.toHaveProperty("toolUseBlocks");
  }
  expect(o.records.filter((r) => r.kind === "span_end" && r.name === "tool.execute").map((r) => (r.body as { resultChars: number }).resultChars)).toEqual([48, 9]);
  expect(o.records.some((r) => r.name === "model.generate.delta")).toBe(false);
});

test("off：只剩 run 边界，agent 事件与工具一条都不投影", async () => {
  const o = await runWith("off", TURNS);
  expect(o.capturePolicy).toBe("off");
  expect(o.records.every((r) => r.name.startsWith("run."))).toBe(true);
  expect(o.summary.tools).toEqual([]);
});
