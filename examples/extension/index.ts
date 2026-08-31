// 第三个样例：**扩展自动发现**。零凭据可跑。
//
// 跑：
//   bun install
//   bun index.ts
//
// 和隔壁 scripted 样例比，差别只有一处：那边把工具写进 `createEcho({ agent: { tools } })`，
// 这边**一个工具都没传**——工具躺在 `extensions/current-year.ts` 里，`createEcho()` 自己发现并装上。
//
// 打印出来的 `extensions` 会有五条：**内建四条**（`echo:tasks` / `echo:skills` / `echo:memory` /
// `echo:scheduler`）在前，外部发现的 `current-year` 在后。内建也走同一套 extension 机制，
// 所以「这个 agent 会什么」在这份清单里是完整的，不是只列第三方。
// 换句话说：往 `extensions/` 里丢一个文件，agent 下次启动就多一件能力，主程序一行不改。
//
// `createEcho()` 是唯一的装配现场（composition root）：它 = 装配 Agent + 扫 `extensions/` + mount。
// 缺省扫 `<cwd>/extensions`；这里显式写出来是为了让样例在任何工作目录下都跑得一样。
//
// 仓库的分发门会装上 tarball 之后**真的执行本文件**并检查输出
// （`test/distribution-gate.test.ts`）——所以它同时证明了 `@echo-agent/core/extension` 这条公共面真的能用。

import {
  createEcho,
  createProvider,
  createProviderStreams,
  type Context,
  type Model,
  type ProviderEvent,
} from "@echo-agent/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const here = dirname(fileURLToPath(import.meta.url));

const echo = await createEcho({
  provider: scripted(),
  allowNetwork: false, // 假 provider 没有目录可刷
  stateDir: join(here, ".echo/extension-example"),
  extensionDirs: [join(here, "extensions")],
  // 注意：**没有 `agent: { tools: [...] }`**。工具全部来自扩展。
});

await echo.agent.start();
try {
  const result = await echo.agent.prompt("今年是哪一年？用工具查。");
  const toolResults = echo.agent.messages.filter((m) => m.role === "toolResult");
  // 打三件事：装上了哪些扩展 · 模型看得见哪些工具 · 工具**真正返回的内容**
  //（只看「有没有 toolResult」是不够的——工具不存在时也会有一条，内容是「没这个工具」）。
  console.log(
    JSON.stringify({
      extensions: echo.extensions.map((e) => e.name),
      tools: echo.agent.state.tools.map((t) => t.name),
      outcome: result.outcome.kind,
      toolOutput: toolResults.map((m) => JSON.stringify(m.content)).join(" | "),
      toolErrored: toolResults.some((m) => m.isError === true),
    }),
  );
} finally {
  await echo.stop();
}
