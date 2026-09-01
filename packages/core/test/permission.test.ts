import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { LifecycleEvent } from "../src/events.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import type { PermissionPolicy } from "../src/permission/types.ts";
import { PermissionLedger, deepFreezePlain } from "../src/permission/ledger.ts";

// §14.10.3 permission stage（O1b）的反例。每条都是**摘掉对应实现就会红**的判据。
//
//   - 顺序固定：transform hooks → 重新校验 → freeze → authorization → execute。ask 里的 params、宿主看到的、
//     execute 收到的是同一份冻结对象；
//   - 只有真正进入 ask 才有 permissionId；policy 直接 allow/deny 的事件不带 ID；
//   - ask 的四种封口（human answer / timeout / run abort / dispose）各一条，同一 ID 贯穿始终；
//   - answerPermission 的 accepted / stale / closed 与并发裁决；
//   - notify-only：hook 对 permissionRequest 返回 block 不生效；
//   - 构造期与 run 入口的 responder 校验 fail-loud。

function tool(name: string, execute: ModelTool["execute"]): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute };
}

const ask = (reason = "要问"): PermissionPolicy => ({
  authorize: () => ({ kind: "ask", reason }),
  askTimeoutMs: null,
  responder: "host",
});

function events(agent: Agent): LifecycleEvent[] {
  const out: LifecycleEvent[] = [];
  agent.subscribeLifecycle((e) => {
    out.push(e);
  });
  return out;
}

function ofType<T extends LifecycleEvent["type"]>(list: LifecycleEvent[], type: T): Extract<LifecycleEvent, { type: T }>[] {
  return list.filter((e): e is Extract<LifecycleEvent, { type: T }> => e.type === type);
}

/* ─────────────── policy 直接裁决：没有 ask、没有 ID ─────────────── */

test("policy allow：发不带 ID 的 permissionGranted(policy)，工具执行；没有 permissionRequest", async () => {
  let ran = 0;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    permission: { authorize: () => ({ kind: "allow" }), askTimeoutMs: 1000 },
  });
  const seen = events(agent);
  await agent.prompt("go");
  expect(ran).toBe(1);
  const granted = ofType(seen, "permissionGranted");
  expect(granted).toHaveLength(1);
  expect(granted[0]).toEqual({ type: "permissionGranted", toolCallId: "c1", decidedBy: "policy" });
  expect("permissionId" in granted[0]!).toBe(false);
  expect(ofType(seen, "permissionRequest")).toHaveLength(0);
});

test("policy deny：permissionDenied(policy) + toolUseDenied(by permission)，工具不执行，结果是错误", async () => {
  let ran = 0;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    permission: { authorize: () => ({ kind: "deny", reason: "策略不许" }), askTimeoutMs: 1000 },
  });
  const seen = events(agent);
  const result = await agent.prompt("go");
  expect(ran).toBe(0);
  expect(ofType(seen, "permissionDenied")[0]).toEqual({ type: "permissionDenied", toolCallId: "c1", toolName: "t", reason: "策略不许", decidedBy: "policy" });
  expect(ofType(seen, "toolUseDenied")[0]?.by).toBe("permission");
  const r = result.messages.find((m) => m.role === "toolResult") as { content: string; isError: boolean };
  expect(r.isError).toBe(true);
  expect(r.content).toBe("策略不许");
});

test("authorization 抛错 = fail-closed：当 deny，不放行", async () => {
  let ran = 0;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    permission: {
      authorize: () => {
        throw new Error("policy 炸了");
      },
      askTimeoutMs: 1000,
    },
  });
  const seen = events(agent);
  await agent.prompt("go");
  expect(ran).toBe(0);
  expect(ofType(seen, "permissionDenied")[0]?.reason).toContain("fail-closed");
});

test("非法 verdict 一律 fail-closed：{kind:\"bogus\"} 与缺 reason 的 ask 都是 deny，工具不执行", async () => {
  for (const bogus of [{ kind: "bogus" }, { kind: "ask" }, { kind: "deny", reason: "" }, null, "allow", 42] as const) {
    let ran = 0;
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
      tools: [tool("t", async () => (ran++, toolOk("ok")))],
      permission: { authorize: () => bogus as never, askTimeoutMs: 1000 },
    });
    const seen = events(agent);
    await agent.prompt("go");
    expect(ran).toBe(0);
    expect(ofType(seen, "permissionRequest")).toHaveLength(0);
    expect(ofType(seen, "permissionDenied")[0]?.reason).toContain("非法裁决");
  }
});

