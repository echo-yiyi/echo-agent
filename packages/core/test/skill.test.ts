// skill 的契约门。设计见 docs/design/AGENT-CORE.md §5A。
//
// 形态变化（2026-08-05）：不再有 SkillHarness 这个对象——池是 `agent.skills`（Map<string, Skill>），
// 工作集是 `agent.activeSkills`，操作全是 `skill/harness.ts` 里的函数。
// 随之取消的能力：按 source 整批卸（`source` 字段本身没了）。

import { test, expect } from "bun:test";
import {
  activateSkill,
  addSkills,
  createSkill,
  deactivateSkill,
  getSkill,
  listActiveSkills,
  listSkills,
  removeSkill,
  validateSkillInput,
  type ActiveSkillMap,
  type SkillMap,
} from "../src/skill/harness.ts";
import { makeSkillTools } from "../src/skill/tools.ts";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import { registerTool } from "../src/tools/harness.ts";
import { toolOk, type InternalTool } from "../src/tools/types.ts";
import type { Skill } from "../src/skill/types.ts";
import { roundTripError } from "../src/skill/format.ts";
import { InMemoryDir } from "../src/storage/in-memory-dir.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";

function skill(name: string, over: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `${name} 的用途`,
    content: `${name} 的指令正文`,
    dir: `/skills/${name}`,
    files: [],
    requiredTools: [],
    modelInvocable: true,
    frontmatter: {},
    ...over,
  };
}

/** 一副空家什：池 + 工作集 + 一个假的工具面查询。 */
function fixture(tools: string[] = []): { skills: SkillMap; active: ActiveSkillMap; hasTool: (n: string) => boolean } {
  return { skills: new Map(), active: new Map(), hasTool: (n) => tools.includes(n) };
}

const ctx = () => ({ toolCallId: "t1", workspace: "/", sessionId: null, iteration: 0 });

/* ══════════ 池与激活是两件事 ══════════ */

test("addSkills 只是「可用」，不激活", () => {
  const f = fixture();
  addSkills(f.skills, [skill("a"), skill("b")]);
  expect(listSkills(f.skills).length).toBe(2);
  expect(listActiveSkills(f.active).length).toBe(0); // ← 装进来 ≠ 激活
});

test("撞名 fail-loud；覆盖须显式（热重载路径必须写 replace）", () => {
  const f = fixture();
  addSkills(f.skills, [skill("a")]);
  expect(() => addSkills(f.skills, [skill("a")])).toThrow(/replace/);
  addSkills(f.skills, [skill("a", { content: "新正文" })], { replace: true });
  expect(getSkill(f.skills, "a")?.content).toBe("新正文");
});

test("批量 add 撞名 → 先查后写，不留半批", () => {
  const f = fixture();
  addSkills(f.skills, [skill("a")]);
  expect(() => addSkills(f.skills, [skill("b"), skill("a")])).toThrow();
  expect(getSkill(f.skills, "b")).toBeUndefined();
});

/* ══════════ 激活 ══════════ */

test("激活不存在的 skill → not_found，不抛", () => {
  const f = fixture();
  const r = activateSkill(f.skills, f.active, "nope");
  expect(r).toEqual({ ok: false, reason: "not_found" });
});

test("requiredTools 缺了 → missing_tools 带上缺哪几个（不让模型试半天）", () => {
  const f = fixture(["read"]); // 只有 read
  addSkills(f.skills, [skill("a", { requiredTools: ["read", "bash"] })]);
  const r = activateSkill(f.skills, f.active, "a", { hasTool: f.hasTool });
  expect(r.ok).toBe(false);
  if (!r.ok && r.reason === "missing_tools") expect(r.missing).toEqual(["bash"]);
});

test("requiredTools 齐了 → 激活成功", () => {
  const f = fixture(["read", "bash"]);
  addSkills(f.skills, [skill("a", { requiredTools: ["read", "bash"] })]);
  expect(activateSkill(f.skills, f.active, "a", { hasTool: f.hasTool }).ok).toBe(true);
  expect(listActiveSkills(f.active).map((s) => s.name)).toEqual(["a"]);
});

test("modelInvocable:false 照样能被激活（那是给模型的门，人和 hook 有权）", () => {
  const f = fixture();
  addSkills(f.skills, [skill("a", { modelInvocable: false })]);
  expect(activateSkill(f.skills, f.active, "a").ok).toBe(true);
});

test("重复激活：更新 instructions，但不改激活顺序", async () => {
  const f = fixture();
  addSkills(f.skills, [skill("a"), skill("b")]);
  activateSkill(f.skills, f.active, "a", { instructions: "第一次" });
  await new Promise((r) => setTimeout(r, 2));
  activateSkill(f.skills, f.active, "b");
  activateSkill(f.skills, f.active, "a", { instructions: "第二次" });

  const active = listActiveSkills(f.active);
  expect(active.map((s) => s.name)).toEqual(["a", "b"]); // 顺序没变
  expect(active[0]?.instructions).toBe("第二次"); // 内容更新了
});

