// TUI 的判据：**它是投影，不是第二个 Agent**。
//
// 所以测的是「事件进来 → 屏幕上出现什么」，不是「Agent 有没有跑对」（那归 core 的测试）。
// 用一个假 TUI 接住 pi-tui 的 `TUI` 接口，就能在没有真终端的进程里断言渲染结果——
// 真终端只在 `bin/echo-tui.ts` 里出现，测试一行都不碰它。

import { test, expect } from "bun:test";
import { Agent, deepseekProvider, InMemoryCredentialStore, kimiProvider, NO_SESSION_FACE, type CredentialStore, type Model, type ProviderEvent, type SessionFace, type SessionRow } from "@echo-agent/core";
import { agentRuntimeOf, type AgentRuntime } from "@echo-agent/core/extension";
import { scriptedStreamFn, textTurn, toolTurn } from "@echo-agent/core/testing";
import { CURSOR_MARKER, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { runTui, type TuiConfigureOptions } from "../src/app.ts";
import { fakeTui } from "../src/testing.ts";
import { Transcript } from "../src/transcript.ts";

/**
 * 假 TUI：只记「谁被挂上去、渲染成什么、输入监听器是谁」。
 *
 * **一次 `feed()` = 终端的一次数据到达**：真终端逐键送达（文本一段、回车一段），
 * 粘贴才是一整块。所以测试里回车要单独喂——把 `"文本\r"` 当一块喂等于模拟了一次不存在的输入。
 */
/** 推进微任务：假 TUI 不驱动事件循环。 */
async function flush(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/**
 * 退出：先 Ctrl+C 清空输入行，再 Ctrl+D。**键位照 pi 之后**（P0）Ctrl+C 是清空、Ctrl+D 才是退出，
 * 而且 Ctrl+D 只在输入行为**空**时退出——有字时它是向前删一个字符。所以两下都要按。
 */
function quit(ui: ReturnType<typeof fakeTui>): void {
  ui.feed(String.fromCharCode(3));
  ui.feed(String.fromCharCode(4));
}

function agentWith(turns: ReturnType<typeof textTurn>[], model: Partial<Model> = {}): Agent {
  return new Agent({
    model: { provider: "t", id: "only", api: "scripted", ...model },
    streamFunction: scriptedStreamFn(turns),
  });
}

/** GLM / K3 那种目录：七档折成三档、关不掉（表里没 off）。 */
const FOLD_NO_OFF = {
  minimal: { reasoning_effort: "low" },
  low: { reasoning_effort: "low" },
  medium: { reasoning_effort: "high" },
  high: { reasoning_effort: "high" },
  xhigh: { reasoning_effort: "max" },
  max: { reasoning_effort: "max" },
} as const;
/** DeepSeek 那种目录：三档 + off 真关。 */
const FOLD_WITH_OFF = { off: { thinking: { type: "disabled" } }, ...FOLD_NO_OFF } as const;

/**
 * 壳子只认 `AgentRuntime` 那份**封闭协议**——不认 Agent，也不认 Echo。
 * 这里把测试用的低层 Agent 收窄成协议，走的是 core 出的那个收窄函数，
 * **不是测试自己另写一份**：另写一份就等于壳子在测一个与生产不同的形状。
 */
/**
 * 投递一条 lifecycle 事件。**捕获 `runTui` 真正挂上去的监听器**，不伪造假 Agent——
 * 走的仍是生产那条订阅通道，只是事件由测试给。
 */
function emitLifecycle(agent: Agent, event: Record<string, unknown>): void {
  const captured = lifecycleListeners.get(agent) ?? [];
  for (const l of captured) l(event as never);
}
const lifecycleListeners = new WeakMap<Agent, ((e: never) => unknown)[]>();

function runtimeOf(agent: Agent, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  const base = agentRuntimeOf(agent);
  // **不能用 `{...base}`**：`state` / `acceptsWork` / `pendingPermissions` 是 getter，
  // spread 会把它们**求值成快照**——打桩改了 `agent.acceptsWork` 之后协议这边还是旧值
  // （写这条时实测踩到：装配层「起来了」之后壳子仍然拒收）。
  // 所以逐个用 `get` 转发，覆盖项单独盖在上面。
  const forwarded: AgentRuntime = {
    get state() {
      return base.state;
    },
    get pendingPermissions() {
      return base.pendingPermissions;
    },
    get pendingQuestions() {
      return base.pendingQuestions;
    },
    get acceptsWork() {
      return base.acceptsWork;
    },
    subscribe: (l) => base.subscribe(l),
    subscribeLifecycle: (l) => {
      const list = lifecycleListeners.get(agent) ?? [];
      list.push(l as never);
      lifecycleListeners.set(agent, list);
      return base.subscribeLifecycle(l);
    },
    prompt: (i, images) => base.prompt(i, images),
    steer: (m) => base.steer(m),
    followUp: (m) => base.followUp(m),
    answerPermission: (a) => base.answerPermission(a),
    abort: (r) => base.abort(r),
    setModel: (m) => base.setModel(m),
    setThinkingLevel: (l) => base.setThinkingLevel(l),
    reset: () => base.reset(),
    compact: (i) => base.compact(i),
    setWorkspace: (w) => base.setWorkspace(w),
    answerQuestion: (a) => base.answerQuestion(a),
  };
  // **不能用 `Object.assign`**：`state` / `acceptsWork` / `pendingPermissions` 是 getter-only，
  // 赋值会抛 "Attempted to assign to readonly property"（实测）。覆盖项一律走 `defineProperty`，
  // 并且**定义成值属性**——覆盖的本意就是「钉死成这个」。
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(forwarded, key, { value, configurable: true, enumerable: true });
  }
  return forwarded;
}

/* ─────────────── Transcript：投影本身 ─────────────── */

test("流式用权威 partial 覆盖；定稿**无条件**为准（含定稿为空与被修正的情形）", () => {
  const t = new Transcript();
  const row = t.push({ kind: "assistant", text: "", streaming: true });
  t.setAssistantText(row, "你");
  t.setAssistantText(row, "你好"); // 事件带的是「此刻的完整 partial」，覆盖而不是累加
  expect(t.render(40).join("\n")).toContain("你好");
  expect(t.render(40).join("\n")).not.toContain("你好好"); // 累加的话会变成这样

  // **定稿修正**：先流出旧 partial，定稿是另一份内容——屏幕必须换成定稿
  const corrected = new Transcript();
  const r2 = corrected.push({ kind: "assistant", text: "", streaming: true });
  corrected.setAssistantText(r2, "旧的半截");
  corrected.finishAssistant(r2, "权威定稿");
  const screen = corrected.render(40).join("\n");
  expect(screen).toContain("权威定稿");
  expect(screen).not.toContain("旧的半截"); // 上一版这里会停在旧 partial

  // 只发 done 的 provider：一个 partial 都没有，直接定稿
  const silent = new Transcript();
  const r3 = silent.push({ kind: "assistant", text: "", streaming: true });
  silent.finishAssistant(r3, "整段定稿");
  expect(silent.render(40).join("\n")).toContain("整段定稿");

  // 定稿为空（只带 tool_use 的那一轮）：正文清掉，不留旧 partial
  const toolOnly = new Transcript();
  const r4 = toolOnly.push({ kind: "assistant", text: "", streaming: true });
  toolOnly.setAssistantText(r4, "边想边说的半句");
  toolOnly.finishAssistant(r4, "");
  expect(toolOnly.render(40).join("\n")).not.toContain("边想边说的半句");
});

test("宽字符按列折行：中文一个字占两列，折出来的每行都不超过宽度", () => {
  const t = new Transcript();
  t.push({ kind: "assistant", text: "中文中文中文中文中文中文", streaming: false });
  const lines = t.render(10).filter((l) => l !== "");
  for (const line of lines) expect([...line].length).toBeLessThanOrEqual(5); // 10 列 = 5 个中文字
  expect(lines.join("")).toBe("中文中文中文中文中文中文");
});

test("工具行有三态：跑着 / 成功 / 失败，各自的标记不同", () => {
  const t = new Transcript();
  const row = t.push({ kind: "tool", name: "read", detail: "a.ts", state: "running" });
  expect(t.render(40).join("\n")).toContain("⋯ read");
  t.updateTool(row, { state: "done" });
  expect(t.render(40).join("\n")).toContain("✓ read");
  t.updateTool(row, { state: "failed" });
  expect(t.render(40).join("\n")).toContain("✗ read");
});

test("工具折叠行：摘要再长也截到宽度——pi-tui 对超宽行直接抛，实测 118 > 112 整屏崩", () => {
  const t = new Transcript();
  // 崩溃现场那条：`TaskCreate` 的参数 JSON 一行 118 列
  const detail = JSON.stringify({ tasks: [{ title: "定位并读取本地代码", detail: "查找工作目录中的本地代码项目，读取其主要文件与结构" }] });
  t.push({ kind: "tool", name: "TaskCreate", detail, state: "done" });
  const lines = t.render(40);
  for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(40);
  expect(lines[0]).toContain("TaskCreate"); // 截的是摘要，不是工具名
  expect(lines[0]).toContain("…"); // 截过要看得出来
});

test("状态栏在窄终端上按可见列宽裁：宽字符段按码点切会超宽——实测 60 > 55 整屏崩（2026-09-04）；先丢尾部次要段，模型名恒在", async () => {
  const ui = fakeTui();
  const agent = agentWith([]);
  // 崩溃现场那组数：deepseek-v4-flash · 空闲 · ↑279k ↓18k · 缓存 255k (91%) · 上下文 …
  const state = {
    ...agent.state,
    model: { ...agent.state.model, id: "deepseek-v4-flash", capabilities: { contextWindow: 256_000 } },
    usage: { inputTokens: 279_000, outputTokens: 18_000, cachedInputTokens: 255_000 },
    contextTokens: 90_000,
  };
  const done = runTui({ agent: runtimeOf(agent, { state }), ui });
  await flush();
  for (const width of [55, 40, 20]) {
    const footer = ui.lines(width).at(-1)!;
    expect(visibleWidth(footer), footer).toBeLessThanOrEqual(width);
    expect(footer).toContain("deepseek-v4-flash"); // 最重要的在最前；丢的是尾部
  }
  expect(ui.lines(120).at(-1)!).toContain("上下文 90k/256k"); // 宽度够时一段不少
  quit(ui);
  await done;
});

test("欢迎头在窄终端上按宽度折：键位提示 95 列，40 列终端上原来启动即崩", async () => {
  const ui = fakeTui();
  const done = runTui({ agent: runtimeOf(agentWith([])), ui });
  await flush();
  for (const line of ui.lines(40)) expect(visibleWidth(line), line).toBeLessThanOrEqual(40);
  expect(ui.lines(40).join("\n")).toContain("Ctrl+O 工具输出"); // 折了，没丢
  quit(ui);
  await done;
});

/* ─────────────── 输入：交给 pi-tui 的 Input，但**行为契约是我们的** ─────────────── */

// 这几条测的是「本壳子对外许诺的行为」，实现在 pi-tui 里也一样要成立——
// 上一版自写的 `PromptLine` 这三条全错（review 逐条实测），所以判据留在这儿盯着。

test("emoji 退格删掉整个字符，不是半个代理对（上一版：删了等于没删）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("a😀");
  ui.feed(String.fromCharCode(127)); // Backspace
  expect(ui.screen()).toContain("a");
  expect(ui.screen()).not.toContain("😀");
  quit(ui);
  await done;
});