/* ─────────────── freeze / 重验不可绕过 ─────────────── */

test("交给 hook 的 params 是冻结快照：原地改在严格模式下抛，preToolUse 是 fail-closed 档 → 拦下，非法值进不了 Tool", async () => {
  const hooks = new HookRuntime();
  hooks.on("preToolUse", (e) => {
    (e.params as { n: unknown }).n = "not-a-number"; // 不返回 patch，只原地改 → TypeError
    return undefined;
  });
  let ran = 0;
  const t: ModelTool = {
    ...tool("t", async () => (ran++, toolOk("ok"))),
    prepareArguments: (raw) => {
      const n = (raw as { n: unknown }).n;
      if (typeof n !== "number") throw new Error("n 必须是数字");
      return { n };
    },
  };
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", { n: 1 }), textTurn("ok")]),
    tools: [t],
    hooks,
  });
  const seen = events(agent);
  await agent.prompt("go");
  expect(ran).toBe(0);
  const denied = ofType(seen, "toolUseDenied")[0]!;
  expect(denied.by).toBe("hook");
  expect(denied.reason).toMatch(/read.?only|not extensible|fail-closed|拦/i);
});

test("prepareArguments 不承诺幂等：没有 hook patch 时只调用一次；hook 返回新对象时才对那份重跑", async () => {
  // 只认 raw 形状的合法 normalizer：喂它自己的输出会炸（上一版「无条件二次 prepare」把它打坏，Tool 没执行）
  let prepared = 0;
  const received: unknown[] = [];
  const t: ModelTool = {
    ...tool("t", async (p) => (received.push(p), toolOk("ok"))),
    prepareArguments: (raw) => {
      prepared++;
      const r = raw as { path?: unknown; abs?: unknown };
      if (typeof r.path !== "string" || r.abs !== undefined) throw new Error("只接受 raw shape {path}");
      return { abs: `/root/${r.path}` };
    },
  };
  const make = (hooks?: HookRuntime): Agent =>
    new Agent({
      model: FAKE_MODEL,
      streamFunction: scriptedStreamFn([toolTurn("c1", "t", { path: "a.txt" }), textTurn("ok")]),
      tools: [t],
      ...(hooks !== undefined ? { hooks } : {}),
    });

  await make().prompt("go");
  expect(prepared).toBe(1);
  expect(received).toEqual([{ abs: "/root/a.txt" }]);

  // hook 返回 patch（新对象，raw 形状）：对那份重跑一次，Tool 收到重跑后的值
  prepared = 0;
  received.length = 0;
  const hooks = new HookRuntime();
  hooks.on("preToolUse", () => ({ patch: { params: { path: "b.txt" } } }));
  await make(hooks).prompt("go");
  expect(prepared).toBe(2);
  expect(received).toEqual([{ abs: "/root/b.txt" }]);
});

test("prepareArguments 返回浅冻结对象：嵌套照样被冻；返回 class 实例 / Date：拒绝，不原样放行", async () => {
  let askedParams: unknown;
  const shallow: ModelTool = {
    ...tool("shallow", async () => toolOk("ok")),
    prepareArguments: () => Object.freeze({ nested: { a: 1 }, list: [{ b: 2 }] }),
  };
  const withDate: ModelTool = {
    ...tool("withDate", async () => toolOk("never")),
    prepareArguments: () => ({ when: new Date(0) }),
  };
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "shallow", {}), toolTurn("c2", "withDate", {}), textTurn("ok")]),
    tools: [shallow, withDate],
    permission: ask(),
  });
  const seen = events(agent);
  agent.subscribeLifecycle((e) => {
    if (e.type !== "permissionRequest") return;
    askedParams = e.params;
    void agent.answerPermission({ permissionId: e.permissionId, decision: "allow" });
  });
  await agent.prompt("go");
  const p = askedParams as { nested: { a: number }; list: { b: number }[] };
  expect(Object.isFrozen(p.nested)).toBe(true);
  expect(Object.isFrozen(p.list)).toBe(true);
  expect(Object.isFrozen(p.list[0])).toBe(true);
  const failed = ofType(seen, "toolUseFailed").find((f) => f.toolCallId === "c2")!;
  expect(failed.cause).toBe("bad_params");
  expect(failed.message).toContain("Date");
  // Date 那次根本没进 ask
  expect(ofType(seen, "permissionRequest").map((r) => r.toolCallId)).toEqual(["c1"]);
});