test("removeSkill 会连带撤下激活态（否则渲染会去找一个不存在的 skill）", () => {
  const f = fixture();
  addSkills(f.skills, [skill("a")]);
  activateSkill(f.skills, f.active, "a");
  expect(removeSkill(f.skills, f.active, "a")).toBe(true);
  expect(listActiveSkills(f.active).length).toBe(0);
  expect(removeSkill(f.skills, f.active, "a")).toBe(false);
});

test("ActiveSkill 按 name 引用，热重载后拿到的是新内容", () => {
  const f = fixture();
  addSkills(f.skills, [skill("a", { content: "旧" })]);
  activateSkill(f.skills, f.active, "a");
  addSkills(f.skills, [skill("a", { content: "新" })], { replace: true });
  // 激活态只记名字，正文每次从池里现取
  expect(getSkill(f.skills, listActiveSkills(f.active)[0]!.name)?.content).toBe("新");
});

test("deactivate 幂等", () => {
  const f = fixture();
  addSkills(f.skills, [skill("a")]);
  activateSkill(f.skills, f.active, "a");
  expect(deactivateSkill(f.active, "a")).toBe(true);
  expect(deactivateSkill(f.active, "a")).toBe(false);
});

/* ══════════ 创建 ══════════ */

test("createSkill 只进池，不写盘（core 不认识文件系统）", () => {
  const f = fixture();
  const r = createSkill(f.skills, { name: "my-flow", description: "做某类活", content: "步骤…" });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.skill.dir).toBeUndefined(); // 没落盘 → 引用不了同目录文件
  expect(getSkill(f.skills, "my-flow")).toBeDefined();
  expect(createSkill(f.skills, { name: "my-flow", description: "x", content: "y" })).toEqual({
    ok: false,
    reason: "exists",
  });
});

test("createSkill 校验不合法的名字，返回错误结果而不是抛", () => {
  const f = fixture();
  const r = createSkill(f.skills, { name: "Bad Name", description: "", content: "x" });
  expect(r.ok).toBe(false);
  if (!r.ok && r.reason === "invalid") expect(r.message).toContain("lowercase letters");
  expect(validateSkillInput("ok-name", "有描述")).toEqual([]);
});

/* ══════════ 模型可见面 ══════════ */

test("skill_activate 对模型不开放的 skill 说不（方法层不查，这条路要查）", async () => {
  const f = fixture();
  addSkills(f.skills, [skill("secret", { modelInvocable: false })]);
  const tools = makeSkillTools(f);
  const activate = tools.find((t) => t.name === "skill_activate")!;
  const out = await activate.execute({ name: "secret" }, ctx());
  expect(out.isError).toBe(true);
  expect(out.content).toContain("not available to the model");
});

test("skill_activate 缺工具时把缺哪几个说清楚", async () => {
  const f = fixture([]);
  addSkills(f.skills, [skill("a", { requiredTools: ["bash"] })]);
  const activate = makeSkillTools(f).find((t) => t.name === "skill_activate")!;
  const out = await activate.execute({ name: "a" }, ctx());
  expect(out.isError).toBe(true);
  expect(out.content).toContain("bash");
});

test("skill_activate 未知名字时把可用清单报出来", async () => {
  const f = fixture();
  addSkills(f.skills, [skill("a")]);
  const activate = makeSkillTools(f).find((t) => t.name === "skill_activate")!;
  const out = await activate.execute({ name: "zzz" }, ctx());
  expect(out.content).toContain("a");
});

/* ══════════ 接到 Agent 上 ══════════ */

test("agent.skills 是池；state.activeSkills 是工作集视图（池不在 state 里）", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    skills: [skill("a"), skill("b")],
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
  expect(agent.skills.size).toBe(2);
  expect(agent.state.activeSkills).toEqual([]);
  activateSkill(agent.skills, agent.activeSkills, "a");
  expect(agent.state.activeSkills.map((s) => s.name)).toEqual(["a"]);
  await agent.dispose();
  expect(agent.skills.size).toBe(0); // 收摊清空
});

test("requiredTools 查的是 agent 真实的工具面", async () => {
  const bash: InternalTool = { kind: "internal", name: "bash", label: "bash", execute: async () => toolOk("") };
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    skills: [skill("a", { requiredTools: ["bash"] })],
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
  expect(activateSkill(agent.skills, agent.activeSkills, "a", { hasTool: (n) => agent.tools.has(n) }).ok).toBe(false);
  registerTool(agent.tools, bash);
  expect(activateSkill(agent.skills, agent.activeSkills, "a", { hasTool: (n) => agent.tools.has(n) }).ok).toBe(true);
  await agent.dispose();
});

