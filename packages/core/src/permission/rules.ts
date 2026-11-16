// 按工具名的规则表：最常见的那种权限策略——每件工具放行、拒、还是问人。
//
// 它是内核的（2026-11-15）：表里没有一行是哪个产品才有的知识，任何产品想要「某件工具先问」都是这一张表。
// 产品只交自己的内容——哪件工具哪一档（`rules`）、表里没有的走哪一档（`fallback`）、有没有人答（`responder`）。
// 要按参数判（不只按工具名）的策略不走这张表，自己写 `PermissionPolicy.authorize`；也可以包在这张表外面再加一条。
//
// 规则表判完放行之后要不要再过安全分类器，不在这里——那是另一个开关（`createEcho({ safetyClassifier })`）。

import type { PermissionPolicy } from "./types.ts";

/** 一件工具的规则：`allow` 放行、`deny` 拒、`ask` 问裁决人。 */
export type PermissionRule = "allow" | "deny" | "ask";

/** 按工具名的规则表，交给 {@link permissionPolicyFromRules} 换成 Agent 收的策略。 */
export type PermissionRules = Readonly<{
  /** 按工具名给规则。 */
  rules?: Readonly<Record<string, PermissionRule>>;
  /** 表里没有的工具走这档，缺省 `"allow"`。 */
  fallback?: PermissionRule;
  /**
   * `ask` 有没有人答。
   *
   * - `"host"`：宿主会答（交互式壳在界面里摆出来问）。
   * - `"none"`（缺省）：**没人答，`ask` 直接折成拒**。管道形态、CI 与评测都是这一档。
   *
   * 缺省选 `none` 是因为猜错的代价不对称：以为有人答而其实没有，工具永远挂着等；
   * 以为没人答而其实有，用户看到一次多余的拒绝，重跑即可。
   */
  responder?: "host" | "none";
}>;

/**
 * 规则表 → Agent 构造期收的策略（`createEcho({ agent: { permission } })`）。
 *
 * `ask` 不超时（等人）；没有裁决人时（`responder: "none"`）Agent 在授权 stage 把 `ask` 当作策略拒绝封口，不生成 ask、不等人。
 */
export function permissionPolicyFromRules(table: PermissionRules): PermissionPolicy {
  return {
    authorize: ({ toolName }) => {
      const rule = table.rules?.[toolName] ?? table.fallback ?? "allow";
      if (rule === "deny") return { kind: "deny", reason: `Tool '${toolName}' was denied by the permission policy` };
      if (rule === "ask") return { kind: "ask", reason: `Tool '${toolName}' was not authorized: it needs approval from a responder` };
      return { kind: "allow" };
    },
    askTimeoutMs: null,
    responder: table.responder ?? "none",
  };
}