test("policy 试图重赋 input.params：authInput 已冻结，赋值当场抛 → fail-closed deny，不产生 ask", async () => {
  let ran = 0;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", { x: 1 }), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    permission: {
      authorize: (input) => {
        (input as { params: unknown }).params = { x: 999 };
        return { kind: "ask", reason: "换了参数再问" };
      },
      askTimeoutMs: 1000,
    },
  });
  const seen = events(agent);
  await agent.prompt("go");
  expect(ran).toBe(0);
  expect(ofType(seen, "permissionRequest")).toHaveLength(0);
  expect(ofType(seen, "permissionDenied")[0]?.reason).toContain("fail-closed");
});

/* ─────────────── run deadline / abort 管得到 authorization 与 ask ─────────────── */

test("run timeoutMs 能终止不超时的 ask：outcome 是 timeout，ask 以 run-aborted 封口，pending 归零", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => toolOk("ok"))],
    permission: ask(),
    timeoutMs: 30,
  });
  const seen = events(agent);
  agent.subscribeLifecycle(() => {}); // 有订阅者但永远不答
  const started = Date.now();
  const result = await agent.prompt("go");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(result.outcome.kind).toBe("error");
  expect((result.outcome as { error: { code: string } }).error.code).toBe("timeout");
  expect(ofType(seen, "permissionCancelled")[0]?.reason).toBe("run-aborted");
  expect(agent.pendingPermissions).toHaveLength(0);
});

test("authorize 永不 resolve：agent.abort() 仍能让 run 结算为 aborted", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => toolOk("ok"))],
    permission: { authorize: () => new Promise(() => {}), askTimeoutMs: 1000 },
  });
  const running = agent.prompt("go");
  await new Promise((r) => setTimeout(r, 10));
  agent.abort("不等了");
  const result = await running;
  expect(result.outcome.kind).toBe("aborted");
});

test("abort 后 authorizer 晚到 reject：没有 unhandled rejection，run 仍是 aborted", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    let rejectLate!: (e: unknown) => void;
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
      tools: [tool("t", async () => toolOk("ok"))],
      permission: {
        authorize: () =>
          new Promise((_, reject) => {
            rejectLate = reject;
          }),
        askTimeoutMs: null,
        responder: "none",
      },
    });
    const done = agent.prompt("go");
    await new Promise((r) => setTimeout(r, 10));
    agent.abort();
    const result = await done;
    expect(result.outcome.kind).toBe("aborted");
    rejectLate(new Error("late reject")); // abort 已先赢，这条 rejection 必须有人接
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("responder 只能是 host | none：\"bogus\" 构造期就抛", () => {
  expect(
    () =>
      new Agent({
        model: FAKE_MODEL,
        streamFunction: scriptedStreamFn([]),
        permission: { authorize: () => ({ kind: "allow" }), askTimeoutMs: null, responder: "bogus" as never },
      }),
  ).toThrow(/responder/);
});

test("responder:host 但到 ask 那一刻已无订阅者（Dream 等不经 run 入口的路径同此）：不开 ask，当场拒", async () => {
  const hooks = new HookRuntime();
  let ran = 0;
  const requests: string[] = [];
  const denials: string[] = [];
  // 用 notify-only hook 收事件，而不是 subscribeLifecycle——测试自己不能成为那个「订阅者」
  hooks.on("permissionRequest", (e) => {
    requests.push(e.permissionId);
  });
  hooks.on("permissionDenied", (e) => {
    denials.push(e.reason);
  });
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    hooks,
    permission: ask(),
  });
  const off = agent.subscribeLifecycle(() => {}); // run 入口看到有订阅者
  hooks.on("preToolUse", () => {
    off(); // 走到 ask 之前把宿主撤了
    return undefined;
  });
  await agent.prompt("go"); // 上一版这里会开一个永远没人答的 ask
  expect(ran).toBe(0);
  expect(requests).toEqual([]);
  expect(denials[0]).toContain("无人回答");
});

