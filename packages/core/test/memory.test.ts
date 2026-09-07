// 记忆模块的契约门。
//
// 锁的不变量:
//   ① 三个分区(agent/user resident + memory indexed)× 三层作用域(user/project/session),
//      分区注册开、路径重叠 fail-loud;哪层有哪个分区按「切法」的落盘表
//   ② 方法是唯一写路径,工具是薄壳;INDEX.md 落盘、由写方法重建、不许直接改、不索引自己
//   ③ 组装:resident 全文、indexed 只有索引;一个分区每层各一段、各带自己的路径;索引行单行化;
//      renderMemorySystem 绝不 throw
//   ④ 写入:统一过 checkWrite(预算拒绝带整理指引);路径 jail(../绝对/点开头全拒);
//      选层走路径前缀——那一层没有这个分区就判红
//   ⑤ 工具六动词行为(str_replace 唯一命中、rename 不许跨分区、也不许跨层)
//   ⑥ Dream 门控(写入/轮次/文件数/间隔/锁)与 markDreamed 清计数;INDEX 与内部状态不计数;
//      **只整理 session 层**——工具够不到上两层
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
import { fnv1a64hex, memoryScopeDir, projectPrefix } from "../src/memory/scope.ts";
import { agentMemory, notesMemory, indexedMemory, memoryOwns, memoryPaths, residentMemory } from "../src/memory/types.ts";
import type { MemoryDir } from "../src/memory/types.ts";
import type { ToolExecutionContext } from "../src/tools/types.ts";

function ctx(): ToolExecutionContext {
  return { toolCallId: "t", workspace: "/", sessionId: null, iteration: 0 };
}

async function call(h: AgentMemories, params: Record<string, unknown>) {
  const tool = memoryTool(h);
  return tool.execute(tool.prepareArguments!(params), ctx());
}

/* ───────────────────────── ① 数据、分区与作用域 ───────────────────────── */

describe("Memory 判别联合与分区", () => {
  test("内建三个分区:agent/user resident,memory indexed", () => {
    const h = createAgentMemories(new InMemoryDir());
    expect(listMemories(h).map((m) => `${m.name}:${m.mode}`)).toEqual(["agent:resident", "user:resident", "memory:indexed"]);
  });

  test("落盘表:agent / user 两分区在 user + project,笔记三层都有(session 层只有笔记)", () => {
    const h = createAgentMemories(new InMemoryDir());
    expect(memoryPaths(getMemory(h, "agent")!).map((p) => p.path)).toEqual(["user/agent.md", "project/agent.md"]);
    expect(memoryPaths(getMemory(h, "user")!).map((p) => p.path)).toEqual(["user/user.md", "project/user.md"]);
    expect(memoryPaths(getMemory(h, "memory")!).map((p) => p.path)).toEqual(["user/memory/", "project/memory/", "session/memory/"]);
  });

  test("memoryOwns:收全路径,resident 精确匹配、indexed 前缀匹配;那一层没有这个分区就不归它", () => {
    expect(memoryOwns(agentMemory, "user/agent.md")).toBe(true);
    expect(memoryOwns(agentMemory, "project/agent.md")).toBe(true);
    expect(memoryOwns(agentMemory, "session/agent.md")).toBe(false); // session 层没有这个分区
    expect(memoryOwns(agentMemory, "agent.md")).toBe(false); // 缺作用域前缀
    expect(memoryOwns(agentMemory, "user/agent.md.bak")).toBe(false);
    expect(memoryOwns(notesMemory, "session/memory/a.md")).toBe(true);
    expect(memoryOwns(notesMemory, "user/memory/")).toBe(false); // 目录本身不是文件
  });

  test("撞名与路径重叠都 fail-loud", () => {
    const h = createAgentMemories(new InMemoryDir());
    expect(() => addMemory(h, residentMemory("agent"))).toThrow("已存在");
    expect(() => addMemory(h, indexedMemory("nested", { path: "memory/nested/" }))).toThrow("重叠");
    addMemory(h, indexedMemory("scratch")); // 不重叠的可以加
    expect(getMemory(h, "scratch")?.mode).toBe("indexed");
  });

  test("同一分区内路径落在不同层不算重叠(比的是带作用域的全路径)", () => {
    const h = createAgentMemories(new InMemoryDir(), { memories: [indexedMemory("a", { scopes: ["user"] })] });
    addMemory(h, indexedMemory("b", { path: "a/", scopes: ["project"] })); // 同一个分区内路径,另一层
    expect(listMemories(h).map((m) => m.name)).toEqual(["a", "b"]);
    expect(() => addMemory(h, indexedMemory("c", { path: "a/", scopes: ["user"] }))).toThrow("重叠");
  });

  test("indexed 的 path 必须以 / 结尾", () => {
    expect(() => indexedMemory("x", { path: "x.md" })).toThrow("must end with /");
  });
});