test("bracketed paste 的多行内容不许被当成回车提交（上一版：擅自提交第一行）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  const ESC = String.fromCharCode(27);
  ui.feed(`${ESC}[200~foo\nbar${ESC}[201~`); // 粘贴两行
  const screen = ui.screen();
  expect(screen).toContain("foo"); // 还在输入行里
  expect(screen).toContain("bar");
  expect(screen).not.toContain("› foo"); // 没有变成已提交的用户行
  quit(ui);
  await done;
});

test("跑着的时候提交被拒，且**文字放回输入行**——不排队也不用重打", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("第一句")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("第一条");
  ui.feed("\r");
  ui.feed("插队的");
  ui.feed("\r"); // 上一条还在跑
  await flush(300);
  const screen = ui.screen();
  expect(screen).toContain("第一条");
  expect(screen).not.toContain("› 插队的"); // 没被当成第二条用户消息
  // **而且文字要还在输入行里**：只断言「没变成用户行」是不够的——那样把输入清空也能过，
  // 用户却得重打一遍（review 点名的判据缺口）
  expect(screen).toContain("插队的");
  quit(ui);
  await done;
});

/* ─────────────── 接线：Agent 事件 → 屏幕 ─────────────── */

test("端到端：输入一句 → 屏幕上出现用户行与模型正文；Ctrl+D 退出，**但不停 Agent**", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("我在")]);
  const done = runTui({ agent: runtimeOf(agent), ui });

  await flush();
  expect(ui.screen()).toContain("模型 only");

  ui.feed("在吗");
  ui.feed("\r");
  await flush(200);
  const screen = ui.screen();
  expect(screen).toContain("在吗"); // 用户那行
  expect(screen).toContain("我在"); // 模型正文

  quit(ui);
  expect(await done).toBe(0);

  // **上一版这里断言「Agent 已 stop」。壳变 extension 之后那条不成立也不该成立**：
  // 协议里没有 `stop`，收摊归装配层（`echo.stop()` 先卸壳这条 Extension、再停 Agent）。
  // 壳子自己停 Agent 就是两个所有者——那正是把 `start`/`stop` 挡在协议外面要防的事。
  expect(agent.acceptsWork).toBe(true); // 壳退出了，Agent 还活着
  await agent.stop(); // 由「装配层」收
});

test("模型报错要显示出来，不静默吞掉；退出码为 1", async () => {
  const ui = fakeTui();
  const agent = agentWith([]); // 脚本用尽 → provider 报错
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("说点什么");
  ui.feed("\r");
  await flush(200);
  expect(ui.screen()).toContain("[错误]");
  quit(ui);
  expect(await done).toBe(1);
});

test("工具调用在屏幕上有独立一行，跑完变成 ✓", async () => {
  const ui = fakeTui();
  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn([toolTurn("call-1", "echo_back", { text: "喂" }), textTurn("好了")]),
    tools: [
      {
        kind: "model" as const,
        name: "echo_back",
        label: "回声",
        description: "原样回声",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        execute: async () => ({ content: "喂", isError: false, metadata: null }),
      },
    ],
  });
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("用一下工具");
  ui.feed("\r");
  await flush(400);
  expect(ui.screen()).toContain("echo_back");
  expect(ui.screen()).toContain("✓ echo_back");
  quit(ui);
  await done;
});

test("传进来的 signal 已经 abort：必须立刻收摊，不能永远停在等退出上", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("不会被用到")]);
  const controller = new AbortController();
  controller.abort(); // **进 runTui 之前就中止**——addEventListener 不会补发历史事件
  let starts = 0;
  const realStart = agent.start.bind(agent);
  agent.start = async (...args: Parameters<Agent["start"]>): Promise<void> => {
    starts += 1;
    return realStart(...args);
  };

  const done = runTui({ agent: runtimeOf(agent), ui, signal: controller.signal });
  await flush(200);
  expect(await done).toBe(0); // 上一版这里会永远挂着
  // **而且根本不许启动**：`start()` 会取锁、恢复会话、激活 Schedule、开 Inbox 消费。
  // 上一版只是提前 resolve 了退出信号，`start()` 照跑（review 实测 starts === 1）——
  // 那不叫立刻收摊，那叫先把副作用做完再退出。
  expect(starts).toBe(0);
});

test("发完一句之后直接回车：不许重复发送同一句（换成 `Editor` 之后它会自己清空，判据不变）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("收到一"), textTurn("收到二")]);
  const prompts: string[] = [];
  const realPrompt = agent.prompt.bind(agent);
  agent.prompt = ((text: string, ...rest: never[]) => {
    prompts.push(text);
    return realPrompt(text, ...rest);
  }) as Agent["prompt"];

  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("first");
  ui.feed("\r");
  await flush(300); // 等这一轮跑完
  ui.feed("\r"); // 空手再按一次回车
  await flush(300);

  // 上一版：输入行里还留着 "first"，这一下会把它再发一遍（review 实测收到两次）
  expect(prompts).toEqual(["first"]);
  quit(ui);
  await done;
});

test("聚焦之后渲染里要有 CURSOR_MARKER（可见光标——这正是改用 pi-tui 编辑器的理由之一）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  // 上一版把焦点给了没有 `focused` 字段的 wrapper，Input.focused 永远 false，标记一次都不输出
  expect(ui.screen()).toContain(CURSOR_MARKER);
  quit(ui);
  await done;
});

test("壳子**不停 Agent**：协议里没有 stop，收摊归装配层（壳变 extension 之后的边界）", async () => {
  // 上一版壳子自己调 `echo.stop()`。现在启停归装配层（`echo.agent.start()` / `echo.stop()`），
  // 协议里根本没有那两个方法——壳子想碰也碰不到。判据落在**Agent 没被停掉**上：
  // 壳子退出之后 Agent 仍然可用，因为收摊是别人的事。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  quit(ui);
  expect(await done).toBe(0);

  // 壳子退出了，但 Agent 还活着——它还接得了活
  expect(agent.acceptsWork).toBe(true);
  await agent.stop(); // 由「装配层」来收
});

test("欢迎头报模型 id（启动是装配层的事，壳子只说自己接上了谁）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  expect(ui.screen()).toContain("模型 only");
  expect(ui.screen()).toContain("only"); // FAKE 模型 id
  quit(ui);
  await done;
});

/* ─────────────── 提问：`ask_user`，与权限平行的另一支 ─────────────── */

test("question（ask_user）摆上屏幕：单选按数字直答；没选项的在输入行打字回车；多选打序号串；答完撤掉（2026-09-05）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const answered: { questionId: string; selected: readonly string[]; text?: string }[] = [];
  const runtime = runtimeOf(agent, {
    answerQuestion: async (a) => {
      answered.push({ questionId: a.questionId, selected: a.selected, ...(a.text === undefined ? {} : { text: a.text }) });
      return { kind: "accepted" as const, questionId: a.questionId, toolCallId: "c" };
    },
  });
  const done = runTui({ agent: runtime, ui });
  await flush();

  emitLifecycle(agent, {
    type: "question",
    questionId: "q1",
    toolCallId: "c1",
    question: "用哪个测试框架？",
    options: [{ label: "vitest" }, { label: "bun test", description: "仓库已在用" }],
    multiSelect: false,
  });
  await flush();
  const screen = ui.screen();
  expect(screen).toContain("用哪个测试框架？");
  expect(screen).toContain("1. vitest");
  expect(screen).toContain("2. bun test");
  expect(screen).toContain("回车确认"); // 提示语写清怎么答
  expect(answered).toEqual([]); // 还没按键，不许替用户答
  // 等答时斜杠命令照样是命令，不会被当成回答送出去
  ui.feed("/model");
  ui.feed(ENTER);
  await flush();
  expect(answered).toEqual([]);
  expect(ui.screen()).toContain("[模型]"); // 真走了派发（没给 configure 的低层用法会说一句）
  // 序号越界：放回输入行说一句，不当自由文本发
  ui.feed("9");
  ui.feed(ENTER);
  await flush();
  expect(answered).toEqual([]);
  expect(ui.screen()).toContain("没有这个序号");
  ui.feed(CTRL_C); // 清掉放回的「9」
  // 序号 + 回车才算数：数字不直答，以数字开头的自由文本不能被吞掉第一个字
  ui.feed("2");
  ui.feed(ENTER);
  await flush();
  expect(answered).toEqual([{ questionId: "q1", selected: ["bun test"] }]);
  expect(ui.screen()).not.toContain("1. vitest"); // 答完撤掉
  expect(ui.screen()).toContain("[回答] bun test");

  // 没选项：输入行打字回车就是回答，不会当成新的一句 prompt
  emitLifecycle(agent, { type: "question", questionId: "q2", toolCallId: "c2", question: "分支叫什么？", options: [], multiSelect: false });
  await flush();
  ui.feed("feature/x");
  ui.feed(ENTER);
  await flush();
  expect(answered.at(-1)).toEqual({ questionId: "q2", selected: [], text: "feature/x" });

  // 多选：序号串按序号选，去重
  emitLifecycle(agent, { type: "question", questionId: "q3", toolCallId: "c3", question: "要哪些？", options: [{ label: "a" }, { label: "b" }, { label: "c" }], multiSelect: true });
  await flush();
  expect(ui.screen()).toContain("可多个");
  ui.feed("1,3,1");
  ui.feed(ENTER);
  await flush();
  expect(answered.at(-1)).toEqual({ questionId: "q3", selected: ["a", "c"] });

  // 没等到答案（那一轮中止）：撤掉
  emitLifecycle(agent, { type: "question", questionId: "q4", toolCallId: "c4", question: "还在吗？", options: [], multiSelect: false });
  await flush();
  expect(ui.screen()).toContain("还在吗？");
  emitLifecycle(agent, { type: "questionCancelled", questionId: "q4", toolCallId: "c4", reason: "run-aborted" });
  await flush();
  expect(ui.screen()).not.toContain("在输入行打字回答");

  quit(ui);
  await done;
});

/* ─────────────── 权限：协议里「必须有人回答」的那一支 ─────────────── */

