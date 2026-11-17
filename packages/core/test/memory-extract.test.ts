import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { bindMemoryScopes, createAgentMemories, memoryCreate, type AgentMemories } from "../src/memory/harness.ts";
import { memoryScopeTable, type MemoryScopeDef } from "../src/memory/scope.ts";
import { agentMemory, notesMemory, userMemory } from "../src/memory/types.ts";
import {
  DEFAULT_EXTRACT_DRAIN_MS,
  DEFAULT_EXTRACT_EVERY_TURNS,
  DEFAULT_EXTRACT_MIN_USER_WORDS,
  DEFAULT_EXTRACT_SETTINGS,
  EXTRACT_PROMPT_OPENING,
  humanTurns,
  userProseWords,
  type ExtractPrompt,
  type ExtractPromptInput,
  type ExtractSettings,
} from "../src/memory/extract.ts";
import { assistantMessage, environmentMessage, toolResultMessage, userMessage, type Context } from "../src/messages.ts";
import type { StreamFn } from "../src/provider/types.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { SessionService } from "../src/session/service.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { errorTurn, FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import type { Model } from "../src/provider/types.ts";
import { COLLAPSE_PROMPT_OPENING, SUMMARY_PROMPT_OPENING } from "../src/compaction/builtin.ts";
import { estimateText } from "../src/compaction/view.ts";
import { fixedOverhead } from "../src/compaction/pipeline.ts";
import { visibleTools } from "../src/tools/harness.ts";

// 记忆提取的端到端判据。
//
// 2026-09-14：d346b56 起提取从来没真跑过（取 transcript 的下标越界恒为空），当时的测试只测 prompt 文本与写入并发，
// 门一直是绿的。所以判据落在可观察的事上：模型收到了提取请求、它用记忆工具写的东西真的落了盘。
// 2026-11-03：提取改为从主对话分叉（前缀与前台最后一次请求逐字相同）、攒满三轮才跑、退出前补一次。
// 「对话不在提取 prompt 里」是新形状的本意——对话在上文；判据改看「从哪句开始看」与前缀是否一致。

const ONE_LAYER: readonly MemoryScopeDef[] = [{ name: "session", order: 1, describe: "only this session", anchor: { kind: "home" }, prefix: "" }];

function memoriesOn(dir: InMemoryDir, extract?: ExtractSettings): AgentMemories {
  const h = createAgentMemories({ memories: [agentMemory, userMemory, notesMemory], ...(extract === undefined ? {} : { extract }) });
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

/**
 * 一次模型调用是不是提取发的：消息里有那条提取指令（开头是 `EXTRACT_PROMPT_OPENING`）。前台的 transcript 里永远没有它——
 * 不能只看最后一条：提取的第二次调用，最后一条是工具结果。
 */
function isExtract(context: Context): boolean {
  return JSON.stringify(context.messages).includes(EXTRACT_PROMPT_OPENING);
}

/** 提取那次的指令正文：接在主对话后面的那条。 */
function instructionOf(context: Context): string {
  return JSON.stringify(context.messages.find((m) => JSON.stringify(m).includes(EXTRACT_PROMPT_OPENING)) ?? null);
}

/** 前台按 `foreground`（缺省一律答「好的」）；提取按 `extract`（缺省答「没什么可记的」）。两边的请求都记下来。 */
function recording(opts: { extract?: StreamFn; foreground?: StreamFn } = {}): { fn: StreamFn; extracts: Context[]; foreground: Context[] } {
  const extracts: Context[] = [];
  const foreground: Context[] = [];
  const fn: StreamFn = (model, context, options) => {
    if (!isExtract(context)) {
      foreground.push(structuredClone(context));
      return (opts.foreground ?? scriptedStreamFn([textTurn("好的")]))(model, context, options);
    }
    extracts.push(structuredClone(context));
    return (opts.extract ?? scriptedStreamFn([textTurn("没什么可记的。")]))(model, context, options);
  };
  return { fn, extracts, foreground };
}

/** 一轮一轮地说。 */
async function say(agent: Agent, ...lines: string[]): Promise<void> {
  for (const line of lines) await agent.prompt(line);
}

/** 等提取通道把手上的活跑完（排着的也跑完）。 */
async function idleExtract(agent: Agent): Promise<void> {
  const channel = (agent as unknown as { extractChannel: { busy: boolean } }).extractChannel;
  await until(async () => !channel.busy);
}

const THREE = ["第一件事：我们的测试一律用 bun 跑", "第二件事：提交信息一律写中文", "第三件事：合并之前先跑全量测试"];

test("hasPendingWork 算上记忆提取（2026-11-17）：提取在跑时为真，跑完才变假——宿主等它再收摊，这段对话就不会没提取过", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((r) => (release = r));
  const extract: StreamFn = (model, context, options) => gate.then(() => scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options)) as never;
  const { fn } = recording({ extract });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });
  await say(agent, ...THREE); // 攒满三轮：提取起来，卡在模型调用上
  expect(await until(async () => agent.state.status === "idle")).toBe(true);
  expect(agent.hasPendingWork).toBe(true); // 前台空闲了，但提取还在跑
  release();
  expect(await until(async () => !agent.hasPendingWork)).toBe(true);
});