/* ───────────────────────── ② INDEX.md:落盘、系统维护 ───────────────────────── */

describe("INDEX.md(落盘索引)", () => {
  test("写方法成功后重建;description 来自 frontmatter,退化首行;条目带作用域前缀", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "user/memory/a.md", file_text: "---\ndescription: 钩子甲\n---\n\n正文" });
    await call(h, { command: "create", path: "user/memory/b.md", file_text: "首行是钩子乙\n第二行" });
    const index = await dir.read("user/memory/INDEX.md");
    expect(index).toContain("- user/memory/a.md — 钩子甲");
    expect(index).toContain("- user/memory/b.md — 首行是钩子乙");
    await call(h, { command: "delete", path: "user/memory/a.md" });
    expect(await dir.read("user/memory/INDEX.md")).not.toContain("a.md");
  });

  test("索引一层一份:写 project 层不动 user 层那份", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "user/memory/u.md", file_text: "---\ndescription: 用户级\n---\n" });
    await call(h, { command: "create", path: "project/memory/p.md", file_text: "---\ndescription: 项目级\n---\n" });
    expect(await dir.read("user/memory/INDEX.md")).toBe("- user/memory/u.md — 用户级");
    expect(await dir.read("project/memory/INDEX.md")).toBe("- project/memory/p.md — 项目级");
  });

  test("索引不索引自己;直接改 INDEX.md 被拒(系统维护)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "user/memory/a.md", file_text: "x" });
    expect(await dir.read("user/memory/INDEX.md")).not.toContain("INDEX.md");
    const denied = await call(h, { command: "create", path: "user/memory/INDEX.md", file_text: "伪造索引" });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("system-maintained");
  });
});

/* ───────────────────────── ③ 组装 ───────────────────────── */

