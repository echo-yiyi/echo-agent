// 第二个样例：**自带工具 + 自带 provider，零凭据也能跑**。
//
// 跑：
//   bun install
//   bun index.ts
//
// 两件事在这里看得最清楚：
//   ① **工具是一等公民**——`kind: "model"` 的工具直接进模型的工具面，`execute` 就是它的实现；
//   ② **provider 是可替换的端口**——这里用一段写死的脚本冒充模型，所以不需要任何 key。
//      真接模型时把 `scripted()` 换成 `kimiProvider()` 即可，其余一行不改（见隔壁 hello 样例）。
//
// 也正因为它不需要凭据，仓库的分发门会**真的把它跑一遍**：
// `test/distribution-gate.test.ts` 装上 tarball 之后执行本文件并检查输出。

import {
  createEcho,
  createProvider,
  createProviderStreams,
  toolOk,
  type Context,
  type Model,
  type ModelTool,
  type ProviderEvent,
} from "@echo-agent/core";

/** 一个真工具：模型说要用它，Agent 就会真的调这个函数。 */
const nowTool: ModelTool = {
  kind: "model",
  name: "current_year",
  label: "取年份",
  description: "返回当前年份",
  parameters: { type: "object", properties: {} },
  execute: async () => toolOk("2026"),
};

/** 写死两轮的假 provider：先要工具，再说结论。真接模型时换成 `kimiProvider()`。 */
function scripted() {
  const turns: ProviderEvent[][] = [
    [
      { type: "start" },
      { type: "toolcall_start", toolCallId: "c1", name: "current_year" },
      { type: "toolcall_delta", argsText: "{}" },
      { type: "toolcall_end" },
      {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "current_year", input: {} }],
          stopReason: "tool_use",
          usage: null,
        },
      },
    ],
    [
      { type: "start" },
      { type: "text_start" },
      { type: "text_delta", text: "今年是 2026 年。" },
      { type: "text_end" },
      {
        type: "done",
        message: { role: "assistant", content: [{ type: "text", text: "今年是 2026 年。" }], stopReason: "end_turn", usage: null },
      },
    ],
  ];
  let i = 0;
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "no-key-needed" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "scripted" }],
    api: createProviderStreams({
      api: "scripted",
      async *request(_model: Model, _context: Context): AsyncGenerator<ProviderEvent> {
        for (const ev of turns[i++] ?? []) yield ev;
      },
    }),
  });
}

const echo = await createEcho({
  provider: scripted(),
  allowNetwork: false, // 假 provider 没有目录可刷
  stateDir: ".echo/scripted-example",
  extensionDirs: [], // 样例自带工具，不扫盘——免得跑它的目录里碰巧有 extensions/
  // `agent.tools` 在 `createEcho()` 这一层会被转成一条 **inline Extension**（`echo:inline-tools`）：
  // 调用方照旧一行传工具，但工具进的是**和内建、和第三方同一本所有权账本**——
  // 它出现在 `echo.extensions` 里，收摊时跟着下线。低层 `new Agent({ tools })` 不受影响。
  agent: { tools: [nowTool] },
});

const agent = echo.agent;
await agent.start();
try {
  const result = await agent.prompt("今年是哪一年？用工具查。");
  // 打出**工具真正返回的内容**，不是「有没有一条 toolResult」——工具不存在时也会有一条
  // toolResult（内容是「没这个工具」）。分不清这两者，判据就等于没有。
  const toolResults = agent.messages.filter((m) => m.role === "toolResult");
  console.log(
    JSON.stringify({
      outcome: result.outcome.kind,
      toolOutput: toolResults.map((m) => JSON.stringify(m.content)).join(" | "),
      toolErrored: toolResults.some((m) => m.isError === true),
    }),
  );
} finally {
  await echo.stop();
}