test("settleMemory（2026-11-17）：现在就把没提取的部分提取完并返回结局——跑完是 completed 带写成几条；再调是 empty_range；用户的话不够是 too_short；没装记忆是 not_allowed；timeoutMs 不对就抛", async () => {
  const create = toolTurn("w1", "memory", { command: "create", path: "session/memory/a.md", file_text: "---\ndescription: 测试用 bun\n---\n\n测试一律用 bun 跑" });
  const { fn } = recording({ extract: scriptedStreamFn([create, textTurn("记好了。")]) });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });
  await say(agent, "以后我们的测试一律用 bun 跑，别再用 npm test 了"); // 一轮：不会自己提取
  expect(await agent.settleMemory()).toEqual({ kind: "completed", written: 1 });
  expect(await agent.settleMemory()).toEqual({ kind: "skipped", reason: "empty_range" }); // 游标已在末尾
  await say(agent, "好");
  expect(await agent.settleMemory()).toEqual({ kind: "skipped", reason: "too_short" });

  const bare = new Agent({ model: FAKE_MODEL, streamFunction: fn });
  expect(await bare.settleMemory()).toEqual({ kind: "skipped", reason: "not_allowed" });
  await expect(agent.settleMemory({ timeoutMs: -1 })).rejects.toThrow("timeoutMs");
});

test("settleMemory 到时限（2026-11-17）：中止提取、等它停下再返回 aborted，游标不动——下一次再看这段", async () => {
  const clock = new FakeClock();
  let reached = (): void => {};
  const started = new Promise<void>((r) => (reached = r));
  const hang: StreamFn = (_model, _context, options) =>
    new Promise((_resolve, reject) => {
      reached();
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  let calls = 0;
  const extract: StreamFn = (model, context, options) => (++calls === 1 ? hang(model, context, options) : scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options));
  const { fn } = recording({ extract });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()), clock });
  await say(agent, "以后我们的测试一律用 bun 跑，别再用 npm test 了");
  const settling = agent.settleMemory({ timeoutMs: 5_000 });
  await started;
  clock.advance(5_000);
  expect(await settling).toEqual({ kind: "aborted" });
  expect(agent.hasPendingWork).toBe(false); // 返回时提取已经停了
  expect(await agent.settleMemory()).toEqual({ kind: "completed", written: 0 }); // 游标没动：这段再看一次
});

test("提取指令可以换（2026-11-17）：用产品给的写法，拿到要看的那段与此刻存着什么；写法抛错按这一次没跑成算、报诊断、不调模型", async () => {
  const seen: ExtractPromptInput[] = [];
  let broken = false;
  const prompt: ExtractPrompt = (i) => {
    if (broken) throw new Error("写法坏了");
    seen.push(i);
    return `OUR-EXTRACT: review the last ${i.range.messages} messages`;
  };
  const extracts: Context[] = [];
  const fn: StreamFn = (model, context, options) => {
    if (JSON.stringify(context.messages).includes("OUR-EXTRACT")) {
      extracts.push(structuredClone(context));
      return scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
    }
    return scriptedStreamFn([textTurn("好的")])(model, context, options);
  };
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir(), { ...DEFAULT_EXTRACT_SETTINGS, prompt }), hooks });

  await say(agent, ...THREE);
  await idleExtract(agent);
  expect(extracts).toHaveLength(1);
  expect(JSON.stringify(extracts[0]!.messages.at(-1))).toContain("OUR-EXTRACT: review the last");
  expect(seen).toHaveLength(1);
  expect([seen[0]!.range.fromStart, seen[0]!.range.retry, seen[0]!.range.firstUserText]).toEqual([true, false, THREE[0]!]);
  expect(seen[0]!.memories.map((m) => m.name)).toEqual(["agent", "user", "memory"]);
  expect(seen[0]!.scopes.entries.map((e) => e.def.name)).toEqual(["session"]);

  broken = true;
  await say(agent, ...NEXT_THREE);
  await idleExtract(agent);
  expect(extracts).toHaveLength(1); // 写法抛错：没调模型
  expect(notices.some((n) => n.includes("记忆提取的指令写不出来（memory.extract.prompt）：写法坏了"))).toBe(true);
});

test("攒满三轮 → 提取起来、从主对话分叉：上文就是这几轮对话，指令说清从哪句看起，模型用记忆工具写的东西落了盘", async () => {
  expect(DEFAULT_EXTRACT_EVERY_TURNS).toBe(3); // 下面的「三轮」都按它写
  const dir = new InMemoryDir();
  const extract = scriptedStreamFn([
    toolTurn("m1", "memory", { command: "create", path: "session/memory/answer-style.md", file_text: "---\ndescription: 用户要简短回答\n---\n\n回答保持简短。" }),
    textTurn("记下了。"),
  ]);
  const { fn, extracts } = recording({ extract });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(dir) });

  await say(agent, "以后回答简短一点，别铺垫", "这个函数是干什么的，说两句就行", "好，就这样，先到这里吧");

  expect(await until(async () => (await dir.read("memory/answer-style.md")) !== null), "提取没有把记忆写下来").toBe(true);
  const first = extracts[0]!;
  expect(JSON.stringify(first.messages.slice(0, -1))).toContain("以后回答简短一点"); // 对话就在上文，不再抄进指令
  expect(instructionOf(first)).not.toContain("这个函数是干什么的");
  expect(instructionOf(first)).toContain("the last 6 messages"); // 三问三答
  expect(instructionOf(first)).toContain("«以后回答简短一点，别铺垫»");
  expect(await dir.read("memory/answer-style.md")).toContain("回答保持简短");
});

test("提取请求的前缀与前台最后一次请求逐字相同：同一份 system、同一份工具菜单，消息是它的延续（厂商前缀缓存接得上）", async () => {
  const { fn, extracts, foreground } = recording();
  const dir = new InMemoryDir();
  await dir.write("user.md", "回答要简短"); // 记忆里有东西：前台的请求最前面有那条记忆正文，提取也得原样带着
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(dir) });
  await mountBuiltinTools(agent); // 主菜单上真有 memory 工具：提取换掉的是同一位置上的同名工具

  await say(agent, ...THREE);
  await idleExtract(agent);

  expect(extracts).toHaveLength(1);
  const last = foreground.at(-1)!;
  const ex = extracts[0]!;
  expect(JSON.stringify(last.messages[0])).toContain("# Memory contents");
  expect(JSON.stringify(last.messages[0])).toContain("回答要简短");
  expect(ex.systemPrompt).toBe(last.systemPrompt);
  expect(ex.tools).toEqual(last.tools);
  expect(ex.tools.map((t) => t.name)).toContain("memory");
  expect(ex.messages.slice(0, last.messages.length)).toEqual(last.messages);
  expect(ex.messages).toHaveLength(last.messages.length + 2); // 最后那条回答 + 提取指令
});