describe("组装(defaultComposeMemory / renderMemorySystem)", () => {
  test("resident:全文进段,超预算截断留标记", async () => {
    const dir = new InMemoryDir();
    await dir.write("user/agent.md", "x".repeat(3000));
    const block = await defaultComposeMemory(agentMemory, dir);
    expect(block).toContain("## agent (user/agent.md)");
    expect(block).toContain("…[truncated]");
    expect(block.length).toBeLessThan(2400);
  });

  test("indexed:读落盘 INDEX.md;没有则现场扫描(人手预置目录的口径)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "user/memory/a.md", file_text: "---\ndescription: 钩子\n---\n\n这段机密正文绝不该出现" });
    const block = await defaultComposeMemory(notesMemory, dir);
    expect(block).toContain("## memory (user/memory/ — index");
    expect(block).toContain("- user/memory/a.md — 钩子");
    expect(block).not.toContain("机密正文"); // 只有索引,正文按需
    // 人手预置(没有 INDEX.md)也能出索引
    const bare = new InMemoryDir();
    await bare.write("user/memory/manual.md", "手放的首行");
    expect(await defaultComposeMemory(notesMemory, bare)).toContain("- user/memory/manual.md — 手放的首行");
  });

  test("注入表:user.md 恰好两段(user、project),索引恰好三段且顺序 user → project → session", async () => {
    const h = createAgentMemories(new InMemoryDir());
    await memoryCreate(h, "user/user.md", "用户级的我");
    await memoryCreate(h, "project/user.md", "项目级的我");
    await memoryCreate(h, "user/memory/a.md", "---\ndescription: 甲\n---\n");
    await memoryCreate(h, "project/memory/b.md", "---\ndescription: 乙\n---\n");
    await memoryCreate(h, "session/memory/c.md", "---\ndescription: 丙\n---\n");
    const sys = await renderMemorySystem(h);

    expect(sys.match(/^## user \(/gm)).toHaveLength(2);
    expect(sys).toContain("## user (user/user.md)");
    expect(sys).toContain("## user (project/user.md)");
    // 都渲染、不去重、各带路径标题:三段索引,顺序恒定
    expect([...sys.matchAll(/^## memory \((user|project|session)\//gm)].map((m) => m[1])).toEqual(["user", "project", "session"]);
    // 分区内先常驻后索引
    expect(sys.indexOf("## user (user/user.md)")).toBeLessThan(sys.indexOf("## memory ("));
    // 使用规则里每个分区把自己各层的路径都摆出来(模型据此选层)
    expect(sys).toContain("- agent (user/agent.md, project/agent.md):");
    expect(sys).toContain("- memory (user/memory/, project/memory/, session/memory/):");
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
        if (p === "user/agent.md") throw new Error("盘坏了");
        return p === "user/user.md" ? "用户偏好中文" : null;
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

  test("空记忆也出使用规则(模型要知道可以写,以及怎么选层)", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const block = await renderMemorySystem(h);
    expect(block).toContain("# Memory");
    expect(block).toContain("session/memory/");
    expect(block).toContain("The first path segment picks who will see an entry");
  });
});

/* ───────────────────────── ④ 路径 jail 与写入闸 ───────────────────────── */

describe("路径 jail", () => {
  test("剥 /memories 前缀(兼容训练行为)", () => {
    expect(normalizeMemoryPath("/memories/user/agent.md")).toBe("user/agent.md");
    expect(normalizeMemoryPath("/memories")).toBe("");
  });

  test("越狱全拒:.. / 相对逃逸 / 反斜杠 / 点开头(内部状态)", () => {
    expect(() => normalizeMemoryPath("../etc/passwd")).toThrow();
    expect(() => normalizeMemoryPath("user/memory/../../x")).toThrow();
    expect(() => normalizeMemoryPath("a\\b")).toThrow();
    expect(() => normalizeMemoryPath("session/.dream/state.json")).toThrow();
    expect(() => normalizeMemoryPath("user/memory/.hidden.md")).toThrow();
  });
});

describe("写入闸(checkWrite 经方法生效)", () => {
  test("resident 超预算拒,拒因带整理指引", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "user/user.md", file_text: "x".repeat(2000) });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exceed its budget");
    expect(r.content).toContain("str_replace");
  });

  test("indexed 单文件超限拒", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "user/memory/big.md", file_text: "x".repeat(5000) });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("File too large");
  });

  test("分区外路径拒,并告知可用分区(带每一层的路径)", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "elsewhere.md", file_text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not inside any memory region");
    expect(r.content).toContain("agent (user/agent.md, project/agent.md)");
  });

  test("选层判红:session 层没有 agent.md / user.md 这两个分区", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    for (const path of ["/memories/session/agent.md", "/memories/session/user.md"]) {
      const r = await call(h, { command: "create", path, file_text: "x" });
      expect(r.isError).toBe(true);
      expect(r.content).toContain("not inside any memory region");
    }
    expect(await dir.read("session/agent.md")).toBeNull();
    // 同一分区在有它的那两层照常写
    expect((await call(h, { command: "create", path: "/memories/project/agent.md", file_text: "x" })).isError).toBe(false);
  });
});

/* ───────────────────────── ⑤ 六动词(薄壳调方法) ───────────────────────── */

