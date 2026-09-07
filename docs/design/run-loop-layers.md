# Run Loop 的四层：run / reply / turn / attempt

> 状态：已实现（2026-09-05，分支 `worktree-loop-layers`）；四条决策均已拍板，见导读<br>
> 读者：要改 run loop、订阅事件流做 UI / 观测、或对循环写评测的人<br>
> 假设已读：[Lifecycle 与 Run Loop](lifecycle-and-run-loop.md) §2–§4 的现状描述。本文只写目标形态；与现状的差异集中在 §7。实现合入后，该稿 §3–§4 指向本文<br>
> 决策记录（四条，本文只指向，论证在记录里）：[外层单位叫 reply](../decisions/implemented/2026-09-05-reply-layer.md) · [重试归 loop](../decisions/implemented/2026-09-05-retry-owned-by-loop.md) · [失败 attempt 留 transcript](../decisions/implemented/2026-09-05-failed-attempt-in-transcript.md) · [迭代预算按 reply 计](../decisions/implemented/2026-09-05-iteration-budget-per-reply.md)。**相邻但不在本文范围**的已有记录：[abort reason](../decisions/proposed/2026-09-01-abort-reason.md) · [`agent_end` 是否 idle barrier](../decisions/proposed/2026-09-01-agent-end-barrier.md) · [stop hook 三次](../decisions/proposed/2026-09-01-stop-continuation-limit.md) · [`toolExecution: "parallel"`](../decisions/proposed/2026-09-01-tool-execution-parallel.md)

## 导读

**解决什么。** 循环里有名字的只有 run（`agent_start / agent_end`）和 turn（`turn_start / turn_end`）。「agent 对一条输入的完整回应」「一次模型请求」「一次重试」都没有名字、没有 ID、没有事件；内层 / 外层只存在于 `inner:` / `outer:` 两个标签里。于是 turn 同时扛着三个意思（一次请求、一次回答、一批工具），重试一发生三个意思就对不齐：同一个 iteration 号发两对 `turn_start / turn_end`；transport 重试与整轮重跑共用一个事件名 `retry_scheduled`、两套计数；撞窗重跑则什么都不发。事件是按实现方便发的，不是按概念边界发的。证据逐条见 §7。

**最终形态。** 四层，每层一个名字、一个 ID、一对事件、一个函数：**run ⊃ reply ⊃ turn ⊃ attempt**，tool call 挂在 turn 下。事件只在概念边界发，配对由结构保证而不是靠各分支各自记得补；重试是「同一 turn 的下一个 attempt」这一结构，只有一份预算；内外层写进 `TurnCause` 类型而不是标签；迭代预算按 reply 计，run 级另有 reply 数上限。turn 的定义与 Claude Agent SDK、OpenAI Agents SDK 一致，reply 对应两家的自然单位（§1.1）。

**Non-Goals（已决，不做）。**

- Agent 实例生命周期（`start / stop / dispose / phase`）：归 [Lifecycle 与 Run Loop](lifecycle-and-run-loop.md) §1 与它的决策记录。
- `toolExecution: "parallel"`、stop hook 三次上限、abort reason、`agent_end` 与 idle 的关系：各有记录（见页首），本文的结构让它们更好落，但不替它们拍板。
- tool call 内部的授权等待：仍只在 hook 侧（`waiting_permission`）可见，本文不加 loop 事件。
- 新事件的落盘范围（session 账本存不存 reply / attempt、观测 journal 存哪些）：归观测层与 session 设计。
- TUI 怎么展示 reply / attempt：归 TUI 设计。

**待拍板。** 四条已各成记录：

1. [外层单位叫 `reply`](../decisions/implemented/2026-09-05-reply-layer.md) —— 拍板 2026-09-05。
2. [重试归 loop，dialect 不再重试](../decisions/implemented/2026-09-05-retry-owned-by-loop.md) —— 拍板 2026-09-05。
3. [失败 attempt 的消息留 transcript、投影时丢](../decisions/implemented/2026-09-05-failed-attempt-in-transcript.md) —— 拍板 2026-09-05。
4. [`maxIterations` 按 reply 计，run 级加 `maxReplies`](../decisions/implemented/2026-09-05-iteration-budget-per-reply.md) —— 拍板 2026-09-05（条件「run 级 reply 上限」已纳入）。

