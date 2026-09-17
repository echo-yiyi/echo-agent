// 等在自己的 inbox 上（`inbox.watch` / `session_send` 的 `wait`）。判据：
// `docs/decisions/implemented/2026-09-03-sessions-are-peers.md` 的验收——命中即消费（作为结果返回、
// 不再以 environment 消息二次投递）、超时不消费（之后到的恰好出现一次）、at-least-once 不破。

import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { InboxStore } from "../src/inbox/store.ts";
import { canonicalizeMessage } from "../src/inbox/records.ts";
import type { InboxWatchResult } from "../src/inbox/watch.ts";
import { environmentMessage, type AgentMessage } from "../src/messages.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { registerTool } from "../src/tools/harness.ts";
import { toolOk, type AgentTool } from "../src/tools/types.ts";

async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等不到：${what}`);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function envReply(text: string, ref: string, replyTo?: string): AgentMessage {
  const m = environmentMessage(text, "session", ref);
  if (replyTo !== undefined && m.role === "environment") m.replyTo = replyTo;
  return m;
}

function textOf(m: AgentMessage): string {
  return "content" in m && Array.isArray(m.content) ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
}

const inboxOf = (agent: Agent): InboxStore => agent["inbox"];
const envTexts = (agent: Agent): string[] => agent.messages.filter((m) => m.role === "environment").map(textOf);

test("afterRun 在 inbox 触发的 run 里登记，收尾时同样排空——不只用户 run 才排", async () => {
  // 被别的会话叫醒的段（--serve 宿主）跑的全是 inbox run。只在用户 run 收尾排空的话，
  // 这种段里登记的收尾活（wait 命中后的 ack、模型触发的热部署）永远不会执行。
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([toolTurn("c1", "later", {}), textTurn("好")]) });
  const drained: string[] = [];
  const later: AgentTool = {
    kind: "model",
    name: "later",
    label: "later",
    description: "登记一件收尾后做的事",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      agent.afterRun(async () => {
        drained.push("ran");
      });
      return toolOk("ok");
    },
  };
  void registerTool(agent.tools, later);

  agent.deliver(environmentMessage("外面来了一件事", "test", "r1"));
  await until(() => inboxOf(agent).pendingCount === 1, "投递进 inbox");
  await agent.consumeInbox();
  await until(() => drained.length === 1, "inbox run 收尾后排空 afterRun");
});

/* ─────────────── 账本层：只摘匹配的那条，没 ack 就崩则重放 ─────────────── */

test("reserveMatching 只摘第一条匹配的，其余 pending 原样原序；没 ack 就崩，重启照样重放——at-least-once", async () => {
  const dir = new InMemoryDir();
  const a = new InboxStore(dir);
  await a.restore();
  await a.accept({ message: envReply("别的事一", "p:1"), dedupeKey: "k1" });
  await a.accept({ message: envReply("回信", "p:2", "me:1"), dedupeKey: "k2" });
  await a.accept({ message: envReply("别的事二", "p:3"), dedupeKey: "k3" });

  const hit = a.reserveMatching((m) => m.role === "environment" && m.replyTo === "me:1");
  expect(hit?.messages.map(textOf)).toEqual(["回信"]);

  // 崩在 ack 之前：盘上没有 marker，新进程 restore 三条都在
  expect((await new InboxStore(dir).restore()).map((r) => textOf(r.message)).sort()).toEqual(["别的事一", "别的事二", "回信"]);

  // 摘走的那条不在 pending 里了，整批消费拿不到它；其余两条顺序不变
  expect(a.reserveBatch()?.messages.map(textOf)).toEqual(["别的事一", "别的事二"]);

  // ack 之后再起：那条没了
  await a.ackBatch(hit!.reservationId);
  expect((await new InboxStore(dir).restore()).map((r) => textOf(r.message)).sort()).toEqual(["别的事一", "别的事二"]);
});

test("replyTo 给了就得是字符串：形状不对的回信永远匹配不上，落盘前判红", () => {
  const good = envReply("回信", "p:1", "me:1");
  expect(() => canonicalizeMessage(good, "投递")).not.toThrow();
  expect(() => canonicalizeMessage({ ...good, replyTo: 42 }, "投递")).toThrow(/replyTo/);
});

/* ─────────────── Agent 层：在 run 里等 ─────────────── */

type Waiter = { agent: Agent; clock: FakeClock; started: () => boolean; result: () => InboxWatchResult | undefined; abort: AbortController };

/** 一个会在工具里等回信的 Agent：工具调 `watchInbox`，把结局原样交出去。 */
function waiter(turns: Parameters<typeof scriptedStreamFn>[0], timeoutMs: number): Waiter {
  const clock = new FakeClock();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn(turns), clock });
  const abort = new AbortController();
  let started = false;
  let result: InboxWatchResult | undefined;
  const tool: AgentTool = {
    kind: "model",
    name: "wait_reply",
    label: "wait_reply",
    description: "等回信",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      started = true;
      result = await agent.watchInbox((m) => m.role === "environment" && m.replyTo === "me:1", { timeoutMs, signal: abort.signal });
      return toolOk(result.kind === "matched" ? textOf(result.message) : result.kind);
    },
  };
  void registerTool(agent.tools, tool);
  return { agent, clock, started: () => started, result: () => result, abort };
}

test("命中即消费：回信作为工具结果交回，run 收尾后 ack，不再以 environment 消息出现；不匹配的留在 inbox", async () => {
  const w = waiter([toolTurn("c1", "wait_reply", {}), textTurn("收到")], 60_000);
  const run = w.agent.prompt("去等回信");
  await until(w.started, "工具开始等");

  w.agent.deliver(envReply("别的事", "p:0"));
  w.agent.deliver(envReply("这是回信", "p:1", "me:1"));
  await until(() => inboxOf(w.agent).pendingCount === 2, "两条都投进来");
  w.clock.advance(1_000); // 一拍：刷盘 → 摘匹配的那条
  await run;

  expect(w.result()?.kind).toBe("matched");
  const toolResult = w.agent.messages.find((m) => m.role === "toolResult");
  expect(toolResult?.role === "toolResult" && toolResult.content).toBe("这是回信"); // toolResult 的 content 是字符串
  expect(envTexts(w.agent)).not.toContain("这是回信"); // 没有二次投递
  await until(() => inboxOf(w.agent).reservationCount === 0, "run 收尾后那条 ack 掉");
  expect(inboxOf(w.agent).pendingCount).toBe(1); // 「别的事」原样留着，等正常消费
});

test("超时什么都不消费：之后到的回信照普通路径进来，恰好一次", async () => {
  const w = waiter([toolTurn("c1", "wait_reply", {}), textTurn("没等到"), textTurn("看到回信了")], 3_000);
  const run = w.agent.prompt("去等回信");
  await until(w.started, "工具开始等");
  for (let i = 0; i < 3; i++) {
    w.clock.advance(1_000);
    await flush();
  }
  await run;
  expect(w.result()?.kind).toBe("timeout");

  w.agent.deliver(envReply("迟到的回信", "p:1", "me:1"));
  await until(() => inboxOf(w.agent).pendingCount === 1, "迟到的回信进 inbox");
  await w.agent.consumeInbox();
  expect(envTexts(w.agent).filter((t) => t === "迟到的回信")).toHaveLength(1);
});

test("叫停什么都不消费；run 外等 → rejected（ack 没有收尾可挂）", async () => {
  const w = waiter([toolTurn("c1", "wait_reply", {}), textTurn("停了")], 60_000);
  const run = w.agent.prompt("去等回信");
  await until(w.started, "工具开始等");
  w.agent.deliver(envReply("不相干的回信", "p:1", "me:9"));
  await until(() => inboxOf(w.agent).pendingCount === 1, "投进来");
  w.abort.abort();
  await run;
  expect(w.result()?.kind).toBe("aborted");
  expect(inboxOf(w.agent).pendingCount).toBe(1);
  expect(inboxOf(w.agent).reservationCount).toBe(0);

  expect(await w.agent.watchInbox(() => true, { timeoutMs: 1_000 })).toMatchObject({ kind: "rejected" });
});
