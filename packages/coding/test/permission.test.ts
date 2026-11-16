// echo-coding 自己的权限规则：三档（allow / deny / ask）与「越出沙箱从不悄悄放行」，以及交给内核安全分类器的那份形状
// （自己哪些工具不用判、bash 的 sandbox: false 是什么意思）。分类器本身的判据在 core 的 safety-classifier.test.ts。

import { expect, test } from "bun:test";
import type { PermissionPolicyInput } from "@echo-agent/core";
import { CODING_CLASSIFIER_NOTES, CODING_SAFE_TOOLS, DEFAULT_PERMISSION, permissionPolicyFor, type PermissionPolicy } from "../src/permission.ts";
import { makeFsTools, makeSearchTools } from "@echo-agent/tools";

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
const authorize = (policy: PermissionPolicy, toolName: string, params: unknown = {}) => Promise.resolve(permissionPolicyFor(policy).authorize(input(toolName, params)));

test("三档：DEFAULT_PERMISSION 下 bash / write_file / edit_file 问人，其余放行；deny 照拒", async () => {
  for (const n of ["bash", "write_file", "edit_file"]) expect((await authorize(DEFAULT_PERMISSION, n)).kind).toBe("ask");
  expect((await authorize(DEFAULT_PERMISSION, "read_file")).kind).toBe("allow");
  expect((await authorize({ rules: { bash: "deny" } }, "bash")).kind).toBe("deny");
});

test("越出沙箱从不悄悄放行：规则是 allow 时 bash 带 sandbox: false 改问人，不带的照放", async () => {
  const open: PermissionPolicy = { fallback: "allow", responder: "host" };
  expect(await authorize(open, "bash", { command: "ls" })).toEqual({ kind: "allow" });
  const escaped = await authorize(open, "bash", { command: "npm i -g x", sandbox: false });
  expect([escaped.kind, escaped.kind === "ask" && escaped.reason.includes("outside the sandbox")]).toEqual(["ask", true]);
});

test("交给安全分类器的形状：只读与工作区内的文件工具都在免判名单里，bash 与 web_fetch 不在；说明讲清 sandbox: false", () => {
  for (const t of [...makeFsTools(), ...makeSearchTools()]) expect([t.name, CODING_SAFE_TOOLS.includes(t.name)]).toEqual([t.name, true]);
  expect(CODING_SAFE_TOOLS).not.toContain("bash");
  expect(CODING_SAFE_TOOLS).not.toContain("web_fetch");
  expect(CODING_CLASSIFIER_NOTES).toContain('"sandbox": false runs outside the sandbox');
});