test("提取只有记忆工具能执行：菜单上别的工具照样摆着（前缀要一致），点名就被拒、不会真跑", async () => {
  let ran = 0;
  const spy: ModelTool = {
    kind: "model",
    name: "spy",
    label: "spy",
    description: "会动东西的工具",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      ran += 1;
      return toolOk("ran");
    },
  };
  const { fn, extracts } = recording({ extract: scriptedStreamFn([toolTurn("s1", "spy", {}), textTurn("没什么可记的。")]) });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()), tools: [spy] });

  await say(agent, ...THREE);
  await idleExtract(agent);

  expect(ran).toBe(0);
  expect(extracts[0]!.tools.map((t) => t.name)).toContain("spy");
  expect(JSON.stringify(extracts[1]!.messages)).toContain("not available while reviewing memory");
});

test("没攒满三轮不跑：两轮各自过了词数门槛也一次不起；第三轮来了，从第一轮看起", async () => {
  const { fn, extracts } = recording();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await say(agent, THREE[0]!, THREE[1]!);
  await idleExtract(agent);
  expect(extracts).toHaveLength(0);

  await say(agent, THREE[2]!);
  await idleExtract(agent);
  expect(extracts).toHaveLength(1);
  expect(instructionOf(extracts[0]!)).toContain(`«${THREE[0]}»`);
});

test("最后一句答完就退出：stop() 先把没攒满的那段补提取一次再收摊（此前直接中止，那一轮永远不会被提取）", async () => {
  const { fn, extracts } = recording();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await agent.prompt("以后提交前先跑一遍全量测试，别只跑窄的");
  await idleExtract(agent);
  expect(extracts).toHaveLength(0); // 只有一轮：没攒满

  await agent.stop();
  expect(extracts).toHaveLength(1); // stop() 返回之前已经提取过
  expect(instructionOf(extracts[0]!)).toContain("«以后提交前先跑一遍全量测试，别只跑窄的»");
});

test("退出前补跑那次卡住：stop() 最多等 DEFAULT_EXTRACT_DRAIN_MS，到点照常收摊、提取被中止", async () => {
  const clock = new FakeClock();
  let reached = (): void => {};
  const started = new Promise<void>((r) => {
    reached = r;
  });
  // 卡在模型调用上，只认中止
  const hang: StreamFn = (_model, _context, options) =>
    new Promise((_resolve, reject) => {
      reached();
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const { fn } = recording({ extract: hang });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()), clock });
  await agent.prompt("以后提交前先跑一遍全量测试，别只跑窄的");

  let stopped = false;
  const stopping = agent.stop().then(() => {
    stopped = true;
  });
  await started;
  await new Promise((r) => setTimeout(r, 20));
  expect(stopped).toBe(false); // 在等补跑那次

  clock.advance(DEFAULT_EXTRACT_DRAIN_MS);
  await stopping;
  expect(stopped).toBe(true);
});

test("stop() 时整理正在跑：先中止整理，补的那次提取照样跑完（此前补跑排在整理后面，到点和整理一起被中止，最后那段没人看）", async () => {
  const clock = new FakeClock(); // 补跑上限不会自己到点：补跑要是排在整理后面，stop() 就一直等着
  const mem = createAgentMemories({ memories: [agentMemory, userMemory, notesMemory], dream: { minWritesSinceLast: 0 } });
  bindMemoryScopes(mem, memoryScopeTable(ONE_LAYER.map((def) => ({ def, dir: new InMemoryDir() }))));
  let dreamReached = (): void => {};
  const dreamStarted = new Promise<void>((r) => {
    dreamReached = r;
  });
  let dreamAborted = false;
  const extracts: string[] = [];
  const fn: StreamFn = (model, context, options) => {
    const seen = JSON.stringify(context.messages);
    if (seen.includes("Consolidate the")) {
      // 整理卡在模型调用上，只认中止
      return new Promise((_resolve, reject) => {
        dreamReached();
        options?.signal?.addEventListener("abort", () => {
          dreamAborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
    if (seen.includes(EXTRACT_PROMPT_OPENING)) extracts.push(seen);
    return scriptedStreamFn([textTurn(seen.includes(EXTRACT_PROMPT_OPENING) ? "没什么可记的。" : "好的")])(model, context, options);
  };
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: mem, autoDream: true, clock });

  await agent.prompt("以后提交前先跑一遍全量测试，别只跑窄的"); // 只有一轮：平时不提取，回到 idle 起整理
  await dreamStarted;

  const stopped = await Promise.race([agent.stop().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1_000))]);
  expect(stopped).toBe(true);
  expect(dreamAborted).toBe(true);
  expect(extracts).toHaveLength(1);
  expect(extracts[0]).toContain("以后提交前先跑一遍全量测试");
});

test("前台这轮自己写过记忆：这一轮不单独起提取，游标也不动——下一次连它一起看（批量之后再推游标就把攒着的几轮丢了）", async () => {
  const foreground = scriptedStreamFn([
    textTurn("好的"),
    textTurn("好的"),
    toolTurn("m1", "memory", { command: "create", path: "session/memory/test-runner.md", file_text: "---\ndescription: 测试用 bun 跑\n---\n\n测试一律用 bun 跑。" }),
    textTurn("记下了。"),
    textTurn("好的"),
  ]);
  const { fn, extracts } = recording({ foreground });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });
  await mountBuiltinTools(agent); // 前台要真有 memory 工具可调（`echo:memory` builtin 注册它）

  await say(agent, THREE[0]!, THREE[1]!, "记住：我们的分支名一律用英文");
  await idleExtract(agent);
  expect(extracts).toHaveLength(0); // 第三轮前台写过：这一轮不单独起

  await say(agent, "第四件事：发版前先看 CI");
  await idleExtract(agent);
  expect(extracts).toHaveLength(1);
  expect(instructionOf(extracts[0]!)).toContain(`«${THREE[0]}»`); // 从第一轮看起：游标没被推过去
  expect(JSON.stringify(extracts[0]!.messages)).toContain("session/memory/test-runner.md"); // 前台那次写入就在上文里
});

