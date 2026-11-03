import { test, expect } from "bun:test";
import { Agent } from "../src/agent.ts";
import { bindMemoryScopes, createAgentMemories, memoryCreate, type AgentMemories } from "../src/memory/harness.ts";
import { memoryScopeTable, type MemoryScopeDef } from "../src/memory/scope.ts";
import { agentMemory, notesMemory, userMemory } from "../src/memory/types.ts";
import {
  DEFAULT_EXTRACT_DRAIN_MS,
  DEFAULT_EXTRACT_EVERY_TURNS,
  DEFAULT_EXTRACT_MIN_USER_WORDS,
  EXTRACT_PROMPT_OPENING,
  humanTurns,
  userProseWords,
} from "../src/memory/extract.ts";
import { assistantMessage, environmentMessage, toolResultMessage, userMessage, type Context } from "../src/messages.ts";
import type { StreamFn } from "../src/provider/types.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import { FakeClock } from "../src/schedule/clock.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import { errorTurn, FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";

// 记忆提取的端到端判据。
//
// 2026-09-14：d346b56 起提取从来没真跑过（取 transcript 的下标越界恒为空），当时的测试只测 prompt 文本与写入并发，
// 门一直是绿的。所以判据落在可观察的事上：模型收到了提取请求、它用记忆工具写的东西真的落了盘。
// 2026-11-03：提取改为从主对话分叉（前缀与前台最后一次请求逐字相同）、攒满三轮才跑、退出前补一次。
// 「对话不在提取 prompt 里」是新形状的本意——对话在上文；判据改看「从哪句开始看」与前缀是否一致。

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
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: fn, memory: memoriesOn(new InMemoryDir()) });
  await mountBuiltinTools(agent); // 主菜单上真有 memory 工具：提取换掉的是同一位置上的同名工具

  await say(agent, ...THREE);
  await idleExtract(agent);

  expect(extracts).toHaveLength(1);
  const last = foreground.at(-1)!;
  const ex = extracts[0]!;
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
