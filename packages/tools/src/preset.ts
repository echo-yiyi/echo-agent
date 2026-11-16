// 产品挂这三组工具时要用到的共用件：三条 Extension 的条目、交给安全分类器的形状、「越出沙箱必须问人」那一条。
//
// 它们跟着工具走，不跟着哪个产品走——每个挂 bash 的产品都得回答同样的三个问题：哪些工具不用过分类器、
// bash 的 `sandbox: false` 是什么意思、分类器关着时越出沙箱的那一条谁来看。答案只有一份，放在工具旁边。
// 开不开沙箱、开不开分类器、有没有人能答，仍是产品与使用者的决定，这里不替它们定。

import type { CredentialStore, PermissionPolicy } from "@echo-agent/core";
import type { ExtensionEntry } from "@echo-agent/core/extension";
import { ECHO_SHELL, ECHO_WEB, ECHO_WORKSPACE } from "./extensions.ts";
import { makeFsTools } from "./fs.ts";
import { workspaceToolsSection } from "./prompt.ts";
import { makeSearchTools } from "./search.ts";
import { makeWebTools } from "./web.ts";

/** {@link toolsEntries} 的选项。 */
export type ToolsEntriesOptions = {
  /** bash 的命令包进操作系统沙箱跑（`sandbox.ts`）。缺省不开。 */
  sandbox?: boolean;
  /** `web_search` 读搜索服务 key 的第二来源（第一是环境变量）。不给 = 只认环境变量。 */
  credentials?: CredentialStore;
};

/**
 * 三条工具 Extension 的条目，顺序固定：`echo:workspace`、`echo:shell`、`echo:web`。产品展开进 `createEcho({ extensions })`。
 * 每次调用造一组新的工具对象（文件工具的「读过」记录、bash 的工作目录都跟着这一组走），所以一个 agent 调一次。
 */
export function toolsEntries(opts: ToolsEntriesOptions = {}): ExtensionEntry[] {
  return [
    // fs / search 的工具是纯函数造出来的，装配前就备好 → 走 `defineToolPack` 的 config；
    // 它们的跨调用习惯段跟工具同一个 config 进来：工具卸了段也走
    { entryId: "echo:workspace", definition: ECHO_WORKSPACE, config: { tools: [...makeFsTools(), ...makeSearchTools()], sections: [workspaceToolsSection()] } },
    // bash 要 `agent.background`，所以 `echo:shell` 自己 inject 那条能力端口并在 apply 里注册工具与段（见 `extensions.ts`）
    { entryId: "echo:shell", definition: ECHO_SHELL, ...(opts.sandbox === true ? { config: { sandbox: true } } : {}) },
    // 取网页 / 搜索：纯函数工具；延迟工具，经 tool_search 取过才上菜单
    { entryId: "echo:web", definition: ECHO_WEB, config: { tools: makeWebTools({ credentials: opts.credentials }) } },
  ];
}

/**
 * 这三组工具里不用过安全分类器的（交给内核的 `SafetyClassifierOptions.safeTools`）：只读的、只动工作区文件的
 * （文件工具有工作区边界）、后台作业的读与停。要判的是 `bash` 与 `web_fetch`——只有它们能把东西送出这台机器、碰到工作区外面。
 * 内核自己的工具由内核的名单管；产品另有自己的工具就接在这份后面。
 */
export const TOOLS_SAFE_TOOLS: readonly string[] = Object.freeze([
  "read_file", "list_dir", "glob", "grep", "web_search", "job_output", "job_stop",
  "write_file", "edit_file",
]);

/** 交给安全分类器的说明：bash 的 `sandbox: false` 是什么意思（`SafetyClassifierOptions.notes`）。模型逐字读，英文。 */
export const SHELL_CLASSIFIER_NOTES =
  'A bash action with "sandbox": false runs outside the sandbox that otherwise limits its writes to the workspace, temporary directories and caches, so nothing else contains it: judge it against the same list.';

/** 这一步是不是要在沙箱外跑命令（bash 带了 `sandbox: false`）。 */
function escapesSandbox(toolName: string, params: unknown): boolean {
  return toolName === "bash" && typeof params === "object" && params !== null && (params as { sandbox?: unknown }).sandbox === false;
}

/**
 * 给一份权限策略加上「越出沙箱从不悄悄放行」：策略放行的那一步如果是 bash 带 `sandbox: false`，改成问人。
 * 策略自己说拒或问的不动。安全分类器关着、沙箱开着时靠它让人看一眼越界的那一条；分类器开着时那一条由分类器判，用不着它。
 */
export function askOutsideSandbox(policy: PermissionPolicy): PermissionPolicy {
  return {
    ...policy,
    authorize: async (input) => {
      const verdict = await policy.authorize(input);
      return verdict.kind === "allow" && escapesSandbox(input.toolName, input.params)
        ? { kind: "ask", reason: "This bash command asks to run outside the sandbox: it needs approval from a person" }
        : verdict;
    },
  };
}
