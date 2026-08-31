// 发现规则②：`<dir>/<sub>/index.ts` —— 子目录的入口文件也算一个 Extension（只找一层）。

import { defineExtension, AgentTools } from "../../../../src/extension/public.ts";
import { toolOk, type ModelTool } from "../../../../src/tools/types.ts";

const tool: ModelTool = {
  kind: "model",
  name: "fixture_nested",
  label: "子目录工具",
  description: "证明子目录入口也被发现",
  parameters: { type: "object", properties: {} },
  execute: async () => toolOk("nested"),
};

export default defineExtension({
  name: "nested",
  hostAbiVersion: 1,
  inject: { tools: { service: AgentTools, required: true } },
  apply(ctx) {
    const tools = ctx.get(AgentTools);
    void ctx.effect({ boundary: "turn", start: () => ({ value: tool.name, dispose: tools.register(tool) }) });
  },
});