test("permissionRequest 摆上屏幕并按 y 放行——不订阅 lifecycle 的壳会把 ask 拖成 deny", async () => {
  // 上一版 TUI **根本没订阅 lifecycle**：每次 `ask` 都因无人回答被折成 deny，
  // 用户看到「工具被拒」却不知道为什么。那不是设计，是壳子少实现了协议的一半。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const answered: { permissionId: string; decision: string }[] = [];
  const runtime = runtimeOf(agent, {
    answerPermission: async (a) => {
      answered.push({ permissionId: a.permissionId, decision: a.decision });
      return { kind: "accepted" as const, permissionId: a.permissionId, runId: "r", toolCallId: "c", decision: a.decision };
    },
  });
  const done = runTui({ agent: runtime, ui });
  await flush();

  // core 发来一次 ask（真实来源是 authorization stage，这里直接投递那条 lifecycle 事件）
  emitLifecycle(agent, {
    type: "permissionRequest",
    permissionId: "p1",
    runId: "r1",
    turnId: "t1",
    toolCallId: "c1",
    toolName: "bash",
    params: { cmd: "rm -rf /" },
    reason: "要跑命令",
  });
  await flush();

  const screen = ui.screen();
  expect(screen).toContain("bash");
  expect(screen).toContain("[y/n]"); // **提示语必须写清怎么答**：问了却不说按什么键等于没问
  // **危险参数必须真实可见**（review 二轮 P0）：上一版只显示「允许 bash？」，
  // 而 ask 里带的是冻结后的最终参数 `rm -rf /`——用户批准的和实际要跑的，屏幕上看不出是不是一回事。
  // 那叫**盲批**，是这个界面最不该有的东西。
  expect(screen).toContain("rm -rf /");
  expect(answered).toEqual([]); // 还没按键，不许替用户答

  ui.feed("y");
  await flush();
  expect(answered).toEqual([{ permissionId: "p1", decision: "allow" }]);
  expect(ui.screen()).not.toContain("[y/n]"); // 答完问题就撤掉

  quit(ui);
  await done;
});

test("按 n 就是 deny；`y`/`n` 在待答期间**不落进输入行**", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const answered: string[] = [];
  const runtime: AgentRuntime = {
    ...runtimeOf(agent),
    answerPermission: async (a) => {
      answered.push(a.decision);
      return { kind: "accepted" as const, permissionId: a.permissionId, runId: "r", toolCallId: "c", decision: a.decision };
    },
  };
  const done = runTui({ agent: runtime, ui });
  await flush();
  emitLifecycle(agent, {
    type: "permissionRequest",
    permissionId: "p2",
    runId: "r",
    turnId: "t",
    toolCallId: "c",
    toolName: "write_file",
    params: {},
    reason: "要写盘",
  });
  await flush();

  ui.feed("n");
  await flush();
  expect(answered).toEqual(["deny"]);
  // 那一刻用户面对的是是非题，不是在写下一句话——按键落进输入行的话，
  // 问题会一直挂着，core 那边则按 askTimeoutMs 折成 deny，用户全程不知道发生过什么
  expect(ui.screen()).not.toContain("› n");

  quit(ui);
  await done;
});

test("那一轮没了（permissionCancelled）：问题从屏幕上撤掉，不让用户对着死问题按键", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  emitLifecycle(agent, {
    type: "permissionRequest",
    permissionId: "p3",
    runId: "r",
    turnId: "t",
    toolCallId: "c",
    toolName: "bash",
    params: {},
    reason: "要跑命令",
  });
  await flush();
  expect(ui.screen()).toContain("[y/n]");

  emitLifecycle(agent, { type: "permissionCancelled", permissionId: "p3", toolCallId: "c", reason: "run-aborted" });
  await flush();
  expect(ui.screen()).not.toContain("[y/n]");

  quit(ui);
  await done;
});

/* ─────────────── 清洗：模型说了什么 ≠ 模型能对你的终端做什么 ─────────────── */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test("OSC 52：模型正文里的改剪贴板序列不许进终端（留下的只能是可见文本）", () => {
  const t = new Transcript();
  // `ESC ] 52 ; c ; <base64> BEL` = 「把这段 base64 写进用户剪贴板」。原样输出就等于模型有了剪贴板写权限。
  t.push({ kind: "assistant", text: `${ESC}]52;c;aGFja2Vk${BEL}正文`, streaming: false });
  const screen = t.render(40).join("\n");
  expect(screen).toContain("正文");
  expect(screen).not.toContain("]52;");
  expect(screen).not.toContain("aGFja2Vk");
  expect(screen).not.toContain(BEL);
});

test("CSI：清屏 / 光标移动序列不许进终端（否则模型能擦掉整个界面）", () => {
  const t = new Transcript();
  t.push({ kind: "assistant", text: `${ESC}[2J${ESC}[H都没了`, streaming: false });
  const screen = t.render(40).join("\n");
  expect(screen).toContain("都没了");
  expect(screen).not.toContain("[2J");
  expect(screen).not.toContain("[H");
});

test("裸 CR / BEL：`stripTerminalSequences()` 不管这两个，必须由第二遍 C0 清洗兜住", () => {
  // 这条是「两遍缺一不可」的判据：实测 pi-tui 那一遍会把 `\r` 和 BEL 原样留下，
  // 而 `\r` 能把后半句覆盖到行首、BEL 会让终端一直响。
  const t = new Transcript();
  t.push({ kind: "assistant", text: `前半${String.fromCharCode(13)}后半${BEL}`, streaming: false });
  const screen = t.render(40).join("\n");
  expect(screen).toContain("前半后半");
  expect(screen).not.toContain(String.fromCharCode(13));
  expect(screen).not.toContain(BEL);
});

test("四类条目都洗，且换行留着、tab 变空格", () => {
  const t = new Transcript();
  t.push({ kind: "user", text: `用户${ESC}[31m` });
  t.push({ kind: "tool", name: `工具${BEL}`, detail: `细节${ESC}]52;c;eA==${BEL}`, state: "done" });
  t.push({ kind: "notice", text: `通知${ESC}[2J` });
  const screen = t.render(40).join("\n");
  expect(screen).toContain("用户");
  expect(screen).toContain("工具");
  expect(screen).toContain("细节");
  expect(screen).toContain("通知");
  expect(screen).not.toContain("[31m"); // 模型自带的颜色也不留——只有 TUI 自己的 SGR 算数
  expect(screen).not.toContain("[2J");
  expect(screen).not.toContain(BEL);

  // 换行是内容，要留；tab 展开成空格，不能被当控制字符删掉（那样代码缩进全丢）
  const t2 = new Transcript();
  t2.push({ kind: "assistant", text: "第一行\n\t缩进", streaming: false });
  const lines = t2.render(40);
  expect(lines).toContain("第一行");
  expect(lines.some((l) => l.startsWith("    缩进"))).toBe(true);
});

test("清洗在加 SGR 之前：TUI 自己的颜色留得住", () => {
  const t = new Transcript();
  t.push({ kind: "user", text: "我说的话" });
  // 顺序反了的话，`clean()` 会把我们刚加的 `ESC[36m` 一起洗掉，屏幕变成纯白
  expect(t.render(40).join("\n")).toContain(`${ESC}[36m`);
});

/* ─────────────── 折行按 grapheme，不按 code point ─────────────── */

test("家庭 emoji 不许被拆开（ZWJ 序列是一个字素，不是 7 个）", () => {
  const t = new Transcript();
  t.push({ kind: "assistant", text: "👨‍👩‍👧‍👦X", streaming: false });
  // 上一版按 code point 累加宽度，宽度 2 时会得到 ["👨","‍","👩","‍","👧","‍","👦","X"]（实测）
  const lines = t.render(2).filter((l) => l !== "");
  expect(lines[0]).toBe("👨‍👩‍👧‍👦");
  expect(lines[1]).toBe("X");
});

test("组合符不许与基字符分家", () => {
  const t = new Transcript();
  const combining = `e${String.fromCharCode(0x0301)}`; // e + 尖音符 = é（两个 code point，一个字素）
  t.push({ kind: "assistant", text: `${combining}${combining}`, streaming: false });
  const lines = t.render(1).filter((l) => l !== "");
  expect(lines[0]).toBe(combining);
  expect(lines[1]).toBe(combining);
});

/* ─────────────── 运行态：由 Agent 生命周期驱动，不是本地 prompt() ─────────────── */

/**
 * 让 core 报告「我接不接新工作」。
 *
 * 打桩的是 `acceptsWork` 而**不是** `status`：五轮 review 的那条就死在这个区别上——
 * Inbox run 之后 core 是 `closeRun()`（置 `status = "idle"`）→ `await ackBatch()` →
 * 清 `inboxTicketOutstanding`，中间 `status` 已经 idle 而 `prompt()` 照拒。
 * 「core 忙不忙」的真判据只有 `acceptsWork` 一个（core 侧那条真跑 InboxStore 的判据在
 * `packages/core/test/inbox-durable.test.ts`「ack 窗口」，这里只验壳子读没读它）。
 */
function setCoreAccepts(agent: Agent, accepts: boolean): void {
  Object.defineProperty(agent, "acceptsWork", { get: () => accepts, configurable: true });
}

/** 捕获 runTui 挂上去的事件监听器，用来合成自主 run（Inbox / Schedule）的事件。 */
function tapEvents(agent: Agent): (event: Record<string, unknown>) => void {
  const captured: ((e: unknown, s: AbortSignal) => unknown)[] = [];
  const real = agent.subscribe.bind(agent);
  agent.subscribe = ((l: (e: unknown, s: AbortSignal) => unknown) => {
    captured.push(l);
    return real(l as never);
  }) as Agent["subscribe"];
  let seq = 1000;
  return (event) => {
    const enveloped = { seq: seq++, at: Date.now(), ...event };
    for (const l of captured) l(enveloped, new AbortController().signal);
  };
}

test("装配层还没把 Agent 起起来（acceptsWork=false）就提交：不发出、不清空、不显示拒绝", async () => {
  // 上一版这条叫「慢启动期间提交」，判据是壳子自己 `start()` 到一半。**壳变 extension 之后
  // 启停归装配层**，壳子压根不 start——「还没起来」这件事对它就是 `acceptsWork === false`，
  // 与「正忙」「Inbox 还在 ack」走同一条判据。这正是协议要达到的效果：壳子不再自己数状态。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  setCoreAccepts(agent, false); // 装配层还没 start：core 说不接活
  const prompts: string[] = [];
  const realPrompt = agent.prompt.bind(agent);
  agent.prompt = ((text: string, ...rest: never[]) => {
    prompts.push(text);
    return realPrompt(text, ...rest);
  }) as Agent["prompt"];

  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("等不及了");
  ui.feed("\r");
  await flush(100);

  expect(prompts).toEqual([]);
  expect(ui.screen()).toContain("等不及了"); // 还在输入行里，不用重打
  expect(ui.screen()).not.toContain("[拒绝]");

  setCoreAccepts(agent, true);
  ui.feed("\r");
  await flush(200);
  expect(prompts).toEqual(["等不及了"]); // 起来了就发得出去

  quit(ui);
  await done;
});

test("自主 run（Inbox / Schedule）跑着的时候提交：同样不发出、不清空", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const emit = tapEvents(agent);
  const prompts: string[] = [];
  const realPrompt = agent.prompt.bind(agent);
  agent.prompt = ((text: string, ...rest: never[]) => {
    prompts.push(text);
    return realPrompt(text, ...rest);
  }) as Agent["prompt"];

  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  // 没有任何本地 prompt()，纯粹是 Agent 自己在跑一轮：
  // run 落位（core 从此不接新工作）比 agent_start 那一拍还早，顺序与 `executeAdmitted` 一致
  setCoreAccepts(agent, false);
  emit({ type: "agent_start" });
  ui.feed("插一句");
  ui.feed("\r");
  await flush(100);

  expect(prompts).toEqual([]); // 上一版 `busy` 是 false → 这句会被发出去并撞上「已有一轮在飞」
  expect(ui.screen()).toContain("插一句");

  emit({ type: "agent_end", outcome: { kind: "completed" } });
  setCoreAccepts(agent, true); // core 真正收完摊了（含 Inbox 的 ack 裁决）
  await flush();
  quit(ui);
  await done;
});

