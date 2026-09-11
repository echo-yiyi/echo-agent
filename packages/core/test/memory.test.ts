// 记忆模块的契约门。
//
// 锁的不变量:
//   ① 三个模块(agent/user resident + memory indexed)× 三层作用域(user/project/session),
//      模块注册开、路径重叠 fail-loud;哪层有哪个模块按「切法」的落盘表
//   ② 方法是唯一写路径,工具是薄壳;INDEX.md 落盘、由写方法重建、不许直接改、不索引自己
//   ③ 组装:resident 全文、indexed 只有索引;一个模块每层各一段、各带自己的路径;索引行单行化;
//      renderMemorySystem 绝不 throw
//   ④ 写入:统一过 checkWrite(预算拒绝带整理指引);路径 jail(../绝对/点开头全拒);
//      选层走路径前缀——那一层没有这个模块就判红
//   ⑤ 工具六动词行为(str_replace 唯一命中、rename 不许跨模块、也不许跨层)
//   ⑥ Dream 门控(写入/轮次/文件数/间隔/锁)与 markDreamed 清计数;INDEX 与内部状态不计数;
//      **只整理 session 层**——工具够不到上两层
//   ⑦ Agent 接线:工具普通注册、system 冻结快照、run 内写下个 run 可见、dispose 链

import { describe, expect, test } from "bun:test";
// 覆写前核对读到的版本、整理独占（2026-09-11）要的几件（别名避免与本文件已有的导入撞名）
import {
  claimDreamPass as claimCas,
  memoryCreate as createCas,
  memoryDelete as deleteCas,
  memoryInsert as insertCas,
  memoryStrReplace as replaceCas,
  memoryView as viewCas,
  type MemoryReads,
} from "../src/memory/harness.ts";
import { createMemoryTool as toolCas } from "../src/memory/tool.ts";
import { readDreamState as dreamStateCas } from "../src/memory/dream.ts";
// 原子提交判据要的几件（别名避免与本文件已有的导入撞名）
import { mkdirSync as mkdirLock, mkdtempSync as mkdtempLock, readFileSync as readLock, rmSync as rmLock, writeFileSync as writeLock } from "node:fs";
import { hostname as hostLock, tmpdir as tmpLock } from "node:os";
import { inspectStateLock as inspectLock } from "../src/storage/file-lock.ts";
import { join as joinLock } from "node:path";
import { FileDir as FileDirLock } from "../src/storage/file-dir.ts";
import { defaultExtractPrompt as extractPromptText } from "../src/memory/extract.ts";
import { defaultDreamPrompt as dreamPromptText } from "../src/memory/dream.ts";
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
  memoryPromptSections, composeMemoryRegion, memoryTool, memoryObserver, bindMemoryScopes, memoryScopeTableOf, dreamScopes,
  shouldDream, dreamTask, markDreamed, disposeMemory, MEMORY_KIND, type AgentMemories, type MemoryHarnessOptions,
} from "../src/memory/harness.ts";

import { InMemoryDir } from "../src/memory/in-memory-dir.ts";
import { createMemoryTool, normalizeMemoryPath, MEMORY_TOOL_NAME } from "../src/memory/tool.ts";
import {
  assertProjectWorkspace, expandMemoryPrefix, fnv1a64hex, memoryScopeTable, projectDirName, withWorkspaceStamp, WORKSPACE_STAMP_FILE,
  type MemoryScopeDef, type MemoryScopeEntry, type MemoryScopeTable,
} from "../src/memory/scope.ts";
import { agentMemory, notesMemory, userMemory, indexedMemory, memoryOwns, memoryPaths, residentMemory } from "../src/memory/types.ts";
import type { MemoryDir } from "../src/memory/types.ts";
import type { ToolExecutionContext } from "../src/tools/types.ts";


/* ── 测试脚手架:作用域现在由产品声明、session 加载完才绑定,所以每个 harness 都要先 bind ── */

/** 三层的声明。名字与顺序沿用从前那套(user → project → session),便于逐条对照旧断言。 */
const TEST_SCOPE_DEFS: readonly MemoryScopeDef[] = [
  { name: "user", order: 1, describe: "every session of this user", anchor: { kind: "home" }, prefix: "" },
  { name: "project", order: 2, describe: "every session in this workspace", anchor: { kind: "home" }, prefix: "" },
  { name: "session", order: 3, describe: "only this session", anchor: { kind: "home" }, prefix: "" },
];

function sub(base: MemoryDir, prefix: string): MemoryDir {
  return {
    read: (path) => base.read(prefix + path),
    write: (path, content) => base.write(prefix + path, content),
    remove: (path) => base.remove(prefix + path),
    list: async (p) => (await base.list(prefix + p)).map((k) => k.slice(prefix.length)),
    close: async () => {
      await base.close?.();
    },
  };
}

function tableOf(dirs: { user: MemoryDir; project: MemoryDir; session: MemoryDir }): MemoryScopeTable {
  const entries: MemoryScopeEntry[] = TEST_SCOPE_DEFS.map((def) => ({ def, dir: dirs[def.name as keyof typeof dirs] }));
  return memoryScopeTable(entries);
}

/** 三层都落在同一个平的 dir 上(`user/…`、`project/…`、`session/…`)——与从前的路径完全一致。 */
function memories(dir: MemoryDir, opts?: MemoryHarnessOptions): AgentMemories {
  // 内建三个现在由 `echo:memory` 经 registry 注册；不经 mount 的纯 harness 测试要显式带上
  const h = createAgentMemories({ memories: [agentMemory, userMemory, notesMemory], ...opts });
  bindMemoryScopes(h, tableOf({ user: sub(dir, "user/"), project: sub(dir, "project/"), session: sub(dir, "session/") }));
  return h;
}