/* ─────────────── ask：同一份冻结参数、同一个 ID 贯穿 ─────────────── */

test("ask → 宿主 allow：ask 的 params 与 execute 收到的是同一份冻结对象（含 hook patch 后的值），事件同 ID", async () => {
  const hooks = new HookRuntime();
  hooks.on("preToolUse", (e) => ({ patch: { params: { ...e.params, x: 2 } } }));
  let executedWith: unknown;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", { x: 1, nested: { y: [1, 2] } }), textTurn("ok")]),
    tools: [
      tool("t", async (params) => {
        executedWith = params;
        return toolOk("ran");
      }),
    ],
    hooks,
    permission: ask("动手要问"),
  });
  const seen = events(agent);
  let askedWith: unknown;
  let answer: unknown;
  agent.subscribeLifecycle((e) => {
    if (e.type !== "permissionRequest") return;
    askedWith = e.params;
    // 宿主收到的就是冻结后的最终参数：patch 生效、递归冻结
    expect((e.params as { x: number }).x).toBe(2);
    expect(Object.isFrozen(e.params)).toBe(true);
    expect(Object.isFrozen((e.params as { nested: { y: number[] } }).nested.y)).toBe(true);
    expect(e.runId.startsWith("run:")).toBe(true);
    expect(e.turnId).toBe(`${e.runId}#1`);
    expect(e.reason).toBe("动手要问");
    void agent.answerPermission({ permissionId: e.permissionId, decision: "allow" }).then((r) => {
      answer = r;
    });
  });

  const result = await agent.prompt("go");
  expect(result.outcome.kind).toBe("completed");
  expect(executedWith).toBe(askedWith); // 同一个对象，不是等价拷贝

  const req = ofType(seen, "permissionRequest")[0]!;
  const granted = ofType(seen, "permissionGranted")[0]!;
  expect(granted).toEqual({ type: "permissionGranted", permissionId: req.permissionId, toolCallId: "c1", decidedBy: "human" });
  expect(ofType(seen, "notification").some((n) => n.kind === "waiting_permission" && n.permissionId === req.permissionId)).toBe(true);
  expect(answer).toEqual({ kind: "accepted", permissionId: req.permissionId, runId: req.runId, toolCallId: "c1", decision: "allow" });
  // 再答一次：已封口
  expect(await agent.answerPermission({ permissionId: req.permissionId, decision: "deny" })).toEqual({
    kind: "closed",
    permissionId: req.permissionId,
    reason: "answered",
  });
});

test("ask → 宿主 deny：permissionDenied(human) 带同 ID 与理由，工具不执行", async () => {
  let ran = 0;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    permission: ask(),
  });
  const seen = events(agent);
  agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") void agent.answerPermission({ permissionId: e.permissionId, decision: "deny", reason: "人不许" });
  });
  await agent.prompt("go");
  expect(ran).toBe(0);
  const req = ofType(seen, "permissionRequest")[0]!;
  expect(ofType(seen, "permissionDenied")[0]).toEqual({
    type: "permissionDenied",
    permissionId: req.permissionId,
    toolCallId: "c1",
    toolName: "t",
    reason: "人不许",
    decidedBy: "human",
  });
});

test("ask → 超时：policy 拥有 timeout；permissionDenied(timeout) 同 ID，之后 answer 得 closed(timed-out)", async () => {
  let ran = 0;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    permission: { authorize: () => ({ kind: "ask", reason: "问" }), askTimeoutMs: 20 },
  });
  const seen = events(agent);
  await agent.prompt("go");
  expect(ran).toBe(0);
  const req = ofType(seen, "permissionRequest")[0]!;
  const denied = ofType(seen, "permissionDenied")[0]!;
  expect(denied.decidedBy).toBe("timeout");
  expect((denied as { permissionId: string }).permissionId).toBe(req.permissionId);
  expect(await agent.answerPermission({ permissionId: req.permissionId, decision: "allow" })).toEqual({
    kind: "closed",
    permissionId: req.permissionId,
    reason: "timed-out",
  });
});