test("前台这轮只 view 了记忆：读不算写，这一轮照常算进提取（2026-11-03 用户报：读记忆被当成写，那一轮被跳过）", async () => {
  const foreground = scriptedStreamFn([
    textTurn("好的"),
    textTurn("好的"),
    toolTurn("v1", "memory", { command: "view", path: "session/memory/" }),
    textTurn("看过了，没有相关记录。"),
  ]);
  const { fn, extracts } = recording({ foreground });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });
  await mountBuiltinTools(agent);

  await say(agent, THREE[0]!, THREE[1]!, "我们之前记过分支命名的规矩吗？查一下");
  await idleExtract(agent);

  expect(extracts).toHaveLength(1); // 第三轮只读：照常攒满三轮就提取
  expect(instructionOf(extracts[0]!)).toContain(`«${THREE[0]}»`);
});

/* ───────── 2026-11-03：stale_read 冲突——提取那把工具的账、提取与整理排成一条 ───────── */

test("前台 view 过的文件，分叉出来的提取直接覆写就放行：账从前台克隆过来（此前空账起步，一覆写就是 not_read，5 轮白花一轮）", async () => {
  const dir = new InMemoryDir();
  const mem = memoriesOn(dir);
  await memoryCreate(mem, "session/memory/a.md", "---\ndescription: 测试怎么跑\n---\n\n测试用 npm 跑。");
  const foreground = scriptedStreamFn([toolTurn("v1", "memory", { command: "view", path: "session/memory/a.md" }), textTurn("看过了"), textTurn("好的"), textTurn("好的")]);
  const extract = scriptedStreamFn([
    toolTurn("w1", "memory", { command: "create", path: "session/memory/a.md", file_text: "---\ndescription: 测试怎么跑\n---\n\n测试一律用 bun 跑。" }),
    textTurn("改好了。"),
  ]);
  const { fn, extracts } = recording({ foreground, extract });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: mem });
  await mountBuiltinTools(agent);

  await say(agent, "我们的测试是怎么跑的？查一下记忆", "改成一律用 bun 跑，别再用 npm 了", "好，就这样定了吧");
  await idleExtract(agent);

  expect(extracts.length).toBeGreaterThan(0);
  expect(await dir.read("memory/a.md")).toContain("一律用 bun 跑");
  expect(JSON.stringify(extracts)).not.toContain("have not viewed it");
});

test("提取指令里全文展示过的常驻文件，提取直接覆写就放行：账上预记了那一版", async () => {
  const dir = new InMemoryDir();
  const mem = memoriesOn(dir);
  await memoryCreate(mem, "session/user.md", "用户偏好长回答。");
  const extract = scriptedStreamFn([toolTurn("w1", "memory", { command: "create", path: "session/user.md", file_text: "用户偏好三句以内的回答。" }), textTurn("改好了。")]);
  const { fn } = recording({ extract });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: mem });

  await say(agent, ...THREE);
  await idleExtract(agent);

  expect(await dir.read("user.md")).toBe("用户偏好三句以内的回答。");
});

test("提取与整理排成一条：提取还在跑时整理不起模型调用，提取跑完它才开始（同一层并发写会互相 stale_read）", async () => {
  const dir = new InMemoryDir();
  const mem = createAgentMemories({ memories: [agentMemory, userMemory, notesMemory], dream: { minWritesSinceLast: 1 } });
  bindMemoryScopes(mem, memoryScopeTable(ONE_LAYER.map((def) => ({ def, dir }))));
  const order: string[] = [];
  let release = (): void => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let reached = (): void => {};
  const extractStarted = new Promise<void>((r) => {
    reached = r;
  });
  const fn: StreamFn = async (model, context, options) => {
    const seen = JSON.stringify(context.messages);
    if (seen.includes(EXTRACT_PROMPT_OPENING)) {
      order.push("extract:start");
      reached();
      await held;
      order.push("extract:end");
      return scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
    }
    if (seen.includes("Consolidate the")) {
      order.push("dream");
      return scriptedStreamFn([textTurn("整理完了。")])(model, context, options);
    }
    return scriptedStreamFn([textTurn("好的")])(model, context, options);
  };
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: mem, autoDream: true });

  await say(agent, THREE[0]!, THREE[1]!);
  await memoryCreate(mem, "session/memory/a.md", "---\ndescription: 甲\n---\n\n甲"); // 第三轮回到 idle 时整理的门才满
  await say(agent, THREE[2]!);
  await extractStarted;
  await new Promise((r) => setTimeout(r, 50)); // 给整理抢跑的机会
  expect(order).toEqual(["extract:start"]);

  release();
  expect(await until(async () => order.includes("dream")), "整理一直没起来").toBe(true);
  expect(order).toEqual(["extract:start", "extract:end", "dream"]);
});