/** 三层各自一个真 dir(测层与层之间互不可见时用)。 */
function layered(dirs: { user: MemoryDir; project: MemoryDir; session: MemoryDir }, opts?: MemoryHarnessOptions): AgentMemories {
  // 内建三个现在由 `echo:memory` 经 registry 注册；不经 mount 的纯 harness 测试要显式带上
  const h = createAgentMemories({ memories: [agentMemory, userMemory, notesMemory], ...opts });
  bindMemoryScopes(h, tableOf(dirs));
  return h;
}

/** 只用来算路径 / 判归属的表（纯函数不碰 dir）。 */
const T: MemoryScopeTable = tableOf({ user: new InMemoryDir(), project: new InMemoryDir(), session: new InMemoryDir() });

function ctx(): ToolExecutionContext {
  return { toolCallId: "t", workspace: "/", sessionId: null, iteration: 0 };
}

/**
 * 一个 harness 一把工具：同一条测试里接连的调用就是同一个模型在操作——它读过、写过的版本要连着记
 * （每把工具一本「读到过的版本」账，2026-09-11）。每次新建一把，等于每一步都换了个没看过文件的模型。
 */
const toolOf = new WeakMap<AgentMemories, ReturnType<typeof memoryTool>>();
async function call(h: AgentMemories, params: Record<string, unknown>) {
  let tool = toolOf.get(h);
  if (tool === undefined) {
    tool = memoryTool(h);
    toolOf.set(h, tool);
  }
  return tool.execute(tool.prepareArguments!(params), ctx());
}

/* ───────────────────────── ① 数据、模块与作用域 ───────────────────────── */

