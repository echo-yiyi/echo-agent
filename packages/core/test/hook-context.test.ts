// HookContext 三个字段都得是真值（review 2026-09-07 #22，2026-09-09 拍板补齐而非减法）：
// `hookId` 由 HookRuntime 逐条填成注册 id，`origin` 由 Agent 按发生处标（用户输入进循环 = `user`）。
import { expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { HookRuntime, type HookContext } from "../src/hooks/runtime.ts";
import { scriptedStreamFn, textTurn } from "../src/testing.ts";

test("HookRuntime 调每条 hook 时把 hookId 填成它的注册 id：显式 id 与自动编号都一样，调用方传的占位被覆盖", async () => {
  const h = new HookRuntime();
  const seen: HookContext[] = [];
  h.on("userPromptSubmit", (_e, ctx) => void seen.push(ctx), { id: "guard" });
  h.on("userPromptSubmit", (_e, ctx) => void seen.push(ctx));
  h.on("abortRequested", (_e, ctx) => void seen.push(ctx), { id: "watch" });

  await h.intercept({ type: "userPromptSubmit", text: "x", source: "human" }, { origin: "user", hookId: "placeholder" });
  await h.notify({ type: "abortRequested", reason: "test" }, { origin: "model", hookId: "placeholder" });

  expect(seen.map((c) => [c.origin, c.hookId])).toEqual([
    ["user", "guard"],
    ["user", "userPromptSubmit#0"],
    ["model", "watch"],
  ]);
});

test("Agent 标 origin：userPromptSubmit 是 user，模型引起的事件是 model", async () => {
  const h = new HookRuntime();
  const seen: [string, string][] = [];
  h.on("userPromptSubmit", (_e, ctx) => void seen.push([ctx.origin, ctx.hookId]), { id: "ups" });
  h.on("contextBeforeBuild", (_e, ctx) => void seen.push([ctx.origin, ctx.hookId]), { id: "cbb" });
  const agent = new Agent({ model: { provider: "t", id: "only", api: "scripted" }, streamFunction: scriptedStreamFn([textTurn("done")]), hooks: h });
  const r = await agent.prompt("go");
  expect(r.outcome.kind).toBe("completed");
  expect(seen).toEqual([
    ["user", "ups"],
    ["model", "cbb"],
  ]);
  await agent.dispose();
});
