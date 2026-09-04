// 会话集群的**跨进程**宿主：一个真的会被 spawn 起来的进程，起一段 session，然后**待着**。
//
// 它证明的是设计里最容易含糊过去的那一条：**别人写进我的 inbox 目录的一条消息，
// 我不重启就看得见**（docs/design/sessions.md §5）。同进程的判据证明不了这个——
// 那时读盘的和写盘的是同一份内存账本；只有「写的人在另一个进程」才逼出 `refresh()` 与轮询。
//
// 用法：`bun session-peer.ts <echoHome> <sessionId> [等待毫秒]`
// 报告走 stdout 最后一行的 JSON：`{ ok, sessionId, saw, texts }`。

import { createAgent } from "../../src/create-agent.ts";
import { mountBuiltinTools } from "../../src/extension/builtin.ts";
import { createProvider } from "../../src/provider/models.ts";
import { createProviderStreams } from "../../src/provider/dialect.ts";
import { scriptedDialect, textTurn } from "../../src/testing.ts";
import { SESSION_SOURCE } from "../../src/session/sessions.ts";
import type { Provider } from "../../src/provider/types.ts";

const [, , echoHomeArg, sessionId, waitArg] = process.argv;
if (echoHomeArg === undefined || sessionId === undefined) {
  console.error("用法：session-peer.ts <echoHome> <sessionId> [等待毫秒]");
  process.exit(2);
}
process.env["ECHO_HOME"] = echoHomeArg;
const waitMs = waitArg === undefined ? 8_000 : Number(waitArg);

/** 确定性 provider：这条判据跟模型说什么无关，只要它**开了一轮**。 */
function scripted(): Provider {
  return createProvider({
    id: "scripted",
    auth: { apiKey: { resolve: async () => ({ apiKey: "x" }) } },
    defaultModelId: "only",
    models: [{ id: "only", api: "fake" }],
    // 脚本给足够多轮：这个进程可能被叫醒不止一次，用尽了会以 error 结束那一轮
    api: createProviderStreams(scriptedDialect(Array.from({ length: 8 }, (_, i) => textTurn(`收到第 ${i + 1} 条`)))),
  });
}

async function main(): Promise<void> {
  const agent = await createAgent({ provider: scripted(), sessionId, allowNetwork: false, withoutMemory: true });
  await mountBuiltinTools(agent);
  await agent.start();

  // **一句话都不主动说**：这个进程只是待着。它之后看到的任何东西都只可能来自别人写进它 inbox 的那条。
  const deadline = Date.now() + waitMs;
  const sawSession = (): boolean =>
    agent.messages.some((m) => m.role === "environment" && (m as { source?: string }).source === SESSION_SOURCE);
  while (Date.now() < deadline && !sawSession()) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const saw = sawSession();
  const texts = agent.messages
    .filter((m) => m.role === "environment")
    .map((m) => JSON.stringify(m.content));
  await agent.stop();
  console.log(JSON.stringify({ ok: true, sessionId: agent.state.sessionId, saw, texts }));
}

void main().catch((e: unknown) => {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
