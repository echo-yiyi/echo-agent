// 决定点上的观测探针，走真实的 createEcho → send → SQLite → reader：
// 工具在执行前被拦下的每一种原因、等人审批的时长、每轮模型能看见的工具、装备变更。
// 这些此前都不在账本里——执行前被拦的调用连 tool.execute 都不发，只能从后面那条 toolResult 的 isError 猜。

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOf, createEcho, type Echo } from "../src/create-echo.ts";
import { openObservationReader } from "../src/index.ts";
import { createProvider } from "../src/provider/models.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { Provider } from "../src/provider/types.ts";
import type { PermissionPolicy } from "../src/permission/types.ts";
import type { ObservationEnvelope } from "../src/observability/types.ts";

const temps: string[] = [];
const running: Echo[] = [];
afterEach(async () => {
  for (const e of running.splice(0)) await e.stop().catch(() => {});
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true });
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

const ping = (ran: { n: number }): ModelTool => ({
  kind: "model",
  name: "ping",
  label: "ping",
  description: "回一个 pong",
  parameters: { type: "object", properties: {} },
  execute: async () => (ran.n++, toolOk("pong")),
});

async function echoWith(opts: { turns: ScriptedTurn[]; tools?: ModelTool[]; permission?: PermissionPolicy; capture?: "metadata" | "content" }): Promise<{ echo: Echo; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "echo-obs-decisions-"));
  temps.push(dir);
  const stateDir = join(dir, "state");
  const echo = await createEcho({
    provider: scripted(opts.turns),
    allowNetwork: false,
    stateDir,
    extensionDirs: [],
    withoutMemory: true,
    agent: { tools: opts.tools ?? [], ...(opts.permission !== undefined ? { permission: opts.permission } : {}) },
    ...(opts.capture !== undefined ? { observation: { capture: opts.capture } } : {}),
  });
  running.push(echo);
  await echo.start();
  return { echo, stateDir };
}

async function recordsOf(echo: Echo, runId: string): Promise<readonly ObservationEnvelope[]> {
  const lookup = await echo.observations.getRun(runId);
  if (lookup.kind !== "found") throw new Error(`run 没读回来：${lookup.kind}`);
  return lookup.observation.records;
}

test("模型点了一个不存在的工具：记 tool.rejected（lookup / not_found），不发 tool.execute", async () => {
  const { echo } = await echoWith({ turns: [toolTurn("c1", "nope", {}), textTurn("ok")], tools: [ping({ n: 0 })] });
  const r = await echo.send("go");
  const records = await recordsOf(echo, r.runId);
  const rejected = records.filter((e) => e.name === "tool.rejected");
  expect(rejected.map((e) => e.attributes)).toEqual([{ toolName: "nope", toolCallId: "c1", stage: "lookup", cause: "not_found" }]);
  expect(rejected[0]!.scope.toolCallId).toBe("c1");
  expect(records.some((e) => e.name === "tool.execute")).toBe(false);
});

test("策略直接拒绝：记 tool.rejected（permission / denied / policy）；原因只在 content 档进 body", async () => {
  const ran = { n: 0 };
  const deny: PermissionPolicy = { authorize: () => ({ kind: "deny", reason: "策略不许：secret-reason" }), askTimeoutMs: 1000 };
  for (const capture of ["metadata", "content"] as const) {
    const { echo } = await echoWith({ turns: [toolTurn("c1", "ping", {}), textTurn("ok")], tools: [ping(ran)], permission: deny, capture });
    const r = await echo.send("go");
    const rejected = (await recordsOf(echo, r.runId)).filter((e) => e.name === "tool.rejected");
    expect(rejected.map((e) => e.attributes)).toEqual([{ toolName: "ping", toolCallId: "c1", stage: "permission", cause: "denied", decidedBy: "policy" }]);
    const body = rejected[0]!.body as Record<string, unknown>;
    if (capture === "metadata") expect(JSON.stringify(body)).not.toContain("secret-reason");
    else expect(body.reason).toBe("策略不许：secret-reason");
  }
  expect(ran.n).toBe(0);
});

