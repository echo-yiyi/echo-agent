// 记忆模块的契约门。对应设计 docs/design/parts/memory.md。
//
// 锁的不变量:
//   ① 三层内建(agent/user resident + memory indexed),分区注册开、路径重叠 fail-loud
//   ② 方法是唯一写路径,工具是薄壳;INDEX.md 落盘、由写方法重建、不许直接改、不索引自己
//   ③ 组装:resident 全文、indexed 只有索引;索引行单行化;renderMemorySystem 绝不 throw
//   ④ 写入:统一过 checkWrite(预算拒绝带整理指引);路径 jail(../绝对/点开头全拒)
//   ⑤ 工具六动词行为(str_replace 唯一命中、rename 不许跨分区)
//   ⑥ Dream 门控(写入/轮次/文件数/间隔/锁)与 markDreamed 清计数;INDEX 与内部状态不计数
//   ⑦ Agent 接线:工具普通注册、system 冻结快照、run 内写下个 run 可见、dispose 链

import { describe, expect, test } from "bun:test";
import { registerTool, unregisterTool, listTools } from "../src/tools/harness.ts";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import type { Context } from "../src/messages.ts";
import type { StreamFn } from "../src/provider/types.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { defaultComposeMemory, renderMemorySystem } from "../src/memory/compose.ts";
import { parseFrontmatter } from "../src/prompt/markdown.ts";
import { singleLine } from "../src/prompt/sanitize.ts";
import { DEFAULT_DREAM_GATES } from "../src/memory/dream.ts";
import {
  createAgentMemories, addMemory, removeMemoryRegion, listMemories, getMemory, memoryFor,
  memoryView, memoryCreate, memoryStrReplace, memoryInsert, memoryDelete, memoryRename,
  memoryPromptSections, composeMemoryRegion, memoryTool, memoryObserver,
  shouldDream, dreamTask, markDreamed, disposeMemory, MEMORY_KIND, type AgentMemories,
} from "../src/memory/harness.ts";

import { InMemoryDir } from "../src/memory/in-memory-dir.ts";
import { createMemoryTool, normalizeMemoryPath, MEMORY_TOOL_NAME } from "../src/memory/tool.ts";
import { agentMemory, notesMemory, indexedMemory, memoryOwns, residentMemory } from "../src/memory/types.ts";
import type { MemoryDir } from "../src/memory/types.ts";
import type { ToolExecutionContext } from "../src/tools/types.ts";

function ctx(): ToolExecutionContext {
  return { toolCallId: "t", cwd: "/", workspaceRoot: "/", sessionId: null, iteration: 0 };
}

async function call(h: AgentMemories, params: Record<string, unknown>) {
  const tool = memoryTool(h);
  return tool.execute(tool.prepareArguments!(params), ctx());
}

/* ───────────────────────── ① 数据与分区 ───────────────────────── */

describe("Memory 判别联合与分区", () => {
  test("内建三层:agent/user resident,memory indexed", () => {
    const h = createAgentMemories(new InMemoryDir());
    expect(listMemories(h).map((m) => `${m.name}:${m.mode}`)).toEqual(["agent:resident", "user:resident", "memory:indexed"]);
  });

  test("memoryOwns:resident 精确匹配,indexed 前缀匹配", () => {
    expect(memoryOwns(agentMemory, "agent.md")).toBe(true);
    expect(memoryOwns(agentMemory, "agent.md.bak")).toBe(false);
    expect(memoryOwns(notesMemory, "memory/a.md")).toBe(true);
    expect(memoryOwns(notesMemory, "memory/")).toBe(false); // 目录本身不是文件
  });

  test("撞名与路径重叠都 fail-loud", () => {
    const h = createAgentMemories(new InMemoryDir());
    expect(() => addMemory(h, residentMemory("agent"))).toThrow("已存在");
    expect(() => addMemory(h, indexedMemory("nested", { path: "memory/nested/" }))).toThrow("重叠");
    addMemory(h, indexedMemory("project")); // 不重叠的可以加
    expect(getMemory(h, "project")?.mode).toBe("indexed");
  });

  test("indexed 的 path 必须以 / 结尾", () => {
    expect(() => indexedMemory("x", { path: "x.md" })).toThrow("以 / 结尾");
  });
});

/* ───────────────────────── ② INDEX.md:落盘、系统维护 ───────────────────────── */

