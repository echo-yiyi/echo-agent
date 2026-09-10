// agent 定义（角色）：文件形状、三处来源的优先级、挂上来之后是什么样。
// 决策见 docs/decisions/implemented/2026-09-07-role-agent.md，设计见 docs/design/sessions.md §4。

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { ExtensionHost } from "../src/extension/host.ts";
import { agentRegistries } from "../src/extension/registries.ts";
import { inlineAgentExtension, INLINE_AGENT_ENTRY } from "../src/agent-def/extension.ts";
import { loadAgentDefs, loadAgentDefsFromDir } from "../src/agent-def/loader.ts";
import { parseAgentFile, parseNameList } from "../src/agent-def/parse.ts";
import { PROMPT_ORDER } from "../src/prompt/types.ts";
import { registerTool } from "../src/tools/harness.ts";
import { toolOk, type AgentTool, type ModelTool } from "../src/tools/types.ts";
import { FAKE_MODEL, scriptedStreamFn, textTurn } from "../src/testing.ts";

function tool(name: string): ModelTool {
  return { kind: "model", name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => toolOk("ok") };
}

/* ─────────────── ① 文件形状 ─────────────── */

test("frontmatter 三项 + 正文即 identity;name 没写就用文件名", () => {
  const parsed = parseAgentFile(
    ["---", "description: 只读审查,不改代码", "tools: [read_file, grep]", "model: kimi-k3", "---", "你是代码审查员。"].join("\n"),
    "reviewer",
  );
  expect(parsed.name).toBe("reviewer");
  expect(parsed.definition).toEqual({
    identity: "你是代码审查员。",
    tools: ["read_file", "grep"],
    model: "kimi-k3",
    description: "只读审查,不改代码",
  });
});

test("frontmatter 的 name 盖过文件名", () => {
  const parsed = parseAgentFile(["---", "name: 审查员", "---", "正文"].join("\n"), "reviewer");
  expect(parsed.name).toBe("审查员");
});

test("列表语法只认方括号一种;引号与空格都吃掉,空列表是空数组", () => {
  expect(parseNameList("[a, b , c]")).toEqual(["a", "b", "c"]);
  expect(parseNameList('["a", \'b\']')).toEqual(["a", "b"]);
  expect(parseNameList("[]")).toEqual([]);
  expect(parseNameList("solo")).toEqual(["solo"]); // 不带方括号 = 单元素
});

test("三项全空判红:写了等于没写,不静默忽略——人放了个文件在那儿", () => {
  expect(() => parseAgentFile(["---", "description: 只有一句说明", "---", "   "].join("\n"), "empty")).toThrow(/全空/);
});

/* ─────────────── ② 三处来源的优先级 ─────────────── */

function seedDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "echo-agentdef-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("目录顺序就是优先级:先到的赢,后到的记一条诊断——一个重名不炸掉整批", async () => {
  const project = seedDir({ "reviewer.md": "---\n---\n项目里的审查员" });
  const user = seedDir({ "reviewer.md": "---\n---\n家目录的审查员", "planner.md": "---\n---\n规划者" });
  try {
    const loaded = await loadAgentDefs([project, user], [{ name: "reviewer", definition: { identity: "产品自带的" } }]);
    expect(loaded.defs.get("reviewer")?.identity).toBe("项目里的审查员");
    expect(loaded.defs.get("planner")?.identity).toBe("规划者"); // 家目录独有的照样进
    expect(loaded.diagnostics.map((d) => d.code)).toEqual(["agent_def_name_clash", "agent_def_name_clash"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test("坏文件跳过 + 诊断,同目录里好的照常加载;目录不存在 = 空结果不是错误", async () => {
  const dir = seedDir({ "good.md": "---\n---\n好的", "bad.md": "---\ndescription: 空壳\n---\n" });
  try {
    const one = await loadAgentDefsFromDir(dir);
    expect(one.files.map((f) => f.name)).toEqual(["good"]);
    expect(one.diagnostics[0]?.code).toBe("agent_def_bad");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const missing = await loadAgentDefsFromDir(join(tmpdir(), "echo-agentdef-nope-xyz"));
  expect(missing.files).toEqual([]);
  expect(missing.diagnostics).toEqual([]);
});

/* ─────────────── ③ 挂上来之后 ─────────────── */

function agentWithIdentity(): { agent: Agent; host: ExtensionHost } {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("好")]) });
  agent.promptSections.set("identity", { name: "identity", order: PROMPT_ORDER.identity, render: () => "产品的身份" });
  void registerTool(agent.tools, tool("read_file") as AgentTool);
  void registerTool(agent.tools, tool("shell") as AgentTool);
  const host = new ExtensionHost({
    services: agentRegistries({
      tools: agent.tools,
      toolRestrictions: agent.toolRestrictions,
      hooks: agent.hooks,
      prompt: { sections: agent.promptSections, variables: agent.promptVariables },
    }),
  });
  return { agent, host };
}

const mountDef = (host: ExtensionHost, gen: string, config: unknown): Promise<unknown> =>
  host.mount(gen, [{ entryId: INLINE_AGENT_ENTRY, definition: inlineAgentExtension() as never, config }]);

test("identity 被替换、工具收成子集;unmount 两样都复原", async () => {
  const { agent, host } = agentWithIdentity();
  await mountDef(host, "g1", { identity: "你是代码审查员。", tools: ["read_file"] });

  expect(agent.promptSections.get("identity")!.render({} as never)).toBe("你是代码审查员。");
  expect(agent.state.tools.map((t) => t.name)).toEqual(["read_file"]);

  await host.unmount("g1");
  expect(agent.promptSections.get("identity")!.render({} as never)).toBe("产品的身份");
  expect(agent.state.tools.map((t) => t.name).sort()).toEqual(["read_file", "shell"]);
});

test("只给一项时另一项不动:光换身份不动工具,光收工具不动身份", async () => {
  const { agent, host } = agentWithIdentity();
  await mountDef(host, "g1", { identity: "只换身份" });
  expect(agent.state.tools.length).toBe(2);
  await host.unmount("g1");

  await mountDef(host, "g2", { tools: ["shell"] });
  expect(agent.promptSections.get("identity")!.render({} as never)).toBe("产品的身份");
  expect(agent.state.tools.map((t) => t.name)).toEqual(["shell"]);
  await host.unmount("g2");
});

test("产品没有 identity 段时判红——悄悄多出一段和替换是两件事", async () => {
  const agent = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("好")]) });
  const host = new ExtensionHost({
    services: agentRegistries({
      tools: agent.tools,
      toolRestrictions: agent.toolRestrictions,
      hooks: agent.hooks,
      prompt: { sections: agent.promptSections, variables: agent.promptVariables },
    }),
  });
  await expect(mountDef(host, "g1", { identity: "替不上去" })).rejects.toThrow(/不存在/);
});

test("空定义不占 effect 位:挂它等于不挂", async () => {
  const { agent, host } = agentWithIdentity();
  await mountDef(host, "g1", {});
  expect(agent.promptSections.get("identity")!.render({} as never)).toBe("产品的身份");
  expect(agent.state.tools.length).toBe(2);
  await host.unmount("g1");
});
