// prompt 组装的契约门。对应设计 docs/design/parts/prompt.md。
//
// 锁的不变量:
//   ① 装配:stable 在前 volatile 沉底(同 tier 保数组序);空段丢弃;坏段隐形 + 留痕;全空 = null
//   ② PromptSource:SkillHarness 供目录段(门控按 skill_activate 在不在工具面)与激活正文注入;
//      ToolHarness 供确定性 toolSchemas——**乱序注册,字节相同**(注册时序天然不稳定,尤其 MCP)
//   ③ 通道 B:激活正文每轮注入(消息末尾、不进 transcript),启用「下一轮起可见」、停用下一轮消失;
//      反引号中和、instructions 单行化
//   ④ 导入:frontmatter 定 name/tier,缺省 stable;没名字 fail-loud
//   ⑤ 缓存:run 内 system 逐字节不变(冻结时刻);激活 skill 不动 system(只动注入)

import { describe, expect, test } from "bun:test";
import { Agent } from "../src/agent.ts";
import { mountBuiltinTools } from "../src/extension/builtin.ts";
import type { Context } from "../src/messages.ts";
import type { StreamFn } from "../src/provider/types.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn, toolTurn } from "../src/testing.ts";
import { assembleSystem } from "../src/prompt/assemble.ts";
import { sectionFromMarkdown } from "../src/prompt/import.ts";
import { fenceSafe } from "../src/prompt/sanitize.ts";
import type { PromptSection } from "../src/prompt/types.ts";
import { addSkills, activateSkill, deactivateSkill, type ActiveSkillMap, type SkillMap } from "../src/skill/harness.ts";
import { renderSkillCatalog, renderSkillInjections, SKILL_CATALOG_CAPS } from "../src/skill/compose.ts";
import { registerTool, toolSchemasOf, type ToolMap } from "../src/tools/harness.ts";
import { toolOk, type ModelTool } from "../src/tools/types.ts";

import type { Skill } from "../src/skill/types.ts";

function skill(name: string, description: string, content = "正文", modelInvocable = true): Skill {
  return { name, description, content, dir: `/skills/${name}`, files: [], requiredTools: [], modelInvocable, frontmatter: {} };
}

function attachedSkills(opts?: { skills?: Skill[]; hasActivateTool?: boolean }): { skills: SkillMap; active: ActiveSkillMap } {
  const skills: SkillMap = new Map();
  if (opts?.skills !== undefined && opts.skills.length > 0) addSkills(skills, opts.skills);
  return { skills, active: new Map() };
}

function fakeTool(name: string): ModelTool {
  return { kind: "model", name, label: name, description: `${name} 工具`, parameters: { type: "object" }, execute: async () => toolOk("") };
}

/* ───────────────────────── ① 装配 ───────────────────────── */

describe("assembleSystem", () => {
  test("stable 在前 volatile 沉底;空段丢弃;全空返回 null", async () => {
    const sections: PromptSection[] = [
      { name: "v", tier: "volatile", render: () => "V" },
      { name: "s1", tier: "stable", render: () => "S1" },
      { name: "empty", tier: "stable", render: () => "" },
      { name: "s2", tier: "stable", render: () => "S2" },
    ];
    expect(await assembleSystem(sections)).toBe("S1\n\nS2\n\nV");
    expect(await assembleSystem([{ name: "e", tier: "stable", render: () => "  " }])).toBeNull();
  });

  test("坏段隐形不击穿,onFailure 留痕", async () => {
    const failures: string[] = [];
    const sections: PromptSection[] = [
      { name: "boom", tier: "stable", render: () => { throw new Error("段坏了"); } },
      { name: "ok", tier: "stable", render: () => "OK" },
    ];
    const out = await assembleSystem(sections, (f) => failures.push(f.section));
    expect(out).toBe("OK");
    expect(failures).toEqual(["boom"]);
  });
});

/* ───────────────────────── ② PromptSource:skill 目录 + tools 确定性 ───────────────────────── */