test("`agent_end` 不等于空闲：循环收尾了但 core 还没 closeRun()，这时不许放行第二条", async () => {
  // 四轮 review 实测：`agent_end` 只说明循环不再产生事件；core 还要 `await ticket.settled`
  // → `finishRun()` → `closeRun()` 才清 `activeRun`。上一版在 `agent_end` 就把运行态灭掉，
  // 第二条输入于是被吃掉并换来一句「Agent 正在处理上一个 prompt」。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const emit = tapEvents(agent);
  const prompts: string[] = [];
  const realPrompt = agent.prompt.bind(agent);
  agent.prompt = ((text: string, ...rest: never[]) => {
    prompts.push(text);
    return realPrompt(text, ...rest);
  }) as Agent["prompt"];

  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  setCoreAccepts(agent, false);
  emit({ type: "agent_start" });
  emit({ type: "agent_end", outcome: { kind: "completed" } }); // 循环收尾了……
  await flush();

  // ……但 core 还没 closeRun()：activeRun 还在，`acceptsWork` 还是 false
  ui.feed("抢跑的第二条");
  ui.feed("\r");
  await flush(100);
  expect(prompts).toEqual([]); // 上一版这里会发出去并撞上「正在处理上一个 prompt」
  expect(ui.screen()).toContain("抢跑的第二条"); // 文字留在输入行，不用重打
  expect(ui.screen()).not.toContain("[拒绝]");

  // core 真的收完摊（permit settle + closeRun，Inbox 还要 ack 裁决）之后才放行
  setCoreAccepts(agent, true);
  ui.feed("\r");
  await flush(200);
  expect(prompts).toEqual(["抢跑的第二条"]);

  quit(ui);
  await done;
});

test("自主 run 报错：屏幕要看得见，退出码要是 1", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const emit = tapEvents(agent);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  emit({ type: "agent_start" });
  emit({
    type: "agent_end",
    outcome: { kind: "error", error: { source: "provider", code: "internal", retryable: false, message: "自主轮炸了" } },
  });
  await flush();

  // 上一版：没有 prompt() 调用方接结果，`agent_end` 又没人听——屏幕上一个字都没有
  expect(ui.screen()).toContain("自主轮炸了");

  quit(ui);
  expect(await done).toBe(1); // 失败退出码
});

test("迭代上限不是坏了，是预算用完：错误后面跟着「输入继续」的提示；别的错误不跟", async () => {
  // 实测 `[错误] 迭代上限 20` 这一行没告诉用户下一步能做什么（2026-09-02）
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const emit = tapEvents(agent);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  emit({ type: "agent_start" });
  emit({
    type: "agent_end",
    outcome: { kind: "error", error: { source: "internal", code: "max_iterations", retryable: false, message: "迭代上限 20" } },
  });
  await flush();
  expect(ui.screen()).toContain("[错误] 迭代上限 20（已做的都在，输入「继续」接着跑）");
  expect(ui.screen().split("输入「继续」").length - 1).toBe(1); // 上一条测试那种普通错误不带这句

  quit(ui);
  await done;
});

test("本地一轮出错只显示一次（`agent_end` 显示，`submit()` 不重复显示）", async () => {
  const ui = fakeTui();
  const agent = agentWith([]); // 脚本用尽 → provider 报错，走真的 agent_end(error)
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("会失败的一句");
  ui.feed("\r");
  await flush(200);

  const screen = ui.screen();
  const count = screen.split("[错误]").length - 1;
  expect(count).toBe(1); // 两边都显示的话这里是 2

  quit(ui);
  expect(await done).toBe(1);
});

test("Inbox 的 ack 窗口：core 报 `status = idle` 但还不接活，壳子不许被 status 骗过去", async () => {
  // 五轮 review：Inbox run 之后 `closeRun()` 已经把 `status` 置回 idle，`ackBatch()` 的裁决
  // 还没出来，`inboxTicketOutstanding` 还立着——这时 `prompt()` 会抛「Inbox 的一批还在等 ack 裁决」。
  // 所以这条把 `status` 与 `acceptsWork` **故意摆成相反**：壳子读错哪一个，这里就红。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  Object.defineProperty(agent, "status", { get: () => "idle", configurable: true });
  setCoreAccepts(agent, false);

  const prompts: string[] = [];
  const realPrompt = agent.prompt.bind(agent);
  agent.prompt = ((text: string, ...rest: never[]) => {
    prompts.push(text);
    return realPrompt(text, ...rest);
  }) as Agent["prompt"];

  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("ack 还没裁决就发");
  ui.feed("\r");
  await flush(100);

  expect(prompts).toEqual([]); // 读 status 的那版会在这里发出去，然后显示一句拒绝
  expect(ui.screen()).toContain("ack 还没裁决就发");
  expect(ui.screen()).not.toContain("[拒绝]");

  setCoreAccepts(agent, true);
  ui.feed("\r");
  await flush(200);
  expect(prompts).toEqual(["ack 还没裁决就发"]);

  quit(ui);
  await done;
});

test("参数里的终端控制序列不许注入——「请你确认」这一步尤其不能被劫持", () => {
  // 参数来自模型，与正文一样不可信。不洗的话一条 `OSC 52` 就能在确认框里改用户剪贴板：
  // 用户以为自己在读「要执行什么」，实际屏幕已经被写这条参数的人接管了。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  return (async () => {
    await flush();
    emitLifecycle(agent, {
      type: "permissionRequest",
      permissionId: "pX",
      runId: "r",
      turnId: "t",
      toolCallId: "c",
      toolName: "bash",
      params: { cmd: `${String.fromCharCode(27)}]52;c;aGFjaw==${String.fromCharCode(7)}真正的命令` },
      reason: "要跑命令",
    });
    await flush();
    const screen = ui.screen();
    expect(screen).toContain("真正的命令"); // 内容留着——洗的是控制序列不是信息

    // **判据落在「参数那一行里有没有真的控制字符」**，不是整屏——整屏本来就有 TUI 自己的
    // SGR 与光标标记，那些是合法的。也不是断言「没有 `]52;` 这几个字」：
    // `JSON.stringify` 会把 ESC 转成字面量 `\u001b`，那串东西作为**可见文本**出现是对的——
    // 用户本来就该看见「这条命令里藏了个转义序列」。危险的是**真字节**进了终端。
    // 写这条时先写成 `not.toContain("]52;")`，实测判红才发现自己在断言错的东西。
    const paramLine = screen.split("\n").find((l) => l.includes("真正的命令")) ?? "";
    const payload = paramLine.replace(/\u001b\[[0-9;]*m/g, ""); // 去掉 TUI 自己加的 SGR
    const rawControls = [...payload].filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    });
    expect(rawControls).toEqual([]); // 参数那一行里一个真控制字符都不许有
    expect(payload).toContain("u001b"); // 而它以可见文本的样子留着——信息没被抹掉
    quit(ui);
    await done;
  })();
});

test("带着**已存在的 ask** 启动：壳子必须把它摆出来（`pendingPermissions` 就是为这个）", async () => {
  // Extension 换代 / 壳重挂时，订阅只能收到「此后」的事件——**在那之前就欠着的那条谁也不会重发**。
  // 不补的话用户看不到问题，run 一直等到 `askTimeoutMs` 折成 deny，全程无人知情。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const runtime = runtimeOf(agent, {
    pendingPermissions: [
      { permissionId: "old-1", runId: "r", turnId: "t", toolCallId: "c", toolName: "write_file", params: { path: "/etc/hosts" }, reason: "要写盘" },
    ] as never,
  });

  const done = runTui({ agent: runtime, ui });
  await flush();

  const screen = ui.screen();
  expect(screen).toContain("write_file");
  expect(screen).toContain("/etc/hosts"); // 参数同样要看得见
  expect(screen).toContain("[y/n]");

  quit(ui);
  await done;
});

test("同一个 permissionId 不重复摆：补发的与订阅收到的会合并", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const runtime = runtimeOf(agent, {
    pendingPermissions: [
      { permissionId: "dup", runId: "r", turnId: "t", toolCallId: "c", toolName: "bash", params: {}, reason: "第一次" },
    ] as never,
  });
  const done = runTui({ agent: runtime, ui });
  await flush();

  // 订阅之后 core 又把同一条发了一遍（换代重放的常见形状）
  emitLifecycle(agent, {
    type: "permissionRequest",
    permissionId: "dup",
    runId: "r",
    turnId: "t",
    toolCallId: "c",
    toolName: "bash",
    params: {},
    reason: "第二次",
  });
  await flush();

  const screen = ui.screen();
  expect(screen.split("[权限] 要用 bash").length - 1).toBe(1); // 只摆一次
  quit(ui);
  await done;
});

/* ─────────────── 键位（P0，照 pi）：五个键各一条，外加编码这一层 ─────────────── */
//
// 键表在 `src/keybindings.ts`。这几条断言的是**行为**（发没发出去、退没退出、文字还在不在），
// 不断言字节——因为同一个键有多种字节形式，下面专门有几条用 Kitty 编码再走一遍。

const ENTER = "\r";
const ESC_KEY = String.fromCharCode(27);
const SHIFT_ENTER = `${ESC_KEY}[13;2u`; // Kitty 编码。传统终端里 Shift+Enter 与 Enter 不可区分，pi-tui 也只认这一种
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const CTRL_MINUS = String.fromCharCode(0x1f);
const LEFT = `${ESC_KEY}[D`;
const UP = `${ESC_KEY}[A`;

/** 记下真正发出去的 prompt。走的是 `Agent.prompt` 本身，只是包一层。 */
function capturePrompts(agent: Agent): string[] {
  const prompts: string[] = [];
  const realPrompt = agent.prompt.bind(agent);
  agent.prompt = ((text: string, ...rest: never[]) => {
    prompts.push(text);
    return realPrompt(text, ...rest);
  }) as Agent["prompt"];
  return prompts;
}

/** 「还在跑」的判据：`runTui()` 在这段时间内没有结算。 */
async function stillRunning(done: Promise<number>, ms = 50): Promise<boolean> {
  const r = await Promise.race([done.then(() => "exited"), new Promise((r) => setTimeout(() => r("running"), ms))]);
  return r === "running";
}

test("Enter 提交；Shift+Enter 换行——多行草稿整段发出去", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const prompts = capturePrompts(agent);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  ui.feed("第一行");
  ui.feed(SHIFT_ENTER);
  ui.feed("第二行");
  expect(prompts, "Shift+Enter 把草稿发出去了——它该是换行").toEqual([]);
  ui.feed(ENTER);
  await flush(200);

  expect(prompts).toEqual(["第一行\n第二行"]);
  quit(ui);
  await done;
});