test("提取还在跑时又攒满一批 → 跑完再跑的那次从新的一批看起，不是把旧材料再提取一遍", async () => {
  let release = (): void => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let reached = (): void => {};
  const firstExtractStarted = new Promise<void>((r) => {
    reached = r;
  });
  let n = 0;
  const extract: StreamFn = async (model, context, options) => {
    if (n++ === 0) {
      reached();
      await held;
    }
    return scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
  };
  const { fn, extracts } = recording({ extract });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await say(agent, ...THREE);
  await firstExtractStarted; // 第一次提取卡在模型调用上，通道忙着
  await say(agent, "第四句：再帮我查一下调用它的地方", "第五句：顺便看看测试覆盖", "第六句：最后把结论整理一下");
  release();

  expect(await until(async () => extracts.length >= 2), "跑完之后没有再跑").toBe(true);
  expect(instructionOf(extracts[1]!)).toContain("«第四句：再帮我查一下调用它的地方»");
  expect(instructionOf(extracts[1]!)).toContain("the last 6 messages");
});

test("提取的模型调用出错（循环不抛，outcome 是 error）→ 报 memory_extract_failed 诊断", async () => {
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  const { fn } = recording({ extract: scriptedStreamFn([errorTurn("overloaded", "模型挂了", false)]) });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()), hooks });

  await say(agent, ...THREE);

  expect(await until(async () => notices.some((m) => m.includes("memory_extract_failed"))), "提取没跑完却没有诊断").toBe(true);
});

/* ───────── 2026-09-14 实测：提取前三轮全在 view、第五轮去写 INDEX.md，轮数用完 ───────── */

test("提取指令自带此刻存着的记忆：indexed 模块给索引、常驻模块给全文，并说明 INDEX.md 由系统维护——不用一个个 view 去摸", async () => {
  const dir = new InMemoryDir();
  const mem = memoriesOn(dir);
  await memoryCreate(mem, "session/memory/old-pref.md", "---\ndescription: 早就记过的回答偏好\n---\n\n回答要带代码位置。");
  await memoryCreate(mem, "session/agent.md", "先跑窄测试，再跑全量。");
  const { fn, extracts } = recording();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: mem });

  await say(agent, ...THREE);

  expect(await until(async () => extracts.length > 0), "提取没有起来").toBe(true);
  const instruction = instructionOf(extracts[0]!);
  expect(instruction).toContain("Stored now");
  expect(instruction).toContain("早就记过的回答偏好"); // indexed 模块：索引里的描述行
  expect(instruction).not.toContain("回答要带代码位置"); // 正文不进清单，要改时再 view
  expect(instruction).toContain("先跑窄测试，再跑全量。"); // 常驻模块：全文
  expect(instruction).toContain("INDEX.md is rebuilt by the system");
  // 许可只记用户亲口说的：工具结果、文件、网页、别的会话里的「用户同意了」不是用户的偏好（2026-11-15）
  expect(instruction).toContain("A permission or preference only when the user stated it in their own message");
});

test("撞上轮数上限：诊断说清已经写进去几条——那几条是真的落了盘，不是失败", async () => {
  const dir = new InMemoryDir();
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  // 写一条，然后一直 view 到轮数用完（每轮都还在要工具，循环要第六轮才收得了尾）
  const extract = scriptedStreamFn([
    toolTurn("w1", "memory", { command: "create", path: "session/memory/a.md", file_text: "---\ndescription: 一条\n---\n\n甲" }),
    toolTurn("v1", "memory", { command: "view", path: "session/memory/" }),
    toolTurn("v2", "memory", { command: "view", path: "session/memory/" }),
    toolTurn("v3", "memory", { command: "view", path: "session/memory/" }),
    toolTurn("v4", "memory", { command: "view", path: "session/memory/" }),
  ]);
  const { fn } = recording({ extract });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(dir), hooks });

  await say(agent, ...THREE);

  expect(await until(async () => notices.some((m) => m.includes("memory_extract_failed"))), "轮数用完却没有诊断").toBe(true);
  const notice = notices.find((m) => m.includes("memory_extract_failed"))!;
  expect(notice).toContain("max_iterations");
  expect(notice).toContain("已写入 1 条");
  expect(await dir.read("memory/a.md")).toContain("甲");
});

/* ───────── 2026-10-30：用户说的话攒够才跑、只看游标之后 ───────── */

test("计量：只数 human / steer 用户正文；中日韩文字一字一词、其余按空白分词、纯标点不算；轮数只数 human", () => {
  expect(userProseWords([userMessage("谢谢")])).toBe(2);
  expect(userProseWords([userMessage("OK.")])).toBe(1);
  expect(userProseWords([userMessage("Use pnpm, not npm !")])).toBe(4);
  expect(userProseWords([userMessage("别用 npm")])).toBe(3);
  expect(userProseWords([userMessage("插一句：先别提交", "steer")])).toBe(7);
  // 不算的：harness 插话、助手回复、工具输出、环境消息
  const noise = [
    userMessage("请继续把任务做完", "harness"),
    assistantMessage([{ type: "text", text: "我读了一个很长很长的文件" }], "end_turn"),
    toolResultMessage("t1", "read_file", "大段文件内容大段文件内容", false),
    environmentMessage("后台任务结束了", "background"),
  ];
  expect(userProseWords(noise)).toBe(0);
  expect(DEFAULT_EXTRACT_MIN_USER_WORDS).toBeGreaterThan(userProseWords([userMessage("好的，谢谢")])); // 致谢挡得住
  // 轮数：steer 是同一轮里的插话，harness 不是用户说的
  expect(humanTurns([userMessage("一"), userMessage("插一句", "steer"), userMessage("二"), ...noise])).toBe(2);
});

test("致谢、确认凑满三轮也不触发；攒着不丢——下一句有内容的话出现时，从第一句致谢看起", async () => {
  const { fn, extracts } = recording();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await say(agent, "谢谢", "OK", "嗯");
  await idleExtract(agent);
  expect(extracts).toHaveLength(0); // 三轮够了，话不够：一次模型调用都没起

  await say(agent, "以后提交前先跑一遍全量测试");
  await idleExtract(agent);
  expect(extracts).toHaveLength(1);
  expect(instructionOf(extracts[0]!)).toContain("«谢谢»"); // 攒着的那几轮一起看
  expect(instructionOf(extracts[0]!)).toContain("the last 8 messages");
});