test("ask → run abort：permissionCancelled(run-aborted) 同 ID，outcome aborted，之后 answer 得 closed(run-aborted)", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => toolOk("ok"))],
    permission: ask(),
  });
  const seen = events(agent);
  agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") agent.abort("不等了");
  });
  const result = await agent.prompt("go");
  expect(result.outcome.kind).toBe("aborted");
  const req = ofType(seen, "permissionRequest")[0]!;
  expect(ofType(seen, "permissionCancelled")[0]).toEqual({ type: "permissionCancelled", permissionId: req.permissionId, toolCallId: "c1", reason: "run-aborted" });
  expect(await agent.answerPermission({ permissionId: req.permissionId, decision: "allow" })).toEqual({
    kind: "closed",
    permissionId: req.permissionId,
    reason: "run-aborted",
  });
});

test("ask → dispose：permissionCancelled(runtime-disposed)，之后任何 answer 都是 closed(runtime-disposed)", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => toolOk("ok"))],
    permission: ask(),
  });
  const seen = events(agent);
  let disposing: Promise<void> | undefined;
  agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") disposing = agent.dispose();
  });
  await agent.prompt("go");
  await disposing;
  const req = ofType(seen, "permissionRequest")[0]!;
  expect(ofType(seen, "permissionCancelled")[0]?.reason).toBe("runtime-disposed");
  expect(await agent.answerPermission({ permissionId: req.permissionId, decision: "allow" })).toEqual({
    kind: "closed",
    permissionId: req.permissionId,
    reason: "runtime-disposed",
  });
  expect(await agent.answerPermission({ permissionId: "从没见过", decision: "allow" })).toEqual({
    kind: "closed",
    permissionId: "从没见过",
    reason: "runtime-disposed",
  });
});

/* ─────────────── answerPermission 的裁决 ─────────────── */

test("并发回答：恰好一个 accepted，其余 closed(answered)；未知 ID 是 stale(unknown)；坏 shape 才 TypeError", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => toolOk("ok"))],
    permission: ask(),
  });
  const results: unknown[] = [];
  agent.subscribeLifecycle((e) => {
    if (e.type !== "permissionRequest") return;
    const id = e.permissionId;
    void Promise.all([
      agent.answerPermission({ permissionId: id, decision: "allow" }),
      agent.answerPermission({ permissionId: id, decision: "deny" }),
      agent.answerPermission({ permissionId: id, decision: "allow" }),
    ]).then((rs) => results.push(...rs));
  });
  await agent.prompt("go");
  expect(results.map((r) => (r as { kind: string }).kind)).toEqual(["accepted", "closed", "closed"]);

  expect(await agent.answerPermission({ permissionId: "nope", decision: "allow" })).toEqual({ kind: "stale", permissionId: "nope", reason: "unknown" });
  await expect(agent.answerPermission({ permissionId: "", decision: "allow" })).rejects.toBeInstanceOf(TypeError);
  await expect(agent.answerPermission({ permissionId: "x", decision: "maybe" as never })).rejects.toBeInstanceOf(TypeError);
});

test("ledger：同一 tool call 重试产生新 ID；旧 ID 的回答得 stale(superseded) 并指向当前 ask", async () => {
  const ledger = new PermissionLedger();
  const base = { runId: "r", turnId: "r#1", toolCallId: "c1", toolName: "t", params: {}, reason: "问" };
  const first = ledger.openAsk(base, { timeoutMs: 5, signal: new AbortController().signal });
  const s1 = await first.settled; // 超时封口
  expect(s1).toEqual({ kind: "deny", decidedBy: "timeout", reason: expect.any(String) });
  const second = ledger.openAsk(base, { timeoutMs: null, signal: new AbortController().signal });
  expect(second.permissionId).not.toBe(first.permissionId);
  expect(ledger.answer({ permissionId: first.permissionId, decision: "allow" })).toEqual({
    kind: "stale",
    permissionId: first.permissionId,
    reason: "superseded",
    currentPermissionId: second.permissionId,
  });
  // 旧 decision 绝不自动落到新 ask：新的仍在等
  expect(ledger.pending.map((a) => a.permissionId)).toEqual([second.permissionId]);
  expect(ledger.answer({ permissionId: second.permissionId, decision: "allow" }).kind).toBe("accepted");
  expect(await second.settled).toEqual({ kind: "allow", decidedBy: "human" });
});

