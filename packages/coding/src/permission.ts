// 权限：产品策略翻译成 core 的 authorization stage，不再是一条 preToolUse hook。
//
// 三档规则不变:allow(放行)/ deny(拒)/ ask(问裁决人)。规则在构造期交给 Agent
// （`permissionPolicyFor()` → `AgentOptions.permission`），跑在固定 stage：
// transform hooks → 重新校验 → freeze → authorization → execute。裁决看到的是冻结后的最终参数，
// 人批准的和工具执行的是同一份；hook 在它之后改不了参数。
//
// **裁决人不在这一层**（2026-08-31）：原先本文件还有个 `installPermission()`，
// 订阅 `permissionRequest` 去问一个回调、再 `answerPermission()`。那件事现在归**壳**——
// `@echo/tui` 的 `echo:tui` 已经在做（摆问题、收 y/n、答复、处理 `permissionCancelled`），
// 而仓库里从来没有调用方给过那个回调。两份实现只有一份被行使，删掉没被行使的那份。
// 于是本文件只剩「规则怎么判」，`responder` 只声明**有没有人会答**，不自己找人答。
//
// **没有裁决人时 ask 视为 deny**——诚实缺席:宁可拦下,不可因为没人问就默默放行。
// 这条由 `responder:"none"` 表达：core 在 authorize 阶段就把 ask 折成 policy deny，不生成 ask、不等人。

import type { PermissionPolicy as CorePermissionPolicy } from "@echo-agent/core";

export type PermissionRule = "allow" | "deny" | "ask";

export type PermissionPolicy = {
  /** 按工具名给规则。 */
  rules?: Record<string, PermissionRule>;
  /** 表里没有的工具走这档,缺省 "allow"。 */
  fallback?: PermissionRule;
  /**
   * ask 有没有人答。
   *
   * - `"host"`：宿主会答（交互式壳：`echo-agent` 在终端里摆出来问 y/n）。
   * - `"none"`（缺省）：**没人答，ask 直接折成 deny**。管道形态、CI 与评测都是这一档。
   *
   * 缺省选 `none` 是因为**猜错的代价不对称**：以为有人答而其实没有 → 工具永远挂着等；
   * 以为没人答而其实有 → 用户看到一次多余的拒绝，重跑即可。
   */
  responder?: "host" | "none";
};

/** 缺省策略:读随便,**动手的先问**。 */
export const DEFAULT_PERMISSION: PermissionPolicy = {
  rules: { bash: "ask", write_file: "ask", edit_file: "ask" },
  fallback: "allow",
};

/** 把产品策略翻译成 core 的 stage 策略——构造期交给 `new Agent({ permission })`。 */
export function permissionPolicyFor(policy: PermissionPolicy = DEFAULT_PERMISSION): CorePermissionPolicy {
  return {
    authorize: ({ toolName }) => {
      const rule = policy.rules?.[toolName] ?? policy.fallback ?? "allow";
      if (rule === "allow") return { kind: "allow" };
      if (rule === "deny") return { kind: "deny", reason: `Tool '${toolName}' was denied by the permission policy` };
      return { kind: "ask", reason: `Tool '${toolName}' was not authorized: it needs approval from a responder` };
    },
    // 交互 CLI 等人不超时；没有裁决人就是 none——core 会把 ask 折成 deny
    askTimeoutMs: null,
    responder: policy.responder ?? "none",
  };
}