describe("Memory 判别联合与模块", () => {
  test("内建三个模块:agent/user resident,memory indexed", () => {
    const h = memories(new InMemoryDir());
    expect(listMemories(h).map((m) => `${m.name}:${m.mode}`)).toEqual(["agent:resident", "user:resident", "memory:indexed"]);
  });

  test("不点名 scopes 的模块在每一层都有(内建三个都不点名,core 里因此没有层名字面量)", () => {
    const h = memories(new InMemoryDir());
    expect(memoryPaths(T, getMemory(h, "agent")!).map((p) => p.path)).toEqual(["user/agent.md", "project/agent.md", "session/agent.md"]);
    expect(memoryPaths(T, getMemory(h, "user")!).map((p) => p.path)).toEqual(["user/user.md", "project/user.md", "session/user.md"]);
    expect(memoryPaths(T, getMemory(h, "memory")!).map((p) => p.path)).toEqual(["user/memory/", "project/memory/", "session/memory/"]);
  });

  test("memoryOwns:收全路径,resident 精确匹配、indexed 前缀匹配;模块点名之外的层不归它", () => {
    expect(memoryOwns(T, agentMemory, "user/agent.md")).toBe(true);
    expect(memoryOwns(T, agentMemory, "project/agent.md")).toBe(true);
    // 点名了层的模块:没点到的那层不归它（不点名 = 每层都有,所以这条要用一个点名的模块来测）
    const onlyUser = residentMemory("scoped", { scopes: ["user"] });
    expect(memoryOwns(T, onlyUser, "user/scoped.md")).toBe(true);
    expect(memoryOwns(T, onlyUser, "session/scoped.md")).toBe(false);
    expect(memoryOwns(T, agentMemory, "agent.md")).toBe(false); // 缺作用域前缀
    expect(memoryOwns(T, agentMemory, "user/agent.md.bak")).toBe(false);
    expect(memoryOwns(T, notesMemory, "session/memory/a.md")).toBe(true);
    expect(memoryOwns(T, notesMemory, "user/memory/")).toBe(false); // 目录本身不是文件
  });

  test("撞名与路径重叠都 fail-loud", () => {
    const h = memories(new InMemoryDir());
    expect(() => addMemory(h, residentMemory("agent"))).toThrow("已存在");
    expect(() => addMemory(h, indexedMemory("nested", { path: "memory/nested/" }))).toThrow("重叠");
    addMemory(h, indexedMemory("scratch")); // 不重叠的可以加
    expect(getMemory(h, "scratch")?.mode).toBe("indexed");
  });

  test("同一模块内路径落在不同层不算重叠(比的是带作用域的全路径)", () => {
    const h = memories(new InMemoryDir(), { memories: [indexedMemory("a", { scopes: ["user"] })] });
    addMemory(h, indexedMemory("b", { path: "a/", scopes: ["project"] })); // 同一个模块内路径,另一层
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
    const h = memories(dir);
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
    const h = memories(dir);
    await call(h, { command: "create", path: "user/memory/u.md", file_text: "---\ndescription: 用户级\n---\n" });
    await call(h, { command: "create", path: "project/memory/p.md", file_text: "---\ndescription: 项目级\n---\n" });
    expect(await dir.read("user/memory/INDEX.md")).toBe("- user/memory/u.md — 用户级");
    expect(await dir.read("project/memory/INDEX.md")).toBe("- project/memory/p.md — 项目级");
  });

  test("索引不索引自己;直接改 INDEX.md 被拒(系统维护)", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir);
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
    const block = await defaultComposeMemory(agentMemory, dir, T);
    expect(block).toContain("## agent (user/agent.md)");
    expect(block).toContain("…[truncated]");
    expect(block.length).toBeLessThan(2400);
  });

  test("indexed:读落盘 INDEX.md;没有则现场扫描(人手预置目录的口径)", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir);
    await call(h, { command: "create", path: "user/memory/a.md", file_text: "---\ndescription: 钩子\n---\n\n这段机密正文绝不该出现" });
    const block = await defaultComposeMemory(notesMemory, dir, T);
    expect(block).toContain("## memory (user/memory/ — index");
    expect(block).toContain("- user/memory/a.md — 钩子");
    expect(block).not.toContain("机密正文"); // 只有索引,正文按需
    // 人手预置(没有 INDEX.md)也能出索引
    const bare = new InMemoryDir();
    await bare.write("user/memory/manual.md", "手放的首行");
    expect(await defaultComposeMemory(notesMemory, bare, T)).toContain("- user/memory/manual.md — 手放的首行");
  });

  test("注入表:user.md 恰好两段(user、project),索引恰好三段且顺序 user → project → session", async () => {
    const h = memories(new InMemoryDir());
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
    // 模块内先常驻后索引
    expect(sys.indexOf("## user (user/user.md)")).toBeLessThan(sys.indexOf("## memory ("));
    // 使用规则里每个模块把自己各层的路径都摆出来(模型据此选层)
    expect(sys).toContain("- agent (user/agent.md, project/agent.md, session/agent.md):");
    expect(sys).toContain("- memory (user/memory/, project/memory/, session/memory/):");
  });

  test("索引行单行化:换行伪装多行 system 被折叠", () => {
    expect(singleLine("a\nb\r\nc d")).toBe("a b c d");
  });

  test("frontmatter:标准解析 + 无 frontmatter 宽容退化", () => {
    expect(parseFrontmatter("---\ndescription: 'x'\n---\nbody").meta["description"]).toBe("x");
    expect(parseFrontmatter("裸正文").meta).toEqual({});
  });

  test("renderMemorySystem 绝不 throw:某模块读坏 → 该模块隐形,其余照常", async () => {
    const bad: MemoryDir = {
      read: async (p) => {
        if (p === "user/agent.md") throw new Error("盘坏了");
        return p === "user/user.md" ? "用户偏好中文" : null;
      },
      write: async () => {},
      remove: async () => false,
      list: async () => [],
    };
    const h = memories(bad);
    const block = await renderMemorySystem(h);
    expect(block).toContain("用户偏好中文");
    expect(block).not.toContain("盘坏了");
  });

  test("空记忆也出使用规则(模型要知道可以写,以及怎么选层)", async () => {
    const h = memories(new InMemoryDir());
    const block = await renderMemorySystem(h);
    expect(block).toContain("# Memory");
    expect(block).toContain("session/memory/");
    // 选层说明**从作用域表生成**（core 不认识任何层名，只按 order 列出每层的 describe）
    expect(block).toContain("The first path segment of every path picks who will see an entry, widest first:");
    expect(block).toContain("- user/ — every session of this user");
    expect(block).toContain("- session/ — only this session");
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
    const h = memories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "user/user.md", file_text: "x".repeat(2000) });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exceed its budget");
    expect(r.content).toContain("str_replace");
  });

  test("indexed 单文件超限拒", async () => {
    const h = memories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "user/memory/big.md", file_text: "x".repeat(5000) });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("File too large");
  });

  test("模块外路径拒,并告知可用模块(带每一层的路径)", async () => {
    const h = memories(new InMemoryDir());
    const r = await call(h, { command: "create", path: "elsewhere.md", file_text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not inside any memory module");
    expect(r.content).toContain("agent (user/agent.md, project/agent.md, session/agent.md)");
  });

  test("选层判红:模块点名之外的层写不进去（点名的才有这条;不点名 = 每层都有）", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir, { memories: [residentMemory("scoped", { scopes: ["user", "project"] })] });
    const r = await call(h, { command: "create", path: "/memories/session/scoped.md", file_text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not inside any memory module");
    expect(await dir.read("session/scoped.md")).toBeNull();
    // 点到的那两层照常写
    expect((await call(h, { command: "create", path: "/memories/project/scoped.md", file_text: "x" })).isError).toBe(false);
  });

  test("路径没有作用域前缀：报错是英文的模型面文本（review 2026-09-07：此前中文原文直回模型）", async () => {
    const h = memories(new InMemoryDir());
    const r = await call(h, { command: "view", path: "/memories/nope/agent.md" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Memory paths must start with a scope \(/);
    expect(r.content).not.toMatch(/[一-鿿]/);
  });
});

/* ───────────────────────── ⑤ 六动词(薄壳调方法) ───────────────────────── */

describe("memory 工具六动词", () => {
  test("create → view(带行号)→ str_replace(唯一命中)", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir);
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
    const h = layered({ user, project, session });
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
    const h1 = layered({ user, project, session: s1 });
    const h2 = layered({ user, project, session: s2 });
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
    const h = memories(dir, { dream: { minWritesSinceLast: 1, minFiles: 1 } });
    // 模拟上层自定义 remember 工具:内部就是调 h.create
    const remember = async (note: string) => memoryCreate(h, `session/memory/note.md`, note);
    expect((await remember("用户偏好 tab")).isError).toBe(false);
    expect(await dir.read("session/memory/INDEX.md")).toContain("note.md"); // 索引重建没断
    expect(await shouldDream(h, "session")).toBe(true); // 计数没断
  });

  test("str_replace:零命中与多义都拒", async () => {
    const h = memories(new InMemoryDir());
    await call(h, { command: "create", path: "user/agent.md", file_text: "aa aa" });
    expect((await call(h, { command: "str_replace", path: "user/agent.md", old_str: "没有", new_str: "x" })).content).toContain("old_str not found");
    expect((await call(h, { command: "str_replace", path: "user/agent.md", old_str: "aa", new_str: "x" })).content).toContain("must be unique");
  });

  test("insert 行号语义与越界", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir);
    await call(h, { command: "create", path: "user/agent.md", file_text: "a\nb" });
    await call(h, { command: "insert", path: "user/agent.md", insert_line: 1, insert_text: "中间" });
    expect(await dir.read("user/agent.md")).toBe("a\n中间\nb");
    expect((await call(h, { command: "insert", path: "user/agent.md", insert_line: 99, insert_text: "x" })).isError).toBe(true);
  });

  test("delete 与 rename;rename 不许跨模块(换预算域不许静默发生),也不许跨层(换的是谁看得见)", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir);
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

  test("view 根:每个模块每一层一行;内部状态(.dream)不可见", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir);
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
    const h = memories(new InMemoryDir());
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
    const h = memories(new InMemoryDir(), { dream: { minWritesSinceLast: 2, minFiles: 2 } });
    expect(await shouldDream(h, "session")).toBe(false);
    await call(h, { command: "create", path: "session/memory/a.md", file_text: "a" });
    expect(await shouldDream(h, "session")).toBe(false); // 写 1 文件 1
    await call(h, { command: "create", path: "session/memory/b.md", file_text: "b" });
    expect(await shouldDream(h, "session")).toBe(true); // 写 2 文件 2

    // 文件数把 INDEX.md 也算进去的话,minFiles: 3 此刻就会满足——必须不满足
    const h3 = memories(new InMemoryDir(), { dream: { minFiles: 3 } });
    await call(h3, { command: "create", path: "session/memory/a.md", file_text: "a" });
    await call(h3, { command: "create", path: "session/memory/b.md", file_text: "b" });
    expect(await shouldDream(h3, "session")).toBe(false);
  });

  test("文件数门只数 session 层:上两层攒再多也不该把整理催起来", async () => {
    const h = memories(new InMemoryDir(), { dream: { minFiles: 2 } });
    await call(h, { command: "create", path: "user/memory/a.md", file_text: "a" });
    await call(h, { command: "create", path: "project/memory/b.md", file_text: "b" });
    expect(await shouldDream(h, "session")).toBe(false); // session 层还是 0 个
    await call(h, { command: "create", path: "session/memory/c.md", file_text: "c" });
    await call(h, { command: "create", path: "session/memory/d.md", file_text: "d" });
    expect(await shouldDream(h, "session")).toBe(true);
  });

  test("轮次门经 observer 喂;markDreamed 清计数并记时间", async () => {
    const h = memories(new InMemoryDir(), { dream: { minTurnsSinceLast: 2 } });
    expect(await shouldDream(h, "session")).toBe(false);
    const observe = memoryObserver(h);
    const fake = { seq: 0, at: 0, type: "turn_end", iteration: 0, message: {} as never, toolResults: [] } as never;
    await observe(fake, new AbortController().signal);
    await observe(fake, new AbortController().signal);
    expect(await shouldDream(h, "session")).toBe(true);
    await markDreamed(h, "session");
    expect(await shouldDream(h, "session")).toBe(false); // 计数清零
  });

  test("dreamTask 上锁:进行中不重复触发;备料只含 memory 工具,prompt 只讲 session 层", async () => {
    const h = memories(new InMemoryDir(), { dream: {} }); // 无门 = 恒可触发
    expect(await shouldDream(h, "session")).toBe(true);
    const task = await dreamTask(h, "session");
    expect(task.tools.map((t) => t.name)).toEqual([MEMORY_TOOL_NAME]);
    expect(task.prompt).toContain("Consolidate the session/ layer");
    expect(task.prompt).toContain("- memory (session/memory/");
    expect(task.prompt).not.toContain("user/memory/"); // 上两层不进整理的视野
    expect(await shouldDream(h, "session")).toBe(false); // 锁住了
  });

  test("dream 那把工具够不到上两层(不是靠 prompt 里说一句,是门)", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir, { dream: {} });
    await memoryCreate(h, "user/agent.md", "上层的东西");
    const tool = (await dreamTask(h, "session")).tools[0]!;
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
    const h = memories(new InMemoryDir(), { dream: { minWritesSinceLast: 2 } });
    await markDreamed(h, "session"); // 写 .dream/state.json——不计数
    await call(h, { command: "create", path: "session/memory/a.md", file_text: "a" }); // 一次写(顺带重建 INDEX,不另计)
    expect(await shouldDream(h, "session")).toBe(false); // 计数是 1 不是 2/3
  });

  test("dream 状态住在 session 层:两段 session 各算各的计数与锁", async () => {
    const shared = new InMemoryDir();
    const s1 = new InMemoryDir();
    const s2 = new InMemoryDir();
    const gates = { minWritesSinceLast: 1, minFiles: 1 };
    const h1 = layered({ user: shared, project: shared, session: s1 }, { dream: gates });
    const h2 = layered({ user: shared, project: shared, session: s2 }, { dream: gates });
    await memoryCreate(h1, "session/memory/a.md", "a");
    expect(await shouldDream(h1, "session")).toBe(true);
    expect(await shouldDream(h2, "session")).toBe(false); // 计数不共用
    await dreamTask(h1, "session"); // h1 上锁
    expect(await s1.read(".dream/state.json")).not.toBeNull();
    expect(await s2.read(".dream/state.json")).toBeNull(); // 锁也不共用
  });

  test("缺省门:四道节流是 CC 量级,外加一道水位(防手滑改缺省)", () => {
    expect(DEFAULT_DREAM_GATES).toEqual({ minWritesSinceLast: 5, minFiles: 10, minIntervalMs: 24 * 3600_000, budgetRatio: 0.8 });
  });
});