test("只看游标之后：跑完一次，下一次从新的那一批看起", async () => {
  const { fn, extracts } = recording();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await say(agent, ...THREE);
  await idleExtract(agent);
  await say(agent, "第四件事：发版前先看 CI", "第五件事：文档改完跑 docs-lint", "第六件事：别用 sed 批量改名");
  await idleExtract(agent);

  expect(extracts).toHaveLength(2);
  expect(instructionOf(extracts[1]!)).toContain("«第四件事：发版前先看 CI»");
  expect(instructionOf(extracts[1]!)).toContain("the last 6 messages");
});

test("提取没跑完（模型出错）游标不动：下一轮就把那段连同新的一轮重看一遍（攒着的已经够三轮）", async () => {
  let calls = 0;
  const flaky: StreamFn = (model, context, options) =>
    calls++ === 0 ? scriptedStreamFn([errorTurn("overloaded", "模型挂了", false)])(model, context, options) : scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
  const { fn, extracts } = recording({ extract: flaky });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await say(agent, ...THREE);
  await idleExtract(agent);
  await say(agent, "第四件事：发版前先看 CI");
  await idleExtract(agent);

  expect(extracts).toHaveLength(2);
  expect(instructionOf(extracts[1]!)).toContain(`«${THREE[0]}»`); // 第一次没跑完，那段还在
  expect(instructionOf(extracts[1]!)).toContain("the last 8 messages");
});

/* ───────── 2026-11-12：节奏与轮数上限读记忆包上的设置（产品经 memory.extract 配） ───────── */

test("配了 everyTurns 1、minUserWords 0：一句「ok」就起提取（缺省要攒满三轮、八个词）", async () => {
  const { fn, extracts } = recording();
  const memory = memoriesOn(new InMemoryDir(), { ...DEFAULT_EXTRACT_SETTINGS, everyTurns: 1, minUserWords: 0 });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory });

  await say(agent, "ok");
  await idleExtract(agent);

  expect(extracts).toHaveLength(1);
  expect(instructionOf(extracts[0]!)).toContain("«ok»");
});

test("配了 maxTurns 2：提取子循环第二次模型调用之后就到上限（缺省 5）", async () => {
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  let n = 0;
  const viewing: StreamFn = (model, context, options) => scriptedStreamFn([toolTurn(`v${n++}`, "memory", { command: "view", path: "session/memory/" })])(model, context, options);
  const { fn, extracts } = recording({ extract: viewing });
  const memory = memoriesOn(new InMemoryDir(), { ...DEFAULT_EXTRACT_SETTINGS, maxTurns: 2 });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory, hooks });

  await say(agent, ...THREE);
  await idleExtract(agent);

  expect(extracts).toHaveLength(2);
  expect(notices.some((m) => m.includes("memory_extract_failed") && m.includes("max_iterations"))).toBe(true);
});

/* ───────── 2026-11-12：没跑完时游标推不推看写成了没有，连续没写成就放弃那段 ───────── */

const NEXT_THREE = ["第四件事：发版前先看 CI", "第五件事：文档改完跑 docs-lint", "第六件事：别用 sed 批量改名"];

/** 每次提取的第一次模型调用：最后一条就是提取指令（之后几次调用的最后一条是工具结果）。 */
function extractStarts(extracts: readonly Context[]): Context[] {
  return extracts.filter((c) => JSON.stringify(c.messages.at(-1)).includes(EXTRACT_PROMPT_OPENING));
}

test("撞上轮数上限、但写成过一条：游标不动，下一次连同那段一起重看、指令说清上次停在半路（2026-11-17 改：此前写成过就算看过、游标照推，没写到的那部分再没人看）", async () => {
  const view = (id: string) => toolTurn(id, "memory", { command: "view", path: "session/memory/" });
  const extract = scriptedStreamFn([
    toolTurn("w1", "memory", { command: "create", path: "session/memory/a.md", file_text: "---\ndescription: 一条\n---\n\n甲" }),
    view("v1"),
    view("v2"),
    view("v3"),
    view("v4"), // 第五轮还在要工具：要第六轮才收得了尾，撞上限
    textTurn("没什么可记的。"),
  ]);
  const { fn, extracts } = recording({ extract });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await say(agent, ...THREE);
  await idleExtract(agent);
  await say(agent, ...NEXT_THREE);
  await idleExtract(agent);

  const starts = extractStarts(extracts);
  expect(starts).toHaveLength(2);
  expect(instructionOf(starts[1]!)).toContain(`«${THREE[0]}»`);
  expect(instructionOf(starts[1]!)).toContain("review it from the start"); // 游标还在开头：部分完成那段没算看过
  expect(instructionOf(starts[1]!)).toContain("An earlier review of this part stopped before it finished");
});

test("一条没写成就撞上限：下一次重看那段；连续两次都这样就放弃那段（报 memory_extract_gave_up），再下一次从之后的内容看起", async () => {
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  let n = 0;
  // 每次都只 view、从不写：每次提取都把 5 轮用完、一条没写成
  const viewing: StreamFn = (model, context, options) => scriptedStreamFn([toolTurn(`v${n++}`, "memory", { command: "view", path: "session/memory/" })])(model, context, options);
  const { fn, extracts } = recording({ extract: viewing });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()), hooks });

  await say(agent, ...THREE); // 第一次：没写成，游标不动
  await idleExtract(agent);
  await say(agent, NEXT_THREE[0]!); // 那段已攒够三轮：这一轮就重看（第二次），又没写成 → 放弃，游标推到这里
  await idleExtract(agent);
  await say(agent, NEXT_THREE[1]!, NEXT_THREE[2]!, "第七件事：周五不发版"); // 从放弃之后攒满三轮
  await idleExtract(agent);

  const starts = extractStarts(extracts);
  expect(starts).toHaveLength(3);
  expect(instructionOf(starts[0]!)).toContain(`«${THREE[0]}»`);
  expect(instructionOf(starts[1]!)).toContain(`«${THREE[0]}»`); // 重看一次
  expect(instructionOf(starts[2]!)).toContain(`«${NEXT_THREE[1]}»`); // 放弃之后从新的看起
  expect(notices.filter((m) => m.includes("memory_extract_gave_up"))).toHaveLength(1);
});

