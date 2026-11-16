// prompt 组装的契约门。对应设计 docs/design/prompt.md。
//
// 锁的不变量:
//   ① 装配:按 order 升序(同数保注册序);空段丢弃;render 抛错 = 隐形 + 留痕;全空 = null
//   ② 变量:声明了 `interpolate` 的段才插值,其余原样;插值严格——未注册 / 无值 / 畸形都**抛**(作者错误要响);
//      孤立 `{{` 原样;替换值不重扫
//   ③ registry:段与变量只经 AgentPrompt 进;同名抛;disposer 只卸自己;内建 echo:* 走同一条路
//   ④ 通道 B:激活正文每轮注入(消息末尾、不进 transcript),启用「下一轮起可见」、停用下一轮消失;
//      正文反引号原样、instructions 单行化;任务清单同款
//   ⑤ 导入:frontmatter 定 name/order,order 缺省 0;没名字 / 写 tier / 非整数 order 都 fail-loud
//   ⑥ 缓存:run 内 system 逐字节不变(冻结时刻);激活 skill 不动 system(只动注入)
//   ⑦ 变量错让 run 以 error 收场,不静默发一份错的 system

import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { definePromptPack, defineToolPack, mountBuiltinTools } from "../src/extension/builtin.ts";
import { ExtensionHost } from "../src/extension/host.ts";
import { AgentPrompt, agentRegistries, type AgentPromptRegistry } from "../src/extension/registries.ts";
import { HookRuntime } from "../src/hooks/runtime.ts";
import type { Context } from "../src/messages.ts";
import type { StreamFn } from "../src/provider/types.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { assemblePrompt, interpolate, PromptVariableError } from "../src/prompt/assemble.ts";
import { sectionFromMarkdown } from "../src/prompt/import.ts";
import { fenceSafe } from "../src/prompt/sanitize.ts";
import { PROMPT_ORDER, type AssembleContext, type PromptSection, type PromptVariable } from "../src/prompt/types.ts";
import { addSkills, activateSkill, deactivateSkill, type ActiveSkillMap, type SkillMap } from "../src/skill/harness.ts";
import { renderSkillCatalog, renderSkillInjections, renderSkillRules, SKILL_CATALOG_CAPS } from "../src/skill/compose.ts";
import { registerTool, toolSchemasOf, type ToolMap } from "../src/tools/harness.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";
import type { Skill } from "../src/skill/types.ts";

function skill(name: string, description: string, content = "正文", modelInvocable = true): Skill {
  return { name, description, content, dir: `/skills/${name}`, files: [], requiredTools: [], modelInvocable, frontmatter: {} };
}

function attachedSkills(opts?: { skills?: Skill[] }): { skills: SkillMap; active: ActiveSkillMap } {
  const skills: SkillMap = new Map();
  if (opts?.skills !== undefined && opts.skills.length > 0) addSkills(skills, opts.skills);
  return { skills, active: new Map() };
}

function fakeTool(name: string): ModelTool {
  return { kind: "model", name, label: name, description: `${name} 工具`, parameters: { type: "object" }, execute: async () => toolOk("") };
}

const CTX: AssembleContext = { workspace: "/repo", model: { provider: "fake", id: "m1" }, agentId: "default", sessionId: null };
const NO_VARS = new Map<string, PromptVariable>();
const sec = (name: string, order: number, text: string): PromptSection => ({ name, order, render: () => text });

/** 记录模型每次看到的 Context 的 StreamFn。 */
function spying(turns: Parameters<typeof scriptedStreamFn>[0]): { spy: StreamFn; seen: Context[] } {
  const seen: Context[] = [];
  const inner = scriptedStreamFn(turns);
  const spy: StreamFn = (m, c, o) => {
    seen.push(structuredClone(c));
    return inner(m, c, o);
  };
  return { spy, seen };
}

/* ───────────────────────── ① 装配 ───────────────────────── */