describe("INDEX.md(落盘索引)", () => {
  test("写方法成功后重建;description 来自 frontmatter,退化首行", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "memory/a.md", file_text: "---\ndescription: 钩子甲\n---\n\n正文" });
    await call(h, { command: "create", path: "memory/b.md", file_text: "首行是钩子乙\n第二行" });
    const index = await dir.read("memory/INDEX.md");
    expect(index).toContain("- memory/a.md — 钩子甲");
    expect(index).toContain("- memory/b.md — 首行是钩子乙");
    await call(h, { command: "delete", path: "memory/a.md" });
    expect(await dir.read("memory/INDEX.md")).not.toContain("a.md");
  });

  test("索引不索引自己;直接改 INDEX.md 被拒(系统维护)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "memory/a.md", file_text: "x" });
    expect(await dir.read("memory/INDEX.md")).not.toContain("INDEX.md");
    const denied = await call(h, { command: "create", path: "memory/INDEX.md", file_text: "伪造索引" });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("系统维护");
  });
});

/* ───────────────────────── ③ 组装 ───────────────────────── */

describe("组装(defaultComposeMemory / renderMemorySystem)", () => {
  test("resident:全文进段,超预算截断留标记", async () => {
    const dir = new InMemoryDir();
    await dir.write("agent.md", "x".repeat(3000));
    const block = await defaultComposeMemory(agentMemory, dir);
    expect(block).toContain("## 记忆 · agent");
    expect(block).toContain("…[截断]");
    expect(block.length).toBeLessThan(2400);
  });

  test("indexed:读落盘 INDEX.md;没有则现场扫描(人手预置目录的口径)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "memory/a.md", file_text: "---\ndescription: 钩子\n---\n\n这段机密正文绝不该出现" });
    const block = await defaultComposeMemory(notesMemory, dir);
    expect(block).toContain("- memory/a.md — 钩子");
    expect(block).not.toContain("机密正文"); // 只有索引,正文按需
    // 人手预置(没有 INDEX.md)也能出索引
    const bare = new InMemoryDir();
    await bare.write("memory/manual.md", "手放的首行");
    expect(await defaultComposeMemory(notesMemory, bare)).toContain("- memory/manual.md — 手放的首行");
  });

  test("索引行单行化:换行伪装多行 system 被折叠", () => {
    expect(singleLine("a\nb\r\nc d")).toBe("a b c d");
  });

  test("frontmatter:标准解析 + 无 frontmatter 宽容退化", () => {
    expect(parseFrontmatter("---\ndescription: 'x'\n---\nbody").meta["description"]).toBe("x");
    expect(parseFrontmatter("裸正文").meta).toEqual({});
  });

  test("renderMemorySystem 绝不 throw:某分区读坏 → 该分区隐形,其余照常", async () => {
    const bad: MemoryDir = {
      read: async (p) => {
        if (p === "agent.md") throw new Error("盘坏了");
        return p === "user.md" ? "用户偏好中文" : null;
      },
      write: async () => {},
      remove: async () => false,
      list: async () => [],
    };
    const h = createAgentMemories(bad);
    const block = await renderMemorySystem(h);
    expect(block).toContain("用户偏好中文");
    expect(block).not.toContain("盘坏了");
  });

  test("空记忆也出使用规则(模型要知道可以写)", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const block = await renderMemorySystem(h);
    expect(block).toContain("# 记忆");
    expect(block).toContain("memory/");
  });
});

/* ───────────────────────── ④ 路径 jail 与写入闸 ───────────────────────── */

describe("路径 jail", () => {
  test("剥 /memories 前缀(兼容训练行为)", () => {
    expect(normalizeMemoryPath("/memories/agent.md")).toBe("agent.md");
    expect(normalizeMemoryPath("/memories")).toBe("");
  });

  test("越狱全拒:.. / 相对逃逸 / 反斜杠 / 点开头(内部状态)", () => {
    expect(() => normalizeMemoryPath("../etc/passwd")).toThrow();
    expect(() => normalizeMemoryPath("memory/../../x")).toThrow();
    expect(() => normalizeMemoryPath("a\\b")).toThrow();
    expect(() => normalizeMemoryPath(".dream/state.json")).toThrow();
    expect(() => normalizeMemoryPath("memory/.hidden.md")).toThrow();
  });
});

describe("写入闸(checkWrite 经方法生效)", () => {
  test("resident 超预算拒,拒因带整理指引", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "user.md", file_text: "x".repeat(2000) });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("超预算");
    expect(r.content).toContain("str_replace");
  });

  test("indexed 单文件超限拒", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "memory/big.md", file_text: "x".repeat(5000) });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("单文件超限");
  });

  test("分区外路径拒,并告知可用分区", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "elsewhere.md", file_text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("不在任何记忆分区");
    expect(r.content).toContain("agent");
  });
});

/* ───────────────────────── ⑤ 六动词(薄壳调方法) ───────────────────────── */

