// 一个 Extension。**这个文件就是全部**——不用注册、不用改任何配置：
// 它躺在 `extensions/` 目录里，`createEcho()` 启动时会发现它、import 它、把它 mount 上去。
//
// 三条规矩（`@echo-agent/core/extension` 的 ABI）：
//   ① 默认导出必须是 `defineExtension({ … })` 的结果；
//   ② **模块求值阶段只许声明**，别在顶层起 timer / 连网络——那种副作用 Host 收不回来；
//   ③ 真正干活在 `apply()` 里，长期副作用一律经 `ctx.effect()` 交出 disposer，卸载时才有东西可卸。

import { defineExtension, AgentTools } from "@echo-agent/core/extension";
import { toolOk, type ModelTool } from "@echo-agent/core";

const currentYear: ModelTool = {
  kind: "model",
  name: "current_year",
  label: "取年份",
  description: "返回当前年份",
  parameters: { type: "object", properties: {} },
  execute: async () => toolOk("2026"),
};

export default defineExtension({
  name: "current-year",
  hostAbiVersion: 1,
  // 声明我要往工具表里注册东西。`ctx.get()` 只能拿这里声明过的 Service。
  inject: { tools: { service: AgentTools, required: true } },
  apply(ctx) {
    const tools = ctx.get(AgentTools);
    // `register()` 返回 disposer，交给 `ctx.effect()` 持有：Extension 卸载时工具自动下线。
    // 直接调 `register()` 而不交出 disposer，也能用——但那件事就没人收了。
    void ctx.effect({
      boundary: "turn",
      start: () => {
        const off = tools.register(currentYear);
        return { value: currentYear.name, dispose: off };
      },
    });
  },
});