/* ───────────────────────── ⑦ 作用域:声明、变量、延迟绑定、留痕 ───────────────────────── */

describe("作用域声明与延迟绑定", () => {
  test("哈希目录名 = workspace 的 fnv1a64 前 12 位;不同 workspace 必然是两个目录", () => {
    expect(fnv1a64hex("")).toBe("cbf29ce484222325"); // FNV-1a 64 的空串偏移量,防实现漂
    expect(projectDirName("/repo/a")).toMatch(/^[0-9a-f]{12}$/);
    expect(projectDirName("/repo/a")).toBe(projectDirName("/repo/a")); // 稳定
    expect(projectDirName("/repo/a")).not.toBe(projectDirName("/repo/b"));
  });

  test("前缀变量:闭合集合展开,认不出的变量 fail-loud(静默留 {{typo}} = 所有 session 共用一个目录)", () => {
    const facts = { workspace: "/repo/a", role: "reviewer", product: "echo-coding", sessionId: "s-1" };
    expect(expandMemoryPrefix("projects/{{workspaceHash}}/memory/", facts)).toBe(`projects/${projectDirName("/repo/a")}/memory/`);
    expect(expandMemoryPrefix("products/{{product}}/memory/", facts)).toBe("products/echo-coding/memory/");
    expect(() => expandMemoryPrefix("x/{{nope}}/", facts)).toThrow(/认不出的变量/);
  });

  test("变量值消毒:含 / 与 .. 的取值不能穿出它那一段", () => {
    const facts = { workspace: "../../etc", role: "r", product: "p", sessionId: "s" };
    const out = expandMemoryPrefix("x/{{workspace}}/", facts);
    const segment = out.slice(2, -1);
    expect(out.startsWith("x/") && out.endsWith("/")).toBe(true);
    expect(segment).not.toContain("/"); // 值里的 / 被消掉:穿不出这一段
    expect(segment).not.toBe(".."); // 也不会整段变成上跳
    expect(segment.startsWith(".")).toBe(false);
  });

  test("绑定前任何读写都抛;只绑一次,重复 bind 是空操作", async () => {
    const h = createAgentMemories({ memories: [agentMemory] });
    expect(h.binding.bound()).toBe(false);
    await expect(h.dir.read("user/agent.md")).rejects.toThrow(/还没绑定/);
    expect(() => memoryScopeTableOf(h)).toThrow(/还没绑定/);

    const first = new InMemoryDir();
    const second = new InMemoryDir();
    bindMemoryScopes(h, tableOf({ user: first, project: first, session: first }));
    bindMemoryScopes(h, tableOf({ user: second, project: second, session: second })); // 空操作
    await memoryCreate(h, "user/agent.md", "x");
    expect(await first.read("agent.md")).toBe("x");
    expect(await second.read("agent.md")).toBeNull();
  });

  test("模块点了本次装配里没有的层 → 绑定时 fail-loud,并列出可用的层", () => {
    const h = createAgentMemories({ memories: [indexedMemory("a", { scopes: ["nope"] })] });
    expect(() => bindMemoryScopes(h, tableOf({ user: new InMemoryDir(), project: new InMemoryDir(), session: new InMemoryDir() }))).toThrow(/nope/);
  });

  test("不点名 scopes = 每一层都有(内建三个模块靠它,core 里因此没有层名字面量)", () => {
    const h = memories(new InMemoryDir());
    expect(memoryPaths(memoryScopeTableOf(h), agentMemory).map((p) => p.path)).toEqual(["user/agent.md", "project/agent.md", "session/agent.md"]);
  });

  test("作用域撞名 fail-loud:一个名字只能是一层", () => {
    const d = new InMemoryDir();
    const dup: MemoryScopeEntry[] = [
      { def: { name: "user", order: 1, describe: "a", anchor: { kind: "home" }, prefix: "" }, dir: d },
      { def: { name: "user", order: 2, describe: "b", anchor: { kind: "home" }, prefix: "" }, dir: d },
    ];
    expect(() => memoryScopeTable(dup)).toThrow(/重复/);
  });

  test("留痕:第一次真写才落 workspace.json;对不上的目录判红(48 位哈希撞了)", async () => {
    const root = new InMemoryDir();
    const stamped = withWorkspaceStamp(root, "/repo/a");
    expect(await root.read(WORKSPACE_STAMP_FILE)).toBeNull(); // 只读不写 → 不留痕
    await stamped.write("agent.md", "x");
    expect(JSON.parse((await root.read(WORKSPACE_STAMP_FILE))!)).toEqual({ workspace: "/repo/a" });

    await assertProjectWorkspace(root, "", "/repo/a"); // 对得上:不抛
    await expect(assertProjectWorkspace(root, "", "/repo/b")).rejects.toThrow(/撞了/);
  });

  test("没有留痕的目录不判红(第一次在这个项目里跑)", async () => {
    await assertProjectWorkspace(new InMemoryDir(), "", "/anything");
  });
});