test("提取被 contextBeforeBuild hook 拦下（signal 没动）：照没跑完算——报诊断、连续两次就放弃那段（此前当成收摊：每条 reply 都重装一遍再被拦，没有诊断、永远到不了放弃）", async () => {
  const notices: string[] = [];
  const hooks = new HookRuntime();
  hooks.on("notification", (e) => {
    notices.push(e.message);
  });
  let blocked = 0;
  // 只拦提取那条子循环的送模（产品的花费上限、内容守卫就是这个形状）：最后一条是提取指令
  hooks.on("contextBeforeBuild", (e) => {
    if (!JSON.stringify(e.messages.at(-1)).includes(EXTRACT_PROMPT_OPENING)) return undefined;
    blocked++;
    return { decision: "block" as const, reason: "花费上限" };
  });
  const { fn, extracts } = recording({ extract: scriptedStreamFn([textTurn("没什么可记的。")]) });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()), hooks });

  await say(agent, ...THREE); // 第一次被拦：没跑完，游标不动
  await idleExtract(agent);
  await say(agent, NEXT_THREE[0]!); // 那段已攒够三轮：这一轮重看，又被拦 → 放弃
  await idleExtract(agent);
  await say(agent, NEXT_THREE[1]!); // 放弃之后还没攒够三轮：不再起提取
  await idleExtract(agent);

  expect(blocked).toBe(2);
  expect(extracts).toHaveLength(0); // 一次都没送到模型
  expect(notices.filter((m) => m.includes("被 hook 拦下（花费上限）"))).toHaveLength(2);
  expect(notices.filter((m) => m.includes("memory_extract_gave_up"))).toHaveLength(1);
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
  const { fn, extracts } = recording({ extract: slow });
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });

  await say(agent, "旧对话一：我们的测试一律用 bun 跑", "旧对话二：提交信息写中文", "旧对话三：合并前跑全量");
  await started; // 提取卡在模型调用上
  agent.reset();
  release();
  await idleExtract(agent);

  await say(agent, "新对话一：分支名用英文", "新对话二：发版前看 CI", "新对话三：文档改完跑 lint");
  await idleExtract(agent);
  expect(extracts).toHaveLength(2);
  // 新对话 6 条：要是旧那次把游标推到了它的 6，这一批就会被当成「已经看过」整段跳过
  expect(instructionOf(extracts[1]!)).toContain("«新对话一：分支名用英文»");
});

test("提取子循环不做自动压缩：主对话在最后那条回答之后越过触发线，分叉出来的提取照样只发一次请求，不先压一遍；压缩通知也不进主 hooks", async () => {
  const kinds: string[] = [];
  const longAnswer = "word ".repeat(400); // ≈ 500 token
  let foreground = 0;
  const fn: StreamFn = (model, context, options) => {
    const last = JSON.stringify(context.messages.at(-1));
    const kind = last.includes(COLLAPSE_PROMPT_OPENING) ? "collapse" : last.includes(SUMMARY_PROMPT_OPENING) ? "summary" : isExtract(context) ? "extract" : "foreground";
    kinds.push(kind);
    if (kind === "collapse" || kind === "summary") return scriptedStreamFn([textTurn("<summary>S</summary>")])(model, context, options);
    if (kind === "extract") return scriptedStreamFn([textTurn("没什么可记的。")])(model, context, options);
    foreground += 1;
    return scriptedStreamFn([textTurn(foreground === 3 ? longAnswer : "ok")])(model, context, options);
  };
  // 窗口按 system 定：第三轮轮首没过线（≈ sys + 40），第三条回答之后过线（≈ sys + 540）
  const probe = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });
  await mountBuiltinTools(probe);
  const sys = estimateText(await probe.assemblePrompt());
  const overhead = fixedOverhead(visibleTools(probe.tools, new Set()), []); // 工具 schema 也算进占用
  kinds.length = 0;
  foreground = 0;
  const reserve = 100;
  const model: Model = { ...FAKE_MODEL, capabilities: { contextWindow: sys + overhead + 450 + reserve } };
  const hooks = new HookRuntime();
  const compactionHooks: string[] = [];
  hooks.on("postCompact", () => void compactionHooks.push("postCompact"));
  hooks.on("compactionFailed", () => void compactionHooks.push("compactionFailed"));
  const agent = new Agent({ model, streamFunction: fn, hooks, memory: memoriesOn(new InMemoryDir()), compaction: { reserveTokens: reserve, keepRecentTokens: 40 } });
  await mountBuiltinTools(agent);
  await say(agent, ...THREE);
  await until(async () => kinds.includes("extract"));
  await idleExtract(agent);
  expect(kinds).toEqual(["foreground", "foreground", "foreground", "extract"]);
  expect(compactionHooks).toEqual([]);
  // 主循环自己下一轮照常压（这是它的事）
  await agent.prompt("第四件事：接着来");
  expect(kinds.slice(4, 5)).toEqual(["collapse"]);
  expect(compactionHooks).toEqual(["postCompact"]);
});

