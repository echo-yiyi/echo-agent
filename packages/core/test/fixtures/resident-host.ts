// Runtime V0 Gate 的**宿主程序**（12 条 resident integration）。
//
// 这不是测试，是一个**真的会被 spawn 起来的进程**。测试（`resident-v0.test.ts`）负责
// 起它三次、比对它吐出的报告——「跨进程」这一维只有这样才成立：
// 此前那些写着「换个进程」的用例换的是**实例**（同一个 InMemoryDir 传给新 Agent），
// 全仓唯一真起第二个进程的是 Distribution Gate 的 `node run.mjs`，而那条只做一次调用。
//
// **只配置 Provider，不实现任何 Core 接口**（第 2 条）：
// 不传 `store` / `lock` / `sessionService` / `memory` / `schedule` / `inboxStore`——
// 全部由 `createAgent` 按状态根装配 + `echo:*` builtin Extension 挂工具面。
// 这里唯一「自己写」的东西是一个**确定性 provider**，
// 而 provider 本来就是使用者该配的那一件。
//
// 用法：`bun resident-host.ts <echoHome> <phase> [sessionId]`，phase ∈ {a, wake, crash, c}。
// **状态根 = session 目录**（2026-09-03）：这里只给 `ECHO_HOME`，让 `createAgent` 自己解析出
// `<home>/sessions/<id>`——跨进程共享的 tasks / inbox / schedule 因此必须**点名同一段**。
// 报告走 stdout 最后一行的 JSON。

import { join } from "node:path";
import { createAgent } from "../../src/create-agent.ts";
import { mountBuiltinTools } from "../../src/extension/builtin.ts";
import { listSchedules } from "../../src/schedule/harness.ts";
import { createProvider } from "../../src/provider/models.ts";
import { createProviderStreams } from "../../src/provider/dialect.ts";
import { environmentMessage } from "../../src/messages.ts";
import { readDreamState } from "../../src/memory/dream.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { FileDir } from "../../src/storage/file-dir.ts";
import type { Model, Provider } from "../../src/provider/types.ts";
import type { Context, ContentBlock } from "../../src/messages.ts";
import type { ProviderEvent } from "../../src/events.ts";

/** 模型每次看见的东西——第 9 条要验的就是它。 */
type SeenCall = {
  readonly systemPrompt: string;
  readonly roles: readonly string[];
  readonly tools: readonly string[];
  readonly texts: readonly string[];
};

// 第三个参数：要**续**哪一段会话。缺省每次启动新建（2026-09-01），跨进程恢复对话由宿主显式给 id
const [, , echoHomeArg, phase, resumeSessionId] = process.argv;
if (echoHomeArg === undefined || phase === undefined) {
  console.error("用法：resident-host.ts <echoHome> <phase> [sessionId]");
  process.exit(2);
}

// 状态根由 `createAgent` 从 ECHO_HOME 解析：`<home>/sessions/<id>`。
process.env["ECHO_HOME"] = echoHomeArg;
/** 那一段 session 自己的目录——tasks / inbox / entries 都在它下面。 */
const sessionDir = (id: string): string => join(echoHomeArg, "sessions", id);
/** 记忆在 user 层（跨 session 共享），不在 session 目录里。 */
const memoryDir = (): string => join(echoHomeArg, "memory");
/** 每一段都点名：跨进程共享 tasks / inbox / schedule 的前提是**同一段 session**。 */
const resumeOpt = resumeSessionId === undefined ? {} : { sessionId: resumeSessionId };

const seen: SeenCall[] = [];

/**
 * 宿主自带的一个 skill。**内容是使用者给的，能力才是 Agent 自己的**——
 * `skill_activate` 这个工具由 Agent 装（构造期见到非空池就注册）。
 * `modelInvocable` 不给 true 的话激活会被拒（「不对模型开放」是 skill 的一条真契约）。
 */
const SKILL = {
  name: "写提交信息",
  description: "写 commit message 时用",
  content: "首行一句话说清改了什么，正文写为什么。",
  files: [] as string[],
  requiredTools: [] as string[],
  modelInvocable: true,
  frontmatter: {},
};

/**
 * 确定性 provider。**每一轮的脚本由 phase 决定**；同时把模型收到的 Context 记下来。
 *
 * 记录点放在 dialect 里而不是包一层 `streamFunction`：后者要走 `agent.streamFunction`
 * 覆盖，那更像「实现 Core 接口」；dialect 是 provider 自己的内部，配 provider 天经地义。
 */
function scriptedProvider(turns: ProviderEvent[][]): Provider {
  let i = 0;
  return createProvider({
    id: "resident",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "resident" }],
    api: createProviderStreams({
      api: "resident",
      async *request(_model: Model, context: Context): AsyncGenerator<ProviderEvent> {
        seen.push({
          systemPrompt: context.systemPrompt ?? "",
          roles: context.messages.map((m) => m.role),
          tools: context.tools.map((t) => t.name).sort(),
          texts: context.messages.flatMap((m) => textsOf(m.content)),
        });
        const turn = turns[i++];
        if (turn === undefined) {
          yield { type: "error", error: { source: "provider", code: "protocol", retryable: false, message: "脚本用尽" } };
          return;
        }
        for (const ev of turn) yield structuredClone(ev);
      },
    }),
  });
}