**验收判据（机器可判）。** 在 `packages/core/test/` 下新增 `loop-layers.test.ts`（随实现一起提交），对下列每种 run 用同一个栈式校验器扫事件流：只有文本、要工具、transport 错误后成功、退避中 abort、退避中 deadline、撞窗应急后成功、`contextBeforeBuild` block、工具执行中 abort、run 超时、followUp、stop hook 注入、`shouldStopAfterTurn`、从 transcript 续跑、reply 数达上限。校验器只看 loop 事件（`agent_* / reply_* / turn_* / attempt_* / message_* / tool_execution_* / compaction_* / retry_scheduled / usage`），`queue_update` 与 `resource_changed` 不参与排序规则。断言：① `agent / reply / turn / attempt` 四层 start / end 严格嵌套且每层至少一对；② assistant 的 `message_start / message_end` 与 `usage` 只出现在 attempt 内，`tool_execution_*` 与 toolResult 的 `message_end` 只出现在 `attempt_end{landed}` 之后、同一 turn 内；③ `retry_scheduled` 只出现在同一 turn 的 `attempt_end{failed}` 之后，其后是下一个 `attempt_start`，或退避被 abort / deadline 打断时的 `turn_end{aborted}`；④ `turnId` 在一个 run 内唯一，其 n 在每条 reply 内从 1 起、每个 turn 加 1（重试不消耗）；⑤ 输入消息的 `message_end` 在它引发的 `turn_start` 之前，中间只允许 `compaction_start / compaction_end`。另断言：失败 attempt 之后的 provider 请求不含那条失败消息；provider 持续返回 retryable 错误时一个 run 的请求总数 = `maxAttempts`；reply 数达 `maxReplies` 且仍有待办 → `agent_end{error, code: "max_replies"}` 且未吸收的消息经 `queue_dropped` 报出，达上限但无待办 → `completed`；异常路径下进程不被 deadline timer 撑住。现有 `bun test packages/core` 全绿。

## 1. 术语

> 规范词表在仓库根 [CONTEXT.md](../../CONTEXT.md)；本表只列本文用到的，定义以那里为准。

| 层 | 定义 | 不表示什么 |
|---|---|---|
| **run** | 一次 admission 到 `agent_end`。可含多条 reply | 进程存活期；一次用户输入 |
| **reply** | agent 对**一条输入**的完整回应。输入来自 prompt、followUp、stop hook 注入之一，或从 transcript 续跑；steer **不**开新 reply，它并入正在进行的这条 | 一条 assistant 消息；一次模型请求 |
| **turn** | reply 里的一次迭代：调一次模型、处理它落地的响应及其工具批。一个 turn **至多一条落地的** assistant 消息 | 一条消息（Messages API 的 turn）；一整个回答 |
| **attempt** | turn 里的**一次模型请求**：一次完整的上下文构建 + 一次 `streamFn`。重试 = 同一 turn 的下一个 attempt | dialect 内部的 HTTP 重试（目标形态下不存在，§6） |
| **tool call** | 落地消息里一个 toolUse 块从被识别到 toolResult 入账，含找工具、修参、hook、授权等待、执行 | 只是 `tool_execution_start / end` 那一段 |
| **落地（landed）** | 一个 attempt 的定稿被采纳：进 transcript 并交给 reply 判决。失败 / block / abort 的 attempt 不落地 | — |

**ID 与计数。** `runId`（现状）；`replyId = ${runId}/${k}`，k 按 run 从 1 起；`turnId = ${replyId}#${n}`，n 按 **reply** 从 1 起、每个 turn 加 1，**重试不消耗**；`shouldStopAfterTurn` / `prepareNextTurn` 收到的 `iteration` 就是这个 n，不另设计数器；attempt 用 `(turnId, attempt)` 二元组，attempt 按 turn 从 1 起。turnId 由 loop 产生、随事件带出，permission 与观测都引用它，不再各自拼一套（§7）。

**预算。** `maxIterations` 是每条 reply 的 turn 上限；`maxReplies` 是每个 run 的 reply 上限。两者都是硬闸，命中都以 `error` 收场（`max_iterations` / `max_replies`）。`timeoutMs` 仍是可选的墙钟，不承担总闸。

### 1.1 与其他 SDK 的对照