describe("assemblePrompt", () => {
  /** system 那一份（system 载体的段拼成的字符串）。 */
  const assembleSystem = async (...args: Parameters<typeof assemblePrompt>): Promise<string | null> => (await assemblePrompt(...args)).system;

  test("按 order 升序、同数保注册序;空段丢弃;全空返回 null", async () => {
    const sections: PromptSection[] = [sec("v", 900, "V"), sec("s1", 10, "S1"), sec("empty", 10, ""), sec("s2", 10, "S2"), sec("id", 0, "ID")];
    expect(await assembleSystem(sections, NO_VARS, CTX)).toBe("ID\n\nS1\n\nS2\n\nV");
    expect(await assembleSystem([sec("e", 0, "  ")], NO_VARS, CTX)).toBeNull();
  });

  test("render 抛错 = 该段隐形不击穿,onFailure 留痕", async () => {
    const failures: string[] = [];
    const sections: PromptSection[] = [
      { name: "boom", order: 0, render: () => { throw new Error("段坏了"); } },
      sec("ok", 1, "OK"),
    ];
    const out = await assembleSystem(sections, NO_VARS, CTX, (f) => failures.push(f.section));
    expect(out).toBe("OK");
    expect(failures).toEqual(["boom"]);
  });

  test("两种载体:carrier 为 messages 的段不进 system,一段一份、按 order;排序、空段、失败、插值与 system 的段同一套规则", async () => {
    const vars = new Map<string, PromptVariable>([["workspace", (c) => c.workspace]]);
    const failures: string[] = [];
    const msg = (name: string, order: number, text: string): PromptSection => ({ ...sec(name, order, text), carrier: "messages" });
    const sections: PromptSection[] = [
      msg("late", 900, "LATE"),
      sec("id", 0, "ID"),
      msg("early", 400, "  EARLY  "), // trim 与 system 的段一样
      msg("empty", 500, ""), // 空段不出消息
      { name: "boom", order: 450, carrier: "messages", render: () => { throw new Error("坏了"); } }, // 失败的段隐形 + 留痕
      { ...msg("vars", 950, "W={{workspace}}"), interpolate: true },
      { ...sec("explicit", 10, "SYS"), carrier: "system" }, // 写明 system 与不写一样
    ];
    const report: { name: string; status: string }[] = [];
    const out = await assemblePrompt(sections, vars, CTX, (f) => failures.push(f.section), (r) => report.push(...r.sections.map((s) => ({ name: s.section.name, status: s.status }))));
    expect(out.system).toBe("ID\n\nSYS");
    expect(out.messages).toEqual([{ name: "early", text: "EARLY" }, { name: "late", text: "LATE" }, { name: "vars", text: "W=/repo" }]);
    expect(failures).toEqual(["boom"]);
    // 两种载体的段在同一份逐段结论里（观测的 prompt.assembled 读它）
    expect(report.map((r) => `${r.name}:${r.status}`)).toEqual(["id:rendered", "explicit:rendered", "early:rendered", "boom:failed", "empty:empty", "late:rendered", "vars:rendered"]);
    // 只有 messages 的段：system 为 null
    expect(await assemblePrompt([msg("only", 0, "X")], NO_VARS, CTX)).toEqual({ system: null, messages: [{ name: "only", text: "X" }] });
  });

  test("render 拿到 AssembleContext;变量从表里取值,同名同值", async () => {
    const vars = new Map<string, PromptVariable>([["workspace", (c) => c.workspace], ["model", (c) => c.model.id]]);
    const sections: PromptSection[] = [
      { name: "env", order: 300, interpolate: true, render: (c) => `Workspace: {{workspace}} / ${c.model.provider}` },
      { ...sec("again", 301, "{{workspace}} {{model}}"), interpolate: true },
    ];
    expect(await assembleSystem(sections, vars, CTX)).toBe("Workspace: /repo / fake\n\n/repo m1");
  });

  test("没声明 interpolate 的段原样:第三方文本里的 `${{ secrets.X }}` / `{{ .Values.x }}` / `{{workspace}}` 都不当变量", async () => {
    const vars = new Map<string, PromptVariable>([["workspace", (c) => c.workspace]]);
    const raw = "CI: `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`; Helm: {{ .Values.x }}; literal {{workspace}}";
    const sections: PromptSection[] = [sec("instructions", 400, raw), { ...sec("env", 300, "W={{workspace}}"), interpolate: true }];
    expect(await assembleSystem(sections, vars, CTX)).toBe(`W=/repo\n\n${raw}`);
  });
});