/** 从投影后的消息里捞出纯文本。线上形状里 content 可能是字符串或块数组。 */
function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).flatMap((b) => (b.type === "text" ? [b.text] : []));
}

function text(t: string): ProviderEvent[] {
  return [
    { type: "start" },
    { type: "text_start" },
    { type: "text_delta", text: t },
    { type: "text_end" },
    { type: "done", message: { role: "assistant", content: [{ type: "text", text: t }], stopReason: "end_turn", usage: null } },
  ];
}

function callTool(id: string, name: string, input: Record<string, unknown>): ProviderEvent[] {
  return [
    { type: "start" },
    { type: "toolcall_start", toolCallId: id, name },
    { type: "toolcall_delta", argsText: JSON.stringify(input) },
    { type: "toolcall_end" },
    {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name, input }],
        stopReason: "tool_use",
        usage: null,
      },
    },
  ];
}

async function main(): Promise<void> {
  if (phase === "a") {
    // ① 全新进程 + Agent；② 只配 provider；③ 自动建会话 + 一次模型调用 + 一次工具调用；
    // ④ 由 **Agent** 建 Memory 与 Schedule（模型点工具，不是宿主调 harness）
    const agent = await createAgent({
      provider: scriptedProvider([
        callTool("t1", "memory", {
          command: "create",
          path: "memory/项目.md",
          file_text: "---\ndescription: 项目笔记\n---\n\n用户在做 Echo",
        }),
        // 再写 9 个，把 Dream 的门喂饱：缺省是 minFiles 10 / minWritesSinceLast 5。
        // **不需要假时钟**——`minIntervalMs`（24h）只在 `lastAt !== null` 时才判，
        // 新 agent 从没整理过，那道门直接跳过。
        ...Array.from({ length: 9 }, (_, k) =>
          callTool(`m${k}`, "memory", {
            command: "create",
            path: `memory/笔记${k}.md`,
            file_text: `---\ndescription: 第 ${k} 条\n---\n\n内容 ${k}`,
          }),
        ),
        callTool("t2", "TaskCreate", { tasks: [{ title: "把 M6 做完", detail: "Runtime V0 Gate 起手" }] }),
        callTool("t3", "skill_activate", { name: "写提交信息" }),
        // schedule_create / skill_create 是延迟工具（2026-09-02 `deferred: true`）：先经 tool_search 取 schema，下一轮才能调
        callTool("t3b", "tool_search", { names: ["schedule_create", "skill_create"] }),
        callTool("t4", "schedule_create", { prompt: "该看一眼进度了", every_seconds: 60 }),
        // OSS-1c：由 **Agent** 创建 skill 并落盘到状态根——下一个进程要能发现它
        callTool("t5", "skill_create", {
          name: "review-checklist",
          description: "review 时逐条过的清单",
          content: "先看判据有没有区分力。",
        }),
        text("建好了"),
        // ⑥ 这一轮是 **Dream 自己**的：门满足后 `finishRun` 会起它，宿主没调任何东西
        text("整理完了"),
      ]),
      allowNetwork: false,
      ...resumeOpt,
      // **skill 的「内容」是使用者给的，「能力」才是 Agent 自己的**——
      // 所以这里传一个 skill 进去（和传 tools 同性质），而 `skill_activate` 这个**工具**
      // 由 `echo:skills` builtin Extension 装（2026-08-31 起：构造归 core，注册走 extension）。
      agent: { skills: [SKILL] },
    });
    await mountBuiltinTools(agent); // 工具面由 builtin Extension 装
    await agent.start();
    await agent.prompt("把「用户在做 Echo」记进记忆、建个任务、启用那个 skill，再建一个每分钟的提醒");
    // ⑥ 等整理**真的提交**再收摊：`stop()` 会中断在飞的 dream（那是它该做的），
    // 睡一觉赌它跑完了是 flaky 的判据，所以这里盯的是盘上的 `lastAt`。
    const dreamed = await waitFor(async () => (await readDreamState(new FileDir(memoryDir()))).lastAt !== null);

    // **快照要在 stop() 之前取**：`dispose()` 的语义是「资产归零」，
    // 停完再读 `state.tasks` / `state.activeSkills` 一律是空的（第一版就这么读的，
    // 于是 taskCount 恒为 0——判据看着有，其实什么都没盯住）。
    const snapshot = {
      tools: toolResults(agent),
      activeSkills: agent.state.activeSkills.map((sk) => sk.name),
      taskCount: agent.state.tasks.total,
      // 这条 id 要在**下一个进程**里还认得出来——否则「闹钟跨进程恢复」没有被证明
      scheduleIds: (await listSchedules(agent.schedule!)).map((e) => e.schedule.id),
    };
    await agent.stop(); // ⑪ 干净收摊
    report({ phase, seen, sessionId: agent.state.sessionId, dreamed, ...snapshot });
    return;
  }

  if (phase === "wake") {
    // ⑤ 到期经 Inbox 唤醒 Agent，**不是测试直接调 loop**。
    // 同样不需要假时钟：`at` 不限过去未来，tick 每秒一拍，设 1.2 秒之后即可。
    const at = new Date(Date.now() + 1_200).toISOString();
    const agent = await createAgent({
      provider: scriptedProvider([
        callTool("w0", "tool_search", { names: ["schedule_create"] }), // 新进程：延迟工具要重新取（已加载按进程记）
        callTool("w1", "schedule_create", { prompt: "该看一眼进度了", at }),
        text("定好了"),
        // 这一轮是闹钟把它叫醒之后自己开的
        text("我醒了，看一眼"),
      ]),
      allowNetwork: false,
      ...resumeOpt,
    });
    await mountBuiltinTools(agent); // 工具面由 builtin Extension 装
    await agent.start();
    await agent.prompt("一分钟后提醒我");

    // 等它自己醒——判据是**环境消息进了对话**，不是「定时器回调被调用过」
    const woke = await waitFor(async () =>
      agent.messages.some((m) => m.role === "environment" && (m as { source?: string }).source === "schedule"),
    );
    const scheduleIds = (await listSchedules(agent.schedule!)).map((e) => e.schedule.id);
    await agent.stop();
    report({ phase, seen, woke, scheduleIds, messages: agent.messages.length });
    return;
  }

  if (phase === "crash") {
    // ⑩ 已接受但未消费的入站事实：投进来、**不消费**、然后硬退出（不 stop）。
    // 同一段里再让模型建一条任务：**工具回执说成功之后就崩**，用来验
    // 「任务改完即落盘」而不是「等到 stop() 才写」——干净 stop 会把这个缺口掩盖掉。
    const agent = await createAgent({
      provider: scriptedProvider([
        callTool("x1", "TaskCreate", { tasks: [{ title: "崩溃前建的" }] }),
        text("建好了"),
      ]),
      allowNetwork: false,
      ...resumeOpt,
    });
    await mountBuiltinTools(agent); // 工具面由 builtin Extension 装
    await agent.start();
    agent.autoConsumeInbox = false;
    await agent.prompt("再建一条任务");
    await agent.ingress.deliverDurable({ message: environmentMessage("后台任务跑完了", "background", "b1"), dedupeKey: "background b1" });
    // 落盘是排在 microtask 上的，让它跑完再崩——**判据是「崩之前不需要 stop()」，
    // 不是「不需要等一个 microtask」**。
    await waitFor(async () => (await new FileDir(sessionDir(agent.state.sessionId!)).read("tasks.json"))?.includes("崩溃前建的") === true, 2_000);
    report({ phase, seen });
    process.exit(0); // **不 stop**：模拟进程被砍
  }

  if (phase === "c") {
    // ⑧ 新进程 + 新 Agent，恢复全部状态；**会话是显式续的**（宿主给 id，2026-09-01：缺省每次启动新建一段）
    // ⑨ 第二轮模型调用要**用得上**第一轮的 Session / Memory / Task 上下文
    const agent = await createAgent({
      provider: scriptedProvider([text("我看到之前的记录了"), text("再说一次")]),
      allowNetwork: false,
      ...resumeOpt,
      // 真实宿主每次启动都会把自己的 skill 交进来（内容来自它的配置或盘），
      // 所以这里也给——第 9 条的「Skill 上下文」指的是**目录段进 system**，
      // 不是「上一轮激活过的那次还留着」（激活是运行态，不跨进程）。
      agent: { skills: [SKILL] },
    });
    await mountBuiltinTools(agent); // 工具面由 builtin Extension 装
    await agent.start();
    // 等恢复出来的 inbox 被**它自己**吃干净。
    // **盯可观测结果，不睡固定时长**——本文件自己强调过这条，上一版却在这里 sleep(50)，
    // CI 上一抖就假红/假绿。没有待消费时这句立即返回。
    await waitFor(async () => (await new InboxStore(new FileDir(sessionDir(agent.state.sessionId!))).restore()).length === 0);
    await agent.prompt("刚才我们聊到哪了？");
    const snapshot = {
      taskCount: agent.state.tasks.total,
      messages: agent.messages.length,
      // A 进程 `skill_create` 的那个要在这里被 `start()` 发现回来——真跨进程，不是换实例
      skills: [...agent.skills.keys()],
    };
    await agent.stop();
    report({ phase, seen, sessionId: agent.state.sessionId, ...snapshot });
    return;
  }

  console.error(`不认识的 phase：${phase}`);
  process.exit(2);
}

/** 轮询到条件成立或超时。**盯可观测的结果，不睡固定时长**——后者是 flaky 的来源。 */
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function report(r: Record<string, unknown>): void {
  console.log(`__REPORT__${JSON.stringify(r)}`);
}

/** 工具调用的**结果**——第 3/4 条要的是「调用成功」，不是「调用发生过」。 */
function toolResults(agent: { messages: readonly { role: string }[] }): unknown[] {
  return agent.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      const t = m as unknown as { toolName: string; isError: boolean; content: string };
      return { tool: t.toolName, isError: t.isError, content: t.content.slice(0, 200) };
    });
}

await main();