describe("skill 目录段", () => {
  test("池空 → 不出段（门控「有没有 skill_activate 工具」在 Agent 那一层）", () => {
    expect(renderSkillCatalog(new Map())).toBe("");
  });

  test("只列 modelInvocable;描述单行化 + 单条截断", () => {
    const h = attachedSkills({
      skills: [skill("a", "第一行\n第二行"), skill("hidden", "看不见", "正文", false), skill("b", "x".repeat(2000))],
    });
    const out = renderSkillCatalog(h.skills);
    expect(out).toContain("- a:第一行 第二行"); // 换行折叠
    expect(out).not.toContain("hidden");
    expect(out).toContain("…[截断]"); // descriptionMax=1024
    expect(SKILL_CATALOG_CAPS.descriptionMax).toBe(1024);
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

/* ───────────────────────── ③ 通道 B:激活正文注入 ───────────────────────── */

describe("renderSkillInjections", () => {
  test("激活出注入(带起止标记),停用即消失;instructions 单行化;反引号中和", () => {
    const skills = attachedSkills({ skills: [skill("h5", "做 H5 页", "步骤:\n```html\n<div>\n```")] });
    expect(renderSkillInjections(skills.skills, skills.active)).toEqual([]);

    activateSkill(skills.skills, skills.active, "h5", { instructions: "这次做\n落地页" });
    const [msg] = renderSkillInjections(skills.skills, skills.active);
    expect(msg?.role).toBe("environment");
    const text = (msg as { content: { type: string; text: string }[] }).content[0]?.text ?? "";
    expect(text).toContain("# skill · h5(扩展指令 · 起)");
    expect(text).toContain("# skill · h5(扩展指令 · 止)");
    expect(text).toContain("本次要求:这次做 落地页"); // 换行折叠
    expect(text).not.toContain("```"); // 围栏被中和
    expect(fenceSafe("```")).toBe("ˋˋˋ");

    deactivateSkill(skills.active, "h5");
    expect(renderSkillInjections(skills.skills, skills.active)).toEqual([]);
  });
});

/* ───────────────────────── ④ 导入 ───────────────────────── */

describe("sectionFromMarkdown", () => {
  test("frontmatter 定 name/tier;正文原样;tier 缺省 stable", () => {
    const s = sectionFromMarkdown("---\nname: policy\ntier: volatile\n---\n\n规矩第一条。");
    expect(s.name).toBe("policy");
    expect(s.tier).toBe("volatile");
    expect(s.render()).toBe("规矩第一条。");
    expect(sectionFromMarkdown("裸正文", "from-file").tier).toBe("stable");
    expect(sectionFromMarkdown("裸正文", "from-file").name).toBe("from-file");
  });

  test("没名字与坏 tier 都 fail-loud", () => {
    expect(() => sectionFromMarkdown("裸正文")).toThrow("缺名字");
    expect(() => sectionFromMarkdown("---\nname: x\ntier: daily\n---\n正文")).toThrow("tier");
  });
});

/* ───────────────────────── ⑤ Agent 接线与缓存语义 ───────────────────────── */

describe("Agent 接线", () => {
  test("目录进 system;激活后下一轮注入可见、system 逐字节不变(激活不打缓存)", async () => {
    const seen: Context[] = [];
    const inner = scriptedStreamFn([
      toolTurn("t1", "skill_activate", { name: "h5", instructions: "做落地页" }),
      textTurn("做完了"),
    ]);
    const spy: StreamFn = (m, c, o) => {
      seen.push(structuredClone(c));
      return inner(m, c, o);
    };
    const agent = new Agent({
      model: FAKE_MODEL,
      streamFunction: spy,
      systemPrompt: "你是测试员",
      skills: [skill("h5", "做 H5 页", "用单文件写")],
    });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    // 构造时给了 skills，Agent 自己就把那两件工具装上了（2026-08-23 拍板），不用再注册

    await agent.prompt("做个 H5");
    // 第 1 轮:目录在 system,还没有注入
    expect(seen[0]?.systemPrompt).toContain("- h5:做 H5 页");
    expect(JSON.stringify(seen[0]?.messages)).not.toContain("扩展指令");
    // 第 2 轮:激活生效,注入出现在消息里(投影成 user 角色)
    const lastMsg = JSON.stringify(seen[1]?.messages);
    expect(lastMsg).toContain("扩展指令 · 起");
    expect(lastMsg).toContain("用单文件写");
    // system 逐字节不变——激活 skill 不打 system 缓存
    expect(seen[1]?.systemPrompt).toBe(seen[0]?.systemPrompt ?? "");
    // 注入不进 transcript
    expect(JSON.stringify(agent.messages)).not.toContain("扩展指令");
  });

  test("任务清单每轮注入(§5D.7):空清单不占位、建完下一轮就可见、不打 system 缓存、不进 transcript", async () => {
    const seen: Context[] = [];
    const inner = scriptedStreamFn([
      toolTurn("t1", "TaskCreate", { tasks: [{ title: "把 M6 做完" }, { title: "已经做完的", status: "done" }] }),
      textTurn("建好了"),
    ]);
    const spy: StreamFn = (m, c, o) => {
      seen.push(structuredClone(c));
      return inner(m, c, o);
    };
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy, systemPrompt: "你是测试员" });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册

    await agent.prompt("规划一下");

    // 第 1 轮:清单是空的,**一个字都不注入**——别拿「（清单是空的）」占每轮的位置
    expect(JSON.stringify(seen[0]?.messages)).not.toContain("任务清单");
    // 第 2 轮:模型自己建的任务,同一个 run 里下一轮就看得见(所以它必须每轮重算)。
    // **判据只看注入那一条**(拼在最末尾):整个 messages 里搜是抓不准的——
    // TaskCreate 的回执本来就把两条都列了,那不是注入。
    const injected = JSON.stringify(seen[1]?.messages.at(-1));
    expect(injected, "建完的任务没进下一轮的 context").toContain("任务清单");
    expect(injected).toContain("把 M6 做完");
    // 只出 ready + active:done 的不重复喂(要看全量模型自己 TaskList)
    expect(injected, "done 的任务也被喂进去了").not.toContain("已经做完的");
    // 走 turnInjection 而非 system 段:system 逐字节不变,清单变动不打 prompt cache
    expect(seen[1]?.systemPrompt).toBe(seen[0]?.systemPrompt ?? "");
    expect(seen[1]?.systemPrompt ?? "", "清单跑到 system 里去了").not.toContain("任务清单");
    // 注入不进 transcript
    expect(JSON.stringify(agent.messages)).not.toContain("任务清单");
  });

  test("产品加段:import 的 md 段进 system;identity 在最前", async () => {
    const seen: Context[] = [];
    const inner = scriptedStreamFn([textTurn("好")]);
    const spy: StreamFn = (m, c, o) => {
      seen.push(structuredClone(c));
      return inner(m, c, o);
    };
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy, systemPrompt: "身份在前" });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    agent.promptSections = [...agent.promptSections, sectionFromMarkdown("---\nname: policy\n---\n公司规矩段")];
    await agent.prompt("hi");
    const sys = seen[0]?.systemPrompt ?? "";
    expect(sys.startsWith("身份在前")).toBe(true);
    expect(sys).toContain("公司规矩段");
  });

  test("产品经 promptSources 供货，段进 system", async () => {
    const seen: Context[] = [];
    const inner = scriptedStreamFn([textTurn("好")]);
    const spy: StreamFn = (m, c, o) => {
      seen.push(structuredClone(c));
      return inner(m, c, o);
    };
    // 产品自己的 prompt 供货方经 `promptSources` 显式给——不再靠「实现了某接口就自动参与」
    // 的鸭子判定（那要求挂件先是个 harness，而 harness 这个概念已经没了）。
    const custom = {
      promptSections: (): PromptSection[] => [{ name: "acme", tier: "stable", render: () => "ACME 段" }],
    };
    const agent = new Agent({ model: FAKE_MODEL, streamFunction: spy, promptSources: [custom] });
    await mountBuiltinTools(agent); // 内建工具经 `echo:*` builtin Extension 注册
    await agent.prompt("hi");
    expect(seen[0]?.systemPrompt).toContain("ACME 段");
  });
});
