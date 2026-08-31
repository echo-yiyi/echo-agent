// 后台活动与 inbox 的契约门。
//
// 核心不变量：**agent 起的东西不能比 agent 活得久**；
// 结束通知走 inbox，**不打断正在跑的任务**；自动醒来缺省关。

import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";

/** 测试用的小闸：并发 2、总量 4、输出 200 字。 */
/** 每个测试按需改 `agent.background.limits`——闸现在是上下文上的一个字段。 */
const LIMITS = { maxConcurrent: 2, maxTasks: 4, maxOutputChars: 200 };
import {
  startBackground, getBackground, listBackground, killBackground, killAllBackground,
} from "../src/background/harness.ts";
import { environmentMessage, defaultConvertToLlm } from "../src/messages.ts";
import type { AgentEvent } from "../src/events.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn } from "../src/testing.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/* ══════════ 执行与状态机 ══════════ */

test("跑完 → completed；输出可增量读", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const r = startBackground(agent.background, {
    kind: "process",
    label: "build",
    run: async (ctx) => {
      ctx.write("第一段");
      ctx.write("第二段");
    },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;

  await tick();
  expect(r.task.status).toBe("completed");
  expect(r.task.buffer.readNew()).toBe("第一段第二段");
  expect(r.task.buffer.readNew()).toBe(""); // 增量：读过就不再给
});

test("抛错 → failed，错因留下", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const r = startBackground(agent.background, {
    kind: "process",
    label: "boom",
    run: async () => {
      throw new Error("端口被占");
    },
  });
  await tick();
  if (!r.ok) return;
  expect(r.task.status).toBe("failed");
  expect(r.task.error).toContain("端口被占");
});

test("kill → killed，且等它真停下来才返回", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  let stopped = false;
  const r = startBackground(agent.background, {
    kind: "process",
    label: "server",
    run: (ctx) =>
      new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          stopped = true;
          resolve();
        });
      }),
  });
  if (!r.ok) return;

  expect(await killBackground(agent.background.tasks, r.task.id)).toBe(true);
  expect(stopped).toBe(true); // ← 「收干净」不是发个信号就算
  expect(r.task.status).toBe("killed");
  expect(await killBackground(agent.background.tasks, r.task.id)).toBe(false); // 终态吸收
});

test("被 kill 后 run 自己抛错，仍算 killed（终态吸收）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const r = startBackground(agent.background, {
    kind: "process",
    label: "x",
    run: (ctx) =>
      new Promise<void>((_, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("被中断")));
      }),
  });
  if (!r.ok) return;
  await killBackground(agent.background.tasks, r.task.id);
  expect(r.task.status).toBe("killed"); // 不是 failed
});

test("并发闸：超了就拒，不是排队", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  agent.background.limits = LIMITS; // maxConcurrent: 2
  const forever = {
    kind: "p",
    label: "x",
    run: (ctx: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve())),
  };
  expect(startBackground(agent.background, forever).ok).toBe(true);
  expect(startBackground(agent.background, forever).ok).toBe(true);
  const third = startBackground(agent.background, forever);
  expect(third.ok).toBe(false);
  if (!third.ok) expect(third.reason).toBe("too_many_running");
  await killAllBackground(agent.background.tasks);
});

test("输出超上限：从头驱逐，读的时候带 dropped 标记（不静默少一段）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  agent.background.limits = { ...LIMITS, maxOutputChars: 10 };
  const r = startBackground(agent.background, {
    kind: "p",
    label: "noisy",
    run: async (ctx) => {
      ctx.write("aaaaa");
      ctx.write("bbbbb");
      ctx.write("ccccc");
    },
  });
  await tick();
  if (!r.ok) return;
  const out = r.task.buffer.readNew();
  expect(out).toContain("dropped");
  expect(out).toContain("ccccc");
});

test("总量上限：终态任务被淘汰，running 的不动", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  agent.background.limits = { ...LIMITS, maxTasks: 3 };
  for (let i = 0; i < 5; i++) {
    startBackground(agent.background, { kind: "p", label: `t${i}`, run: async () => {} });
    await tick();
  }
  expect(listBackground(agent.background.tasks).length).toBeLessThanOrEqual(3);
  // 淘汰的是最老的那批
  expect(listBackground(agent.background.tasks).map((t) => t.label)).toContain("t4");
});

