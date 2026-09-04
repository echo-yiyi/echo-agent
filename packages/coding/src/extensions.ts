// coding agent 自己那几件工具的 Extension 形态（`docs/design/AGENT-CORE.md` §14 owner 表里的
// `echo:workspace` 与 `echo:shell`）。
//
// **为什么不是直接 `registerTool()`**（2026-08-31 用户拍板：「机制必须同一份，都要走 extension」）：
// 直调那条路没有 owner——装上去的工具没人持 disposer，卸不掉、也不出现在能力清单里。
// 走 Extension 之后，产品层的工具与内建、与第三方**同一个 `AgentTools.register`、同一份所有权账本**，
// 并且规格明写 first-party Extension「是公开扩展面是否够用的第一个 conformance consumer」——
// 我们自己先用一遍，扩展作者才不会撞上只有他们能看见的坑。
//
// **`defineToolPack` 来自 `@echo-agent/core/extension`，不在这里另抄一份**（review 二轮 P1）：
// 上一版这里复制了 core 的实现，于是「注册中途撞名要整组回滚」那个修复得改两处——
// 复制一份实现就是复制一份将来会漏修的地方。

import { AgentBackgroundService, AgentPrompt, AgentRuntimeService, AgentTools, defineExtension, defineToolPack } from "@echo-agent/core/extension";
import { makeShellTools } from "./tools/bash.ts";
import { makeWorktreeTools } from "./tools/worktree.ts";
import { shellToolsSection } from "./prompt.ts";

/** 工作区读写与搜索：`read_file` / `write_file` / `edit_file` / `glob` / `grep` / `list_dir`。 */
export const ECHO_WORKSPACE = defineToolPack("echo:workspace");

/** 取网页：`web_fetch`（延迟工具）。纯函数造的工具，config 进来即可。 */
export const ECHO_WEB = defineToolPack("echo:web");

/**
 * worktree 隔离：`worktree_enter` / `worktree_exit`（2026-09-03 用户拍板 B）。
 * 与 `echo:shell` 同一个理由不用 `defineToolPack`：工具要 `AgentRuntime.setWorkspace`，那是 Agent 上的东西，
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
      start: () => {
        const offs: (() => unknown)[] = [];
        try {
          for (const tool of tools) offs.push(registry.register(tool));
        } catch (e) {
          for (const off of offs.reverse()) void off();
          throw e;
        }
        return {
          value: tools.map((t) => t.name),
          dispose: () => {
            for (const off of offs.reverse()) void off();
          },
        };
      },
    });
  },
});

/**
 * 受权限管控的命令执行：`bash`。
 *
 * **它不用 `defineToolPack`，因为工具造不出来**：bash 要 `agent.background` 才支持
 * `background: true`，而那是 Agent 实例上的东西——装配层在调 `createEcho()` 之前拿不到它。
 * 上一版的做法是产品层自己 `new Agent()` 再自己 mount，也就是**第二个装配现场**。
 *
 * 现在换成从 `ctx` 拿：core 2026-08-31 把后台队列做成能力端口
 * （`AgentBackgroundService`，见 `extension/registries.ts` 文件头）。于是本扩展变成
 * 纯静态的一条 definition，装配层只管把它列进 `createEcho({ extensions })`。
 *
 * **`required: true`，不是 optional**（2026-08-31 review 三轮 P1 修正）：上一版写的是
 * `required: false`，理由是「没接后台队列照样能跑命令」——听起来合理，**但 ABI 里根本没有
 * 读 optional 的方法**：`ctx.get()` 遇到没有 provider 的 optional 依赖直接抛
 * （`fiber.ts` 的「optional 依赖 '…' 当前没有 provider」），扩展也无从先问一句「有没有」。
 * 于是那个声明不是「优雅降级」，是**装不上**——review 实测复现。
 *
 * 改 required 之后语义反而更准：`agent.background` 是 **Agent 恒有的能力**
 * （构造函数无条件造），所以任何由 Agent 造出来的 registries 都提供得了它。
 * 走 `createEcho()` 恒有；自己搭 Host 而不传 `background` 就装不上本扩展，
 * 报错明确指向缺的那条 Service——比装上一个「bash 在但后台不灵」的半残工具好。
 *
 * （`makeBashTool()` 的 `deps.background` 仍是可选：那是给「自己给端口、自己注册」的
 * 低层 `new Agent()` 用的，与本扩展的装配前提是两件事。）
 */
export const ECHO_SHELL = defineExtension({
  name: "echo:shell",
  hostAbiVersion: 1,
  inject: {
    tools: { service: AgentTools, required: true },
    background: { service: AgentBackgroundService, required: true },
    prompt: { service: AgentPrompt, required: true },
  },
  apply(ctx) {
    const registry = ctx.get(AgentTools);
    const prompt = ctx.get(AgentPrompt);
    // bash + job_output / job_stop：同一张后台任务表（`agent.background`），一起装、一起撤
    const tools = makeShellTools({ background: ctx.get(AgentBackgroundService) });
    void ctx.effect({
      // 与 `defineToolPack` 同一档：工具面每轮都可能变，声明得比实际需要强会挡住热重载
      boundary: "turn",
      start: () => {
        // 工具与它们的习惯段（`tool:shell`）同一个 effect：一起装、一起撤。
        // 中途撞名要把已注册的撤回去——半组工具在、半组不在，比整组不在更难排查
        const offs: (() => unknown)[] = [];
        try {
          for (const tool of tools) offs.push(registry.register(tool));
          offs.push(prompt.section(shellToolsSection()));
        } catch (e) {
          for (const off of offs.reverse()) void off();
          throw e;
        }
        return {
          value: tools.map((t) => t.name),
          dispose: () => {
            for (const off of offs.reverse()) void off();
          },
        };
      },
    });
  },
});