test("三种结局分得清（2026-11-16，2026-11-17 部分完成改成不推游标）：会话里的游标记录带上正常结束 / 部分完成 / 失败后放弃、写了几条、停下的原因码；观测每次跑了的提取都记一条（含没看完待重看）", async () => {
  const create = (id: string, path: string) => toolTurn(id, "memory", { command: "create", path, file_text: "---\ndescription: 一条\n---\n\n内容" });
  const view = (id: string) => toolTurn(id, "memory", { command: "view", path: "session/memory/" });
  // 每次提取一份剧本：最后一条消息是那条提取指令，就是新的一次开始
  const attempts = [
    [create("w1", "session/memory/a.md"), textTurn("记好了。")], // 正常结束，写了 1 条
    [create("w2", "session/memory/b.md"), view("v1"), view("v2"), view("v3"), view("v4")], // 写了 1 条后撞轮数上限：部分完成，游标不动
    [view("x1"), view("x2"), view("x3"), view("x4"), view("x5")], // 重看那段，一条没写成：连续两次没看完，放弃——这一串写过，记部分完成
    [view("y1"), view("y2"), view("y3"), view("y4"), view("y5")], // 下一段一条没写成：游标不动
    [view("z1"), view("z2"), view("z3"), view("z4"), view("z5")], // 又没写成：放弃——这一串没写过，记失败后放弃
  ];
  let current: StreamFn | undefined;
  let next = 0;
  const extract: StreamFn = (model, context, options) => {
    if (JSON.stringify(context.messages.at(-1)).includes(EXTRACT_PROMPT_OPENING)) current = scriptedStreamFn(attempts[next++]!);
    return current!(model, context, options);
  };
  const { fn } = recording({ extract });
  const store = new InMemoryDir();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()), sessionService: new SessionService(store), sessionId: "s1" });
  await agent.start();
  const facts: { kind: string; outcome?: string; written?: number; reasonCode?: string }[] = [];
  (agent as unknown as { memoryActivity: { offer(f: unknown): void } }).memoryActivity = { offer: (f) => void facts.push(f as (typeof facts)[number]) };

  await say(agent, ...THREE);
  await idleExtract(agent);
  await say(agent, ...NEXT_THREE);
  await idleExtract(agent);
  await say(agent, "第七件事：周五不发版");
  await idleExtract(agent); // 重看部分完成的那段，没写成：放弃
  await say(agent, "第八件事：先写测试再改代码", "第九件事：评审意见当天回", "第十件事：发版说明写中文");
  await idleExtract(agent); // 没写成：游标不动
  await say(agent, "第十一件事：回滚先发公告");
  await idleExtract(agent); // 重看那段，又没写成：放弃
  await agent.stop();

  const reviewed: Record<string, unknown>[] = [];
  for (const name of (await store.list("entries/")).sort()) {
    const entry = JSON.parse((await store.read(name))!) as Record<string, unknown>;
    if (entry.kind === "memory_reviewed") reviewed.push({ outcome: entry.outcome, written: entry.written, ...(entry.reason === undefined ? {} : { reason: entry.reason }) });
  }
  expect(reviewed).toEqual([
    { outcome: "completed", written: 1 },
    { outcome: "partial", written: 1, reason: "max_iterations" },
    { outcome: "abandoned", written: 0, reason: "max_iterations" },
  ]);
  expect(facts.filter((f) => f.kind === "extract_finished").map((f) => [f.outcome, f.written, f.reasonCode])).toEqual([
    ["completed", 1, undefined],
    ["partial", 1, "max_iterations"],
    ["abandoned", 0, "max_iterations"],
    ["failed", 0, "max_iterations"],
    ["abandoned", 0, "max_iterations"],
  ]);
});

test("部分完成不推游标（2026-11-17）：写了一部分就停的那段下次接着看——指令从那段第一句看起、说清上次停在半路；补完才推游标，记下这段一共写成几条", async () => {
  const create = (id: string, path: string) => toolTurn(id, "memory", { command: "create", path, file_text: "---\ndescription: 一条\n---\n\n内容" });
  const view = (id: string) => toolTurn(id, "memory", { command: "view", path: "session/memory/" });
  const attempts = [
    [create("w1", "session/memory/a.md"), view("v1"), view("v2"), view("v3"), view("v4")], // 写了 1 条后撞轮数上限
    [create("w2", "session/memory/b.md"), textTurn("补完了。")], // 接着补完
  ];
  const instructions: string[] = [];
  let current: StreamFn | undefined;
  let next = 0;
  const extract: StreamFn = (model, context, options) => {
    if (JSON.stringify(context.messages.at(-1)).includes(EXTRACT_PROMPT_OPENING)) {
      instructions.push(instructionOf(context));
      current = scriptedStreamFn(attempts[next++]!);
    }
    return current!(model, context, options);
  };
  const { fn } = recording({ extract });
  const store = new InMemoryDir();
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()), sessionService: new SessionService(store), sessionId: "s1" });
  await agent.start();

  await say(agent, ...THREE);
  await idleExtract(agent); // 部分完成：游标不动
  await say(agent, "第四件事：发版前先看 CI");
  await idleExtract(agent); // 重看那段，补完
  await agent.stop();

  expect(instructions).toHaveLength(2);
  expect(instructions[0]).not.toContain("stopped before it finished");
  expect(instructions[1]).toContain(`«${THREE[0]}»`); // 从部分完成那段的第一句看起，不是从第四件事
  expect(instructions[1]).toContain("An earlier review of this part stopped before it finished");
  const reviewed: Record<string, unknown>[] = [];
  for (const name of (await store.list("entries/")).sort()) {
    const entry = JSON.parse((await store.read(name))!) as Record<string, unknown>;
    if (entry.kind === "memory_reviewed") reviewed.push({ outcome: entry.outcome, written: entry.written });
  }
  expect(reviewed).toEqual([{ outcome: "completed", written: 2 }]);
});