test("Ctrl+C 清空输入行，**不退出**", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  ui.feed("打了一半");
  expect(ui.screen()).toContain("打了一半");
  ui.feed(CTRL_C);

  expect(ui.screen(), "Ctrl+C 没清掉输入行").not.toContain("打了一半");
  expect(await stillRunning(done), "Ctrl+C 把界面退了——照 pi 它是清空，退出归 Ctrl+D").toBe(true);
  ui.feed(CTRL_D);
  expect(await done).toBe(0);
});

test("Ctrl+D：输入行为空时退出；有字时是向前删一个字符，不退出", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  ui.feed("ab");
  ui.feed(LEFT); // 光标挪到 b 前面
  ui.feed(CTRL_D); // 有字：删掉光标后面那个 b
  expect(ui.screen()).toContain("a");
  expect(ui.screen(), "有字时 Ctrl+D 没有向前删").not.toContain("ab");
  expect(await stillRunning(done), "有字时 Ctrl+D 把界面退了").toBe(true);

  ui.feed(CTRL_C); // 清空
  ui.feed(CTRL_D); // 空了：退出
  expect(await done).toBe(0);
});

test("Esc 中断在飞的那一轮（走协议的 `abort`）；空闲时按 Esc 什么都不发生", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const aborts: (string | undefined)[] = [];
  const done = runTui({ agent: runtimeOf(agent, { abort: (r) => aborts.push(r) }), ui });
  await flush();

  ui.feed(ESC_KEY); // 空闲：不该 abort
  await flush();
  expect(aborts).toEqual([]);

  ui.feed("跑一轮");
  ui.feed(ENTER); // 发出去的那一拍就算「在飞」（pendingLocal），不用等模型回话
  ui.feed(ESC_KEY);
  expect(aborts).toEqual(["用户中断"]);

  await flush(200);
  quit(ui);
  await done;
});

test("↑ 翻出上一条输入（单行草稿），再按回车就是重发那一句", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("一"), textTurn("二")]);
  const prompts = capturePrompts(agent);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  ui.feed("first");
  ui.feed(ENTER);
  await flush(300);
  ui.feed(UP); // 空输入行 + 首行 → 翻历史
  ui.feed(ENTER);
  await flush(300);

  expect(prompts).toEqual(["first", "first"]);
  quit(ui);
  await done;
});

test("被拒的那次提交不进历史：↑ 翻出来的是发出去的那句，不是被拒的", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("一"), textTurn("二")]);
  const prompts = capturePrompts(agent);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  ui.feed("发出去的");
  ui.feed(ENTER);
  ui.feed("被拒的");
  ui.feed(ENTER); // 上一条还在跑 → 被拒，文字放回输入行
  await flush(300);
  ui.feed(CTRL_C); // 清掉被拒的那句
  ui.feed(UP);
  ui.feed(ENTER);
  await flush(300);

  expect(prompts).toEqual(["发出去的", "发出去的"]);
  quit(ui);
  await done;
});

test("Ctrl+- 撤销", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  ui.feed("abc");
  expect(ui.screen()).toContain("abc");
  ui.feed(CTRL_MINUS);
  expect(ui.screen(), "撤销没生效").not.toContain("abc");

  quit(ui);
  await done;
});

/* ─────────────── 同一个键的另一种字节形式：Kitty 键盘协议 ─────────────── */
//
// pi-tui 探测到终端支持就会启用它（`dist/terminal.js:120`），之后**所有**按键都换编码：
// Ctrl+D 是 `ESC[100;5u` 不是 `0x04`，`y` 是 `ESC[121u`，而且每次按键还补发一条 release。
// 上一版手写 `data.includes(String.fromCharCode(3))` 就是在这种终端上退不出去的。

const KITTY = {
  ctrlD: `${ESC_KEY}[100;5u`,
  ctrlDRelease: `${ESC_KEY}[100;5:3u`,
  y: `${ESC_KEY}[121u`,
  yRelease: `${ESC_KEY}[121:3u`,
};

test("Kitty 编码的 Ctrl+D 也能退出", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed(KITTY.ctrlD);
  expect(await done).toBe(0);
});

test("Kitty 的按键 release 不算一次按键：release 的 Ctrl+D 不退出，release 的 y 不答题", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const answered: string[] = [];
  const runtime = runtimeOf(agent, {
    answerPermission: async (a) => {
      answered.push(a.decision);
      return { kind: "accepted" as const, permissionId: a.permissionId, runId: "r", toolCallId: "c", decision: a.decision };
    },
  });
  const done = runTui({ agent: runtime, ui });
  await flush();

  ui.feed(KITTY.ctrlDRelease);
  expect(await stillRunning(done), "release 事件被当成按下，退出了").toBe(true);

  emitLifecycle(agent, { type: "permissionRequest", permissionId: "p", runId: "r", turnId: "t", toolCallId: "c", toolName: "bash", params: {}, reason: "" });
  await flush();
  ui.feed(KITTY.yRelease);
  await flush();
  expect(answered, "release 事件被当成按下，替用户答了题").toEqual([]);

  ui.feed(KITTY.y); // 真正的按下
  await flush();
  expect(answered).toEqual(["allow"]);

  ui.feed(KITTY.ctrlD);
  await done;
});

/* ─────────────── 凭据配置段：配置是运行态，不阻塞启动（2026-09-01 用户拍板） ─────────────── */
//
// 上一版是启动前弹一屏向导。现在装配不看凭据（core `create-agent.ts`），主界面照样起来，
// 缺 key 时把配置段摆在输入行的位置上——配好就撤、输入行回来，**不用重启**。

/** 两个 key 环境变量都清掉；跑测试那台机器上真配了 key 的话这一组全是假绿。 */
function isolateKeys(): () => void {
  const keys = ["MOONSHOT_API_KEY", "ECHO_LLM_API_KEY"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** 配置段 / 选择器相关的测试要用 kimi 身份：当前家按 `state.model.provider` 现查，`"t"` 查不到。 */
function kimiAgent(turns: ProviderEvent[][]): Agent {
  return new Agent({
    model: { provider: "kimi", id: "kimi-k3", api: "scripted" },
    streamFunction: scriptedStreamFn(turns as never),
  });
}

function configureWith(over: Partial<TuiConfigureOptions> = {}): TuiConfigureOptions {
  return {
    // 两家：跨家选择器与「换到未配 key 的家」都靠第二家
    providers: [
      { name: "kimi", provider: kimiProvider() },
      { name: "deepseek", provider: deepseekProvider() },
    ],
    credentials: new InMemoryCredentialStore(),
    verify: async () => ({ ok: true }),
    ...over,
  };
}

test("没配 key：主界面**照样起来**，配置段顶替输入行；配好之后输入行回来、直接就能发", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("我在")]);
    const prompts = capturePrompts(agent);
    const credentials = new InMemoryCredentialStore();
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    expect(ui.screen()).toContain("模型 kimi-k3"); // 主界面起来了
    expect(ui.screen()).toContain("Kimi (Moonshot) 的 API key"); // 配置段就在里面
    // 「还没有」只许说一遍（段头自己那句）——启动时再推一条 notice 就是同一句话说两遍
    // （2026-09-01 用户截图点名的重复）
    expect(ui.screen().split("还没有").length - 1).toBe(1);
    expect(ui.screen()).toContain("--provider deepseek"); // 换家怎么换
    // 配置段期间输入行不该在：它自己的提示行在、输入行下面那条提示不在（欢迎头里的那句不算）
    expect(ui.screen()).toContain("输入不回显");
    expect(ui.screen().split("Enter 发送").length - 1, "配置段期间输入行不该在").toBe(1);

    for (const ch of "sk-GOOD") ui.feed(ch);
    ui.feed(ENTER);
    await flush(100);

    expect(ui.screen()).toContain("[凭据] 已保存");
    expect(await credentials.read("kimi")).toEqual({ type: "api_key", key: "sk-GOOD" });
    expect(ui.screen()).not.toContain("输入不回显");
    expect(ui.screen().split("Enter 发送").length - 1, "配好之后输入行没回来").toBe(2); // 欢迎头 + 输入行下的提示

    ui.feed("在吗");
    ui.feed(ENTER);
    await flush(200);
    expect(prompts).toEqual(["在吗"]); // 不用重启，直接说话

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("配好了的：不摆配置段", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]); // 身份必须能查到家，「配好了」这句话才有内容
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();
    expect(ui.screen()).not.toContain("的 API key");
    expect(ui.screen()).toContain("Enter 发送");
    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("跑着的时候端点报 `auth`（key 被撤了）：配置段再摆一次，而不是让用户对着 [错误] 猜", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const authTurn: ProviderEvent[] = [
      { type: "error", error: { source: "provider", code: "auth", retryable: false, message: "端点未配置凭据：kimi" } },
    ];
    const agent = kimiAgent([authTurn]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-revoked" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();
    expect(ui.screen()).not.toContain("的 API key"); // 启动时是配好的

    ui.feed("hi");
    ui.feed(ENTER);
    await flush(300);

    expect(ui.screen()).toContain("[错误]");
    expect(ui.screen()).toContain("重新配一个");
    expect(ui.screen()).toContain("Kimi (Moonshot) 的 API key");

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("配置段里：Ctrl+C 清空、有字时 Ctrl+D 不退出、空了 Ctrl+D 退出", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith() });
    await flush();
    expect(ui.screen()).toContain("的 API key");

    for (const ch of "sk-half") ui.feed(ch);
    expect(ui.screen()).toContain("•".repeat("sk-half".length));
    ui.feed(CTRL_D); // 有字：不退出
    expect(await stillRunning(done), "配置段里有字时 Ctrl+D 把界面退了").toBe(true);
    ui.feed(CTRL_C); // 清空
    expect(ui.screen()).not.toContain("•");
    ui.feed(CTRL_D); // 空了：退出
    expect(await done).toBe(0);
  } finally {
    restore();
  }
});

test("读不了凭据文件：**不挡启动**，说一句，当成没配", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const broken: CredentialStore = {
      read: async () => {
        throw new Error("凭据文件不是合法 JSON：/x/credentials.json");
      },
      write: async () => undefined,
      delete: async () => undefined,
    };
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials: broken }) });
    await flush();
    expect(ui.screen()).toContain("模型 kimi-k3");
    expect(ui.screen()).toContain("[凭据] 读不了凭据文件");
    expect(ui.screen()).toContain("的 API key");
    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("不给 configure：壳子不管凭据，什么都不摆（低层用户自己装配的场合）", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = agentWith([textTurn("好")]);
    const done = runTui({ agent: runtimeOf(agent), ui });
    await flush();
    expect(ui.screen()).not.toContain("的 API key");
    quit(ui);
    await done;
  } finally {
    restore();
  }
});

/* ─────────────── 欢迎头与状态栏（P1，`docs/design/tui.md` §三 §四） ─────────────── */