describe("memory 工具六动词", () => {
  test("create → view(带行号)→ str_replace(唯一命中)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    expect((await call(h, { command: "create", path: "agent.md", file_text: "第一行\n第二行" })).isError).toBe(false);
    const viewed = await call(h, { command: "view", path: "agent.md" });
    expect(viewed.content).toBe("1\t第一行\n2\t第二行");
    const replaced = await call(h, { command: "str_replace", path: "agent.md", old_str: "第二行", new_str: "改过的" });
    expect(replaced.isError).toBe(false);
    expect(await dir.read("agent.md")).toBe("第一行\n改过的");
  });

  test("上层复写的正确姿势:自己的工具调我们的方法(计数、索引照常)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir, { dream: { minWritesSinceLast: 1, minFiles: 1 } });
    // 模拟上层自定义 remember 工具:内部就是调 h.create
    const remember = async (note: string) => memoryCreate(h, `memory/note.md`, note);
    expect((await remember("用户偏好 tab")).isError).toBe(false);
    expect(await dir.read("memory/INDEX.md")).toContain("note.md"); // 索引重建没断
    expect(await shouldDream(h)).toBe(true); // 计数没断
  });

  test("str_replace:零命中与多义都拒", async () => {
    const h = createAgentMemories(new InMemoryDir());
    await call(h, { command: "create", path: "agent.md", file_text: "aa aa" });
    expect((await call(h, { command: "str_replace", path: "agent.md", old_str: "没有", new_str: "x" })).content).toContain("没找到");
    expect((await call(h, { command: "str_replace", path: "agent.md", old_str: "aa", new_str: "x" })).content).toContain("必须唯一");
  });

  test("insert 行号语义与越界", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "agent.md", file_text: "a\nb" });
    await call(h, { command: "insert", path: "agent.md", insert_line: 1, insert_text: "中间" });
    expect(await dir.read("agent.md")).toBe("a\n中间\nb");
    expect((await call(h, { command: "insert", path: "agent.md", insert_line: 99, insert_text: "x" })).isError).toBe(true);
  });

  test("delete 与 rename;rename 不许跨分区(换预算域不许静默发生)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "memory/a.md", file_text: "内容" });
    const cross = await call(h, { command: "rename", path: "memory/a.md", new_path: "agent.md" });
    expect(cross.isError).toBe(true);
    expect(cross.content).toContain("同一分区");
    expect((await call(h, { command: "rename", path: "memory/a.md", new_path: "memory/b.md" })).isError).toBe(false);
    expect(await dir.read("memory/a.md")).toBeNull();
    expect(await dir.read("memory/b.md")).toBe("内容");
    expect(await dir.read("memory/INDEX.md")).toContain("b.md"); // 改名后索引跟上
    expect((await call(h, { command: "delete", path: "memory/b.md" })).isError).toBe(false);
    expect((await call(h, { command: "delete", path: "memory/b.md" })).isError).toBe(true); // 已不存在
  });

  test("view 根:各分区概览;内部状态(.dream)不可见", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "memory/a.md", file_text: "x" });
    await dir.write(".dream/state.json", "{}");
    const r = await call(h, { command: "view", path: "" });
    expect(r.content).toContain("memory/a.md");
    expect(r.content).not.toContain(".dream");
  });

  test("细粒度复写:handlers 只换一个动词,其余走缺省", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const tool = createMemoryTool(h, { handlers: { view: async () => ({ content: "自定义视图", isError: false, metadata: null }) } });
    const viewed = await tool.execute(tool.prepareArguments!({ command: "view", path: "" }), ctx());
    expect(viewed.content).toBe("自定义视图");
    const created = await tool.execute(tool.prepareArguments!({ command: "create", path: "agent.md", file_text: "x" }), ctx());
    expect(created.isError).toBe(false);
  });
});

/* ───────────────────────── ⑥ Dream ───────────────────────── */