/* ───────────────────────── ② 变量:严格插值 ───────────────────────── */

describe("interpolate(严格)", () => {
  const values = new Map<string, string | undefined>([["ws", "/repo"], ["none", undefined]]);

  test("完整引用替换;替换值不重扫;孤立 `{{` 原样", () => {
    expect(interpolate("a {{ws}} b", values, "s")).toBe("a /repo b");
    expect(interpolate("{{ws}}{{ws}}", values, "s")).toBe("/repo/repo");
    expect(interpolate("x {{ 没有闭合", values, "s")).toBe("x {{ 没有闭合");
    const v2 = new Map([["ws", "{{ws}}"]]);
    expect(interpolate("{{ws}}", v2, "s")).toBe("{{ws}}"); // 值里的 {{ws}} 不再被解释
  });

  test("未注册 / 无值 / 畸形三种都抛 PromptVariableError,带段名", () => {
    expect(() => interpolate("{{nope}}", values, "identity")).toThrow(PromptVariableError);
    expect(() => interpolate("{{nope}}", values, "identity")).toThrow(/identity.*nope/);
    expect(() => interpolate("{{none}}", values, "s")).toThrow(/本次没有值/);
    expect(() => interpolate("{{Bad Name}}", values, "s")).toThrow(/畸形/);
    expect(() => interpolate("{{{ws}}}", values, "s")).toThrow(/畸形/); // `{{{ws}}}`:内层是 `{ws`,不是合法名字
  });
});

/* ───────────────────────── ③ registry ───────────────────────── */