test("全在 running 且到了总量上限 → 拒，理由是 too_many_tasks", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  agent.background.limits = { maxConcurrent: 8, maxTasks: 2, maxOutputChars: 200 };
  const forever = {
    kind: "p",
    label: "x",
    run: (ctx: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve())),
  };
  expect(startBackground(agent.background, forever).ok).toBe(true);
  expect(startBackground(agent.background, forever).ok).toBe(true); // maxTasks:2 = 能有两个
  const third = startBackground(agent.background, forever);
  expect(third.ok).toBe(false);
  if (!third.ok) expect(third.reason).toBe("too_many_tasks"); // 并发没满，是总量满了且无可淘汰
  await killAllBackground(agent.background.tasks);
});

/* ══════════ 生命周期不变量 ══════════ */

test("agent.dispose() 收掉所有后台任务（起的东西不能比 agent 活得久）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  let stopped = false;
  startBackground(agent.background, {
    kind: "p",
    label: "daemon",
    run: (ctx) =>
      new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          stopped = true;
          resolve();
        });
      }),
  });
  await agent.dispose();
  expect(stopped).toBe(true);
});

/* ══════════ 结束通知 → inbox ══════════ */

test("结束通知进 inbox，缺省不自动跑（自动醒来是很强的行为，要显式开）", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("处理完了")]) });
  startBackground(agent.background, { kind: "p", label: "build", run: async () => {} });
  await tick();
  await tick();

  expect(agent.messages.length).toBe(0); // 没有自己开跑
  const r = await agent.consumeInbox(); // 手动消费
  expect(r).not.toBeNull();
  const env = agent.messages.find((m) => m.role === "environment");
  expect(env).toBeDefined();
  expect((env as { source: string }).source).toBe("background");
});

test("autoConsumeInbox 开着：回 idle 后自己醒来处理", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    autoConsumeInbox: true,
    streamFunction: scriptedStreamFn([textTurn("知道了")]),
  });
  startBackground(agent.background, { kind: "p", label: "build", run: async () => {} });
  await tick();
  await tick();
  await tick();

  expect(agent.messages.some((m) => m.role === "environment")).toBe(true);
  expect(agent.messages.some((m) => m.role === "assistant")).toBe(true); // 真跑了一轮
});

test("onEnd 返回 null = 这个任务结束了不必打扰 agent", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  startBackground(agent.background, { kind: "p", label: "quiet", run: async () => {}, onEnd: () => null });
  await tick();
  await tick();
  expect(await agent.consumeInbox()).toBeNull(); // inbox 是空的
});

test("正在跑时结束 → 只入队，不打断当前任务", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    autoConsumeInbox: true,
    streamFunction: scriptedStreamFn([textTurn("第一件"), textTurn("处理通知")]),
  });
  const events: AgentEvent[] = [];
  let started = false; // ← 只起一次：起多次会自我再生（见下面那条注释）
  agent.subscribe((e) => {
    events.push(e);
    if (e.type === "turn_start" && !started) {
      started = true;
      startBackground(agent.background, { kind: "p", label: "x", run: async () => {} });
    }
  });
  await agent.prompt("做第一件");

  // 第一次 run 只跑了一轮（没被通知打断）
  const firstRunTurns = events.filter((e) => e.type === "turn_start").length;
  expect(firstRunTurns).toBe(1);
  await tick();
  await tick();
  // 通知在回到 idle 之后才被处理
  expect(agent.messages.some((m) => m.role === "environment")).toBe(true);
});

test("run 不理会 abort 时：宽限期到就放弃等待，不挂死 dispose", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]) });
  const r = startBackground(agent.background, {
    kind: "p",
    label: "stubborn",
    run: () => new Promise<void>(() => {}), // ← 压根不听 signal
  });
  if (!r.ok) return;

  const killed = await killBackground(agent.background.tasks, r.task.id, { graceMs: 10 }); // 10ms 宽限
  expect(killed).toBe(true);
  expect(r.task.status).toBe("killed");
  expect(r.task.error).toContain("仍未停止");
});

/* ══════════ 环境消息 ══════════ */

// 已知的锋利边（实测踩到）：**autoConsumeInbox + 每轮都产生 inbox 消息 = 自我再生的死循环**。
// core 不加护栏——「消息会不会自我再生」是产品的事，加闸等于替产品定策略。
test("环境消息投影成 user 消息；source/ref 不出门", async () => {
  const out = await defaultConvertToLlm([environmentMessage("构建完成", "background", "bg-1")]);
  expect(out.length).toBe(1);
  expect(out[0]?.role).toBe("user");
  const json = JSON.stringify(out);
  expect(json).toContain("构建完成");
  expect(json).not.toContain("background");
  expect(json).not.toContain("bg-1");
});
