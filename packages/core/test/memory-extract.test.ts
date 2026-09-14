import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { bindMemoryScopes, createAgentMemories, type AgentMemories } from "../src/memory/harness.ts";
import { memoryScopeTable, type MemoryScopeDef } from "../src/memory/scope.ts";
import { agentMemory, notesMemory, userMemory } from "../src/memory/types.ts";
import { EXTRACT_PROMPT_OPENING } from "../src/memory/extract.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { errorTurn, FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";

// 记忆提取的端到端判据（2026-09-14）。
//
// d346b56 起提取从来没真跑过：`enqueueExtract` 用 `viewAt(messages, compaction, messages.length)` 取 transcript——
// 那是「第 i 条单条在视图里的样子」，i 越界恒为空数组，`runExtract` 见空串直接返回，不报诊断。
// 当时的测试只测提取 prompt 的文本与写入并发，没有一条让提取子循环真的起来，所以门一直是绿的。
// 判据落在两件可观察的事上：模型收到的提取 prompt 里有这次对话；它用记忆工具写的东西真的落了盘。

const ONE_LAYER: readonly MemoryScopeDef[] = [{ name: "session", order: 1, describe: "only this session", anchor: { kind: "home" }, prefix: "" }];

function memoriesOn(dir: InMemoryDir): AgentMemories {
  const h = createAgentMemories({ memories: [agentMemory, userMemory, notesMemory] });
  bindMemoryScopes(h, memoryScopeTable(ONE_LAYER.map((def) => ({ def, dir }))));
  return h;
}

/** 提取在回复收尾后异步起：等到条件成立或超时。 */
async function until(cond: () => Promise<boolean>, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

test("一条回复结束 → 提取子循环真的起来：提取 prompt 里有这次对话，模型用记忆工具写的东西落了盘", async () => {
  const dir = new InMemoryDir();
  const mem = memoriesOn(dir);
  const calls: string[] = [];
  const scripted = scriptedStreamFn([
    textTurn("好，之后都简短回答。"),
    toolTurn("m1", "memory", { command: "create", path: "session/memory/answer-style.md", file_text: "---\ndescription: 用户要简短回答\n---\n\n回答保持简短。" }),
    textTurn("记下了。"),
  ]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: (model, context, options) => {
      calls.push(JSON.stringify(context.messages));
      return scripted(model, context, options);
    },
    memory: mem,
  });

  await agent.prompt("以后回答简短一点");

  expect(await until(async () => (await dir.read("memory/answer-style.md")) !== null), "提取没有把记忆写下来").toBe(true);
  const extract = calls.find((c) => c.includes(EXTRACT_PROMPT_OPENING));
  expect(extract, "提取子循环没有起来").toBeDefined();
  // transcript 不是空的：用户说的与助手答的都在提取 prompt 里
  expect(extract).toContain("以后回答简短一点");
  expect(extract).toContain("好，之后都简短回答。");
  expect(await dir.read("memory/answer-style.md")).toContain("回答保持简短");
});

test("提取还在跑时又结束一条回复 → 跑完再跑的那次看的是最新对话，不是把旧材料再提取一遍", async () => {
  const dir = new InMemoryDir();
  const mem = memoriesOn(dir);
  const extractPrompts: string[] = [];
  let release = (): void => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let reached = (): void => {};
  const firstExtractStarted = new Promise<void>((r) => {
    reached = r;
  });
  const foreground = scriptedStreamFn([textTurn("第一条回答"), textTurn("第二条回答")]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: async (model, context, options) => {
      const seen = JSON.stringify(context.messages);
      if (!seen.includes(EXTRACT_PROMPT_OPENING)) return foreground(model, context, options);
      extractPrompts.push(seen);
      if (extractPrompts.length === 1) {
        reached();
        await held;
      }
      return scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
    },
    memory: mem,
  });

  await agent.prompt("第一句");
  await firstExtractStarted; // 第一次提取卡在模型调用上，通道忙着
  await agent.prompt("第二句"); // 这条回复收尾时排进来的提取带着第二句
  release();

  expect(await until(async () => extractPrompts.length >= 2), "跑完之后没有再跑").toBe(true);
  expect(extractPrompts[1]).toContain("第二句");
  expect(extractPrompts[1]).toContain("第二条回答");
});

test("提取的模型调用出错（循环不抛，outcome 是 error）→ 报 memory_extract_failed 诊断", async () => {
  const dir = new InMemoryDir();
  const mem = memoriesOn(dir);
  // 诊断落成一条 notification 生命周期事件（`reportDiagnostic` → `hooks.notify`）
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  const foreground = scriptedStreamFn([textTurn("答完")]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: (model, context, options) =>
      JSON.stringify(context.messages).includes(EXTRACT_PROMPT_OPENING)
        ? scriptedStreamFn([errorTurn("overloaded", "模型挂了", false)])(model, context, options)
        : foreground(model, context, options),
    memory: mem,
    hooks,
  });

  await agent.prompt("干点活");

  expect(await until(async () => notices.some((m) => m.includes("memory_extract_failed"))), "提取没跑完却没有诊断").toBe(true);
});