test("要人审批且人批准：permission.wait 是一对 span（decision=granted、decidedBy=human），之后才有 tool.execute", async () => {
  const ran = { n: 0 };
  const ask: PermissionPolicy = { authorize: () => ({ kind: "ask", reason: "要人看一眼" }), askTimeoutMs: null, responder: "host" };
  const { echo } = await echoWith({ turns: [toolTurn("c1", "ping", {}), textTurn("ok")], tools: [ping(ran)], permission: ask });
  // 测试在这里扮演宿主：订阅事件协议去回答审批——那是协议的功能用法，观测不经过它
  echo.agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") void echo.agent.answerPermission({ permissionId: e.permissionId, decision: "allow" });
  });
  const r = await echo.send("go");
  expect(ran.n).toBe(1);
  const records = await recordsOf(echo, r.runId);
  const names = records.map((e) => `${e.kind}:${e.name}`);
  const waitStart = names.indexOf("span_start:permission.wait");
  const waitEnd = names.indexOf("span_end:permission.wait");
  const toolStart = names.indexOf("span_start:tool.execute");
  expect(waitStart).toBeGreaterThanOrEqual(0);
  expect(waitEnd).toBeGreaterThan(waitStart);
  expect(toolStart).toBeGreaterThan(waitEnd);
  const end = records[waitEnd]!;
  expect(end.attributes).toMatchObject({ toolName: "ping", toolCallId: "c1", decision: "granted", decidedBy: "human" });
  expect(end.attributes.permissionId).toBe(records[waitStart]!.attributes.permissionId);
  expect(records.some((e) => e.name === "tool.rejected")).toBe(false);
});

test("要人审批且人拒绝：permission.wait（denied / human）+ tool.rejected（permission / denied / human），工具没跑", async () => {
  const ran = { n: 0 };
  const ask: PermissionPolicy = { authorize: () => ({ kind: "ask", reason: "要人看一眼" }), askTimeoutMs: null, responder: "host" };
  const { echo } = await echoWith({ turns: [toolTurn("c1", "ping", {}), textTurn("ok")], tools: [ping(ran)], permission: ask });
  echo.agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") void echo.agent.answerPermission({ permissionId: e.permissionId, decision: "deny", reason: "不行" });
  });
  const r = await echo.send("go");
  expect(ran.n).toBe(0);
  const records = await recordsOf(echo, r.runId);
  expect(records.find((e) => e.kind === "span_end" && e.name === "permission.wait")?.attributes).toMatchObject({ decision: "denied", decidedBy: "human" });
  expect(records.filter((e) => e.name === "tool.rejected").map((e) => e.attributes)).toEqual([
    { toolName: "ping", toolCallId: "c1", stage: "permission", cause: "denied", decidedBy: "human" },
  ]);
  expect(records.some((e) => e.name === "tool.execute")).toBe(false);
});

test("每轮开头记下模型这一轮能看见的工具（工作集）", async () => {
  const { echo } = await echoWith({ turns: [toolTurn("c1", "ping", {}), textTurn("ok")], tools: [ping({ n: 0 })] });
  const r = await echo.send("go");
  const starts = (await recordsOf(echo, r.runId)).filter((e) => e.kind === "span_start" && e.name === "turn.execute");
  expect(starts).toHaveLength(2);
  for (const s of starts) {
    const tools = (s.body as { tools: string[] }).tools;
    expect(tools).toContain("ping");
    expect(s.attributes.toolCount).toBe(tools.length);
  }
});

test("装备变更在 setter 节点上记（run 之外）：思考档从哪档换到哪档", async () => {
  const { echo, stateDir } = await echoWith({ turns: [textTurn("ok")] });
  const before = agentOf(echo).thinkingLevel;
  const next = before === "high" ? "low" : "high";
  agentOf(echo).thinkingLevel = next;
  await echo.send("go");
  await echo.stop();
  // `stop()` 不等观测写完（2026-09-14：观测不在主流程上），写入端可能还没打开过——
  // 离线读之前必须先 flush，否则这一句是竞态：本机快、CI 上慢，实测 CI 连红三天报 ObservationStoreMissingError。
  await echo.observations.flush();
  const reader = await openObservationReader({ stateRoot: stateDir });
  try {
    const changed = [...(await reader.recentActivity({ limit: 500 }))].filter((e) => e.name === "agent.equipment.changed");
    expect(changed.map((e) => e.attributes)).toEqual([{ field: "thinkingLevel", from: before, to: next }]);
  } finally {
    await reader.close();
  }
});