test("ledger：tombstone 身份是 runId + toolCallId——另一个 run 复用同一 toolCallId，旧 run 的 ID 得 closed，不是 superseded", async () => {
  const ledger = new PermissionLedger();
  const askOf = (runId: string) => ({ runId, turnId: `${runId}#1`, toolCallId: "c1", toolName: "t", params: {}, reason: "问" });
  const a = ledger.openAsk(askOf("run-A"), { timeoutMs: null, signal: new AbortController().signal });
  expect(ledger.answer({ permissionId: a.permissionId, decision: "deny" }).kind).toBe("accepted");
  await a.settled;
  ledger.closeRun("run-A");
  const b = ledger.openAsk(askOf("run-B"), { timeoutMs: null, signal: new AbortController().signal });
  // 上一版只记 toolCallId：这里会错误返回 superseded 并指向 run-B 的 ask
  expect(ledger.answer({ permissionId: a.permissionId, decision: "allow" })).toEqual({
    kind: "closed",
    permissionId: a.permissionId,
    reason: "answered",
  });
  expect(ledger.pending.map((x) => x.permissionId)).toEqual([b.permissionId]);
  // 同一 run 内的重试仍是 superseded
  const b2 = ledger.openAsk(askOf("run-B"), { timeoutMs: null, signal: new AbortController().signal });
  expect(ledger.answer({ permissionId: b.permissionId, decision: "allow" }).kind).toBe("accepted");
  await b.settled;
  const b3 = ledger.openAsk(askOf("run-B"), { timeoutMs: null, signal: new AbortController().signal });
  expect(ledger.answer({ permissionId: b.permissionId, decision: "allow" })).toMatchObject({
    kind: "stale",
    reason: "superseded",
    currentPermissionId: expect.any(String),
  });
  ledger.dispose();
  await b2.settled;
  await b3.settled;
});

test("ledger：retention 至少到 run 封口——同一 run 内 300 个 ask 全部可答 closed(answered)，封口后才受 256 池约束", async () => {
  const ledger = new PermissionLedger();
  const ids: string[] = [];
  for (let i = 0; i < 300; i++) {
    const h = ledger.openAsk(
      { runId: "run-X", turnId: "run-X#1", toolCallId: `c${i}`, toolName: "t", params: {}, reason: "问" },
      { timeoutMs: null, signal: new AbortController().signal },
    );
    expect(ledger.answer({ permissionId: h.permissionId, decision: "allow" }).kind).toBe("accepted");
    await h.settled;
    ids.push(h.permissionId);
  }
  // run 未封口：第 1 个不能被第 257 个挤成 stale(unknown)
  expect(ledger.answer({ permissionId: ids[0]!, decision: "allow" })).toMatchObject({ kind: "closed", reason: "answered" });
  expect(ledger.answer({ permissionId: ids[299]!, decision: "allow" })).toMatchObject({ kind: "closed", reason: "answered" });
  ledger.closeRun("run-X");
  // 封口后进有界池（256）：最早的 44 条被淘汰，只能是 stale(unknown)；最近的仍是 closed
  expect(ledger.answer({ permissionId: ids[0]!, decision: "allow" })).toMatchObject({ kind: "stale", reason: "unknown" });
  expect(ledger.answer({ permissionId: ids[43]!, decision: "allow" })).toMatchObject({ kind: "stale", reason: "unknown" });
  expect(ledger.answer({ permissionId: ids[44]!, decision: "allow" })).toMatchObject({ kind: "closed", reason: "answered" });
  expect(ledger.answer({ permissionId: ids[299]!, decision: "allow" })).toMatchObject({ kind: "closed", reason: "answered" });
});

test("Agent 层：run 结束即封口——同一 permissionId 在下一次 run 里仍是 closed，不会被新 run 的同名 toolCallId 劫成 superseded", async () => {
  const hooks = new HookRuntime();
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok"), toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => toolOk("ok"))],
    hooks,
    permission: ask(),
  });
  const requests: string[] = [];
  agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") {
      requests.push(e.permissionId);
      if (requests.length === 1) void Promise.resolve().then(() => agent.answerPermission({ permissionId: e.permissionId, decision: "allow" }));
    }
  });
  await agent.prompt("one");
  const second = agent.prompt("two"); // 第二个 run 也用 toolCallId c1，且停在 ask 上
  await new Promise((r) => setTimeout(r, 20));
  expect(requests).toHaveLength(2);
  expect(await agent.answerPermission({ permissionId: requests[0]!, decision: "allow" })).toMatchObject({ kind: "closed", reason: "answered" });
  expect((await agent.answerPermission({ permissionId: requests[1]!, decision: "deny" })).kind).toBe("accepted");
  await second;
});

