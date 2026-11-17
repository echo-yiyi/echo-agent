# 工具执行时拿到所在的 run：异步任务与上报能对回原来那次执行

> 状态:implemented · 提出 2026-11-17（产品方报告：工具执行时没有稳定的运行引用；业务工具上报问题、提交异步任务，关联不回原生的执行）· 拍板 2026-11-17（用户：「可以，按你的顺序做」）· 落地 `packages/core/src/tools/types.ts`（`ToolExecutionContext`）、`packages/core/src/loop/run-turn.ts`（`runOneTool`）、`packages/core/src/messages.ts`（`ToolCallRef`、`EnvironmentMessage.startedBy`）、`packages/core/src/message-shape.ts`、`packages/core/src/background/`（`BackgroundTask.startedBy`、`BackgroundSpec.startedBy`）、`packages/core/src/agent.ts`（后台子 agent）、`packages/tools/src/bash.ts`，判据见验收

**给谁看**：写业务工具的产品，改工具执行、后台任务或环境消息的人。

## 现状（拍板前）

1. 工具执行时收到的 [`ToolExecutionContext`](../../../packages/core/src/tools/types.ts#symbol=ToolExecutionContext) 只有 `toolCallId`、`workspace`、`sessionId`、`iteration`，没有所在的 run 与那一轮。观测按 run 记、工具事件挂在 turn 上，业务工具自己提交的异步任务、上报的问题就挂不回观测里那次执行。
2. 内核的后台任务只记了起它的 admission run（[`BackgroundTask.runId`](../../../packages/core/src/background/types.ts#symbol=BackgroundTask)，管 `abort()` 停哪些任务），不记是哪次工具调用起的；结束通知只带任务 id（`ref`），任务表最多留 64 条、只在内存里，被淘汰或重启之后就对不回去。

## 决定

1. **`ToolExecutionContext` 加两个必填字段**：`runId` 是这次调用所在的 run，与观测里那个 run 是同一个 id，子循环（子 agent、提取）里的调用是子循环自己的 run；`turnId` 是发起调用的那一轮，与观测里工具事件的 turnId 是同一个值。由 [`runOneTool`](../../../packages/core/src/loop/run-turn.ts#symbol=runOneTool) 填，工具里包一层再转交的（记忆工具、提取的替身）原样转。业务工具拿 `runId` / `turnId` / `toolCallId` 给自己的异步任务和上报打标签。
2. **一次工具调用的引用是一对值**：

   ```ts
   export type ToolCallRef = Readonly<{ runId: string; toolCallId: string }>;
   ```

   `toolCallId` 只在它所在的 run 里唯一，所以和那个 run 成对记，不拿 admission 的 `runId` 去配。
3. **后台任务记下起它的那次工具调用**：`BackgroundSpec.startedBy?` 由起任务的工具填（`{ runId: ctx.runId, toolCallId: ctx.toolCallId }`），任务上是 `BackgroundTask.startedBy: ToolCallRef | null`（不是工具起的为 null）。原来的 `runId` 不动，仍只管 `abort()` 停哪些任务。`bash` 的 `background: true` 与后台子 agent 都填。
4. **任务投回来的环境消息带上同一对值**：`EnvironmentMessage.startedBy?: ToolCallRef`。结束通知由 `startBackground` 统一盖（产品的 `onEnd` 交回环境消息、自己没填时）；后台子 agent 的每条回执也带。与 `ref` / `replyTo` 一样不出门（不发给模型），随会话落盘，形状校验要求给了就得两个字符串齐全。

## Non-Goals

- 不改 `BackgroundTask.runId` 的含义，也不改后台子 agent 观测来源里的 `parentRunId`。
- 不给业务工具一个「提交异步任务」的内核接口：怎么提交、投回来的结果怎么带引用，是产品自己的事；内核只保证工具拿得到引用、内核自己的后台任务带上引用。
- `turnId` 不进 `ToolCallRef`：同一个 run 里 `toolCallId` 已经定位到那次调用，轮次从观测里查得到。

## 验收

- [工具拿到所在的 run 与那一轮](../../../packages/core/test/loop-layers.test.ts#test=工具拿到所在的-run-与那一轮2026-11-17ctxrunid-是这次-run-的-idctxturnid-是发起调用的那一轮业务工具拿它们给异步任务打标签能对回观测)：`ctx.runId` 等于 `prompt()` 交回的 runId，`ctx.turnId` 等于发起调用那一轮 `turn_start` 的 turnId。
- [后台子 agent 挂回起它的那次调用](../../../packages/core/test/subagent.test.ts#test=后台任务挂回起它的那次工具调用2026-11-17任务记下-startedby回执与收尾两种环境消息都带同一对-runid-与-toolcallid)与[后台 bash 作业](../../../packages/tools/test/bash.test.ts#test=后台作业挂回起它的那次-bash-调用2026-11-17任务记下-startedby结束通知带同一对-runid-与-toolcallid)：任务上的 `startedBy` 对；回执与收尾都带同一对值。去掉结束通知的盖章这两条是红的。
- [形状校验](../../../packages/core/test/subagent.test.ts#test=环境消息的-startedby-过形状校验2026-11-17给了就得-runid-与-toolcallid-两个字符串缺一件拒半份引用挂不回那次调用)：齐全的过，缺 `toolCallId` 的拒。