| 概念 | 本设计 | Claude Agent SDK | OpenAI Agents SDK |
|---|---|---|---|
| 一次模型调用 + 它的工具 | turn | turn（`maxTurns` = "tool-use round trips"） | turn（loop 一圈；`max_turns`） |
| 对一条输入的完整回应 | reply | 一条 `result` 消息（`num_turns` 等） | **run**（`Runner.run()` = "a single logical turn in a chat conversation"） |
| 多条输入共用执行上下文 | run | 一次 `query()`（streaming input） | 无；对话靠 `to_input_list()` 串 |
| 一次请求 | attempt | 不暴露 | `raw_responses` 每次 model call 一个 |
| 重试 | attempt k → k+1，事件可见 | 不暴露 | 不暴露 |
| 迭代预算的作用域 | 每条 reply | 每次 query（`maxTurns`） | 每次 run（`max_turns`） |

三点：turn 三家一致，但 Anthropic 的 Messages API 里 turn 指**一条消息**，同一家两个意思，所以本仓必须在代码里定义；**OpenAI 的 run 是本设计的 reply**，从那边来的读者会撞名；attempt 两家都不暴露，本仓暴露它是因为观测是产品目标。

## 2. 边界

每层只管自己的开与关；外层不替内层补事件，内层不替外层判断。异常路径同样如此：emit / hook / intake 自身坏了，attempt / turn / reply 各自补发自己的 `*_end`（result / outcome 记 `internal` 错误）再上抛，run 的 `finally` 关门——配对由结构成立。attempt 内部（上下文构建、`streamFn`、投影）抛出的不算异常路径，`runAttempt` 折成 `failed`。

### 2.1 run