/* ─────────────── notify-only：hook 对 permission 事件只能观察 ─────────────── */

test("外部脚本 hook 对 permissionRequest 返回 block：不生效——授权只来自 authorization stage", async () => {
  const hooks = new HookRuntime({ externalRunner: async () => ({ decision: "block", reason: "我要拦" }) });
  hooks.addScript({ event: "permissionRequest", command: "block.sh" });
  let ran = 0;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    hooks,
    permission: ask(),
  });
  agent.subscribeLifecycle((e) => {
    if (e.type === "permissionRequest") void agent.answerPermission({ permissionId: e.permissionId, decision: "allow" });
  });
  await agent.prompt("go");
  expect(ran).toBe(1);
});

/* ─────────────── responder：诚实缺席与 fail-loud ─────────────── */

test("responder:none：策略返回 ask 时折成 policy deny，不生成 ask、不等人", async () => {
  let ran = 0;
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "t", {}), textTurn("ok")]),
    tools: [tool("t", async () => (ran++, toolOk("ok")))],
    permission: { authorize: () => ({ kind: "ask", reason: "要问" }), askTimeoutMs: null, responder: "none" },
  });
  const seen = events(agent);
  await agent.prompt("go");
  expect(ran).toBe(0);
  expect(ofType(seen, "permissionRequest")).toHaveLength(0);
  const denied = ofType(seen, "permissionDenied")[0]!;
  expect(denied.decidedBy).toBe("policy");
  expect(denied.reason).toContain("no responder is configured");
});

test("构造期校验：不超时又没声明 responder 直接抛；超时值不是正整数直接抛", () => {
  const base = { model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) };
  expect(() => new Agent({ ...base, permission: { authorize: () => ({ kind: "allow" }), askTimeoutMs: null } })).toThrow(/responder/);
  expect(() => new Agent({ ...base, permission: { authorize: () => ({ kind: "allow" }), askTimeoutMs: 0 } })).toThrow(/正整数/);
  expect(() => new Agent({ ...base, permission: { authorize: () => ({ kind: "allow" }), askTimeoutMs: 1.5 } })).toThrow(/正整数/);
});

test("声明了 responder:host 却没人 subscribeLifecycle：run 入口 fail-loud，不等 Tool 暂停了才发现", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([textTurn("ok")]),
    permission: ask(),
  });
  await expect(agent.prompt("go")).rejects.toThrow(/subscribeLifecycle/);
  const off = agent.subscribeLifecycle(() => {});
  await expect(agent.prompt("go")).resolves.toBeDefined();
  off();
});

/* ─────────────── deepFreezePlain ─────────────── */

test("deepFreezePlain：递归冻结 plain 数据；已冻结的顶层不跳过子节点；循环引用安全；非 plain 一律拒绝", () => {
  const v = deepFreezePlain({ a: { b: [1, { c: 2 }] } });
  expect(Object.isFrozen(v.a.b[1])).toBe(true);
  expect(() => {
    (v.a as { b: unknown }).b = null;
  }).toThrow();

  // 顶层已浅冻：嵌套仍要冻（上一版 isFrozen 早退，嵌套照改）
  const shallow = Object.freeze({ inner: { x: 1 } });
  deepFreezePlain(shallow);
  expect(Object.isFrozen(shallow.inner)).toBe(true);

  // 循环引用：不栈溢出
  const cyc: { self?: unknown } = {};
  cyc.self = cyc;
  expect(() => deepFreezePlain(cyc)).not.toThrow();
  expect(Object.isFrozen(cyc)).toBe(true);

  // 非 plain：拒
  class Box {
    v = 1;
  }
  expect(() => deepFreezePlain({ box: new Box() })).toThrow(/Box 实例/);
  expect(() => deepFreezePlain({ m: new Map() })).toThrow(/Map/);
  expect(() => deepFreezePlain({ f: () => 1 })).toThrow(/函数/);
});