describe("AgentPrompt registry", () => {
  function registryOf(): { sections: Map<string, PromptSection>; variables: Map<string, PromptVariable>; svc: AgentPromptRegistry } {
    const sections = new Map<string, PromptSection>();
    const variables = new Map<string, PromptVariable>();
    const services = agentRegistries({ tools: new Map(), hooks: new HookRuntime(), prompt: { sections, variables } });
    const svc = services.find(([k]) => k === AgentPrompt)![1] as AgentPromptRegistry;
    return { sections, variables, svc };
  }

  test("段与变量注册进两张表;同名抛;disposer 只卸自己那个对象", () => {
    const r = registryOf();
    const svc = r.svc;
    const a = sec("a", 0, "A");
    const offA = svc.section(a);
    expect(() => svc.section(sec("a", 5, "A2"))).toThrow(/已存在/);
    expect(() => svc.section({ name: "nan", order: Number.NaN, render: () => "" })).toThrow(/有限数/);
    // 载体只有两种：写了别的当场拒，不静默当成 system
    expect(() => svc.section({ name: "odd", order: 0, carrier: "tools" as never, render: () => "" })).toThrow(/carrier/);
    const offMsg = svc.section({ name: "m", order: 400, carrier: "messages", render: () => "M" });
    expect(r.sections.get("m")?.carrier).toBe("messages"); // 同一张表、同一个注册口
    void offMsg();
    expect(r.sections.has("m")).toBe(false);
    const offV = svc.variable("ws", () => "/x");
    expect(() => svc.variable("ws", () => "/y")).toThrow(/已存在/);
    expect(() => svc.variable("Bad", () => "")).toThrow(/不合法/);
    expect(r.sections.get("a")).toBe(a);
    void offA();
    void offV();
    expect(r.sections.has("a")).toBe(false);
    expect(r.variables.has("ws")).toBe(false);
  });

  test("replace:同名必须已存在才换得成;disposer 把原来那段放回去,不是删掉", () => {
    // 角色替产品的 identity 段（2026-09-07）。**替代要有被替代的那一段**——
    // 段名写错时静默变成「多出一段」，人看到的却是「角色没生效」，查起来毫无线索。
    const r = registryOf();
    const original = sec("identity", 0, "产品的身份");
    void r.svc.section(original);
    expect(() => r.svc.section(sec("nobody", 0, "x"), { replace: true })).toThrow(/不存在/);

    const role = sec("identity", 0, "reviewer 的身份");
    const off = r.svc.section(role, { replace: true });
    expect(r.sections.get("identity")).toBe(role);
    off();
    expect(r.sections.get("identity")).toBe(original); // 复原,不是删掉
  });

  test("两层 replace 叠在同一段上、按任意顺序卸:生效的永远是还在的最上一层,不复活已卸的那层", () => {
    // 两个盘上扩展都替产品的 identity：P → A → B。热部署先删 A 再删 B，此前 B 的 disposer 把它记下的 A 放了回去——
    // A 已经不在 echo.extensions 里，它的段却回到了 system，P 直到重启都回不来
    for (const order of [["a", "b"], ["b", "a"]] as const) {
      const r = registryOf();
      const product = sec("identity", 0, "P");
      void r.svc.section(product);
      const offs = {
        a: r.svc.section(sec("identity", 0, "A"), { replace: true }),
        b: r.svc.section(sec("identity", 0, "B"), { replace: true }),
      };
      expect(r.sections.get("identity")!.render({} as AssembleContext)).toBe("B");
      offs[order[0]]();
      expect(r.sections.get("identity")!.render({} as AssembleContext)).toBe(order[0] === "a" ? "B" : "A");
      offs[order[1]]();
      expect(r.sections.get("identity")).toBe(product);
    }
  });

  test("原段先卸、替代层后卸:不把已卸的原段复活", () => {
    const r = registryOf();
    const offProduct = r.svc.section(sec("identity", 0, "P"));
    const offRole = r.svc.section(sec("identity", 0, "R"), { replace: true });
    offProduct();
    expect(r.sections.get("identity")!.render({} as AssembleContext)).toBe("R"); // 替代层还在：它照旧生效
    offRole();
    expect(r.sections.has("identity")).toBe(false);
  });

  test("replace 不给时行为一个字没变:同名照旧 fail-loud", () => {
    const r = registryOf();
    void r.svc.section(sec("identity", 0, "产品的身份"));
    expect(() => r.svc.section(sec("identity", 0, "偷偷盖掉"))).toThrow(/已存在/);
  });

  test("definePromptPack / defineToolPack 带段:mount 进表,unmount 撤走;撞名整包回滚", async () => {
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("好")]) });
    const host = new ExtensionHost({
      services: agentRegistries({
        tools: agent.tools,
        hooks: agent.hooks,
        prompt: { sections: agent.promptSections, variables: agent.promptVariables },
      }),
    });
    const PACK = definePromptPack("t:pack");
    const TOOLS = defineToolPack("t:tools");
    await host.mount("g1", [
      { entryId: "t:pack", definition: PACK as never, config: { sections: [sec("identity", 0, "I am test")] } },
      { entryId: "t:tools", definition: TOOLS as never, config: { tools: [fakeTool("x")], sections: [sec("tool:x", 100, "use x wisely")] } },
    ]);
    expect([...agent.promptSections.keys()].sort()).toEqual(["identity", "tool:x"]);
    expect(agent.tools.has("x")).toBe(true);
    // 撞名:第二包里 "identity" 已存在 → 这包整体失败,它自己的另一段不许留下
    await expect(
      host.mount("g2", [{ entryId: "t:dup", definition: PACK as never, config: { sections: [sec("fresh", 1, "F"), sec("identity", 0, "dup")] } }]),
    ).rejects.toThrow(/已存在/);
    expect(agent.promptSections.has("fresh")).toBe(false);
    await host.unmount("g1");
    expect(agent.promptSections.size).toBe(0);
    expect(agent.tools.has("x")).toBe(false);
  });
});

/* ───────────────────────── skill 目录 / tools 投影 / 通道 B(渲染函数本身) ───────────────────────── */

