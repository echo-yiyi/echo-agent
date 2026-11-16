// coding agent 自己那一条工具 Extension：`echo:worktree`（git worktree 是编码才有的事）。
// 文件 / 搜索 / shell / web 那三条（`echo:workspace` / `echo:shell` / `echo:web`）不属于本产品，在 `@echo-agent/tools`，
// 本产品在 `codingPreset()` 里挂它们。
//
// **为什么不是直接 `registerTool()`**（2026-08-31 用户拍板：「机制必须同一份，都要走 extension」）：
// 直调那条路没有 owner——装上去的工具没人持 disposer，卸不掉、也不出现在能力清单里。
// 走 Extension 之后，产品层的工具与内建、与第三方**同一个 `AgentTools.register`、同一份所有权账本**。

import { AgentRuntimeService, AgentTools, defineExtension, registerAll } from "@echo-agent/core/extension";
import { makeWorktreeTools } from "./tools/worktree.ts";

/**
 * worktree 隔离：`worktree_enter` / `worktree_exit`（2026-09-03 用户拍板 B）。
 * 不用 `defineToolPack`：工具要 `AgentRuntime.setWorkspace`，那是 Agent 上的东西，
 * 装配前拿不到——从 `AgentRuntimeService` 注入（`echo:agent` 恒 provide，排在所有扩展之前）。
 */
export const ECHO_WORKTREE = defineExtension({
  name: "echo:worktree",
  hostAbiVersion: 1,
  inject: {
    tools: { service: AgentTools, required: true },
    runtime: { service: AgentRuntimeService, required: true },
  },
  apply(ctx) {
    const registry = ctx.get(AgentTools);
    const tools = makeWorktreeTools({ runtime: ctx.get(AgentRuntimeService) });
    void ctx.effect({
      boundary: "turn",
      // 中途撞名整组撤回、卸载逆序全撤：`registerAll`，与内建同一份
      start: () => registerAll(tools.map((tool) => () => registry.register(tool))),
    });
  },
});
