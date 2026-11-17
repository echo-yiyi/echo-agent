# 宿主等记忆提取收完：settleMemory、stop 返回结局、热部署避开记忆任务

> 状态:implemented · 提出 2026-11-17（产品方报告：宿主不知道记忆处理完了没有、成没成；没有在跑的 run 不代表没有排着的提取；记忆任务进行中模块可能被卸掉）· 拍板 2026-11-17（用户：「可以，按你的顺序做」）· 落地 `packages/core/src/agent.ts`（`Agent.settleMemory`、`Agent.enqueueExtract`、`Agent.hasPendingWork`、`Agent.memoryWorkInFlight`）、`packages/core/src/extension/runtime.ts`（`AgentRuntime.settleMemory`）、`packages/core/src/create-echo.ts`（`EchoStopResult`、`reloadExtensions`）、`packages/core/src/memory/observe.ts`（`MemorySettleResult`），判据见验收

**给谁看**：写宿主 / 产品收摊逻辑的人，改热部署或记忆通道的人。

## 现状（拍板前）

1. [`AgentRuntime.hasPendingWork`](../../../packages/core/src/extension/runtime.ts#symbol=AgentRuntime) 不算记忆提取：前台一空闲它就是 false，排着或在跑的提取不算——宿主据此收摊，这段对话就可能没提取过。
2. 宿主拿不到提取的结局：`echo.stop()` 补提取一次、返回 `void`。到点被中止、没跑完、被门挡下，宿主都看不到，「正常关闭」被当成「都提取成了」。
3. 热部署只在后台子 agent 在跑时推迟，不看记忆的提取与整理。产品经自己的扩展注册的记忆模块，换代时先被卸掉，正在跑的提取或整理随后往卸掉的模块里写，全被拒。

## 决定

1. **新增 `AgentRuntime.settleMemory(opts?: { timeoutMs?: number }): Promise<MemorySettleResult>`**：现在就把这段对话还没提取的部分提取完、等它结束、返回结局。不看攒了几轮（仍过词数门槛）；在跑的整理先中止（提取排在整理后面，整理被中止只是推迟到下次）。`timeoutMs` 不给就等到结束；给了到点中止提取与整理、**等它们停下再返回** `aborted`，游标不动。永不 reject，`timeoutMs` 不是不小于 0 的有限数时抛 `TypeError`。
2. **结局沿用提取已有的结局与跳过原因**，只多一种 `aborted`：

   ```ts
   import type { ExtractSkipReason } from "@echo-agent/core";

   export type MemorySettleResult =
     | Readonly<{ kind: "completed"; written: number }>
     | Readonly<{ kind: "partial" | "abandoned"; written: number; reason: string }>
     | Readonly<{ kind: "failed"; reason: string }>
     | Readonly<{ kind: "aborted" }>
     | Readonly<{ kind: "skipped"; reason: ExtractSkipReason }>;
   ```

   `partial` / `failed` 的游标不动、下次重看；没装记忆或已经不许做记忆工作（收摊中、丢锁）记成 `skipped: not_allowed`；没有新内容是 `empty_range`。
3. **`hasPendingWork` 算上在跑或排着的提取**。整理不算：它推迟到下次不丢东西，算进来的话 `--serve` 与管道形态要为一次可有可无的整理多等好几轮模型调用。
4. **`Echo.stop()` 返回 `EchoStopResult = { memory: MemorySettleResult }`**：退出补提取的结局（`Agent.drainExtract` 就是 `settleMemory({ timeoutMs: DEFAULT_EXTRACT_DRAIN_MS })`）。收摊本身出错照旧抛。
5. **热部署在提取或整理在跑、在排时 rejected**，原因写明是记忆任务——与后台子 agent 在跑时同一个口径（[`Agent.memoryWorkInFlight`](../../../packages/core/src/agent.ts#symbol=Agent.memoryWorkInFlight)）。

## 已知影响

- 模型触发的热部署在 run 收尾后执行，而提取正是在那条 reply 结束时排进去的：这个 run 恰好攒满提取轮数时，热部署被推迟，报告里写着原因，模型在下一个 run 里再调一次 `extension_reload`。此前那次热部署会照做，但同时在跑的提取往卸掉的模块里写。
- 管道形态输入耗尽后等 `hasPendingWork` 变 false 再收摊，现在包括等在跑的提取跑完（中止信号照样能打断）；`--serve` 在提取期间不计空闲时间。

## Non-Goals

- 不把整理的结局放进 `settleMemory` 或 `hasPendingWork`（见决定 3）。
- 被推迟的热部署不自动重试：人与程序拿到 rejected 自己再来，模型看报告再调。
- 不改宿主壳对 `stop()` 返回值的使用：结局给调 `stop()` 的产品看，`echo-agent` / `echo-coding` 的壳不打印它。

## 验收

- [hasPendingWork 算上记忆提取](../../../packages/core/test/memory-extract.test.ts#test=haspendingwork-算上记忆提取2026-11-17提取在跑时为真跑完才变假宿主等它再收摊这段对话就不会没提取过)：前台空闲、提取在跑时为真，跑完变假。去掉改动这条是红的。
- [settleMemory 的结局](../../../packages/core/test/memory-extract.test.ts#test=settlememory2026-11-17现在就把没提取的部分提取完并返回结局跑完是-completed-带写成几条再调是-emptyrange用户的话不够是-tooshort没装记忆是-notallowedtimeoutms-不对就抛)与[到时限](../../../packages/core/test/memory-extract.test.ts#test=settlememory-到时限2026-11-17中止提取等它停下再返回-aborted游标不动下一次再看这段)：completed 带写成几条、empty_range、too_short、not_allowed、参数不对抛；到时限返回 aborted、返回时提取已停、游标没动。
- [Echo.stop() 返回结局](../../../packages/core/test/create-echo.test.ts#test=echostop-返回退出补提取的结局2026-11-17正常关闭不等于提取成了跑完是-completed没说话的段是-noscope)：跑完是 completed，一个 run 都没跑过是 no_scope；补提取到点被中止返回 aborted。
- [记忆任务在跑时热部署推迟](../../../packages/core/test/extension-reload.test.ts#test=记忆提取或整理在跑时热部署推迟2026-11-17它们写的是这一代扩展注册的记忆模块换代就是往卸掉的模块里写)：提取卡在模型调用上时 rejected 且原因写明记忆任务，跑完后放行。去掉改动这条是红的。