test("欢迎头：版本、cwd、模型、键位提示，在文档流最上面", async () => {
  const ui = fakeTui();
  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn([textTurn("好")]),
    workspace: "/tmp/echo-welcome-workspace",
  });
  // 产品由调用方给：**壳不认识任何产品**（2026-09-09 拆包），不给就显示一个中性名字
  const done = runTui({ agent: runtimeOf(agent), ui, product: { name: "echo-agent", version: "9.9.9" } });
  await flush();

  const screen = ui.screen();
  const lines = screen.split("\n");
  expect(lines[0]).toContain("echo-agent");
  expect(lines[0]).toMatch(/v\d+\.\d+\.\d+/); // 版本来自 package.json
  expect(screen).toContain("/tmp/echo-welcome-workspace"); // 「在哪」= session 的 workspace（`AgentState.workspace`），不是进程 cwd
  expect(screen).toContain("模型 only · t"); // 来自 AgentState.model
  expect(screen).toContain("Enter 发送 · Shift+Enter 换行 · Esc 中断 · Ctrl+D 退出 · ↑ 历史");
  // 头在对话之前：发一句之后用户行出现在头的下面
  ui.feed("你好");
  ui.feed(ENTER);
  await flush(200);
  const after = ui.screen();
  expect(after.indexOf("echo-agent")).toBeLessThan(after.indexOf("你好"));

  quit(ui);
  await done;
});

test("状态栏：最底下一行，模型 / 状态 / 用量恒显；任务 / skill / MCP 为零不占地方", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  const lines = ui.screen().split("\n");
  const footer = lines.at(-1)!.replace(/\x1b\[[0-9;]*m/g, "");
  expect(footer).toContain("only"); // 模型
  expect(footer).toContain("空闲"); // 状态（未开工）
  expect(footer).toMatch(/↑\d+.* ↓\d+/); // 用量
  expect(footer, "为零的项不该占地方").not.toContain("任务");
  expect(footer).not.toContain("skill");
  expect(footer).not.toContain("mcp");

  quit(ui);
  await done;
});

test("状态栏在配置段期间也在（它不依赖输入行）", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith() });
    await flush();
    expect(ui.screen()).toContain("的 API key"); // 配置段真的在（不在的话这条判据是空的）
    const footer = ui.screen().split("\n").at(-1)!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(footer).toContain("kimi-k3");
    expect(footer).toContain("空闲");
    quit(ui);
    await done;
  } finally {
    restore();
  }
});

/* ─────────────── 消息渲染（P2，`docs/design/tui.md` §五） ─────────────── */
//
// 每条消息是一个组件（`messages.ts`）：助手正文走 pi-tui 的 `Markdown`，工具调用默认折叠、
// Ctrl+O 全局展开，thinking 暗色斜体。清洗仍在 `Transcript` 入口（上面那组判据没动）。

const ITALIC = `${ESC_KEY}[3m`;
const CTRL_O = String.fromCharCode(15);
const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("Markdown：代码块、列表、表格由 `Markdown` 组件渲染，不是原样吐字", () => {
  const t = new Transcript();
  t.push({
    kind: "assistant",
    text: "说明：\n```ts\nconst a = 1;\n```\n- 甲\n- 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    streaming: false,
  });
  const lines = t.render(40).map(stripSgr);
  expect(lines).toContain("```ts");
  expect(lines.some((l) => l.includes("const a = 1;"))).toBe(true);
  expect(lines).toContain("- 甲");
  expect(lines.some((l) => l.startsWith("┌"))).toBe(true); // 表格画了框
  expect(lines).toContain("│ 1 │ 2 │");
});

test("thinking：暗色斜体、在正文前面，与正文区分", () => {
  const t = new Transcript();
  const row = t.push({ kind: "assistant", text: "", streaming: true });
  t.setAssistantContent(row, { text: "结论在此", thinking: "先想一想" });
  const raw = t.render(40);
  const think = raw.find((l) => l.includes("先想一想"))!;
  const body = raw.find((l) => l.includes("结论在此"))!;
  expect(think).toContain(ITALIC);
  expect(body).not.toContain(ITALIC);
  expect(raw.indexOf(think)).toBeLessThan(raw.indexOf(body));
});

test("工具调用默认折叠：一行「标记 + 名字 + 摘要」；toggleTools() 展开看参数与结果，再切回去收起", () => {
  const t = new Transcript();
  const row = t.push({ kind: "tool", name: "read_file", detail: '{"path":"a.ts"}', state: "running", params: { path: "a.ts" } });
  t.updateTool(row, { state: "done", result: { content: "第一行内容\n第二行内容", isError: false, metadata: null } });

  const folded = t.render(60).map(stripSgr);
  expect(folded[0]).toBe('✓ read_file  {"path":"a.ts"}');
  expect(folded.join("\n"), "折叠时结果不该在").not.toContain("第二行内容");

  expect(t.toggleTools()).toBe(true);
  const open = t.render(60).map(stripSgr);
  expect(open.join("\n")).toContain('"path": "a.ts"'); // 参数（多行 JSON）
  expect(open.join("\n")).toContain("第二行内容"); // 结果
  expect(open.some((l) => l.startsWith("│ "))).toBe(true); // 缩在竖线后面

  expect(t.toggleTools()).toBe(false);
  expect(t.render(60).map(stripSgr).join("\n")).not.toContain("第二行内容");
});

test("长输出不刷屏：200 行结果折叠时只占一行（加一个空行）", () => {
  const t = new Transcript();
  const row = t.push({ kind: "tool", name: "bash", detail: "ls", state: "running" });
  const content = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
  t.updateTool(row, { state: "done", result: { content, isError: false, metadata: null } });
  expect(t.render(80).length).toBe(2);
  t.toggleTools();
  expect(t.render(80).length).toBeGreaterThan(200);
});

test("工具结果也要洗：展开时结果里的控制序列不许进终端", () => {
  const t = new Transcript();
  const row = t.push({ kind: "tool", name: "bash", detail: "", state: "running" });
  const BEL7 = String.fromCharCode(7);
  t.updateTool(row, { state: "done", result: { content: `${ESC_KEY}]52;c;aGFjaw==${BEL7}真正的输出`, isError: false, metadata: null } });
  t.toggleTools();
  const screen = t.render(80).join("\n");
  expect(screen).toContain("真正的输出");
  expect(screen).not.toContain("]52;");
  expect(screen).not.toContain("aGFjaw==");
});

test("端到端：Ctrl+O 展开 / 收起工具输出；折叠时长结果不刷屏", async () => {
  const ui = fakeTui();
  const agent = new Agent({
    model: { provider: "t", id: "only", api: "scripted" },
    streamFunction: scriptedStreamFn([toolTurn("call-1", "list", { dir: "/" }), textTurn("列完了")]),
    tools: [
      {
        kind: "model" as const,
        name: "list",
        label: "列目录",
        description: "列目录",
        parameters: { type: "object", properties: { dir: { type: "string" } } },
        execute: async () => ({
          content: Array.from({ length: 100 }, (_, i) => `entry-${i}`).join("\n"),
          isError: false,
          metadata: null,
        }),
      },
    ],
  });
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("列一下");
  ui.feed(ENTER);
  await flush(300);

  const folded = ui.screen();
  expect(folded).toContain("✓ list");
  expect(folded).toContain('{"dir":"/"}'); // 一行摘要
  expect(folded, "折叠时长结果刷出来了").not.toContain("entry-99");

  ui.feed(CTRL_O);
  expect(ui.screen()).toContain("entry-99");
  ui.feed(CTRL_O);
  expect(ui.screen()).not.toContain("entry-99");

  quit(ui);
  await done;
});

/* ─────────────── 换装备（P3a）：Ctrl+L 模型选择器 · Shift+Tab 思考档位 · /clear ─────────────── */
//
// 协议面的判据在 core（`runtime-equip.test.ts`）；这里测壳子的接线：键 → 协议方法 → 屏幕。

const CTRL_L = String.fromCharCode(12);
const SHIFT_TAB = `${ESC_KEY}[Z`;

test("Ctrl+L：选择器顶替输入行，当前项 ✓ 且预选中；选另一个 → 走协议换掉，状态栏跟着变", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = new Agent({
      model: { provider: "kimi", id: "kimi-k3", api: "openai-completions" },
      streamFunction: scriptedStreamFn([textTurn("好")]),
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    ui.feed(CTRL_L);
    await flush(); // 构建是异步的：逐家问配没配 key
    const s = ui.screen();
    expect(s).toContain("选择模型");
    expect(s).toContain("→ 1. Kimi K3 ✓"); // 当前项标着、预选中
    expect(s).toContain("DeepSeek V4 Flash"); // 跨家平铺（P3b-a）
    expect(s).toContain("未配 key"); // deepseek 没配，标出来
    // 「Enter 发送 · Shift+Enter」欢迎头里恒有一句；选择器顶替输入行时**只剩那一句**（输入行下的短提示没了）
    expect(s.split("Enter 发送 · Shift+Enter").length - 1, "选择器打开时输入行不该在").toBe(1);

    ui.feed("2"); // 数字直选 kimi-k2.7-code
    await flush();
    expect(ui.screen()).toContain("[模型] 已换到 kimi-k2.7-code");
    expect(agent.state.model.id).toBe("kimi-k2.7-code");
    expect(ui.screen().split("\n").at(-1)!).toContain("kimi-k2.7-code"); // 状态栏现读 state

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("Ctrl+L：Esc 收起、再按 Ctrl+L 也是收起；没给 configure 的低层用法如实说没有目录", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    ui.feed(CTRL_L);
    await flush();
    expect(ui.screen()).toContain("选择模型");
    ui.feed(ESC_KEY);
    expect(ui.screen()).not.toContain("选择模型");
    ui.feed(CTRL_L);
    ui.feed(CTRL_L); // 构建中再按一次 = 收起（token 防重入，在飞构建作废）
    await flush();
    expect(ui.screen()).not.toContain("选择模型");
    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("没给 configure 的低层用法：Ctrl+L 如实说没有目录，不摆一个空选择器", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui }); // 不给 configure
  await flush();
  ui.feed(CTRL_L);
  expect(ui.screen()).toContain("[模型] 壳子没拿到目录");
  expect(ui.screen()).not.toContain("选择模型");
  quit(ui);
  await done;
});

test("忙的时候选模型：rejected 原因上屏，装备原样不动", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = new Agent({
      model: { provider: "kimi", id: "kimi-k3", api: "openai-completions" },
      streamFunction: scriptedStreamFn([textTurn("好")]),
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    ui.feed("跑一轮");
    ui.feed(ENTER); // 发出去的那一拍就算在跑（pendingLocal / userRunPending）
    ui.feed(CTRL_L);
    await flush(); // 构建异步：entries 齐了数字直选才有目标
    ui.feed("2");
    await flush(300);

    expect(ui.screen()).toContain("[模型] 没换成");
    expect(ui.screen()).toContain("正在运行");
    expect(agent.state.model.id).toBe("kimi-k3");

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("Shift+Tab：只轮映射表里发出去的参数不同的档，状态栏显示真发的值；关不掉的模型圈里没有 off、起手显示「缺省」", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")], { thinkingLevelMap: FOLD_NO_OFF });
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  const bar = (): string => ui.screen().split("\n").at(-1)!;

  expect(bar()).toContain("思考 缺省"); // off 没映射：不发参数、服务端按缺省思考——不能显示成「没在思考」
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    ui.feed(SHIFT_TAB);
    await flush();
    seen.push(agent.state.thinkingLevel);
  }
  expect(seen).toEqual(["low", "high", "max", "low"]); // minimal / medium / xhigh 与相邻档同值，跳过；没有 off
  expect(bar()).toContain("思考 low");

  quit(ui);
  await done;
});

test("Shift+Tab：能关的模型（表里有 off）圈里有 off、显示 disabled；没有映射表的模型只报一句、档位不动", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")], { thinkingLevelMap: FOLD_WITH_OFF });
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  expect(ui.screen().split("\n").at(-1)!).toContain("思考 disabled"); // 起手 off = 真关
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    ui.feed(SHIFT_TAB);
    await flush();
    seen.push(agent.state.thinkingLevel);
  }
  expect(seen).toEqual(["low", "high", "max", "off"]);
  quit(ui);
  await done;

  const bareUi = fakeTui();
  const bare = agentWith([textTurn("好")]);
  const bareDone = runTui({ agent: runtimeOf(bare), ui: bareUi });
  await flush();
  expect(bareUi.screen()).not.toContain("思考");
  bareUi.feed(SHIFT_TAB);
  await flush();
  expect(bare.state.thinkingLevel).toBe("off");
  expect(bareUi.screen()).toContain("[思考] 这个模型没有思考档位");
  quit(bareUi);
  await bareDone;
});

