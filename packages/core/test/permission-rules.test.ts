// 规则表（`permissionPolicyFromRules`）：按工具名三档，表里没有的走 fallback；没说有人答就是没人答。
// 它只换形状——ask 怎么等人、没人答怎么折成拒，判据在 permission.test.ts（授权 stage）。

import { expect, test } from "bun:test";
import { permissionPolicyFromRules, type PermissionRules } from "../src/permission/rules.ts";
import type { PermissionPolicyInput } from "../src/permission/types.ts";

const input = (toolName: string): PermissionPolicyInput => ({
  runId: "r",
  turnId: "t",
  toolCallId: "c",
  toolName,
  params: {},
  userIntent: [],
  askModel: async () => {
    throw new Error("规则表不该调模型");
  },
});
const verdict = (table: PermissionRules, toolName: string) => Promise.resolve(permissionPolicyFromRules(table).authorize(input(toolName)));

test("规则表三档：点名的工具照点名的走，allow 放行、deny 拒并说是策略拒的、ask 问人并说要裁决人", async () => {
  const table: PermissionRules = { rules: { a: "allow", d: "deny", q: "ask" } };
  expect(await verdict(table, "a")).toEqual({ kind: "allow" });
  expect(await verdict(table, "d")).toEqual({ kind: "deny", reason: "Tool 'd' was denied by the permission policy" });
  expect(await verdict(table, "q")).toEqual({ kind: "ask", reason: "Tool 'q' was not authorized: it needs approval from a responder" });
});

test("规则表里没有的工具走 fallback；fallback 不给就是放行", async () => {
  expect((await verdict({ rules: { a: "deny" } }, "other")).kind).toBe("allow");
  expect((await verdict({ rules: { a: "allow" }, fallback: "ask" }, "other")).kind).toBe("ask");
  expect((await verdict({ rules: { a: "allow" }, fallback: "ask" }, "a")).kind).toBe("allow");
  expect((await verdict({ fallback: "deny" }, "anything")).kind).toBe("deny");
  expect((await verdict({}, "anything")).kind).toBe("allow");
});

test("规则表换出来的策略：ask 等人不超时；没说有人答就是 none（Agent 把 ask 折成拒），说了 host 就是 host", () => {
  expect(permissionPolicyFromRules({})).toMatchObject({ askTimeoutMs: null, responder: "none" });
  expect(permissionPolicyFromRules({ responder: "host" }).responder).toBe("host");
});
