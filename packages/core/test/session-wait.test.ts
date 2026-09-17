// `session_send` 的 `wait` 与消息抬头：走真装配（`createEcho`）、真盘、两段会话同进程。
// 要证明的是整条链——A 的工具发出去、B 的模型看得见是谁发的与这条的 id、B 带 reply_to 回信、
// A 的工具等到并交回、那封回信之后**不再**以普通消息进 A 的对话（A 是开着自动消费的托管 Agent）。
// 只测 `EchoSessions` 或只测 `watchInbox` 都证明不了中间那几步有一步真的发生。

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEcho, type Echo } from "../src/create-echo.ts";
import { defaultConvertToLlm, type AgentMessage } from "../src/messages.ts";
import { createProviderStreams } from "../src/provider/dialect.ts";
import { createProvider } from "../src/provider/models.ts";
import type { Provider } from "../src/provider/types.ts";
import { scriptedDialect, textTurn, toolTurn, type ScriptedTurn } from "../src/testing.ts";

const temps: string[] = [];
const running: Echo[] = [];
afterEach(async () => {
  for (const echo of running.splice(0)) await echo.stop().catch(() => {});
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function scripted(turns: ScriptedTurn[]): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    api: createProviderStreams(scriptedDialect(turns)),
  });
}

async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等不到：${what}`);
}

const textOf = (m: AgentMessage): string =>
  "content" in m ? (typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")) : "";

async function session(sessionsRoot: string, turns: ScriptedTurn[]): Promise<Echo> {
  const echo = await createEcho({
    provider: scripted(turns),
    sessionsRoot,
    allowNetwork: false,
    withoutMemory: true,
    extensionDirs: [],
    sessions: {}, // 开会话面（没给 runner：两段都已经在跑，不需要叫醒）
  });
  running.push(echo);
  await echo.start();
  return echo;
}

test("A wait 发给 B：B 看得见抬头、带 reply_to 回信，A 的工具直接拿到回信，之后不再以普通消息出现", async () => {
  process.env["ECHO_HOME"] = tmp("echo-home-wait-");
  const root = tmp("echo-sessions-wait-");

  const b = await session(root, [textTurn("B 收到了")]);
  const bId = b.agent.state.sessionId!;
  const a = await session(root, [toolTurn("c1", "session_send", { to: bId, message: "问个事：答案是多少", wait: true, timeout_seconds: 20 }), textTurn("A 拿到答案了")]);
  const aId = a.agent.state.sessionId!;

  const runA = a.agent.prompt("去问 B");

  // ① B 那边：消息带抬头，说清发件段与这条的 id——没有它 B 的模型不知道回给谁
  await until(() => b.agent.state.messages.some((m) => m.role === "environment" && textOf(m).includes("问个事")), "B 收到 A 的消息");
  const received = b.agent.state.messages.find((m) => m.role === "environment" && textOf(m).includes("问个事"))!;
  const header = textOf(received).split("\n")[0]!;
  expect(header).toStartWith(`[from session ${aId} · message ${aId}:`);
  const messageId = /message (\S+?)\]/.exec(header)![1]!;
  // 抬头在正文里，模型看得见；`source` / `ref` / `replyTo` 这些账本字段照旧不出门
  const projected = JSON.stringify(await defaultConvertToLlm([received]));
  expect(projected).toContain(`message ${messageId}`);
  expect(projected).not.toContain('"ref"');

  // ② B 回信（测试替 B 的模型做它会做的事：照抬头填 to 与 reply_to）
  const replied = await b.sessions.send(aId, "答案是 42", { replyTo: messageId });
  expect(replied.kind).toBe("accepted");

  // ③ A 的工具等到了，回信原样交回（带它自己的抬头，里面点名回的是哪一条）
  await runA;
  const toolResult = a.agent.state.messages.find((m) => m.role === "toolResult");
  expect(toolResult !== undefined && textOf(toolResult)).toContain("答案是 42");
  expect(toolResult !== undefined && textOf(toolResult)).toContain(`reply to ${messageId}`);

  // ④ 不二次投递：A 开着自动消费、每秒刷一次盘，多等两拍，回信也不会再以普通消息进来
  await new Promise((r) => setTimeout(r, 2_500));
  expect(a.agent.state.messages.filter((m) => m.role === "environment" && textOf(m).includes("答案是 42"))).toHaveLength(0);
}, 20_000);