describe("memory 工具六动词", () => {
  test("create → view(带行号)→ str_replace(唯一命中)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    expect((await call(h, { command: "create", path: "user/agent.md", file_text: "第一行\n第二行" })).isError).toBe(false);
    const viewed = await call(h, { command: "view", path: "user/agent.md" });
    expect(viewed.content).toBe("1\t第一行\n2\t第二行");
    const replaced = await call(h, { command: "str_replace", path: "user/agent.md", old_str: "第二行", new_str: "改过的" });
    expect(replaced.isError).toBe(false);
    expect(await dir.read("user/agent.md")).toBe("第一行\n改过的");
  });

  test("三层各落各的目录(选层走路径前缀,工具不加参数)", async () => {
    const user = new InMemoryDir();
    const project = new InMemoryDir();
    const session = new InMemoryDir();
    const h = createAgentMemories(memoryScopeDir({ user, project, session }));
    await call(h, { command: "create", path: "user/agent.md", file_text: "用户级" });
    await call(h, { command: "create", path: "project/agent.md", file_text: "项目级" });
    await call(h, { command: "create", path: "session/memory/x.md", file_text: "会话级" });
    expect(await user.read("agent.md")).toBe("用户级");
    expect(await project.read("agent.md")).toBe("项目级");
    expect(await session.read("memory/x.md")).toBe("会话级");
    // 各写各的:没有串层
    expect(await user.read("memory/x.md")).toBeNull();
    expect(await session.read("agent.md")).toBeNull();
  });

  test("两段 session:session 层互不可见、索引各改各的;user 层是同一份", async () => {
    const user = new InMemoryDir();
    const project = new InMemoryDir();
    const s1 = new InMemoryDir();
    const s2 = new InMemoryDir();
    const h1 = createAgentMemories(memoryScopeDir({ user, project, session: s1 }));
    const h2 = createAgentMemories(memoryScopeDir({ user, project, session: s2 }));
    await Promise.all([
      memoryCreate(h1, "session/memory/a.md", "---\ndescription: 甲\n---\n"),
      memoryCreate(h2, "session/memory/b.md", "---\ndescription: 乙\n---\n"),
    ]);
    expect(await s1.read("memory/INDEX.md")).toBe("- session/memory/a.md — 甲");
    expect(await s2.read("memory/INDEX.md")).toBe("- session/memory/b.md — 乙");
    // user 层共享:一边写,另一边立刻读得到
    await memoryCreate(h1, "user/agent.md", "共用的事实");
    expect((await memoryView(h2, "user/agent.md")).content).toContain("共用的事实");
  });

  test("上层复写的正确姿势:自己的工具调我们的方法(计数、索引照常)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir, { dream: { minWritesSinceLast: 1, minFiles: 1 } });
    // 模拟上层自定义 remember 工具:内部就是调 h.create
    const remember = async (note: string) => memoryCreate(h, `session/memory/note.md`, note);
    expect((await remember("用户偏好 tab")).isError).toBe(false);
    expect(await dir.read("session/memory/INDEX.md")).toContain("note.md"); // 索引重建没断
    expect(await shouldDream(h)).toBe(true); // 计数没断
  });

  test("str_replace:零命中与多义都拒", async () => {
    const h = createAgentMemories(new InMemoryDir());
    await call(h, { command: "create", path: "user/agent.md", file_text: "aa aa" });
    expect((await call(h, { command: "str_replace", path: "user/agent.md", old_str: "没有", new_str: "x" })).content).toContain("old_str not found");
    expect((await call(h, { command: "str_replace", path: "user/agent.md", old_str: "aa", new_str: "x" })).content).toContain("must be unique");
  });

  test("insert 行号语义与越界", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "user/agent.md", file_text: "a\nb" });
    await call(h, { command: "insert", path: "user/agent.md", insert_line: 1, insert_text: "中间" });
    expect(await dir.read("user/agent.md")).toBe("a\n中间\nb");
    expect((await call(h, { command: "insert", path: "user/agent.md", insert_line: 99, insert_text: "x" })).isError).toBe(true);
  });

  test("delete 与 rename;rename 不许跨分区(换预算域不许静默发生),也不许跨层(换的是谁看得见)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "user/memory/a.md", file_text: "内容" });
    const cross = await call(h, { command: "rename", path: "user/memory/a.md", new_path: "user/agent.md" });
    expect(cross.isError).toBe(true);
    expect(cross.content).toContain("within one region");
    const crossScope = await call(h, { command: "rename", path: "user/memory/a.md", new_path: "session/memory/a.md" });
    expect(crossScope.isError).toBe(true);
    expect(crossScope.content).toContain("within one scope");
    expect((await call(h, { command: "rename", path: "user/memory/a.md", new_path: "user/memory/b.md" })).isError).toBe(false);
    expect(await dir.read("user/memory/a.md")).toBeNull();
    expect(await dir.read("user/memory/b.md")).toBe("内容");
    expect(await dir.read("user/memory/INDEX.md")).toContain("b.md"); // 改名后索引跟上
    expect((await call(h, { command: "delete", path: "user/memory/b.md" })).isError).toBe(false);
    expect((await call(h, { command: "delete", path: "user/memory/b.md" })).isError).toBe(true); // 已不存在
  });

  test("view 根:每个分区每一层一行;内部状态(.dream)不可见", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir);
    await call(h, { command: "create", path: "user/memory/a.md", file_text: "x" });
    await dir.write("session/.dream/state.json", "{}");
    const r = await call(h, { command: "view", path: "" });
    expect(r.content).toContain("user/memory/a.md");
    expect(r.content).toContain("project/agent.md (empty)");
    expect(r.content).not.toContain(".dream");
    // 看一层目录同样不该露出内部状态
    expect((await call(h, { command: "view", path: "session/" })).content).not.toContain(".dream");
  });

  test("细粒度复写:handlers 只换一个动词,其余走缺省", async () => {
    const h = createAgentMemories(new InMemoryDir());
    const tool = createMemoryTool(h, { handlers: { view: async () => ({ content: "自定义视图", isError: false, metadata: null }) } });
    const viewed = await tool.execute(tool.prepareArguments!({ command: "view", path: "" }), ctx());
    expect(viewed.content).toBe("自定义视图");
    const created = await tool.execute(tool.prepareArguments!({ command: "create", path: "user/agent.md", file_text: "x" }), ctx());
    expect(created.isError).toBe(false);
  });
});