/* ───────────────────────── ⑧ Agent 接线 ───────────────────────── */

describe("Agent 接线", () => {
  test("memory 工具经 `echo:memory` builtin Extension 注册（无特权通道）,state.tools 可见", async () => {
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: scriptedStreamFn([]),
      memory: memories(new InMemoryDir()),
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
      memory: memories(dir),
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
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), memory: memories(dir) });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    await agent.dispose();
    expect(closed).toBe(true);
  });
});

/* ───────────────────────── ⑧ 模块声明真的生效（2026-09-10 接线） ───────────────────────── */

describe("模块声明真的生效", () => {
  test("ops 在唯一写路径上生效：声明只读的模块 create / str_replace / delete 都被拒，view 照常", async () => {
    const dir = new InMemoryDir();
    await dir.write("user/locked.md", "原文");
    const h = memories(dir, { memories: [residentMemory("locked", { ops: ["view"] })] });
    for (const r of [
      await memoryCreate(h, "user/locked.md", "改了"),
      await memoryStrReplace(h, "user/locked.md", "原文", "改了"),
      await memoryDelete(h, "user/locked.md"),
    ]) {
      expect(r.isError).toBe(true);
      expect(r.content).toContain("does not support");
    }
    expect(await dir.read("user/locked.md")).toBe("原文");
    expect((await memoryView(h, "user/locked.md")).isError).toBe(false);
  });

  test("ops 只能收紧：indexed 模块声明不含 rename 就改不了名；不声明时六个全有", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir, { memories: [indexedMemory("frozen", { ops: ["view", "create"] }), indexedMemory("open")] });
    await memoryCreate(h, "user/frozen/a.md", "---\ndescription: 甲\n---\n");
    const r = await memoryRename(h, "user/frozen/a.md", "user/frozen/b.md");
    expect(r.isError).toBe(true);
    expect(r.content).toContain("does not support 'rename'");
    await memoryCreate(h, "user/open/a.md", "---\ndescription: 乙\n---\n");
    expect((await memoryRename(h, "user/open/a.md", "user/open/b.md")).isError).toBe(false);
  });

  test("整理那把工具碰不到同层 dream:false 的模块（memory.md 第 8 节那条复现，修复后变拒绝）", async () => {
    const dir = new InMemoryDir();
    const h = memories(dir, { memories: [residentMemory("locked", { dream: false }), residentMemory("open")] });
    const task = await dreamTask(h, "session");
    const tool = task.tools[0]!;
    const denied = await tool.execute(tool.prepareArguments!({ command: "create", path: "session/locked.md", file_text: "changed" }), ctx());
    expect(denied.isError).toBe(true);
    expect(await dir.read("session/locked.md")).toBeNull();
    const ok = await tool.execute(tool.prepareArguments!({ command: "create", path: "session/open.md", file_text: "fine" }), ctx());
    expect(ok.isError).toBe(false);
    // 读不拦：整理要看全貌才判断得了归位
    expect((await tool.execute(tool.prepareArguments!({ command: "view", path: "session/" }), ctx())).isError).toBe(false);
  });

  test("工具说明不再写死具体层名（层由产品声明，模型从 system 的 Memory 段读）", () => {
    const tool = memoryTool(memories(new InMemoryDir()));
    expect(tool.description).not.toMatch(/\b(user|project|session)\//);
  });
});