describe("skill 的两段:规则与目录", () => {
  test("池空 → 两段都不出（门控「有没有 skill_activate 工具」在段的闭包里）", () => {
    expect(renderSkillCatalog(new Map())).toBe("");
    expect(renderSkillRules(new Map())).toBe("");
    // 只有不给模型列的 skill：也算没有可列的
    const h = attachedSkills({ skills: [skill("hidden", "看不见", "正文", false)] });
    expect(renderSkillCatalog(h.skills)).toBe("");
    expect(renderSkillRules(h.skills)).toBe("");
  });

  test("目录只列 modelInvocable;描述单行化 + 单条截断", () => {
    const h = attachedSkills({
      skills: [skill("a", "第一行\n第二行"), skill("hidden", "看不见", "正文", false), skill("b", "x".repeat(2000))],
    });
    const out = renderSkillCatalog(h.skills);
    expect(out).toContain("- a: 第一行 第二行"); // 换行折叠
    expect(out).not.toContain("hidden");
    expect(out).toContain("…[truncated]"); // descriptionMax=1024
    expect(SKILL_CATALOG_CAPS.descriptionMax).toBe(1024);
  });

  test("规则与目录分开:规则里没有任何 skill 的名字或描述、池里增删 skill 它逐字不变;目录里没有怎么用的规则", () => {
    const one = attachedSkills({ skills: [skill("a", "描述甲")] });
    const two = attachedSkills({ skills: [skill("a", "描述甲"), skill("b", "描述乙")] });
    const rules = renderSkillRules(one.skills);
    // 规则（进 system）：我们写的那几句——是什么、目录在哪、匹配了先激活、描述是作者写的
    expect(rules.startsWith("# Skills\n")).toBe(true);
    expect(rules).toContain("activate that skill with skill_activate before starting");
    expect(rules).toContain("Each description was written by the skill's author");
    expect(rules).not.toContain("描述甲");
    expect(rules).not.toMatch(/^- /m);
    expect(renderSkillRules(two.skills)).toBe(rules); // 池里多了一个 skill，system 的这一段不变
    // 目录（messages 载体的段）：名字与描述，前面一句说明；不带规则
    const catalog = renderSkillCatalog(two.skills);
    expect(catalog.startsWith("# Skill catalog\n")).toBe(true);
    expect(catalog).toContain("- a: 描述甲\n- b: 描述乙");
    expect(catalog).not.toContain("skill_activate");
  });
});