/* ── 输入与执行对得上（2026-11-05，docs/decisions/implemented/2026-11-05-input-lifecycle.md） ── */

test("输入 → 这一轮 → 这一轮的工具调用：turn.execute 记引出它的 inputId；插话收下有一条 agent.input.accepted；被它撤掉的调用记 tool.rejected（start / superseded）", async () => {
  const holder: { echo?: Echo } = {};
  const step = (name: string, then?: () => Promise<unknown>): ModelTool => ({
    kind: "model",
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      await then?.();
      return toolOk(`${name} done`);
    },
  });
  let steerId: string | undefined;
  const turns: ScriptedTurn[] = [
    [
      { type: "start" },
      {
        type: "done",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "c1", name: "a", input: {} },
            { type: "tool_use", id: "c2", name: "b", input: {} },
          ],
          stopReason: "tool_use",
          usage: null,
        },
      },
    ],
    textTurn("好，b 不做了"),
  ];
  const { echo } = await echoWith({
    turns,
    tools: [
      step("a", async () => {
        const r = await holder.echo!.agent.steer("别做 b");
        if (r.kind === "accepted") steerId = r.inputId;
      }),
      step("b"),
    ],
  });
  holder.echo = echo;
  const r = await echo.send("go");
  const promptId = (agentOf(echo).messages[0] as { inputId?: string }).inputId ?? "";
  expect(promptId).toMatch(/^in-/);
  expect(steerId).toMatch(/^in-/);
  const steered = steerId ?? "";

  const records = await recordsOf(echo, r.runId);
  const turnStarts = records.filter((e) => e.kind === "span_start" && e.name === "turn.execute");
  expect(turnStarts.map((e) => (e.body as { inputs: string[] }).inputs)).toEqual([[promptId], [steered]]);
  const firstTurn = turnStarts[0]!.scope.turnId ?? "";
  expect(records.filter((e) => e.name === "agent.input.accepted").map((e) => e.attributes)).toEqual([
    { inputId: steered, channel: "steer", runId: r.runId, turnId: firstTurn },
  ]);
  const rejected = records.filter((e) => e.name === "tool.rejected");
  expect(rejected.map((e) => [e.attributes, e.scope.turnId])).toEqual([[{ toolName: "b", toolCallId: "c2", stage: "start", cause: "superseded" }, turnStarts[0]!.scope.turnId]]);
  // 插话入账那条也带着同一个 inputId
  const appended = records.filter((e) => e.name === "agent.message.appended" && (e.body as { source?: string }).source === "steer");
  expect(appended.map((e) => (e.body as { inputId?: string }).inputId)).toEqual([steered]);
});

test("方言丢掉的工具调用记 tool.call.dropped：哪种丢法、哪个调用、参数多长 metadata 档就记；参数原文只在 content 档", async () => {
  const dropped: ScriptedTurn = [
    { type: "start" },
    { type: "warning", code: "tool_call_dropped", message: "参数不可解析", toolCall: { id: "c9", name: "write", args: '{"path":"a.ts","content":"sec' } },
    { type: "text_start" },
    { type: "text_delta", text: "写不了" },
    { type: "text_end" },
    { type: "done", message: { role: "assistant", content: [{ type: "text", text: "写不了" }], stopReason: "end_turn", usage: null } },
  ];
  for (const capture of ["metadata", "content"] as const) {
    const { echo } = await echoWith({ turns: [dropped], capture });
    const r = await echo.send("go");
    const rec = (await recordsOf(echo, r.runId)).filter((e) => e.name === "tool.call.dropped");
    expect(rec.map((e) => [e.attributes, e.scope.toolCallId])).toEqual([[{ code: "tool_call_dropped", argsChars: 29, toolName: "write", toolCallId: "c9" }, "c9"]]);
    expect((rec[0]!.body as { args?: string }).args).toBe(capture === "content" ? '{"path":"a.ts","content":"sec' : undefined);
  }
});
