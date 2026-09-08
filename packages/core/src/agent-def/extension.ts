// `echo:inline-agent` —— 一份 agent 定义挂上来之后长什么样。
//
// **走已有先例**（`echo:inline-tools`，`create-echo.ts`）：定义是数据，mount 时变成一条
// Extension。于是角色和别的扩展长在同一套机制上——同一个 ExtensionHost、同一份所有权账本，
// 卸载时按注册的逆序复原。不另立 `AgentTemplate` 那种与 extension 并行的第二套注册机制。
//
// **这里只做两项**：identity（替产品那一段）与 tools（收紧工作集）。第三项 `model` 归装配层
// （`createEcho`）——角色写的是模型 **id**，而 `AgentRuntime.setModel()` 要的是 `Model` 对象，
// 按 id 查目录的能力只有装配层有。为它在 ABI 上开一条「查模型」的 Service 是扩公共面，
// 而模型缺省本来就是装配期的事，不必绕这一圈。

import { defineExtension, type ExtensionDefinition } from "../extension/abi.ts";
import { AgentPrompt, AgentTools } from "../extension/registries.ts";
import { PROMPT_ORDER } from "../prompt/types.ts";
import type { AgentDefinition } from "./types.ts";

export const INLINE_AGENT_ENTRY = "echo:inline-agent";

/**
 * 造那条 Extension。config 就是定义本身。
 *
 * **identity 用受控 replace**：同名必须已存在——产品没有 identity 段时角色替不上去，
 * 这时 mount 判红。那是对的：角色的正文是「你是谁」，产品连身份段都没有的话，
 * 悄悄多出一段和替换是两件事，人看到的却都是「角色生效了」。
 */
export function inlineAgentExtension(): ExtensionDefinition<AgentDefinition> {
  return defineExtension<AgentDefinition>({
    name: INLINE_AGENT_ENTRY,
    hostAbiVersion: 1,
    // `agent`：角色是这一段 session 的身份，不该在轮中途被换掉
    reload: "agent",
    inject: {
      prompt: { service: AgentPrompt, required: true },
      tools: { service: AgentTools, required: true },
    },
    config: (input: unknown): AgentDefinition => {
      const d = (input ?? {}) as AgentDefinition;
      if (d.identity !== undefined && typeof d.identity !== "string") throw new Error(`${INLINE_AGENT_ENTRY} 的 identity 必须是字符串`);
      if (d.tools !== undefined && !Array.isArray(d.tools)) throw new Error(`${INLINE_AGENT_ENTRY} 的 tools 必须是名字数组`);
      return d;
    },
    apply(ctx, config) {
      if (config.identity === undefined && config.tools === undefined) return; // 没什么可改的，不占 Fiber 的 effect 位
      const prompt = ctx.get(AgentPrompt);
      const tools = ctx.get(AgentTools);
      void ctx.effect({
        boundary: "agent",
        start: () => {
          const offs: (() => void)[] = [];
          try {
            if (config.identity !== undefined) {
              const body = config.identity;
              offs.push(prompt.section({ name: "identity", order: PROMPT_ORDER.identity, render: () => body }, { replace: true }));
            }
            if (config.tools !== undefined) offs.push(tools.restrict(new Set(config.tools)));
          } catch (e) {
            // **全有或全无**：identity 换上了但 restrict 抛了的话，registry 必须回到调用前的样子
            for (let i = offs.length - 1; i >= 0; i--) offs[i]!();
            throw e;
          }
          return {
            value: offs.length,
            dispose: () => {
              for (let i = offs.length - 1; i >= 0; i--) offs[i]!();
            },
          };
        },
      });
    },
  });
}
