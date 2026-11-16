// 权限：echo-coding 这一头只剩**内容**——缺省规则表里点哪几件工具、交给安全分类器的名单里补哪几件。
//
// 机制都不在这里（2026-11-15）：
//   · 规则表怎么判（allow / deny / ask、表里没有的走 fallback、有没有人答）是内核的：`@echo-agent/core` 的
//     `PermissionRules` 与 `permissionPolicyFromRules()`；
//   · 「越出沙箱从不悄悄放行」跟着 bash 走：`@echo-agent/tools` 的 `askOutsideSandbox()`；
//   · 安全分类器是内核的（`createEcho({ safetyClassifier })`），文件 / shell / web 工具的免判名单与 bash 的说明
//     跟着工具走（`TOOLS_SAFE_TOOLS` / `SHELL_CLASSIFIER_NOTES`）。
//
// 规则在构造期交给 Agent（`permissionPolicyFor()` → `createEcho({ agent: { permission } })`），跑在固定 stage：
// transform hooks → 重新校验 → freeze → authorization → execute。裁决看到的是冻结后的最终参数，
// 人批准的和工具执行的是同一份；hook 在它之后改不了参数。裁决人归壳（终端里摆问题、收 y/n），不在这一层。

import { permissionPolicyFromRules, type PermissionPolicy, type PermissionRules } from "@echo-agent/core";
import { TOOLS_SAFE_TOOLS, askOutsideSandbox } from "@echo-agent/tools";

/**
 * `codingPreset()` 的缺省规则表：读随便；**bash / write_file / edit_file 先问**，其余放行——与 Claude Code 的缺省一个精神。
 *
 * **适用范围**：只在嵌入方调 `codingPreset()` 而不传 `permission` 时生效（评测、别的宿主）。出厂的 `echo-coding`
 * 命令不用它（理由写在 `cli.ts` 文件头）。
 *
 * 这是一张黑名单而不是白名单（2026-09-09 拍板，`docs/decisions/implemented/2026-09-09-default-permission-blacklist.md`）：
 * 「其余」里也有动东西的，各有各的不问的理由——worktree_enter 开的是新分支与新目录，可逆；worktree_exit 的删除
 * 由 git 自己挡（有未提交改动就拒，分支保留）；web_fetch / web_search 出网不问（2026-09-03 拍板）；core 内建的
 * 记忆 / 任务 / 技能 / 闹钟写的是 agent 自己的状态，不是用户的世界。要更严的产品自己给 `rules`。
 * bash 不受工作区边界约束，它靠的正是这一条 ask。
 */
export const DEFAULT_PERMISSION: PermissionRules = {
  rules: { bash: "ask", write_file: "ask", edit_file: "ask" },
  fallback: "allow",
};

/**
 * echo-coding 交给安全分类器的免判名单（`SafetyClassifierOptions.safeTools`）：工具包那份，加上本产品自己的两件——
 * worktree（新分支新目录，可逆）。内核自己的工具由内核的名单管。
 */
export const CODING_SAFE_TOOLS: readonly string[] = Object.freeze([...TOOLS_SAFE_TOOLS, "worktree_enter", "worktree_exit"]);

/**
 * 规则表 → Agent 收的策略，外加「越出沙箱从不悄悄放行」：bash 带 `sandbox: false` 时，规则是 `allow` 也改成 `ask`。
 * 安全分类器开着时出厂产品不装这份策略（越界那一条由分类器判，`cli.ts`）；关着时就靠它让人看一眼。
 */
export function permissionPolicyFor(table: PermissionRules = DEFAULT_PERMISSION): PermissionPolicy {
  return askOutsideSandbox(permissionPolicyFromRules(table));
}