describe("Dream 门控", () => {
  test("写入门与文件数门;INDEX.md 不算一条记忆", async () => {
    const h = createAgentMemories(new InMemoryDir(), { dream: { minWritesSinceLast: 2, minFiles: 2 } });
    expect(await shouldDream(h)).toBe(false);
    await call(h, { command: "create", path: "memory/a.md", file_text: "a" });
    expect(await shouldDream(h)).toBe(false); // 写 1 文件 1
    await call(h, { command: "create", path: "memory/b.md", file_text: "b" });
    expect(await shouldDream(h)).toBe(true); // 写 2 文件 2

    // 文件数把 INDEX.md 也算进去的话,minFiles: 3 此刻就会满足——必须不满足
    const h3 = createAgentMemories(new InMemoryDir(), { dream: { minFiles: 3 } });
    await call(h3, { command: "create", path: "memory/a.md", file_text: "a" });
    await call(h3, { command: "create", path: "memory/b.md", file_text: "b" });
    expect(await shouldDream(h3)).toBe(false);
  });

  test("轮次门经 observer 喂;markDreamed 清计数并记时间", async () => {
    const h = createAgentMemories(new InMemoryDir(), { dream: { minTurnsSinceLast: 2 } });
    expect(await shouldDream(h)).toBe(false);
    const observe = memoryObserver(h);
    const fake = { seq: 0, at: 0, type: "turn_end", iteration: 0, message: {} as never, toolResults: [] } as never;
    await observe(fake, new AbortController().signal);
    await observe(fake, new AbortController().signal);
    expect(await shouldDream(h)).toBe(true);
    await markDreamed(h);
    expect(await shouldDream(h)).toBe(false); // 计数清零
  });

  test("dreamTask 上锁:进行中不重复触发;备料只含 memory 工具", async () => {
    const h = createAgentMemories(new InMemoryDir(), { dream: {} }); // 无门 = 恒可触发
    expect(await shouldDream(h)).toBe(true);
    const task = await dreamTask(h);
    expect(task.tools.map((t) => t.name)).toEqual([MEMORY_TOOL_NAME]);
    expect(task.prompt).toContain("整理");
    expect(await shouldDream(h)).toBe(false); // 锁住了
  });

  test("内部状态与索引重建不计入写入计数", async () => {
    const h = createAgentMemories(new InMemoryDir(), { dream: { minWritesSinceLast: 2 } });
    await markDreamed(h); // 写 .dream/state.json——不计数
    await call(h, { command: "create", path: "memory/a.md", file_text: "a" }); // 一次写(顺带重建 INDEX,不另计)
    expect(await shouldDream(h)).toBe(false); // 计数是 1 不是 2/3
  });

  test("缺省门就是 CC 量级(防手滑改缺省)", () => {
    expect(DEFAULT_DREAM_GATES).toEqual({ minWritesSinceLast: 5, minFiles: 10, minIntervalMs: 24 * 3600_000 });
  });
});

/* ───────────────────────── ⑦ Agent 接线 ───────────────────────── */

describe("Agent 接线", () => {
  test("memory 工具经 `echo:memory` builtin Extension 注册（无特权通道）,state.tools 可见", async () => {
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: scriptedStreamFn([]),
      memory: createAgentMemories(new InMemoryDir()),
    });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    expect(agent.state.tools.map((t) => t.name)).toContain(MEMORY_TOOL_NAME);
    expect(agent.tools.has(MEMORY_TOOL_NAME)).toBe(true);
  });

  test("不传 memory = 没有记忆:无工具、system 无记忆段", async () => {
    const seen: Context[] = [];
    const inner = scriptedStreamFn([textTurn("好")]);
    const spy: StreamFn = (m, c, o) => {
      seen.push(c);
      return inner(m, c, o);
    };
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy, systemPrompt: "base" });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    await agent.prompt("hi");
    expect(seen[0]?.systemPrompt).toContain("base");
    expect(seen[0]?.systemPrompt).not.toContain("# 记忆");
    expect(agent.state.tools.map((t) => t.name)).not.toContain(MEMORY_TOOL_NAME);
  });

  test("冻结快照:模型 run 内写记忆,本 run system 不变、下个 run 可见", async () => {
    const dir = new InMemoryDir();
    await dir.write("user.md", "旧偏好");
    const seen: Context[] = [];
    const inner = scriptedStreamFn([
      toolTurn("t1", MEMORY_TOOL_NAME, { command: "str_replace", path: "user.md", old_str: "旧偏好", new_str: "新偏好" }),
      textTurn("记好了"),
      textTurn("第二个任务"),
    ]);
    const spy: StreamFn = (m, c, o) => {
      seen.push(c);
      return inner(m, c, o);
    };
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: spy,
      systemPrompt: "base",
      memory: createAgentMemories(dir),
    });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册

    const first = await agent.prompt("记住:新偏好");
    expect(first.outcome.kind).toBe("completed");
    expect(await dir.read("user.md")).toBe("新偏好"); // 盘上立即生效
    // 本 run 两轮看到同一份快照(旧内容)——冻结,不破 prompt cache
    expect(seen[0]?.systemPrompt).toContain("旧偏好");
    expect(seen[1]?.systemPrompt).toContain("旧偏好");

    await agent.prompt("下一个任务");
    expect(seen[2]?.systemPrompt).toContain("新偏好"); // 任务边界刷新
    expect(seen[2]?.systemPrompt).toContain("base"); // 装备 systemPrompt 在前,记忆段在后
  });

  test("dispose 链:close 传到 MemoryDir", async () => {
    let closed = false;
    const dir: MemoryDir = {
      read: async () => null,
      write: async () => {},
      remove: async () => false,
      list: async () => [],
      close: async () => {
        closed = true;
      },
    };
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), memory: createAgentMemories(dir) });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    await agent.dispose();
    expect(closed).toBe(true);
  });
});
