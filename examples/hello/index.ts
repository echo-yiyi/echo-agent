// 最小样例：**装一个包，说一句话**。
//
// 跑：
//   bun install
//   MOONSHOT_API_KEY=sk-… bun index.ts
//
// 这里能看到的全部：`createEcho` 一次装配好状态根、单写者锁、会话、记忆、任务、
// 定时器与 Inbox——**普通用户不需要 import 任何子路径**。想换其中某一件才进子路径。
//
// 状态落在 `$PWD/.echo/agents/default/`。再跑一次，它记得上次说过什么。

import { createEcho, kimiProvider } from "@echo-agent/core";

const echo = await createEcho({ provider: kimiProvider() });
const agent = echo.agent;

// 流式正文直接打到终端；不订阅也能拿到最终结果，订阅只是为了边生成边看见。
agent.subscribe((e) => {
  if (e.type === "message_update" && e.delta.type === "text_delta") process.stdout.write(e.delta.text);
});

await agent.start();
try {
  await agent.prompt("用一句话介绍你自己");
} finally {
  // **stop 不是 dispose**：前者在收拢资产之外还会还锁。不还锁，下一个进程会被挡在门外。
  await echo.stop();   // 先卸 Extension 再停 Agent
}