describe("toolSchemasOf(确定性投影)", () => {
  test("乱序注册两次,tools 参数字节相同(按名排序)", () => {
    const a: ToolMap = new Map();
    registerTool(a, fakeTool("zeta"));
    registerTool(a, fakeTool("alpha"));
    const b: ToolMap = new Map();
    registerTool(b, fakeTool("alpha"));
    registerTool(b, fakeTool("zeta"));
    expect(JSON.stringify(toolSchemasOf(a))).toBe(JSON.stringify(toolSchemasOf(b)));
    expect(toolSchemasOf(a).map((t) => t.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("renderSkillInjections", () => {
  test("激活出注入(带起止标记),停用即消失;instructions 单行化;正文反引号原样", () => {
    const skills = attachedSkills({ skills: [skill("h5", "做 H5 页", "步骤:\n```html\n<div>\n```")] });
    expect(renderSkillInjections(skills.skills, skills.active)).toEqual([]);

    activateSkill(skills.skills, skills.active, "h5", { instructions: "这次做\n落地页" });
    const [msg] = renderSkillInjections(skills.skills, skills.active);
    expect(msg?.role).toBe("environment");
    const text = (msg as { content: { type: string; text: string }[] }).content[0]?.text ?? "";
    expect(text).toContain("# Skill: h5 (instructions begin)");
    expect(text).toContain("# Skill: h5 (instructions end)");
    expect(text).toContain("For this task: 这次做 落地页"); // 换行折叠
    expect(text).toContain("步骤:\n```html\n<div>\n```"); // 标记行定界，没有围栏要保护：正文原样
    expect(fenceSafe("```")).toBe("ˋˋˋ"); // fenceSafe 本身仍在，给放进围栏的内容用

    deactivateSkill(skills.active, "h5");
    expect(renderSkillInjections(skills.skills, skills.active)).toEqual([]);
  });
});

/* ───────────────────────── ⑤ 导入 ───────────────────────── */

describe("sectionFromMarkdown", () => {
  test("frontmatter 定 name/order;正文原样;order 缺省 0", () => {
    const s = sectionFromMarkdown("---\nname: policy\norder: 10\n---\n\n规矩第一条。");
    expect(s.name).toBe("policy");
    expect(s.order).toBe(10);
    expect(s.render(CTX)).toBe("规矩第一条。");
    expect(sectionFromMarkdown("裸正文", "from-file").order).toBe(0);
    expect(sectionFromMarkdown("裸正文", "from-file").name).toBe("from-file");
  });

  test("没名字 / 写 tier / 非整数 order 都 fail-loud", () => {
    expect(() => sectionFromMarkdown("裸正文")).toThrow("缺名字");
    expect(() => sectionFromMarkdown("---\nname: x\ntier: stable\n---\n正文")).toThrow("tier");
    expect(() => sectionFromMarkdown("---\nname: x\norder: high\n---\n正文")).toThrow("order");
  });
});

/* ───────────────────────── ⑥⑦ Agent 接线与缓存语义 ───────────────────────── */

describe("Agent 接线", () => {
  test("内建段经 echo:* 装进 prompt:环境段带 {{workspace}}/{{model}};skill 的规则在 system、目录是对话最前面的一条消息;激活后下一轮注入可见、system 逐字节不变", async () => {
    const { spy, seen } = spying([toolTurn("t1", "skill_activate", { name: "h5", instructions: "做落地页" }), textTurn("做完了")]);
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: spy,
      workspace: "/repo/x",
      skills: [skill("h5", "做 H5 页", "用单文件写")],
    });
    await mountBuiltinTools(agent); // 内建工具与段经 `echo:*` builtin Extension 注册

    await agent.prompt("做个 H5");
    const sys = seen[0]?.systemPrompt ?? "";
    // echo:agent 的环境段:变量从 AssembleContext 来,模型名是 admission 冻结的那个
    expect(sys).toContain(`# Environment\nWorkspace: /repo/x\nModel: ${FAKE_MODEL.id} (${FAKE_MODEL.provider})`);
    // echo:skills 的规则段在 system,且排在环境段之后(order 500 > 300);目录不在 system——描述是 skill 作者写的
    expect(sys).toContain("# Skills\n");
    expect(sys.indexOf("# Environment")).toBeLessThan(sys.indexOf("# Skills\n"));
    expect(sys).not.toContain("- h5: 做 H5 页");
    expect(sys).not.toContain("# Skill catalog");
    // 目录是 messages 载体的段:对话最前面的一条消息,来源标签写段名;之后才是用户的输入
    const firstTexts = seen[0]!.messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
    expect(firstTexts[0]!.startsWith('<environment source="skills-catalog">\n# Skill catalog\n')).toBe(true);
    expect(firstTexts[0]).toContain("- h5: 做 H5 页");
    expect(firstTexts[1]).toBe("做个 H5");
    expect(JSON.stringify(seen[0]?.messages)).not.toContain("instructions begin");
    // 第 2 轮:激活生效,注入出现在消息里(投影成 user 角色)
    const lastMsg = JSON.stringify(seen[1]?.messages);
    expect(lastMsg).toContain("# Skill: h5 (instructions begin)");
    expect(lastMsg).toContain("用单文件写");
    // system 逐字节不变——激活 skill 不打 system 缓存；目录那条消息也不变
    expect(seen[1]?.systemPrompt).toBe(sys);
    expect(seen[1]!.messages[0]).toEqual(seen[0]!.messages[0]!);
    // 注入不进 transcript
    expect(JSON.stringify(agent.messages)).not.toContain("instructions begin");
  });

  test("任务清单每轮注入:空清单不占位、建完下一轮就可见、不打 system 缓存、不进 transcript", async () => {
    const { spy, seen } = spying([
      toolTurn("t1", "TaskCreate", { tasks: [{ title: "把 M6 做完" }, { title: "已经做完的", status: "done" }] }),
      textTurn("建好了"),
    ]);
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy });
    await mountBuiltinTools(agent);

    await agent.prompt("规划一下");

    expect(JSON.stringify(seen[0]?.messages)).not.toContain("# Task list");
    const injected = JSON.stringify(seen[1]?.messages.at(-1));
    expect(injected, "建完的任务没进下一轮的 context").toContain("# Task list");
    expect(injected).toContain("把 M6 做完");
    expect(injected, "done 的任务也被喂进去了").not.toContain("已经做完的");
    expect(seen[1]?.systemPrompt).toBe(seen[0]?.systemPrompt ?? "");
    expect(seen[1]?.systemPrompt ?? "", "清单跑到 system 里去了").not.toContain("# Task list");
    expect(JSON.stringify(agent.messages)).not.toContain("# Task list");
  });

  test("产品加段:md 导入的 identity 段经 registry 进 system 且在最前;tool pack 带的习惯段在环境段之前", async () => {
    const { spy, seen } = spying([textTurn("好")]);
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy });
    const host = await mountBuiltinTools(agent);
    await host.mount("product", [
      {
        entryId: "p:identity",
        definition: definePromptPack("p:identity") as never,
        config: { sections: [sectionFromMarkdown("---\nname: identity\n---\nYou are Test, working in {{workspace}}.")] },
      },
      {
        entryId: "p:tools",
        definition: defineToolPack("p:tools") as never,
        config: { tools: [fakeTool("x")], sections: [sec("tool:x", PROMPT_ORDER.tools, "Use x for x-things.")] },
      },
    ]);
    await agent.prompt("hi");
    const sys = seen[0]?.systemPrompt ?? "";
    expect(sys.startsWith("You are Test, working in /.")).toBe(true); // order 0 最前;{{workspace}} 缺省 "/"
    expect(sys.indexOf("Use x for x-things.")).toBeLessThan(sys.indexOf("# Environment"));
  });

  test("carrier 为 messages 的段:不进 system,是对话最前面的一条消息(包在来源标签里、按 order 排),不进 transcript;文本没变跨 run 逐字不变,变了才换", async () => {
    const { spy, seen } = spying([textTurn("一"), textTurn("二"), textTurn("三")]);
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy });
    const host = await mountBuiltinTools(agent);
    let conventions = "Use bun.";
    await host.mount("product", [
      {
        entryId: "p:context",
        definition: definePromptPack("p:context") as never,
        config: {
          sections: [
            { name: "notes", order: 900, carrier: "messages", render: () => "NOTES" },
            { name: "conventions", order: 400, carrier: "messages", render: () => conventions },
            sec("identity", 0, "You are Test."),
          ],
        },
      },
    ]);
    const texts = (c: Context): string[] => c.messages.map((m) => m.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
    // 送模前的视图里最前面那两条消息对象（投影之前）：看是不是同一个对象
    const heads: unknown[][] = [];
    agent.transformContext = async (messages) => {
      heads.push(messages.slice(0, 2));
      return messages;
    };
    await agent.prompt("甲");
    // system 里只有 system 载体的段
    expect(seen[0]?.systemPrompt).toContain("You are Test.");
    expect(seen[0]?.systemPrompt).not.toContain("Use bun.");
    expect(seen[0]?.systemPrompt).not.toContain("NOTES");
    // 消息：两段各一条，按 order 在最前，来源标签写段名；之后才是用户的输入
    expect(texts(seen[0]!)).toEqual(['<environment source="conventions">\nUse bun.\n</environment>', '<environment source="notes">\nNOTES\n</environment>', "甲"]);
    // 不进 transcript
    expect(agent.state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    await agent.prompt("乙");
    // 文本没变：前缀逐字相同，消息只在末尾长
    expect(seen[1]!.messages.slice(0, 2)).toEqual(seen[0]!.messages.slice(0, 2));
    expect(texts(seen[1]!).slice(2)).toEqual(["甲", "一", "乙"]);
    // 而且是同一个消息对象（观测镜像按对象身份记编号，只交一次值）
    expect(heads[1]![0]).toBe(heads[0]![0]);
    expect(heads[1]![1]).toBe(heads[0]![1]);

    conventions = "Use bun. Run the type check.";
    await agent.prompt("丙");
    // 一段的文本变了：换的只是那一条，另一条不动
    expect(texts(seen[2]!).slice(0, 2)).toEqual(['<environment source="conventions">\nUse bun. Run the type check.\n</environment>', '<environment source="notes">\nNOTES\n</environment>']);
    expect(heads[2]![0]).not.toBe(heads[0]![0]);
    expect(heads[2]![1]).toBe(heads[0]![1]);
    expect(seen[2]?.systemPrompt).toBe(seen[0]!.systemPrompt);
  });

  test("变量错 = run 以 error 收场,不静默发一份错的 system", async () => {
    const { spy, seen } = spying([textTurn("好")]);
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy });
    const host = await mountBuiltinTools(agent);
    await host.mount("product", [
      { entryId: "p:bad", definition: definePromptPack("p:bad") as never, config: { sections: [{ ...sec("identity", 0, "I am {{modle}}"), interpolate: true }] } },
    ]);
    const r = await agent.prompt("hi");
    expect(r.outcome.kind).toBe("error");
    expect(seen).toHaveLength(0); // 模型一次都没被调
    expect(agent.status).toBe("idle");
  });

  test("assemblePrompt() 缺省用当前装备的模型;{{provider}} 也在", async () => {
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([]), workspace: "/w" });
    await mountBuiltinTools(agent);
    const sys = await agent.assemblePrompt();
    expect(sys).toContain(`Model: ${FAKE_MODEL.id} (${FAKE_MODEL.provider})`);
    expect(sys).toContain("Workspace: /w");
  });
});