test("/clear：协议 reset() 清会话真相，屏幕投影一起清；装备不动", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("这句会被清掉"), textTurn("新的一句")], { thinkingLevelMap: FOLD_NO_OFF });
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  ui.feed(SHIFT_TAB); // 先把 thinking 拨到 low，验证 /clear 不动装备
  ui.feed("说一句");
  ui.feed(ENTER);
  await flush(300);
  expect(ui.screen()).toContain("这句会被清掉");
  expect(agent.state.messages.length).toBeGreaterThan(0);

  for (const ch of "/clear") ui.feed(ch);
  ui.feed(ENTER);
  await flush(200);

  expect(ui.screen()).toContain("[清空] 对话已清");
  expect(ui.screen(), "屏幕投影没清").not.toContain("这句会被清掉");
  expect(agent.state.messages, "会话真相没清").toEqual([]);
  expect(agent.state.thinkingLevel, "/clear 把装备也清了").toBe("low");

  // 清完还能正常说话
  ui.feed("再来");
  ui.feed(ENTER);
  await flush(300);
  expect(ui.screen()).toContain("新的一句");

  quit(ui);
  await done;
});

test("不认识的斜杠命令：报一句、原文放回输入行，不发给模型", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("不该被跑到")]);
  const prompts = capturePrompts(agent);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();

  for (const ch of "/foo") ui.feed(ch);
  ui.feed(ENTER);
  await flush();

  expect(ui.screen()).toContain("不认识的命令 /foo");
  expect(ui.screen()).toContain("/model"); // 报错里说清有哪些命令
  expect(prompts, "斜杠命令被当成消息发出去了").toEqual([]);
  // 原文放回了输入行：直接再按回车，同一条提示出现第二次（放没放回，按一下就知道）
  ui.feed(ENTER);
  await flush();
  expect(ui.screen().split("不认识的命令").length - 1, "原文没放回输入行").toBe(2);

  quit(ui);
  await done;
});

/* ─────────────── 跨家换模（P3b-a）：选另一家的模型 → 换过去 + 主动弹配置段 + 回调写设置 ─────────────── */

test("Ctrl+L 选 DeepSeek 的模型：换过去、onModelChange 拿到 provider id、没配 key 就**主动**弹配置段", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" }); // 只配了 kimi
    const changes: { provider: string; id: string }[] = [];
    const done = runTui({
      agent: runtimeOf(agent),
      ui,
      configure: configureWith({ credentials, onModelChange: (m) => changes.push(m) }),
    });
    await flush();

    ui.feed(CTRL_L);
    await flush();
    ui.feed("5"); // 平铺清单：1–4 是 kimi 的，5 = DeepSeek V4 Flash
    await flush(100);

    expect(ui.screen()).toContain("[模型] 已换到 deepseek-v4-flash（deepseek，下一轮生效）");
    expect(agent.state.model).toMatchObject({ provider: "deepseek", id: "deepseek-v4-flash" });
    expect(changes).toEqual([{ provider: "deepseek", id: "deepseek-v4-flash" }]); // D7：cli 拿它写 settings.json
    // deepseek 没配 key：不等第一句 prompt 撞 auth，配置段**这就**摆出来，而且对的是 DeepSeek
    expect(ui.screen()).toContain("DeepSeek 的 API key");
    // 状态栏跟着换
    expect(ui.screen().split("\n").at(-1)!).toContain("deepseek-v4-flash");

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("Ctrl+L：某一家的凭据条目坏了 → 那家当没配并说一声，选择器照开、进程不死（review 2026-09-07：此前是裸 promise，Bun 里 unhandled rejection 直接退出、锁不还）", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const realRead = credentials.read.bind(credentials);
    Object.defineProperty(credentials, "read", {
      value: async (provider: string) => {
        if (provider === "deepseek") throw new Error("credentials.json 坏了");
        return realRead(provider);
      },
    });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();
    ui.feed(CTRL_L);
    await flush(100);
    expect(ui.screen()).toContain("读不了凭据文件");
    expect(ui.screen()).toContain("Kimi K3"); // 选择器照开，别家照列
    ui.feed(ESC_KEY);
    await flush();
    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("Ctrl+L 选已配好那家的模型：换过去就完，不弹配置段", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    ui.feed(CTRL_L);
    await flush();
    ui.feed("2"); // kimi-k2.7-code，同一家
    await flush(100);

    expect(agent.state.model.id).toBe("kimi-k2.7-code");
    expect(ui.screen()).not.toContain("的 API key"); // 配好了就别烦人
    quit(ui);
    await done;
  } finally {
    restore();
  }
});

/* ─────────────── 状态栏的缓存那一格（2026-09-01：token 就够，但要看到缓存情况） ─────────────── */

test("provider 报了缓存：状态栏出现「缓存 <数> (<百分比>%)」；没报就不占地方（没报 ≠ 0%）", async () => {
  const withCache: ProviderEvent[] = [
    {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "好" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1000, outputTokens: 5, cachedInputTokens: 600 },
      },
    },
  ];
  const ui = fakeTui();
  const agent = agentWith([withCache]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("说");
  ui.feed(ENTER);
  await flush(300);

  const footer = ui.screen().split("\n").at(-1)!.replace(/\x1b\[[0-9;]*m/g, "");
  expect(footer).toContain("缓存 600 (60%)");
  quit(ui);
  await done;

  // 对照：**报了 usage 但没报缓存**——状态栏不出现「缓存」，0% 冒充「没命中」是另一种假账。
  // 对照必须有 inputTokens > 0：用 textTurn（usage 为 null）的话「显示 0%」那类错根本走不到显示分支
  const noCache: ProviderEvent[] = [
    {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "好" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    },
  ];
  const ui2 = fakeTui();
  const agent2 = agentWith([noCache]);
  const done2 = runTui({ agent: runtimeOf(agent2), ui: ui2 });
  await flush();
  ui2.feed("说");
  ui2.feed(ENTER);
  await flush(300);
  expect(ui2.screen().split("\n").at(-1)!).not.toContain("缓存");
  quit(ui2);
  await done2;
});

/* ─────────────── /model 斜杠命令（P3 最小集补齐；用户实敲被顶回来过） ─────────────── */

test("`/model` 开选择器（与 Ctrl+L 同一个）；`/model <id>` 跨家直切，走同一条路（写设置、主动弹配置段）", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const changes: { provider: string; id: string }[] = [];
    const done = runTui({
      agent: runtimeOf(agent),
      ui,
      configure: configureWith({ credentials, onModelChange: (m) => changes.push(m) }),
    });
    await flush();

    for (const ch of "/model") ui.feed(ch);
    ui.feed(ENTER);
    await flush();
    expect(ui.screen()).toContain("选择模型"); // 开的就是那个选择器
    ui.feed(ESC_KEY); // 收起

    for (const ch of "/model deepseek-v4-flash") ui.feed(ch);
    ui.feed(ENTER);
    await flush(100);
    expect(agent.state.model).toMatchObject({ provider: "deepseek", id: "deepseek-v4-flash" });
    expect(changes).toEqual([{ provider: "deepseek", id: "deepseek-v4-flash" }]); // 写设置那条回调同样走到
    expect(ui.screen()).toContain("DeepSeek 的 API key"); // deepseek 没配 key：主动弹配置段

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("`/model 不存在的id`：如实报、装备不动、不发给模型", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("不该被跑到")]);
    const prompts = capturePrompts(agent);
    // kimi 预先配好 key：让输入行在场（否则配置段顶替输入行，敲的字全进了密钥框）
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    for (const ch of "/model gpt-99-并不存在") ui.feed(ch);
    ui.feed(ENTER);
    await flush(100);

    expect(ui.screen()).toContain("目录里没有 'gpt-99-并不存在'");
    expect(agent.state.model.id).toBe("kimi-k3");
    expect(prompts).toEqual([]);

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

/* ─────────────── 斜杠命令菜单：敲 / 出候选、边敲边过滤，Tab 补全，Enter 直接执行（键位照 pi） ─────────────── */

const TAB = "\t";