- **开**：admission 通过，[`RunIntakeGate.openRun`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.openRun) 与 `agent_start`。
- **关**：intake 关门（[`tryCloseRun`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.tryCloseRun) 或 [`closeRun`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.closeRun)）→ `agent_end`。**关门三件事（清 deadline timer、`closeRun`、`agent_end`）在 `finally` 里**，任何异常路径都走——现状只有 `break outer` 走得到，§7。
- **reply 之间**，按序：
  1. 上一条 reply 是被 `shouldStopAfterTurn` 叫停的 → 直接关门（不 drain、不问 stop hook；现状语义）。
  2. reply 数 < `maxReplies`：drain followUp 有货 → 新 reply（`follow_up`）；没货 → 问 stop hook，block 且注入次数未到上限（[`MAX_STOP_CONTINUATIONS`](../../packages/core/src/loop/run-loop.ts#symbol=MAX_STOP_CONTINUATIONS)）→ 新 reply（`stop_hook`）。
  3. `tryCloseRun`：队列空 → 关门，`completed`；非空且 reply 数 < `maxReplies` → 新 reply（`follow_up`）；非空且已达上限 → `closeRun`，`error{max_replies}`。
- **未吸收的消息**：drain 出来但没吸收进 transcript 的（turn 交出的 steer、达上限时 drain 出的 followUp）随关门作为 leftovers 经 `queue_dropped` 报出，与现状 `closeRun` 的报法同一条路。

### 2.2 reply

- **开**：`reply_start{source}`，随后把这条输入吸收进 transcript（每条 `message_end`）。续跑（`resume`）没有新输入，只发 `reply_start`。
- **每个 turn 之前**：三道硬闸（abort / `maxIterations` / deadline）与 `maybeCompact()`。硬闸命中 → 不开 turn，reply 以该 outcome 结束。
- **turn 之后**：`shouldStopAfterTurn` → 结束（`completed`）；`prepareNextTurn` 换装；turn 交出的 steer 有货 → 吸收、下一 turn（`steer`）；落地消息 `tool_use` / `max_tokens` → 下一 turn；否则 settle，结束（`completed`）。turn 未落地 → 以 turn 的结果结束。
- **关**：`reply_end{outcome, final, turns}`；`final` 是最后一条落地消息，未落地时为 `null`。

### 2.3 turn

- **开**：冻结工作集（工具、已知名、hooks）→ [`openTurn`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.openTurn) → `turn_start{cause}`。**一个 turn 只开一次**，重试不重开。
- **attempt 循环**：落地 → 出循环；失败且 `error.retryable` 且 `attempt < maxAttempts` → `retry_scheduled` → 等待 → 下一个 attempt；失败且 `code === "context_overflow"` 且应急压缩成功 → 下一个 attempt（不发 `retry_scheduled`，压缩事件已说明原因）；其余失败 / block / abort → 出循环。**一个 turn 最多 `maxAttempts` 个 attempt，不分原因。** 退避受 run 的 signal 管：abort / deadline 一到就提前结束等待，不再发起 attempt，turn 以 `aborted` 收场（reply 据 deadline 折成 `error{timeout}`）。
- **工具批**：只在落地后，按响应顺序逐个 [`runOneTool`](../../packages/core/src/loop/run-turn.ts#symbol=runOneTool)；signal 中止则剩下的不跑（现状）。
- **关**：`closeTurn` 交出 steer → `turn_end{result, toolResults}`。gate 的 turn 边界与事件的 turn 边界重合。

### 2.4 attempt

- **开**：`attempt_start`。
- **内容**：压缩投影 → 每轮注入 → `transformContext` → `contextBeforeBuild`（block 则结果 `blocked`，不调模型）→ `convertToLlm` → 取 key → `streamFn` → 消费流（`message_start / message_update`）→ 定稿入 transcript（`message_end`、`usage`）。
- **每个 attempt 完整重建。** 同一 turn 内重试时，`getTurnInjections`、`transformContext`、`contextBeforeBuild`、`convertToLlm`、`getApiKey` **每个 attempt 各调一次**。这是有意的：两次 attempt 之间上下文可能已被应急压缩改过，短命 key 可能已过期。代价是这些回调的契约要补一句「同一 turn 内可能被多次调用，有副作用的实现自己去重」——现状 dialect 重试是同一份请求体重发，不重建（§7）。
- **关**：`attempt_end{result}`。定稿的 `stopReason` 决定 `result.kind`：`end_turn / tool_use / max_tokens` → `landed`；`error` → `failed`；`aborted` → `aborted`。

### 2.5 tool call

现状不变：[`runOneTool`](../../packages/core/src/loop/run-turn.ts#symbol=runOneTool) 的跨度从落地消息的 `message_end` 到 toolResult 的 `message_end`；`tool_execution_start` 只标记执行阶段开始，它前面的找不到 / 修参失败 / hook 拦 / 授权拒等出口只走 hook notify（见 Non-Goals）。

## 3. 类型与事件

`loop/types.ts` 新增下列类型，`AgentLoopConfig` 新增 `maxReplies: number`（与 `maxIterations` 同形，Agent 给缺省）；`events.ts` 的 `AgentEventInput` 新增四个变体、改三个：

```ts
import type { AgentError, AgentMessage, AgentOutcome, AssistantMessage, ToolResultMessage } from "@echo-agent/core";

/** 这条 reply 在回应谁。 */
export type ReplySource = "prompt" | "follow_up" | "stop_hook" | "resume";

/** 为什么开这一 turn：input 是 reply 的第一轮；其余三个是「上一轮没干完」。 */
export type TurnCause = "input" | "tool_use" | "max_tokens" | "steer";

export type AttemptResult =
  | { kind: "landed"; message: AssistantMessage } // 定稿被采纳，交给 reply 判决
  | { kind: "failed"; error: AgentError } // 重不重试看 error.retryable 与预算
  | { kind: "blocked"; reason?: string } // contextBeforeBuild 说别发
  | { kind: "aborted" };

export type TurnResult = {
  turnId: string;
  result: AttemptResult; // 最后一个 attempt 的结果
  toolResults: ToolResultMessage[]; // 只有 landed 才非空
  steers: AgentMessage[]; // closeTurn 交出的插话，由 reply 决定吸收
};

/** turn 事件不再带 iteration：turnId 的 n 就是它。 */
export type LoopLayerEvent =
  | { type: "reply_start"; replyId: string; source: ReplySource }
  | { type: "reply_end"; replyId: string; outcome: AgentOutcome; final: AssistantMessage | null; turns: number }
  | { type: "turn_start"; turnId: string; replyId: string; cause: TurnCause }
  | { type: "turn_end"; turnId: string; result: AttemptResult; toolResults: ToolResultMessage[] }
  | { type: "attempt_start"; turnId: string; attempt: number }
  | { type: "attempt_end"; turnId: string; attempt: number; result: AttemptResult }
  /** 只出现在同一 turn 的 attempt_end{failed} 之后；attempt 是即将开始的那个。退避被 abort / deadline 打断时其后是 turn_end{aborted}，那个 attempt 不会开始。 */
  | { type: "retry_scheduled"; turnId: string; attempt: number; maxAttempts: number; delayMs: number; cause: string };
```

不改的：`agent_start / agent_end`、`message_*`、`tool_execution_*`、`compaction_*`、`usage`、`queue_update`、`resource_changed`。`ProviderEvent` 里的 `retry` 变体删除（§6）。`AgentError` 的 `code` 新增 `"max_replies"`。

## 4. 函数与归属

```text
ids.ts
  replyIdOf(runId, k) / turnIdOf(replyId, n) / turnNumberOf(turnId)   三个 ID 只在这里拼与拆
run-loop.ts
  runLoop(deps, first)                           run：agent_start → reply+ → finally{清 timer, closeRun, agent_end}
  runReply(deps, replyId, source, input)         reply：reply_start → 吸收 input → { 硬闸 → maybeCompact → runTurn → 判决 }* → reply_end
run-turn.ts
  runTurn(deps, replyId, n, cause)               turn：冻工作集 → openTurn → turn_start → { runAttempt → 重试 / 应急压缩 }* → 工具批 → closeTurn → turn_end
  runAttempt(deps, turnId, attempt, workset)     attempt：attempt_start → 投影 … streamFn → 定稿 → attempt_end
```

| 谁 | 发什么事件 | 开关哪扇门 | 判什么 |
|---|---|---|---|
| `runLoop` | `agent_start / agent_end` | `closeRun` / `tryCloseRun` | reply 之间：`maxReplies`、followUp、stop hook |
| `runReply` | `reply_start / reply_end`、输入与 steer 的 `message_end` | — | 硬闸、`maybeCompact`、`shouldStopAfterTurn`、`prepareNextTurn`、下一 turn 的 cause |
| `runTurn` | `turn_start / turn_end`、`retry_scheduled`、toolResult 的 `message_end`、`tool_execution_*` | `openTurn` / `closeTurn` | 重试预算、撞窗应急 |
| `runAttempt` | `attempt_start / attempt_end`、assistant 的 `message_*`、`usage` | — | `contextBeforeBuild` 的 block |

原先 `decideAfterTurn` 的四步归 [`runReply`](../../packages/core/src/loop/run-loop.ts#symbol=runReply)；原先的 `ContextBuildBlocked` 异常不再存在，是 [`runAttempt`](../../packages/core/src/loop/run-turn.ts#symbol=runAttempt) 返回的 `AttemptResult.blocked`。压缩器仍由 `runLoop` 建一次，经 deps 传给下面两层。

## 5. 事件排序

规则三条：

1. **四层严格嵌套。** `agent_start` … `agent_end` 内至少一对 reply；reply 内至少一对 turn；turn 内至少一对 attempt。
2. **输入消息的 `message_end` 在它引发的 `turn_start` 之前，中间只允许 `compaction_start / compaction_end`**（轮首 `maybeCompact()` 触发时插在这里）。prompt / followUp / stop hook 的在 `reply_start` 之后；steer 的在上一个 `turn_end` 之后。现状 prompt 的 `message_end` 落在 `agent_start` 之前（§7），按 run 分组事件时它在区间外。
3. **失败不破配对。** 失败 attempt 的 assistant 消息照常 `message_start … message_end`，随后 `attempt_end{failed}`；只是不落地。

`queue_update`、`resource_changed` 不是 loop 事件，可以出现在任何位置，排序规则不管它们。

一条要工具、第一次请求 529 的 reply（runId 记作 `R`）：

```text
agent_start
reply_start{R/1, prompt}
  message_end(user)
  turn_start{R/1#1, R/1, input}
    attempt_start{R/1#1, 1}
      message_start … message_end(assistant, stopReason=error)
    attempt_end{R/1#1, 1, failed 529}
    retry_scheduled{R/1#1, 2, 1000ms}
    attempt_start{R/1#1, 2}
      message_start … message_end(assistant, tool_use)  usage
    attempt_end{R/1#1, 2, landed}
    tool_execution_start / tool_execution_end  message_end(toolResult)
  turn_end{R/1#1, landed}
  turn_start{R/1#2, R/1, tool_use}
    attempt_start{R/1#2, 1}
      message_start … message_end(assistant, end_turn)  usage
    attempt_end{R/1#2, 1, landed}
  turn_end{R/1#2, landed}
reply_end{R/1, completed, final = 那条 end_turn, turns = 2}
reply_start{R/2, follow_up} …            ← 有 followUp 才有；它的第一个 turn 是 R/2#1
agent_end{completed}
```

`contextBeforeBuild` block：`attempt_start → attempt_end{blocked} → turn_end{blocked} → reply_end{aborted, reason} → agent_end{aborted, reason}`，配对由结构成立，不用另补。

## 6. 重试与失败

**attempt 是唯一的重试单位。** dialect 只做协议翻译：一次请求、一条流、流断了就以 `error` 收场并标 `retryable`；它自己不重试，`ProviderEvent.retry` 删除。重试由 `runTurn` 按 `retryPolicy` 做：`retryable && attempt < maxAttempts` → `retry_scheduled` → `backoffMs(attempt)` → 下一个 attempt（完整重建，§2.4）。撞窗（`context_overflow`）→ 应急压缩一次 → 下一个 attempt；压不动 → `failed`。hook 侧 `modelCallFailed`（每次 `attempt_end{failed}`）与 `retryScheduled`（每次 `retry_scheduled`）由 `runTurn` 在同一位置 notify，attempt 计数与事件一致——现状这两个通知**没有任何发送点**（§7）。

**失败消息的去向。** 失败 attempt 的定稿进 transcript（`stopReason: "error"`，与现状同），`convertToLlm` 投影时丢掉 `stopReason === "error"` 的 assistant 消息——它不是模型说过的话，不该作为上文送回去。现状没有这道过滤（§7）。

**outcome 自内向外传，外层不发明内层没报的结果**：

| attempt 结果 | turn | reply | run |
|---|---|---|---|
| landed | 跑工具 → `landed` | 判决：继续 / settle / 叫停 | — |
| failed，可重试且有预算 | 下一个 attempt | — | — |
| failed，撞窗且应急成功 | 下一个 attempt | — | — |
| failed（终） | `failed` | `error` | `error` |
| blocked | `blocked` | `aborted{reason}` | `aborted{reason}` |
| aborted（调用方 signal） | `aborted` | `aborted` | `aborted` |
| aborted（deadline signal） | `aborted` | `error{timeout}`（reply 区分两个 signal，现状同） | `error{timeout}` |
| — | — | 轮首硬闸：`aborted` / `error{max_iterations}` / `error{timeout}` | 同 reply |
| — | — | — | reply 之间：达 `maxReplies` 且仍有待办 → `error{max_replies}` |

## 7. 与现状的差异

| 现状 | 目标 | 影响面 |
|---|---|---|
| [`runTurn`](../../packages/core/src/loop/run-turn.ts#symbol=runTurn) 每次重跑都发一对 `turn_start / turn_end`，同一 `iteration`；[`openTurn`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.openTurn) 为此专门顺延上一 turn 的 steer | 一个 turn 一对事件；重跑是 attempt；`openTurn` 的顺延分支删除 | 事件消费者：`agent.ts`、`memory/dream.ts`、`memory/harness.ts`、`observability/agent-events.ts`；10 个测试文件 |
| `turn_end` 在工具批之后立即发，早于 `decideAfterTurn`（已删）里的 `closeTurn` | `closeTurn` 之后发；gate 与事件边界重合 | 同上 |
| turn 事件带 `iteration`，turnId 另算 | 事件只带 `turnId`，其 n 即 iteration | `memory/dream.ts`、`memory/harness.ts`、`observability/agent-events.ts` 读 `event.iteration` 的地方 |
| turnId **两套格式**：loop 给 permission 的是 `${runId}#${iteration}`；`agent.ts` 与 `observability/agent-events.ts` 给观测 scope 的是自己拼的 `t${iteration}` | 一个 `turnId = ${replyId}#${n}` 由 loop 产、随事件带，permission 与观测都用它 | `permission/types.ts`（只当不透明字符串用，无解析）、`observability/agent-events.ts`、`agent.ts` 的观测 scope 供给 |
| `ContextBuildBlocked`（已删）用异常出 `runTurn`，`turn_start` 发了、`turn_end` 没发（探针见 §8） | `AttemptResult.blocked`，配对由结构成立 | `packages/core/test/prompt.test.ts` 的 block 用例要加事件序列断言 |
| [`runLoop`](../../packages/core/src/loop/run-loop.ts#symbol=runLoop) 无 `try / finally`：`runTurn` 抛出时 deadline timer 不清、`closeRun` 不调（探针见 §8） | 关门三件事在 `finally` | — |
| `iteration -= 1` 记账重试；`maxIterations` 按 run 计 | attempt 计数；`maxIterations` 按 reply 计，run 级加 `maxReplies` | `shouldStopAfterTurn` / `prepareNextTurn` 的 `iteration` 变为 reply 内计数；`AgentOptions` 与 `AgentLoopConfig` 新增 `maxReplies` |
| 重试两层：`packages/core/src/provider/dialect.ts` 读 `retry.maxAttempts` 重试，`runLoop` 再按同一个 `retryPolicy` 整轮重跑；最坏 3 × (1 + 3) = 12 次请求；dialect 重试是同一份请求体重发 | 只有 `runTurn` 一层，最多 `maxAttempts` 次；每个 attempt 完整重建上下文 | dialect 的重试段与 `ProviderEvent.retry`；`packages/core/test` 里的重试用例；`transformContext` / `getTurnInjections` / `contextBeforeBuild` 的实现者（同一 turn 内会被多次调用） |
| 撞窗重跑不发任何重试事件 | 是下一个 attempt，`attempt_end{failed} → compaction_* → attempt_start` | — |
| `retry_scheduled` 两个意思（dialect 内 / 整轮），字段 `attempt` 两套计数 | 一个意思，`attempt` 是即将开始的那个 | 同上 |
| 失败 attempt 的定稿进 transcript 且被投影送回模型 | 进 transcript，投影丢 `stopReason === "error"` | `packages/core/src/message-shape.ts` |
| hook 侧 `modelCallFailed` / `retryScheduled` 声明了但无发送点 | `runTurn` 在 attempt 边界发 | hook 订阅者 |
| prompt 的 `message_end` 早于 `agent_start`（[`runAgentLoop`](../../packages/core/src/loop/run-loop.ts#symbol=runAgentLoop) 先 push 再进 `runLoop`） | 在 `reply_start` 之后吸收 | 按 run 分组事件的观测侧 |
| 内层 / 外层是 `inner:` / `outer:` 标签，settle 与 followUp 吸收不发事件 | `reply_*` 与 `TurnCause` | — |

## 8. 复核

`contextBeforeBuild` block 时事件不配对（现状）：

```bash
bun -e 'import { Agent } from "./packages/core/src/agent.ts"; import { HookRuntime } from "./packages/core/src/hooks/runtime.ts"; import { FAKE_MODEL, scriptedStreamFn, textTurn } from "./packages/core/src/testing.ts"; const h = new HookRuntime(); h.on("contextBeforeBuild", () => ({ decision: "block", reason: "NO" })); const a = new Agent({ model: FAKE_MODEL, streamFunction: scriptedStreamFn([textTurn("x")]), hooks: h }); const ev: string[] = []; a.subscribe((e) => { ev.push(e.type); }); await a.prompt("go"); console.log(ev.join(","));'
```

当前输出：`message_end,agent_start,turn_start,agent_end`——`turn_start` 一个、`turn_end` 零个，且 `message_end` 在 `agent_start` 之前。

`runTurn` 抛出时 deadline timer 泄漏（现状）：

```bash
bun -e 'import { Agent } from "./packages/core/src/agent.ts"; import { FAKE_MODEL } from "./packages/core/src/testing.ts"; const boom = (() => { throw new Error("BOOM"); }) as any; const a = new Agent({ model: FAKE_MODEL, streamFunction: boom, timeoutMs: 8000 }); const r = await a.prompt("go"); console.log(r.outcome.kind, "logic done — process should exit now");'
```

当前行为：打印后进程再挂 8 秒才退出（timer 撑住 event loop）。

主路径回归：

```bash
bun test packages/core/test/invariants.test.ts packages/core/test/intake.test.ts packages/core/test/prompt.test.ts packages/core/test/compaction.test.ts
```
