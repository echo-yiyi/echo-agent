// 发现规则①：`<dir>/*.ts` 直接就是一个 Extension。往工具表里注册一件工具。
//
// 走**相对路径**引 ABI 而不是 `@echo-agent/core/extension`：这是包内 fixture，包内相对 import 才是对的
//（`test/package-boundary.test.ts` 只拦跨包的相对深 import）。样例里的写法见 `examples/extension/`。

import { defineExtension, AgentTools } from "../../../src/extension/public.ts";
import { toolOk, type ModelTool } from "../../../src/tools/types.ts";

const tool: ModelTool = {
  kind: "model",
  name: "fixture_year",
  label: "取年份",
  description: "返回年份",
  parameters: { type: "object", properties: {} },
  execute: async () => toolOk("2026"),
};

export default defineExtension({
  name: "adds-tool",
  hostAbiVersion: 1,
  inject: { tools: { service: AgentTools, required: true } },
  apply(ctx) {
    const tools = ctx.get(AgentTools);
    void ctx.effect({
      boundary: "turn",
      start: () => ({ value: tool.name, dispose: tools.register(tool) }),
    });
  },
});