test("敲 `/cl`：菜单弹出且过滤掉不匹配的命令；Tab 补全成 /clear、菜单收起；Enter 直接执行", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("不该被跑到")]);
    const prompts = capturePrompts(agent);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    for (const ch of "/cl") ui.feed(ch);
    await flush();
    expect(ui.screen()).toContain("清空对话"); // clear 的描述行在菜单里
    expect(ui.screen()).not.toContain("选模型"); // model 被 fuzzy 过滤掉

    ui.feed(TAB);
    await flush();
    expect(ui.screen()).not.toContain("清空对话"); // 菜单收起
    expect(ui.screen()).toContain("/clear"); // 只敲了 /cl，全名上屏说明补全生效

    ui.feed(ENTER);
    await flush();
    expect(prompts).toEqual([]); // 是命令不是消息
    expect(ui.screen()).not.toContain("不认识"); // 派发到了 /clear

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("`/mo` 菜单开着按 Enter：补全并**直接执行**——模型选择器弹出", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    for (const ch of "/mo") ui.feed(ch);
    await flush();
    expect(ui.screen()).toContain("选模型"); // 菜单里只剩 model 的描述

    ui.feed(ENTER);
    await flush(100);
    expect(ui.screen()).toContain("选择模型"); // Enter 落进 /model 的执行体：选择器开了

    ui.feed(ESC_KEY);
    await flush();
    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("`/model dee`：模型 id 参数补全弹出；Tab 补全整个 id；Enter 直切到该模型", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    for (const ch of "/model dee") ui.feed(ch);
    await flush();
    expect(ui.screen()).toContain("deepseek-v4-flash"); // 参数菜单在，fuzzy 首选

    ui.feed(TAB);
    await flush();
    ui.feed(ENTER);
    await flush(100);
    expect(agent.state.model).toMatchObject({ provider: "deepseek", id: "deepseek-v4-flash" }); // 只敲了 dee，Tab 补全后直切成功
    expect(ui.screen()).toContain("DeepSeek 的 API key"); // 未配 key 的家：主动弹配置段

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("`/zz` 什么都不匹配：不弹菜单", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = kimiAgent([textTurn("好")]);
    const credentials = new InMemoryCredentialStore();
    await credentials.write("kimi", { type: "api_key", key: "sk-ok" });
    const done = runTui({ agent: runtimeOf(agent), ui, configure: configureWith({ credentials }) });
    await flush();

    for (const ch of "/zz") ui.feed(ch);
    await flush();
    expect(ui.screen()).not.toContain("清空对话");
    expect(ui.screen()).not.toContain("选模型");
    expect(ui.screen()).not.toContain("压缩上下文");

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

/* ═══════════════ /sessions：只看不切 ═══════════════ */

/** 造几行会话，形状与 core 合成出来的那份一致（`alive` 为假时 `phase` 恒为 null）。 */
function sessionsWith(rows: readonly SessionRow[], fail?: Error): SessionFace {
  return {
    ...NO_SESSION_FACE,
    list: async () => {
      if (fail !== undefined) throw fail;
      return rows;
    },
  };
}

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  name: over.id,
  workspace: "/repo",
  product: "echo-agent",
  agent: "default",
  main: true,
  status: "active",
  alive: false,
  phase: null,
  ...over,
});

test("/sessions：把别的会话摆出来——在跑 / 忙着 / 没在跑各说各的，自己那一段不列", async () => {
  // 两个终端各跑一段时，这是唯一能一眼看到对面的地方。没有它只能去翻 ~/.echo/sessions/。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const runtime = runtimeOf(agent, { state: { ...agent.state, sessionId: "s-me" } as never });
  const done = runTui({
    agent: runtime,
    ui,
    sessions: sessionsWith([
      row({ id: "s-me", name: "我自己" }),
      row({ id: "s-busy", name: "改接口", alive: true, phase: "working", workspace: "/repo/back" }),
      row({ id: "s-idle", name: "看 PR", alive: true, phase: "idle", agent: "echo-coding" }),
      row({ id: "s-away", name: "昨天那段" }),
    ]),
  });
  await flush();
  ui.feed("/sessions");
  ui.feed(ENTER);
  await flush();
  const screen = ui.screen();
  expect(screen).toContain("另外 3 段"); // 自己那一段不算
  expect(screen).not.toContain("s-me");
  expect(screen).toContain("改接口");
  expect(screen).toContain("忙着");
  expect(screen).toContain("空闲");
  expect(screen).toContain("没在跑");
  quit(ui);
  await done;
});

test("/sessions：只有自己在跑时说一句，不摆一张空表", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui, sessions: sessionsWith([]) });
  await flush();
  ui.feed("/sessions");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("只有这一段在跑");
  quit(ui);
  await done;
});

test("/sessions：列不出来时如实说，不把界面掀了", async () => {
  // 会话目录在别人手里、盘上有坏 meta 都可能让它抛——那不该让正在用的这一段崩掉。
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui, sessions: sessionsWith([], new Error("meta 解不开")) });
  await flush();
  ui.feed("/sessions");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("列不出来");
  expect(ui.screen()).toContain("meta 解不开");
  quit(ui);
  await done;
});

test("不给 sessions 也能跑：/sessions 说只有这一段（低层用户自己装壳的场合）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui });
  await flush();
  ui.feed("/sessions");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("只有这一段在跑");
  quit(ui);
  await done;
});

/* ─────────────── /resume：挑一段、退出，换实例归装配层 ─────────────── */

/** `/resume` 的常备场景：自己是 s-me，另外两段在盘上。 */
function resumeFixture(): { ui: ReturnType<typeof fakeTui>; runtime: AgentRuntime; sessions: SessionFace } {
  const agent = agentWith([textTurn("好")]);
  return {
    ui: fakeTui(),
    runtime: runtimeOf(agent, { state: { ...agent.state, sessionId: "s-me" } as never }),
    sessions: sessionsWith([
      row({ id: "a1b2c3d4e5f60000", name: "改接口" }),
      row({ id: "9988776655443322", name: "看 PR", alive: true, phase: "idle" }),
      row({ id: "s-me", name: "我自己" }),
    ]),
  };
}

test("/resume <id>：说出要换到哪一段，然后界面自己退出——壳不换 Agent", async () => {
  // 换实例（租约、收件箱、任务清单、闹钟、观测库）归装配层，壳子只挑段。
  const { ui, runtime, sessions } = resumeFixture();
  const resumed: string[] = [];
  const done = runTui({ agent: runtime, ui, sessions, onResume: (id) => resumed.push(id) });
  await flush();
  ui.feed("/resume a1b2c3d4e5f60000");
  ui.feed(ENTER);
  await done; // 不用 quit(ui)：切段本身就是退出这一份界面
  expect(resumed).toEqual(["a1b2c3d4e5f60000"]);
});

test("/resume：认 id 的前缀，也认名字的一截——16 位十六进制没人照着敲全", async () => {
  const { ui, runtime, sessions } = resumeFixture();
  const resumed: string[] = [];
  const done = runTui({ agent: runtime, ui, sessions, onResume: (id) => resumed.push(id) });
  await flush();
  ui.feed("/resume a1b2");
  ui.feed(ENTER);
  await done;
  expect(resumed).toEqual(["a1b2c3d4e5f60000"]);

  const second = resumeFixture();
  const alsoResumed: string[] = [];
  const done2 = runTui({ agent: second.runtime, ui: second.ui, sessions: second.sessions, onResume: (id) => alsoResumed.push(id) });
  await flush();
  second.ui.feed("/resume 看 PR");
  second.ui.feed(ENTER);
  await done2;
  expect(alsoResumed).toEqual(["9988776655443322"]);
});

test("/resume：list() 挂起期间 core 忙起来了 → await 之后复查、顶回去，不掐在飞的那一轮（review 2026-09-07）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  let release: (rows: readonly SessionRow[]) => void = () => {};
  const sessions: SessionFace = {
    ...NO_SESSION_FACE,
    list: () =>
      new Promise<readonly SessionRow[]>((r) => {
        release = r;
      }),
  };
  const resumed: string[] = [];
  const done = runTui({ agent: runtimeOf(agent), ui, sessions, onResume: (id) => resumed.push(id) });
  await flush();
  ui.feed("/resume aa11");
  ui.feed(ENTER);
  await flush();
  setCoreAccepts(agent, false); // list() 还挂着，这时 core 开跑了
  release([row({ id: "aa11", name: "前端" })]);
  await flush();
  expect(resumed).toEqual([]);
  expect(ui.screen()).toContain("正在跑");
  setCoreAccepts(agent, true);
  quit(ui);
  await done;
});

test("/resume：对上多段就把候选摆出来，**不猜**——切错段是打断别人的活", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const resumed: string[] = [];
  const done = runTui({
    agent: runtimeOf(agent),
    ui,
    sessions: sessionsWith([row({ id: "aa11", name: "前端" }), row({ id: "aa22", name: "后端" })]),
    onResume: (id) => resumed.push(id),
  });
  await flush();
  ui.feed("/resume aa");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("对上了 2 段");
  expect(ui.screen()).toContain("aa22");
  expect(resumed).toEqual([]);
  quit(ui);
  await done;
});

test("/resume：没匹配、不带参数、点到自己——各说各的，都不切", async () => {
  const { ui, runtime, sessions } = resumeFixture();
  const resumed: string[] = [];
  const done = runTui({ agent: runtime, ui, sessions, onResume: (id) => resumed.push(id) });
  await flush();
  ui.feed("/resume 不存在的");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("没有匹配");
  ui.feed("/resume");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("要点名切到哪一段");
  ui.feed("/resume s-me");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("已经在这一段了");
  expect(resumed).toEqual([]);
  quit(ui);
  await done;
});

test("/resume：不空就不切——切=收摊这一段，会把在飞的那一轮掐掉（「还没就绪」同一条判据）", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const resumed: string[] = [];
  const done = runTui({
    agent: runtimeOf(agent, { acceptsWork: false }),
    ui,
    sessions: sessionsWith([row({ id: "aa11", name: "前端" })]),
    onResume: (id) => resumed.push(id),
  });
  await flush();
  ui.feed("/resume aa11");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("先 Esc 中断或等它空下来再切");
  expect(resumed).toEqual([]);
  quit(ui);
  await done;
});

test("不给 onResume 的低层用法：/resume 如实说一句没地方去，不假装切了", async () => {
  const ui = fakeTui();
  const agent = agentWith([textTurn("好")]);
  const done = runTui({ agent: runtimeOf(agent), ui, sessions: sessionsWith([row({ id: "aa11" })]) });
  await flush();
  ui.feed("/resume aa11");
  ui.feed(ENTER);
  await flush();
  expect(ui.screen()).toContain("没有换段的去处");
  quit(ui);
  await done;
});

/* ─────────────── 动效：busy 时状态段转 spinner + 计秒，执行中的工具标记也转；空闲全静止 ─────────────── */

const BRAILLE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("跑着的时候：状态段有 spinner 帧和计秒，且帧随时间前进（真 interval）", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = agentWith([textTurn("好")]);
    const pinned = { ...agent.state, status: "generating" as const };
    const done = runTui({ agent: runtimeOf(agent, { state: pinned }), ui });
    await flush();

    const footer = (): string => ui.screen().split("\n").at(-1)!;
    expect(footer()).toMatch(/生成中 \d+s/); // 计秒挂在状态词后面
    expect(footer()).toMatch(BRAILLE);

    const before = BRAILLE.exec(footer())![0];
    await sleep(200); // 80ms 一帧：200ms 必跨帧、不够绕整圈回到原帧
    const after = BRAILLE.exec(footer())![0];
    expect(after).not.toBe(before);

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("空闲：状态段没有帧、没有计秒——动效只属于跑着的时候", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = agentWith([textTurn("好")]);
    const done = runTui({ agent: runtimeOf(agent), ui });
    await flush();

    const footer = ui.screen().split("\n").at(-1)!;
    expect(footer).toContain("空闲");
    expect(footer).not.toMatch(BRAILLE);
    expect(footer).not.toMatch(/\d+s/);

    quit(ui);
    await done;
  } finally {
    restore();
  }
});

test("执行中的工具标记跟着帧走（不再是静态 ⋯），完成后回到 ✓", async () => {
  const restore = isolateKeys();
  try {
    const ui = fakeTui();
    const agent = agentWith([textTurn("好")]);
    const emit = tapEvents(agent);
    const pinned = { ...agent.state, status: "acting" as const };
    const done = runTui({ agent: runtimeOf(agent, { state: pinned }), ui });
    await flush();

    emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", params: { cmd: "sleep 9" } });
    await flush();
    const toolLine = (): string => ui.screen().split("\n").find((l) => l.includes("bash"))!;
    expect(toolLine()).toMatch(BRAILLE);
    expect(toolLine()).not.toContain("⋯");

    const before = BRAILLE.exec(toolLine())![0];
    await sleep(200);
    expect(BRAILLE.exec(toolLine())![0]).not.toBe(before);

    emit({ type: "tool_execution_end", toolCallId: "c1", result: { content: "ok", isError: false } });
    await flush();
    expect(toolLine()).toContain("✓ bash"); // 收尾回静态勾，动效只挂在 running 上

    quit(ui);
    await done;
  } finally {
    restore();
  }
});