/* ───────────────────────── ⑨ 共享层的原子提交（2026-09-10） ───────────────────────── */

const oneLayer = (name: string): MemoryScopeDef => ({ name, order: 1, describe: name, anchor: { kind: "home" }, prefix: "" });
const sleepLock = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("共享层的原子提交", () => {
  test("两个 harness 实例、同一个字节面对象（不带 lock 原语）：按对象互斥，两边的修改都在（find_job 并发探针同形）", async () => {
    const raw = new InMemoryDir();
    await raw.write("note.md", "A B");
    // 写得慢一点，把「两边都读到旧内容」的窗口撑开——没有锁时这里必然丢一边
    const slow: MemoryDir = {
      read: (p) => raw.read(p),
      list: (p) => raw.list(p),
      remove: (p) => raw.remove(p),
      write: async (p, c) => {
        if (p === "note.md") await sleepLock(20);
        await raw.write(p, c);
      },
    };
    const bind = () => {
      const h = createAgentMemories({ memories: [residentMemory("note")] });
      bindMemoryScopes(h, memoryScopeTable([{ def: oneLayer("project"), dir: slow }]));
      return h;
    };
    const [a, b] = await Promise.all([
      memoryStrReplace(bind(), "project/note.md", "A", "AA"),
      memoryStrReplace(bind(), "project/note.md", "B", "BB"),
    ]);
    expect([a.isError, b.isError]).toEqual([false, false]);
    expect(await raw.read("note.md")).toBe("AA BB");
  });

  test("不同的视图对象、同一个底层字节面：互斥靠视图转发下去的 lock 原语，不靠对象身份", async () => {
    const raw = new InMemoryDir();
    await raw.write("project/note.md", "A B");
    const view = (): MemoryDir => ({
      read: (p) => raw.read("project/" + p),
      list: async (p) => (await raw.list("project/" + p)).map((k) => k.slice("project/".length)),
      remove: (p) => raw.remove("project/" + p),
      write: async (p, c) => {
        if (p === "note.md") await sleepLock(20);
        await raw.write("project/" + p, c);
      },
      lock: (n, o) => raw.lock("project/" + n, o),
    });
    const bind = () => {
      const h = createAgentMemories({ memories: [residentMemory("note")] });
      bindMemoryScopes(h, memoryScopeTable([{ def: oneLayer("project"), dir: view() }]));
      return h;
    };
    const [a, b] = await Promise.all([
      memoryStrReplace(bind(), "project/note.md", "A", "AA"),
      memoryStrReplace(bind(), "project/note.md", "B", "BB"),
    ]);
    expect([a.isError, b.isError]).toEqual([false, false]);
    expect(await raw.read("project/note.md")).toBe("AA BB");
  });

  test("等不到锁 = 明确报冲突，一个字节都不写；锁一放就能写", async () => {
    const raw = new InMemoryDir();
    const h = createAgentMemories({ memories: [residentMemory("note")], lockTimeoutMs: 30 });
    bindMemoryScopes(h, memoryScopeTable([{ def: oneLayer("project"), dir: raw }]));
    const release = await raw.lock(".locks/note");
    const r = await memoryCreate(h, "project/note.md", "x");
    expect(r.isError).toBe(true);
    expect(r.content).toContain("being written by another session");
    expect(await raw.read("note.md")).toBeNull();
    await release();
    expect((await memoryCreate(h, "project/note.md", "x")).isError).toBe(false);
  });

  test("两个 FileDir 实例并发往同一个 indexed 模块写：正文一条不少、索引一条不少、锁用完即放", async () => {
    const dir = mkdtempLock(joinLock(tmpLock(), "echo-mem-lock-"));
    try {
      const bind = () => {
        const h = createAgentMemories({ memories: [indexedMemory("notes")] });
        bindMemoryScopes(h, memoryScopeTable([{ def: oneLayer("project"), dir: new FileDirLock(dir) }]));
        return h;
      };
      const a = bind();
      const b = bind();
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => memoryCreate(i % 2 === 0 ? a : b, `project/notes/n${i}.md`, `---\ndescription: 第 ${i} 条\n---\n`)),
      );
      expect(results.every((r) => r.isError !== true)).toBe(true);
      const index = readLock(joinLock(dir, "notes", "INDEX.md"), "utf8");
      for (let i = 0; i < 12; i++) expect(index).toContain(`project/notes/n${i}.md`);
      expect((await inspectLock(joinLock(dir, ".locks", "notes.lock"))).state).toBe("missing"); // 锁目录常驻（当前代不删），但已释放
    } finally {
      rmLock(dir, { recursive: true, force: true });
    }
  });

  test("写者崩在提交中途（锁没放就死了）：下一个写者自动接管，不再一直 busy", async () => {
    const dir = mkdtempLock(joinLock(tmpLock(), "echo-mem-crash-"));
    try {
      // 本机上一个已经死掉的进程留下的认领。此前（单文件锁、不接管）这一层的这个模块会一直 busy，要人手删
      mkdirLock(joinLock(dir, ".locks", "note.lock"), { recursive: true });
      writeLock(
        joinLock(dir, ".locks", "note.lock", "g1"),
        JSON.stringify({ holder: "崩掉的", pid: 2 ** 22, host: hostLock(), at: Date.now(), token: "dead" }),
      );
      const h = createAgentMemories({ memories: [residentMemory("note")], lockTimeoutMs: 2_000 });
      bindMemoryScopes(h, memoryScopeTable([{ def: oneLayer("project"), dir: new FileDirLock(dir) }]));
      expect((await memoryCreate(h, "project/note.md", "接着写")).isError).toBe(false);
      expect(readLock(joinLock(dir, "note.md"), "utf8")).toContain("接着写");
    } finally {
      rmLock(dir, { recursive: true, force: true });
    }
  });

  test("真的两个进程同时读改写同一个文件：成功的插入一条不丢，失败必须是明确返回的", async () => {
    const dir = mkdtempLock(joinLock(tmpLock(), "echo-mem-xproc-"));
    const writer = joinLock(import.meta.dir, "fixtures", "memory-writer.ts");
    try {
      writeLock(joinLock(dir, "note.md"), "base");
      const run = (tag: string) => {
        const proc = Bun.spawn(["bun", writer, dir, tag, "25"], { stdout: "pipe", stderr: "pipe" });
        return (async () => {
          const out = await new Response(proc.stdout).text();
          const err = await new Response(proc.stderr).text();
          await proc.exited;
          const last = out.trim().split("\n").at(-1) ?? "";
          try {
            return JSON.parse(last) as { tag: string; failed: number };
          } catch {
            throw new Error(`子进程没给出报告：${out}\n${err}`);
          }
        })();
      };
      const [ra, rb] = await Promise.all([run("a"), run("b")]);
      const lines = readLock(joinLock(dir, "note.md"), "utf8").split("\n");
      expect(lines.filter((l) => l.startsWith("a-")).length).toBe(25 - ra.failed);
      expect(lines.filter((l) => l.startsWith("b-")).length).toBe(25 - rb.failed);
      expect(ra.failed + rb.failed).toBe(0); // 锁等得到：十秒的窗口里不该有一次等不到
      expect(lines.at(-1)).toBe("base");
    } finally {
      rmLock(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ───────────────────────── ⑩ 判据跟着模块走（2026-09-10） ───────────────────────── */

describe("判据跟着模块走", () => {
  test("只有自定义模块时：记忆段、提取、整理的 prompt 里都没有 coding 味的判据，模块自己的说明原样在", async () => {
    const custom = createAgentMemories({
      memories: [indexedMemory("experiences", { instructions: "moments you shared with this person, including one-off ones" })],
    });
    bindMemoryScopes(custom, tableOf({ user: new InMemoryDir(), project: new InMemoryDir(), session: new InMemoryDir() }));
    const system = await renderMemorySystem(custom);
    expect(system).not.toContain("next month");
    expect(system).not.toContain("repository already states");
    expect(system).toContain("moments you shared");
    const extract = extractPromptText(listMemories(custom), memoryScopeTableOf(custom), "user: hi");
    expect(extract).not.toContain("next month");
    expect(extract).not.toContain("true only inside this conversation");
    expect(extract).toContain("moments you shared");
    const dream = dreamPromptText(listMemories(custom), memoryScopeTableOf(custom), "user");
    expect(dream).not.toContain("true only once");
  });

  test("内建模块在时，判据跟着它们出现（在模块的说明里，不在全局规则里）", async () => {
    const system = await renderMemorySystem(memories(new InMemoryDir()));
    expect(system).toContain("next month");
    expect(system).toContain("repository already states");
  });
});

/* ───────────────────────── ⑪ 覆写前核对读到的版本（2026-09-11） ───────────────────────── */

describe("覆写前核对读到的版本", () => {
  // 提交锁只罩住一次调用；模型「读完 → 思考 → 写回」横跨好几次调用，中间别人写过的那一笔要靠这里保住
  const bindCas = (dir: MemoryDir) => {
    const h = createAgentMemories({ memories: [residentMemory("note"), indexedMemory("notes")] });
    bindMemoryScopes(h, memoryScopeTable([{ def: oneLayer("project"), dir }]));
    return h;
  };
  const T = undefined as never; // 缺省动词不看工具上下文

  test("A 读完去想、B 写了一笔、A 凭旧内容整份写回：被拒，B 那一笔还在；A 重看之后再写，两边都在", async () => {
    const raw = new InMemoryDir();
    await raw.write("note.md", "A B");
    const h = bindCas(raw);
    const a: MemoryReads = new Map();
    const b: MemoryReads = new Map();
    await viewCas(h, "project/note.md", a);
    await viewCas(h, "project/note.md", b);
    expect((await replaceCas(h, "project/note.md", "B", "BB", b)).isError).toBe(false);
    const stale = await createCas(h, "project/note.md", "AA B", a);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain("changed since you viewed it");
    expect(await raw.read("note.md")).toBe("A BB");
    await viewCas(h, "project/note.md", a);
    expect((await createCas(h, "project/note.md", "AA BB", a)).isError).toBe(false);
    expect(await raw.read("note.md")).toBe("AA BB");
  });

  test("没看过的已有文件：不许整份覆写、不许按行插、不许删；新建文件不用先看", async () => {
    const raw = new InMemoryDir();
    const h = bindCas(raw);
    const r: MemoryReads = new Map();
    expect((await createCas(h, "project/notes/a.md", "---\ndescription: a\n---\n", r)).isError).toBe(false);
    await raw.write("note.md", "别人写的");
    await raw.write("notes/b.md", "---\ndescription: b\n---\n");
    for (const res of [
      await createCas(h, "project/note.md", "x", r),
      await insertCas(h, "project/note.md", 0, "x", r),
      await deleteCas(h, "project/notes/b.md", r),
    ]) {
      expect(res.isError).toBe(true);
      expect(res.content).toContain("have not viewed it");
    }
    expect(await raw.read("note.md")).toBe("别人写的");
    expect(await raw.read("notes/b.md")).not.toBeNull();
    await viewCas(h, "project/notes/b.md", r);
    expect((await deleteCas(h, "project/notes/b.md", r)).isError).toBe(false);
  });

  test("看完之后文件被别人删了：凭旧内容重建被拒（不把别人整理掉的东西复活）", async () => {
    const raw = new InMemoryDir();
    await raw.write("note.md", "旧的");
    const h = bindCas(raw);
    const r: MemoryReads = new Map();
    await viewCas(h, "project/note.md", r);
    await raw.remove("note.md");
    const res = await createCas(h, "project/note.md", "旧的", r);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("deleted by another session");
    expect(await raw.read("note.md")).toBeNull();
  });

  test("str_replace 不核对（在最新内容上找得到就是核对），但凭过期的账写成之后这一条作废：接着整份覆写得先重看", async () => {
    const raw = new InMemoryDir();
    await raw.write("note.md", "A B");
    const h = bindCas(raw);
    const r: MemoryReads = new Map();
    await viewCas(h, "project/note.md", r);
    await raw.write("note.md", "A BB"); // 别人那一笔
    expect((await replaceCas(h, "project/note.md", "A", "AA", r)).isError).toBe(false);
    expect(await raw.read("note.md")).toBe("AA BB"); // 两笔都在
    const res = await createCas(h, "project/note.md", "AA B", r); // 它以为文件是 AA B
    expect(res.isError).toBe(true);
    expect(await raw.read("note.md")).toBe("AA BB");
  });

  test("工具：各把各的账（提取看过的不替前台作保）；自己看过、自己写过，接着写不用重看；rename 账跟着文件搬", async () => {
    const raw = new InMemoryDir();
    await raw.write("note.md", "A");
    await raw.write("notes/a.md", "---\ndescription: a\n---\n");
    const h = bindCas(raw);
    const front = toolCas(h);
    const extract = toolCas(h);
    await extract.execute({ command: "view", path: "project/note.md" }, T);
    expect((await front.execute({ command: "create", path: "project/note.md", file_text: "B" }, T)).isError).toBe(true);
    await front.execute({ command: "view", path: "project/note.md" }, T);
    expect((await front.execute({ command: "create", path: "project/note.md", file_text: "B" }, T)).isError).toBe(false);
    expect((await front.execute({ command: "create", path: "project/note.md", file_text: "C" }, T)).isError).toBe(false);
    expect(await raw.read("note.md")).toBe("C");

    await front.execute({ command: "view", path: "project/notes/a.md" }, T);
    expect((await front.execute({ command: "rename", path: "project/notes/a.md", new_path: "project/notes/c.md" }, T)).isError).toBe(false);
    expect((await front.execute({ command: "create", path: "project/notes/c.md", file_text: "---\ndescription: c\n---\n" }, T)).isError).toBe(false);
  });
});

describe("整理这一层的独占与计数", () => {
  const bindAt = (dir: string) => {
    const h = createAgentMemories({ memories: [residentMemory("note"), indexedMemory("notes")] });
    bindMemoryScopes(h, memoryScopeTable([{ def: oneLayer("project"), dir: new FileDirLock(dir) }]));
    return h;
  };

  test("同一层已有整理在跑：再来一个试拿不到、当场跳过（不等）；放手之后能拿到——两个 FileDir 实例，跨实例算数", async () => {
    const dir = mkdtempLock(joinLock(tmpLock(), "echo-dream-pass-"));
    try {
      const a = bindAt(dir);
      const b = bindAt(dir);
      const held = await claimCas(a, "project");
      expect(held).not.toBeNull();
      const t0 = Date.now();
      expect(await claimCas(b, "project")).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1_000);
      await held!();
      const next = await claimCas(b, "project");
      expect(next).not.toBeNull();
      await next!();
    } finally {
      rmLock(dir, { recursive: true, force: true });
    }
  });

  test("两个实例同时往同一层的两个模块写（两把提交锁互不相干）：这一层的写入计数一个不少", async () => {
    const dir = mkdtempLock(joinLock(tmpLock(), "echo-dream-count-"));
    try {
      const a = bindAt(dir);
      const b = bindAt(dir);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0 ? createCas(a, `project/notes/n${i}.md`, `---\ndescription: 第 ${i} 条\n---\n`) : createCas(b, "project/note.md", `第 ${i} 版`),
        ),
      );
      expect((await dreamStateCas(a.dir, "project")).writes).toBe(20);
    } finally {
      rmLock(dir, { recursive: true, force: true });
    }
  });
});

