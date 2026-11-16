// echo-coding 这一头的权限内容：缺省规则表点了哪三件、它的策略带着「越出沙箱从不悄悄放行」、交给安全分类器的名单补了哪两件。
// 机制的判据不在这里：规则表在 core 的 permission-rules.test.ts，越出沙箱那一条与工具包的名单在 tools 的 preset.test.ts，
// 分类器在 core 的 safety-classifier.test.ts。

import { expect, test } from "bun:test";
import type { PermissionPolicyInput, PermissionRules } from "@echo-agent/core";
import { CODING_SAFE_TOOLS, DEFAULT_PERMISSION, permissionPolicyFor } from "../src/permission.ts";
import { TOOLS_SAFE_TOOLS } from "@echo-agent/tools";
import { makeWorktreeTools } from "../src/tools/worktree.ts";

const input = (toolName: string, params: unknown): PermissionPolicyInput => ({
  runId: "r",
  turnId: "t",
  toolCallId: "c",
  toolName,
  params,
  userIntent: [],
  askModel: async () => {
    throw new Error("产品的规则不该调模型");
  },
});
const authorize = (table: PermissionRules, toolName: string, params: unknown = {}) => Promise.resolve(permissionPolicyFor(table).authorize(input(toolName, params)));

test("三档：DEFAULT_PERMISSION 下 bash / write_file / edit_file 问人，其余放行；deny 照拒", async () => {
  for (const n of ["bash", "write_file", "edit_file"]) expect((await authorize(DEFAULT_PERMISSION, n)).kind).toBe("ask");
  expect((await authorize(DEFAULT_PERMISSION, "read_file")).kind).toBe("allow");
  expect((await authorize({ rules: { bash: "deny" } }, "bash")).kind).toBe("deny");
});

test("越出沙箱从不悄悄放行：规则是 allow 时 bash 带 sandbox: false 改问人，不带的照放", async () => {
  const open: PermissionRules = { fallback: "allow", responder: "host" };
  expect(await authorize(open, "bash", { command: "ls" })).toEqual({ kind: "allow" });
  const escaped = await authorize(open, "bash", { command: "npm i -g x", sandbox: false });
  expect([escaped.kind, escaped.kind === "ask" && escaped.reason.includes("outside the sandbox")]).toEqual(["ask", true]);
});

test("交给安全分类器的免判名单：工具包那份原样，加上本产品自己的 worktree 两件；bash 与 web_fetch 不在", () => {
  expect(CODING_SAFE_TOOLS).toEqual([...TOOLS_SAFE_TOOLS, ...makeWorktreeTools().map((t) => t.name)]);
  expect(CODING_SAFE_TOOLS).not.toContain("bash");
  expect(CODING_SAFE_TOOLS).not.toContain("web_fetch");
});
