import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { bindMemoryScopes, createAgentMemories, memoryCreate, type AgentMemories } from "../src/memory/harness.ts";
import { memoryScopeTable, type MemoryScopeDef } from "../src/memory/scope.ts";
import { agentMemory, notesMemory, userMemory } from "../src/memory/types.ts";
import { DEFAULT_EXTRACT_MIN_USER_WORDS, EXTRACT_PROMPT_OPENING, userProseWords } from "../src/memory/extract.ts";
import { assistantMessage, environmentMessage, toolResultMessage, userMessage } from "../src/messages.ts";
import type { StreamFn } from "../src/provider/types.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
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

  await agent.prompt("第一句：帮我看看这个函数为什么返回空");
  await firstExtractStarted; // 第一次提取卡在模型调用上，通道忙着
  await agent.prompt("第二句：再帮我查一下调用它的地方"); // 这条回复收尾时排进来的提取带着第二句
  release();

  expect(await until(async () => extractPrompts.length >= 2), "跑完之后没有再跑").toBe(true);
  expect(extractPrompts[1]).toContain("第二句");
  expect(extractPrompts[1]).toContain("第二条回答");
  // 游标：第一次跑完已经看过第一句，跑完再跑的那次只看它之后的（2026-10-30）
  expect(extractPrompts[1]).not.toContain("第一句");
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

  await agent.prompt("帮我把这个模块的测试跑一遍看看");

  expect(await until(async () => notices.some((m) => m.includes("memory_extract_failed"))), "提取没跑完却没有诊断").toBe(true);
});

/* ───────── 2026-09-14 实测：提取前三轮全在 view、第五轮去写 INDEX.md，轮数用完 ───────── */

test("提取 prompt 自带此刻存着的记忆：indexed 模块给索引、常驻模块给全文，并说明 INDEX.md 由系统维护——不用一个个 view 去摸", async () => {
  const dir = new InMemoryDir();
  const mem = memoriesOn(dir);
  await memoryCreate(mem, "session/memory/old-pref.md", "---\ndescription: 早就记过的回答偏好\n---\n\n回答要带代码位置。");
  await memoryCreate(mem, "session/agent.md", "先跑窄测试，再跑全量。");
  let extractPrompt = "";
  const foreground = scriptedStreamFn([textTurn("好的")]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: (model, context, options) => {
      const seen = JSON.stringify(context.messages);
      if (!seen.includes(EXTRACT_PROMPT_OPENING)) return foreground(model, context, options);
      extractPrompt = seen;
      return scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
    },
    memory: mem,
  });

  await agent.prompt("随便聊一句，最近项目进展怎么样");

  expect(await until(async () => extractPrompt !== ""), "提取没有起来").toBe(true);
  expect(extractPrompt).toContain("Stored now");
  expect(extractPrompt).toContain("早就记过的回答偏好"); // indexed 模块：索引里的描述行
  expect(extractPrompt).not.toContain("回答要带代码位置"); // 正文不进清单，要改时再 view
  expect(extractPrompt).toContain("先跑窄测试，再跑全量。"); // 常驻模块：全文
  expect(extractPrompt).toContain("INDEX.md is rebuilt by the system");
});

test("撞上轮数上限：诊断说清已经写进去几条——那几条是真的落了盘，不是失败", async () => {
  const dir = new InMemoryDir();
  const mem = memoriesOn(dir);
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  const foreground = scriptedStreamFn([textTurn("答完")]);
  // 写一条，然后一直 view 到轮数用完（每轮都还在要工具，循环要第六轮才收得了尾）
  const extract = scriptedStreamFn([
    toolTurn("w1", "memory", { command: "create", path: "session/memory/a.md", file_text: "---\ndescription: 一条\n---\n\n甲" }),
    toolTurn("v1", "memory", { command: "view", path: "session/memory/" }),
    toolTurn("v2", "memory", { command: "view", path: "session/memory/" }),
    toolTurn("v3", "memory", { command: "view", path: "session/memory/" }),
    toolTurn("v4", "memory", { command: "view", path: "session/memory/" }),
  ]);
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: (model, context, options) =>
      JSON.stringify(context.messages).includes(EXTRACT_PROMPT_OPENING) ? extract(model, context, options) : foreground(model, context, options),
    memory: mem,
    hooks,
  });

  await agent.prompt("帮我把这个模块的测试跑一遍看看");

  expect(await until(async () => notices.some((m) => m.includes("memory_extract_failed"))), "轮数用完却没有诊断").toBe(true);
  const notice = notices.find((m) => m.includes("memory_extract_failed"))!;
  expect(notice).toContain("max_iterations");
  expect(notice).toContain("已写入 1 条");
  expect(await dir.read("memory/a.md")).toContain("甲");
});

/* ───────── 2026-10-30：用户说的话攒够才跑、只看游标之后（「谢谢」也跑一次、每次重发整段对话的那一版的替代） ───────── */

test("计量：只数 human / steer 用户正文；中日韩文字一字一词、其余按空白分词、纯标点不算", () => {
  expect(userProseWords([userMessage("谢谢")])).toBe(2);
  expect(userProseWords([userMessage("OK.")])).toBe(1);
  expect(userProseWords([userMessage("Use pnpm, not npm !")])).toBe(4);
  expect(userProseWords([userMessage("别用 npm")])).toBe(3);
  expect(userProseWords([userMessage("插一句：先别提交", "steer")])).toBe(7);
  // 不算的：harness 插话、助手回复、工具输出、环境消息
  expect(
    userProseWords([
      userMessage("请继续把任务做完", "harness"),
      assistantMessage([{ type: "text", text: "我读了一个很长很长的文件" }], "end_turn"),
      toolResultMessage("t1", "read_file", "大段文件内容大段文件内容", false),
      environmentMessage("后台任务结束了", "background"),
    ]),
  ).toBe(0);
  expect(DEFAULT_EXTRACT_MIN_USER_WORDS).toBeGreaterThan(userProseWords([userMessage("好的，谢谢")])); // 致谢挡得住
});

