// 产品挂这三组工具的共用件：三条条目、交给安全分类器的形状、「越出沙箱必须问人」。
// 分类器本身的判据在 core 的 safety-classifier.test.ts；这里只验工具这一头交出去的东西对不对。

import { expect, test } from "bun:test";
import type { PermissionPolicy, PermissionPolicyInput } from "@echo-agent/core";
import { makeShellTools } from "../src/bash.ts";
import { makeFsTools } from "../src/fs.ts";
import { SHELL_CLASSIFIER_NOTES, TOOLS_SAFE_TOOLS, askOutsideSandbox, toolsEntries } from "../src/preset.ts";
import { makeSearchTools } from "../src/search.ts";
import { makeWebTools } from "../src/web.ts";

const input = (toolName: string, params: unknown): PermissionPolicyInput => ({
  runId: "r",
  turnId: "t",
  toolCallId: "c",
  toolName,
  params,
  userIntent: [],
  askModel: async () => {
    throw new Error("这一层不该调模型");
  },
});
const policy = (kind: "allow" | "deny" | "ask"): PermissionPolicy => ({
  authorize: () => (kind === "allow" ? { kind } : { kind, reason: `policy says ${kind}` }),
  askTimeoutMs: null,
  responder: "host",
});

test("toolsEntries：三条，顺序 echo:workspace / echo:shell / echo:web；sandbox: true 才给 echo:shell 配沙箱；每次调用是一组新的工具对象", () => {
  const plain = toolsEntries();
  expect(plain.map((e) => e.entryId)).toEqual(["echo:workspace", "echo:shell", "echo:web"]);
  expect(plain[1]!.config).toBeUndefined();
  expect(toolsEntries({ sandbox: true })[1]!.config).toEqual({ sandbox: true });
  const names = (e: (typeof plain)[number]) => (e.config as { tools: { name: string }[] }).tools.map((t) => t.name);
  expect(names(plain[0]!)).toEqual(["read_file", "write_file", "edit_file", "glob", "grep", "list_dir"]);
  expect(names(plain[2]!)).toEqual(["web_fetch", "web_search"]);
  // 文件工具的「读过」记录跟着这一组工具走：两次调用不能共用同一组对象
  const tools = (e: (typeof plain)[number]) => (e.config as { tools: object[] }).tools;
  expect(tools(toolsEntries()[0]!)[0]).not.toBe(tools(plain[0]!)[0]);
});

test("免判名单：只读的、只动工作区文件的、后台作业的读与停都在；能出这台机器的 bash 与 web_fetch 不在；名单里没有不存在的工具", () => {
  const all = [...makeFsTools(), ...makeSearchTools(), ...makeShellTools(), ...makeWebTools()].map((t) => t.name);
  for (const t of [...makeFsTools(), ...makeSearchTools()]) expect([t.name, TOOLS_SAFE_TOOLS.includes(t.name)]).toEqual([t.name, true]);
  for (const n of ["job_output", "job_stop", "web_search"]) expect([n, TOOLS_SAFE_TOOLS.includes(n)]).toEqual([n, true]);
  // 名单与真工具集对得上：免判的加上要判的两件，恰好是这个包的全部工具——加了新工具没归类就红
  expect([...TOOLS_SAFE_TOOLS, "bash", "web_fetch"].sort()).toEqual([...all].sort());
  expect(SHELL_CLASSIFIER_NOTES).toContain('"sandbox": false runs outside the sandbox');
});

test("askOutsideSandbox：策略放行的 bash 带 sandbox: false 改问人；不带的、别的工具照放；策略自己说拒或问的不动", async () => {
  const open = askOutsideSandbox(policy("allow"));
  expect(await open.authorize(input("bash", { command: "ls" }))).toEqual({ kind: "allow" });
  expect(await open.authorize(input("bash", { command: "ls", sandbox: true }))).toEqual({ kind: "allow" });
  expect(await open.authorize(input("read_file", { sandbox: false }))).toEqual({ kind: "allow" });
  const escaped = await open.authorize(input("bash", { command: "npm i -g x", sandbox: false }));
  expect([escaped.kind, escaped.kind === "ask" && escaped.reason.includes("outside the sandbox")]).toEqual(["ask", true]);
  // 拒的还是拒、问的还是原来那句问：不把策略自己的结论换掉
  expect(await askOutsideSandbox(policy("deny")).authorize(input("bash", { sandbox: false }))).toEqual({ kind: "deny", reason: "policy says deny" });
  expect(await askOutsideSandbox(policy("ask")).authorize(input("bash", { sandbox: false }))).toEqual({ kind: "ask", reason: "policy says ask" });
  // 等不等人、谁来答照原策略
  expect([open.askTimeoutMs, open.responder]).toEqual([null, "host"]);
});