/* ───────────────────────── 送模前的两道闸（2026-09-01 review） ───────────────────────── */

describe("送模前", () => {
  test("contextBeforeBuild 返回 block：不调模型，run 以 aborted 收场、reason 透传，transcript 不多一条", async () => {
    const h = new HookRuntime();
    h.on("contextBeforeBuild", () => ({ decision: "block", reason: "DO_NOT_CALL_MODEL" }));
    const { spy, seen } = spying([textTurn("done")]);
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy, hooks: h });
    const r = await agent.prompt("go");
    expect(r.outcome).toEqual({ kind: "aborted", reason: "DO_NOT_CALL_MODEL" });
    expect(seen, "block 之后模型仍被调用").toHaveLength(0);
    expect(agent.messages.map((m) => m.role)).toEqual(["user"]); // 没有合成的 assistant 消息
    expect(agent.status).toBe("idle");
  });

  test("注入的工具门控读本轮冻结的菜单：turn_start 里才注册的 TaskList，本轮菜单与清单都没有、下一轮一起出现", async () => {
    const { spy, seen } = spying([toolTurn("t1", "TaskList", {}), textTurn("ok")]);
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy, tasks: [{ title: "把 M6 做完" }] });
    let registered = false;
    agent.subscribe((e) => {
      if (e.type === "turn_start" && !registered) {
        registered = true;
        registerTool(agent.tools, fakeTool("TaskList"));
      }
    });
    await agent.prompt("go");
    // 第 1 轮：工作集在 turn_start 之前就冻了 → 菜单里没有 TaskList → 清单也不许注入（否则要模型用它点不到的工具）
    expect(seen[0]?.tools.map((t) => t.name)).toEqual([]);
    expect(JSON.stringify(seen[0]?.messages)).not.toContain("# Task list");
    // 第 2 轮：菜单里有了，清单跟着出现——两者永远是同一份快照
    expect(seen[1]?.tools.map((t) => t.name)).toEqual(["TaskList"]);
    expect(JSON.stringify(seen[1]?.messages.at(-1))).toContain("# Task list");
  });
});