/** 前台一律答「好的」；提取的 prompt 记下来，答「没什么可记的」。 */
function recording(extract?: StreamFn): { fn: StreamFn; extractPrompts: string[] } {
  const extractPrompts: string[] = [];
  const fn: StreamFn = (model, context, options) => {
    const seen = JSON.stringify(context.messages);
    if (!seen.includes(EXTRACT_PROMPT_OPENING)) return scriptedStreamFn([textTurn("好的")])(model, context, options);
    extractPrompts.push(seen);
    return (extract ?? scriptedStreamFn([textTurn("没什么可记的。")]))(model, context, options);
  };
  return { fn, extractPrompts };
}

/** 等提取通道把手上的活跑完（排着的也跑完）。 */
async function idleExtract(agent: Agent): Promise<void> {
  const channel = (agent as unknown as { extractChannel: { busy: boolean } }).extractChannel;
  await until(async () => !channel.busy);
}

test("致谢、确认不触发提取；攒着不丢——下一句有内容的话出现时一并看", async () => {
  const { fn, extractPrompts } = recording();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await agent.prompt("谢谢");
  await agent.prompt("OK");
  await idleExtract(agent);
  expect(extractPrompts).toHaveLength(0); // 两条致谢：一次模型调用都没起

  await agent.prompt("以后提交前先跑一遍全量测试");
  await idleExtract(agent);
  expect(extractPrompts).toHaveLength(1);
  expect(extractPrompts[0]).toContain("谢谢"); // 攒着的那两条一起看了
  expect(extractPrompts[0]).toContain("以后提交前先跑一遍全量测试");
});

test("只看游标之后：跑完一次，下一次的材料里没有已经看过的那段", async () => {
  const { fn, extractPrompts } = recording();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await agent.prompt("第一件事：我们的测试一律用 bun 跑");
  await idleExtract(agent);
  await agent.prompt("第二件事：提交信息一律写中文");
  await idleExtract(agent);

  expect(extractPrompts).toHaveLength(2);
  expect(extractPrompts[1]).toContain("第二件事");
  expect(extractPrompts[1]).not.toContain("第一件事");
});

test("提取没跑完（模型出错）游标不动：下一次把那段重看一遍", async () => {
  let calls = 0;
  const flaky: StreamFn = (model, context, options) =>
    calls++ === 0 ? scriptedStreamFn([errorTurn("overloaded", "模型挂了", false)])(model, context, options) : scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
  const { fn, extractPrompts } = recording(flaky);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await agent.prompt("第一件事：我们的测试一律用 bun 跑");
  await idleExtract(agent);
  await agent.prompt("第二件事：提交信息一律写中文");
  await idleExtract(agent);

  expect(extractPrompts).toHaveLength(2);
  expect(extractPrompts[1]).toContain("第一件事"); // 第一次没跑完，那段还在
  expect(extractPrompts[1]).toContain("第二件事");
});

test("前台这轮自己写过记忆：这一段算看过，之后的提取不再带它", async () => {
  const extractPrompts: string[] = [];
  const foreground = scriptedStreamFn([
    toolTurn("m1", "memory", { command: "create", path: "session/memory/test-runner.md", file_text: "---\ndescription: 测试用 bun 跑\n---\n\n测试一律用 bun 跑。" }),
    textTurn("记下了。"),
    textTurn("好的"),
  ]);
  const fn: StreamFn = (model, context, options) => {
    const seen = JSON.stringify(context.messages);
    if (!seen.includes(EXTRACT_PROMPT_OPENING)) return foreground(model, context, options);
    extractPrompts.push(seen);
    return scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
  };
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });
  await mountBuiltinTools(agent); // 前台要真有 memory 工具可调（`echo:memory` builtin 注册它）

  await agent.prompt("记住：我们的测试一律用 bun 跑");
  await idleExtract(agent);
  expect(extractPrompts).toHaveLength(0); // 前台写过：跳过

  await agent.prompt("第二件事：提交信息一律写中文");
  await idleExtract(agent);
  expect(extractPrompts).toHaveLength(1);
  expect(extractPrompts[0]).not.toContain("记住：我们的测试一律用 bun 跑");
});

test("reset 清空 transcript：游标归零，在飞的那次提取不把游标推到旧下标上", async () => {
  let release = (): void => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let reached = (): void => {};
  const started = new Promise<void>((r) => {
    reached = r;
  });
  let first = true;
  const slow: StreamFn = async (model, context, options) => {
    if (first) {
      first = false;
      reached();
      await held;
    }
    return scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
  };
  const { fn, extractPrompts } = recording(slow);
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await agent.prompt("旧对话：我们的测试一律用 bun 跑，再加一句话");
  await started; // 提取卡在模型调用上
  agent.reset();
  release();
  await idleExtract(agent);

  await agent.prompt("新对话：提交信息一律写中文");
  await idleExtract(agent);
  expect(extractPrompts).toHaveLength(2);
  // 新对话只有 2 条：要是旧那次把游标推到了它的 2，这次就会被当成「已经看过」整段跳过
  expect(extractPrompts[1]).toContain("新对话");
});