/* ───────────────────────── ⑥ Dream ───────────────────────── */

describe("Dream 门控", () => {
  test("写入门与文件数门;INDEX.md 不算一条记忆", async () => {
    const h = createAgentMemories(new InMemoryDir(), { dream: { minWritesSinceLast: 2, minFiles: 2 } });
    expect(await shouldDream(h)).toBe(false);
    await call(h, { command: "create", path: "session/memory/a.md", file_text: "a" });
    expect(await shouldDream(h)).toBe(false); // 写 1 文件 1
    await call(h, { command: "create", path: "session/memory/b.md", file_text: "b" });
    expect(await shouldDream(h)).toBe(true); // 写 2 文件 2

    // 文件数把 INDEX.md 也算进去的话,minFiles: 3 此刻就会满足——必须不满足
    const h3 = createAgentMemories(new InMemoryDir(), { dream: { minFiles: 3 } });
    await call(h3, { command: "create", path: "session/memory/a.md", file_text: "a" });
    await call(h3, { command: "create", path: "session/memory/b.md", file_text: "b" });
    expect(await shouldDream(h3)).toBe(false);
  });

  test("文件数门只数 session 层:上两层攒再多也不该把整理催起来", async () => {
    const h = createAgentMemories(new InMemoryDir(), { dream: { minFiles: 2 } });
    await call(h, { command: "create", path: "user/memory/a.md", file_text: "a" });
    await call(h, { command: "create", path: "project/memory/b.md", file_text: "b" });
    expect(await shouldDream(h)).toBe(false); // session 层还是 0 个
    await call(h, { command: "create", path: "session/memory/c.md", file_text: "c" });
    await call(h, { command: "create", path: "session/memory/d.md", file_text: "d" });
    expect(await shouldDream(h)).toBe(true);
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

  test("dreamTask 上锁:进行中不重复触发;备料只含 memory 工具,prompt 只讲 session 层", async () => {
    const h = createAgentMemories(new InMemoryDir(), { dream: {} }); // 无门 = 恒可触发
    expect(await shouldDream(h)).toBe(true);
    const task = await dreamTask(h);
    expect(task.tools.map((t) => t.name)).toEqual([MEMORY_TOOL_NAME]);
    expect(task.prompt).toContain("Consolidate the session/ layer");
    expect(task.prompt).toContain("- memory (session/memory/");
    expect(task.prompt).not.toContain("user/memory/"); // 上两层不进整理的视野
    expect(await shouldDream(h)).toBe(false); // 锁住了
  });

  test("dream 那把工具够不到上两层(不是靠 prompt 里说一句,是门)", async () => {
    const dir = new InMemoryDir();
    const h = createAgentMemories(dir, { dream: {} });
    await memoryCreate(h, "user/agent.md", "上层的东西");
    const tool = (await dreamTask(h)).tools[0]!;
    const denied = await tool.execute(tool.prepareArguments!({ command: "str_replace", path: "user/agent.md", old_str: "上层的东西", new_str: "被改了" }), ctx());
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("only reaches the 'session/' layer");
    expect(await dir.read("user/agent.md")).toBe("上层的东西");
    // 自己那一层照常
    expect((await tool.execute(tool.prepareArguments!({ command: "create", path: "session/memory/x.md", file_text: "自己的" }), ctx())).isError).toBe(false);
    // 「看全部」对这把工具就是「看这一层」
    const viewed = await tool.execute(tool.prepareArguments!({ command: "view", path: "" }), ctx());
    expect(viewed.isError).toBe(false);
    expect(viewed.content).toContain("session/memory/x.md");
    expect(viewed.content).not.toContain("user/agent.md");
  });

  test("内部状态与索引重建不计入写入计数", async () => {
    const h = createAgentMemories(new InMemoryDir(), { dream: { minWritesSinceLast: 2 } });
    await markDreamed(h); // 写 .dream/state.json——不计数
    await call(h, { command: "create", path: "session/memory/a.md", file_text: "a" }); // 一次写(顺带重建 INDEX,不另计)
    expect(await shouldDream(h)).toBe(false); // 计数是 1 不是 2/3
  });

  test("dream 状态住在 session 层:两段 session 各算各的计数与锁", async () => {
    const shared = new InMemoryDir();
    const s1 = new InMemoryDir();
    const s2 = new InMemoryDir();
    const gates = { minWritesSinceLast: 1, minFiles: 1 };
    const h1 = createAgentMemories(memoryScopeDir({ user: shared, project: shared, session: s1 }), { dream: gates });
    const h2 = createAgentMemories(memoryScopeDir({ user: shared, project: shared, session: s2 }), { dream: gates });
    await memoryCreate(h1, "session/memory/a.md", "a");
    expect(await shouldDream(h1)).toBe(true);
    expect(await shouldDream(h2)).toBe(false); // 计数不共用
    await dreamTask(h1); // h1 上锁
    expect(await s1.read(".dream/state.json")).not.toBeNull();
    expect(await s2.read(".dream/state.json")).toBeNull(); // 锁也不共用
  });

  test("缺省门就是 CC 量级(防手滑改缺省)", () => {
    expect(DEFAULT_DREAM_GATES).toEqual({ minWritesSinceLast: 5, minFiles: 10, minIntervalMs: 24 * 3600_000 });
  });
});

/* ───────────────────────── ⑦ project 层的目录名 ───────────────────────── */

describe("project 层目录", () => {
  test("目录名 = workspace 的 fnv1a64 前 12 位;不同 workspace 必然是两个目录", () => {
    expect(fnv1a64hex("")).toBe("cbf29ce484222325"); // FNV-1a 64 的空串偏移量,防实现漂
    expect(projectPrefix("/repo/a")).toMatch(/^projects\/[0-9a-f]{12}\/$/);
    expect(projectPrefix("/repo/a")).toBe(projectPrefix("/repo/a")); // 稳定
    expect(projectPrefix("/repo/a")).not.toBe(projectPrefix("/repo/b"));
  });
});

/* ───────────────────────── ⑧ Agent 接线 ───────────────────────── */

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
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    await agent.prompt("hi");
    expect(seen[0]?.systemPrompt).toContain("# Environment"); // echo:agent 的段在，说明 system 装配跑过
    expect(seen[0]?.systemPrompt).not.toContain("# Memory");
    expect(agent.state.tools.map((t) => t.name)).not.toContain(MEMORY_TOOL_NAME);
  });

  test("冻结快照:模型 run 内写记忆,本 run system 不变、下个 run 可见", async () => {
    const dir = new InMemoryDir();
    await dir.write("user/user.md", "旧偏好");
    const seen: Context[] = [];
    const inner = scriptedStreamFn([
      toolTurn("t1", MEMORY_TOOL_NAME, { command: "str_replace", path: "user/user.md", old_str: "旧偏好", new_str: "新偏好" }),
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
      memory: createAgentMemories(dir),
    });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册

    const first = await agent.prompt("记住:新偏好");
    expect(first.outcome.kind).toBe("completed");
    expect(await dir.read("user/user.md")).toBe("新偏好"); // 盘上立即生效
    // 本 run 两轮看到同一份快照(旧内容)——冻结,不破 prompt cache
    expect(seen[0]?.systemPrompt).toContain("旧偏好");
    expect(seen[1]?.systemPrompt).toContain("旧偏好");

    await agent.prompt("下一个任务");
    expect(seen[2]?.systemPrompt).toContain("新偏好"); // 任务边界刷新
    // 环境段（order 300）在前，记忆段（order 900）沉底
    const sys = seen[2]?.systemPrompt ?? "";
    expect(sys.indexOf("# Environment")).toBeGreaterThanOrEqual(0);
    expect(sys.indexOf("# Environment")).toBeLessThan(sys.indexOf("新偏好"));
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