test("模型点名 skill_activate → 真的激活（工具走普通注册，无特权通道）", async () => {
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([toolTurn("c1", "skill_activate", { name: "a" }), textTurn("好")]),
    skills: [skill("a")],
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
  // 不用自己注册了：构造时给了 skills（池非空），Agent 就把这两件装上（2026-08-23 拍板）。
  // **池为空时仍然不装**——空可选集每轮白占 token，那条纪律没变。
  await agent.prompt("用一下 a");
  expect(agent.state.activeSkills.map((s) => s.name)).toEqual(["a"]);
  await agent.dispose();
});

test("skill_create：onCreate 没 settle 之前不许回执（工具说成功 = 盘上真有）", async () => {
  // Task 面吃过的亏在这里堵住：只排一个 microtask 就说成功，慢 Store 下模型收到
  // 「已创建」而落盘还没发生。`onCreate` 放宽成可返回 Promise，工具必须等它。
  const skills = new Map<string, Skill>();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tools = makeSkillTools({
    skills,
    active: new Map(),
    onCreate: () => gate,
  });
  const create = tools.find((t) => t.name === "skill_create")!;

  let settled = false;
  const call = (create.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean }>)(
    { name: "slow", description: "慢落盘", content: "x" },
    ctx(),
  ).then((r) => {
    settled = true;
    return r;
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(settled, "onCreate 还没 resolve，工具就回执了").toBe(false);

  release();
  const out = await call;
  expect(out.isError).toBe(false);
});

test("description 的保真约束：换行 / 首尾空白 / 成对引号一律拒绝——落盘再读会变值", () => {
  expect(validateSkillInput("ok-name", "第一行\n第二行").join("; ")).toContain("single line");
  expect(validateSkillInput("ok-name", " 首尾有空白 ").join("; ")).toContain("whitespace");
  expect(validateSkillInput("ok-name", '"整个被引号包着"').join("; ")).toContain("quotes");
  expect(validateSkillInput("ok-name", "中间有 \"引号\" 没关系")).toEqual([]);
  expect(validateSkillInput("ok-name", "单行没问题")).toEqual([]);
});

test("roundTripError：保真的返回 null；不保真的说出会变成什么", () => {
  const base = { name: "x", description: "正常", content: "正文" };
  expect(roundTripError(base)).toBeNull();
  // 校验挡不住的情况（这里绕过校验直接造），落盘前的兜底必须报出来而不是写下去
  expect(roundTripError({ ...base, description: '"被剥引号"' })).toContain("被剥引号");
  expect(roundTripError({ ...base, content: "  首尾空白  " })).toContain("content");
});

test("createSkill 进池时 trim 正文：池里的 == 盘上的 == 读回来的", () => {
  const skills = new Map<string, Skill>();
  const r = createSkill(skills, { name: "t", description: "d", content: "\n正文带尾换行\n\n" });
  expect(r.ok && r.skill.content).toBe("正文带尾换行");
});

test("Agent 自己拥有 skill 机制：给了 skillStore，零池也装两件工具；start() 发现后 activate 直接可用", async () => {
  // review 点的洞：发现了 skill 却没有激活工具，目录段又按「有 activate 才出」门控——
  // 模型完全看不见。有 store = 支持创建 = 池随时会长，所以两件工具构造期就装上。
  const dir = new InMemoryDir();
  await dir.write("h5/SKILL.md", "---\ndescription: 做 H5 页\n---\n用单文件写");
  const agent = new Agent({
    model: FAKE_MODEL,
    streamFunction: scriptedStreamFn([]),
    skillStore: dir, // 低层用法：不受生命周期管，没有租约语义
  });
  await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
  expect(agent.tools.has("skill_activate"), "零池就没装 activate——发现之后模型看不见 skill").toBe(true);
  expect(agent.tools.has("skill_create")).toBe(true);
  expect(agent.skills.size).toBe(0);

  await agent.start();
  expect(agent.skills.get("h5")?.description).toBe("做 H5 页");
  const activate = [...agent.tools.values()].find((t) => t.name === "skill_activate")!;
  const out = await (activate.execute as (p: unknown, c: unknown) => Promise<{ isError: boolean }>)({ name: "h5" }, ctx());
  expect(out.isError).toBe(false);

  // 落盘也走这个 store：布局是 `<name>/SKILL.md`
  const create = [...agent.tools.values()].find((t) => t.name === "skill_create")!;
  await (create.execute as (p: unknown, c: unknown) => Promise<unknown>)({ name: "made", description: "新建的", content: "x" }, ctx());
  expect(await dir.read("made/SKILL.md")).toContain("新建的");
  await agent.dispose();
});

