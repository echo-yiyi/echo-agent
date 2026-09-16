# Run Loop 的四层：run / reply / turn / attempt

> 读者：修改循环、消费事件流或编写运行评测的人<br>
> 范围：循环层级、ID、预算、事件顺序、重试与结果传播<br>
> 状态：当前实现说明；实例的启动与停止见 [Lifecycle](lifecycle-and-run-loop.md)

## 导读

**解决什么。** 一条输入可能触发多次模型调用，一次调用可能重试，一次执行又可能继续处理追加输入。分层让计数、事件和错误归属保持一致。

**设计主线。** run 包含 reply，reply 包含 turn，turn 包含 attempt；工具批在 attempt 落地后、turn 结束前执行。每层负责自己的起止事件，重试只增加 attempt，不增加 turn。预算分别限制 reply 内迭代、run 内回复及 turn 内请求次数。

**边界。** 本文不定义 provider 的线协议或 TUI 展示。命名与取舍见 [reply](../decisions/implemented/2026-09-05-reply-layer.md)、[重试](../decisions/implemented/2026-09-05-retry-owned-by-loop.md)、[失败消息](../decisions/implemented/2026-09-05-failed-attempt-in-transcript.md)、[迭代预算](../decisions/implemented/2026-09-05-iteration-budget-per-reply.md)。

## 1. 术语

> 规范词表在仓库根 [CONTEXT.md](../../CONTEXT.md)；本表只列本文用到的，定义以那里为准。

| 层 | 定义 | 不表示什么 |
|---|---|---|
| **run** | 一次 admission 到 `agent_end`。可含多条 reply | 进程存活期；一次用户输入 |
| **reply** | agent 对**一条输入**的完整回应。输入来自 prompt、followUp、stop hook 注入之一，或从 transcript 续跑；steer **不**开新 reply，它并入正在进行的这条 | 一条 assistant 消息；一次模型请求 |
| **turn** | reply 里的一次迭代：调一次模型、处理它落地的响应及其工具批。一个 turn **至多一条落地的** assistant 消息 | 一条消息（Messages API 的 turn）；一整个回答 |
| **attempt** | turn 里的**一次模型请求**：一次完整的上下文构建 + 一次 `streamFn`。重试 = 同一 turn 的下一个 attempt | dialect 内部的 HTTP 重试（本仓不在 dialect 内重试，见 §6） |
| **tool call** | 落地消息里一个 toolUse 块从被识别到 toolResult 入账，含找工具、修参、hook、授权等待、执行 | 只是 `tool_execution_start / end` 那一段 |
| **落地（landed）** | 一个 attempt 的定稿被采纳：进 transcript 并交给 reply 判决。失败 / block / abort 的 attempt 不落地 | — |

**ID 与计数。** `runId`；`replyId = ${runId}/${k}`，k 按 run 从 1 起；`turnId = ${replyId}#${n}`，n 按 **reply** 从 1 起、每个 turn 加 1，**重试不消耗**；`shouldStopAfterTurn` / `prepareNextTurn` 收到的 `iteration` 就是这个 n，不另设计数器；attempt 用 `(turnId, attempt)` 二元组，attempt 按 turn 从 1 起。turnId 由 loop 产生、随事件带出，permission 与观测都引用它，由同一套 ID 函数生成。

**预算。** `maxIterations` 是每条 reply 的 turn 上限；`maxReplies` 是每个 run 的 reply 上限。两者都是硬闸，命中都以 `error` 收场（`max_iterations` / `max_replies`）。`timeoutMs` 仍是可选的墙钟，不承担总闸。

### 1.1 术语边界

本仓的 run、reply、turn、attempt 以本节和 [术语表](../../CONTEXT.md) 为准，不根据其他 SDK 的同名字段推断。尤其不要用“一条消息”代替 turn，或用“一次 HTTP 请求”代替整条 reply。

## 2. 边界

每层只管自己的开与关；外层不替内层补事件，内层不替外层判断。异常路径同样如此：emit / hook / intake 自身坏了，attempt / turn / reply 各自补发自己的 `*_end`（result / outcome 记 `internal` 错误）再上抛，run 的 `finally` 关门——配对由结构成立。attempt 内部（上下文构建、`streamFn`、投影）抛出的不算异常路径，`runAttempt` 折成 `failed`。

### 2.1 run

- **开**：admission 通过，[`RunIntakeGate.openRun`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.openRun) 与 `agent_start`。
- **关**：intake 关门（[`tryCloseRun`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.tryCloseRun) 或 [`closeRun`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.closeRun)）→ `agent_end`。**`agent_end` 是 run 事件流的封口，不是 idle barrier**：它发出时 admission ticket 还没 settle，监听器里读到的 `status` 仍是 `generating`；要等空闲，等 `prompt()` / `continue()` 的 resolve（那就是 barrier），或订阅 `onChange` 看状态变化。不另设 barrier API（[决策](../decisions/implemented/2026-09-01-agent-end-barrier.md)）。**关门三件事（清 deadline timer、`closeRun`、`agent_end`）在 `finally` 里**，任何异常路径都走（验证见 §8）。
- **reply 之间**，按序：
  1. 上一条 reply 是被 `shouldStopAfterTurn` 叫停的 → 直接关门（不 drain、不问 stop hook）。
  2. reply 数 < `maxReplies`：drain followUp 有货 → 新 reply（`follow_up`）；没货 → 问 stop hook，block 且注入次数未到上限 → 新 reply（`stop_hook`）。**stop hook 最多把 agent 拉回来 3 次**（[`MAX_STOP_CONTINUATIONS`](../../packages/core/src/loop/run-loop.ts#symbol=MAX_STOP_CONTINUATIONS)），第 4 次 block 被忽略、run 照常关门。这是防死循环的保险丝，不是产品契约、不进配置（[决策](../decisions/implemented/2026-09-01-stop-continuation-limit.md)）。
  3. `tryCloseRun`：队列空 → 关门，`completed`；非空且 reply 数 < `maxReplies` → 新 reply（`follow_up`）；非空且已达上限 → `closeRun`，`error{max_replies}`。
- **未吸收的消息**：drain 出来但没吸收进 transcript 的（turn 交出的 steer、达上限时 drain 出的 followUp）随关门作为 leftovers 经 `queue_dropped` 报出（`closeRun` 的报法）。

### 2.2 reply

- **开**：`reply_start{source}`，随后把这条输入吸收进 transcript（每条 `message_end`）。续跑（`resume`）没有新输入，只发 `reply_start`。
- **每个 turn 之前**：三道硬闸（abort / `maxIterations` / deadline）与 `maybeCompact()`。硬闸命中 → 不开 turn，reply 以该 outcome 结束。
- **turn 之后**（顺序即 [`runReply`](../../packages/core/src/loop/run-loop.ts#symbol=runReply) 里的顺序）：落地消息 `tool_use` / `max_tokens` → 直接下一 turn（**先短路**：工具链的每一轮都不问下面两个钩）；否则 `shouldStopAfterTurn` → 结束（`completed`）；`prepareNextTurn` 换装；turn 交出的 steer 有货 → 吸收、下一 turn（`steer`）；否则 settle，结束（`completed`）。turn 未落地 → 以 turn 的结果结束。
- **关**：`reply_end{outcome, final, turns}`；`final` 是最后一条落地消息，未落地时为 `null`。

### 2.3 turn

- **开**：冻结工作集（工具、已知名、hooks）→ [`openTurn`](../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.openTurn) → `turn_start{cause}`。**一个 turn 只开一次**，重试不重开。
- **attempt 循环**：落地 → 出循环；失败且 `error.retryable` 且 `attempt < maxAttempts` → `retry_scheduled` → 等待 → 下一个 attempt；失败且 `code === "context_overflow"` 且应急压缩成功 → 下一个 attempt（不发 `retry_scheduled`，压缩事件已说明原因）；其余失败 / block / abort → 出循环。**一个 turn 最多 `maxAttempts` 个 attempt，不分原因。** 退避受 run 的 signal 管：abort / deadline 一到就提前结束等待，不再发起 attempt，turn 以 `aborted` 收场（reply 据 deadline 折成 `error{timeout}`）。
- **工具批**：只在落地后。响应里**连续的**可并行调用（工具自己声明 `concurrent`）切成一批同跑，碰到没标的就断批、它自己一批；批与批之间仍是顺序的。批内每个工具走各自的 [`runOneTool`](../../packages/core/src/loop/run-turn.ts#symbol=runOneTool)，`tool_execution_*` 交错、按 `toolCallId` 配对，**toolResult 入账按 tool_use 出现顺序**（不按完成顺序），授权询问批内串行。signal 中止：已起跑的那一批各自收 signal 结束、结果照样入账，**剩下的批不跑**。为什么是声明制、为什么询问要串行，见 [并行工具](../decisions/implemented/2026-09-07-parallel-tools.md)。
- **关**：`closeTurn` 交出 steer → `turn_end{result, toolResults}`。gate 的 turn 边界与事件的 turn 边界重合。

### 2.4 attempt

- **开**：`attempt_start`。
- **内容**：压缩投影 → attempt 注入 → `transformContext` → `contextBeforeBuild`（block 则结果 `blocked`，不调模型）→ `convertToLlm` → 取 key → `streamFn` → 消费流（`message_start / message_update`）→ 定稿入 transcript（`message_end`、`usage`）。
- **每个 attempt 完整重建。** 同一 turn 内重试时，`getTurnInjections`、`transformContext`、`contextBeforeBuild`、`convertToLlm`、`getApiKey` **每个 attempt 各调一次**。这是有意的：两次 attempt 之间上下文可能已被应急压缩改过，短命 key 可能已过期。代价是这些回调的契约要补一句「同一 turn 内可能被多次调用，有副作用的实现自己去重」。方言层不再自带重试（`packages/core/src/provider/dialect.ts` 只剩 `RetryPolicy` 类型）。
- **关**：`attempt_end{result}`。定稿的 `stopReason` 决定 `result.kind`：`end_turn / tool_use / max_tokens` → `landed`；`error` → `failed`；`aborted` → `aborted`。

### 2.5 tool call

[`runOneTool`](../../packages/core/src/loop/run-turn.ts#symbol=runOneTool) 的跨度从落地消息的 `message_end` 到 toolResult 的 `message_end`；`tool_execution_start` 只标记执行阶段开始，它前面的找不到 / 修参失败 / hook 拦 / 授权拒等出口只走 hook notify；对应观测事实见 [Observability](observability.md) §7。

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

其他事件包括：`agent_start / agent_end`、`message_*`、`tool_execution_*`、`compaction_*`、`usage`、`queue_update`、`resource_changed`。provider 不另外发一套重试事件；reply 上限错误码是 max_replies。

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
| `runReply` | `reply_start / reply_end`、输入与 steer 的 `message_end` | — | 硬闸、`maybeCompact`、`tool_use` / `max_tokens` 短路、`shouldStopAfterTurn`、`prepareNextTurn`、下一 turn 的 cause |
| `runTurn` | `turn_start / turn_end`、`retry_scheduled`、toolResult 的 `message_end`、`tool_execution_*` | `openTurn` / `closeTurn` | 重试预算、撞窗应急 |
| `runAttempt` | `attempt_start / attempt_end`、assistant 的 `message_*`、`usage` | — | `contextBeforeBuild` 的 block |

reply 内的继续判决归 [`runReply`](../../packages/core/src/loop/run-loop.ts#symbol=runReply)；context block 由 [`runAttempt`](../../packages/core/src/loop/run-turn.ts#symbol=runAttempt) 返回的 `AttemptResult.blocked`。压缩器仍由 `runLoop` 建一次，经 deps 传给下面两层。

## 5. 事件排序

规则三条：

1. **四层成对且严格嵌套；允许空层。** run 内至少一条 reply；reply 内**可以零 turn**——输入吸收之后轮首硬闸就命中（abort / deadline / `max_iterations`，§6 那一行）；turn 内**可以零 attempt**——`turn_start` 之后、发请求之前被 abort。消费者按栈配对消费永远成立；「取 turn 的最后一个 attempt」「按 attempt 数算重试率」这类非空假设不成立。
2. **输入消息的 `message_end` 在它引发的 `turn_start` 之前，中间只允许 `compaction_start / compaction_end`**（轮首 `maybeCompact()` 触发时插在这里）；轮首硬闸在吸收之后就命中时没有 `turn_start`，紧接着是 `reply_end`（规则 1 的零 turn reply）。prompt / followUp / stop hook 的在 `reply_start` 之后；steer 的在上一个 `turn_end` 之后。
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

**attempt 是唯一的重试单位。** dialect 只做协议翻译：一次请求、一条流、流断了就以 `error` 收场并标 `retryable`；它自己不重试，`ProviderEvent.retry` 删除。压缩摘要器的模型调用（[`modelCallFor`](../../packages/core/src/compaction/pipeline.ts#symbol=modelCallFor)）不是 attempt，但同一份 `retryPolicy`、同一个受 signal 管的退避（[`loop/backoff.ts`](../../packages/core/src/loop/backoff.ts#symbol=sleep)）：retryable 错误重试到 `maxAttempts`，只发 hook 侧的 `modelCallFailed` / `retryScheduled`，不发 loop 事件（它不在任何 turn 里）。重试由 `runTurn` 按 `retryPolicy` 做：`retryable && attempt < maxAttempts` → `retry_scheduled` → `backoffMs(attempt)` → 下一个 attempt（完整重建，§2.4）。撞窗（`context_overflow`）→ 应急压缩一次 → 下一个 attempt；压不动 → `failed`。hook 侧 `modelCallFailed`（每次 `attempt_end{failed}`）与 `retryScheduled`（每次 `retry_scheduled`）由 `runTurn` 在同一位置 notify，attempt 计数与事件一致。

**失败消息的去向。** 失败 attempt 的定稿进 transcript（stopReason: error），`convertToLlm` 投影时丢掉 `stopReason === "error"` 的 assistant 消息——它不是模型说过的话，不该作为上文送回去。

**outcome 自内向外传，外层不发明内层没报的结果**：

| attempt 结果 | turn | reply | run |
|---|---|---|---|
| landed | 跑工具 → `landed` | 判决：继续 / settle / 叫停 | — |
| failed，可重试且有预算 | 下一个 attempt | — | — |
| failed，撞窗且应急成功 | 下一个 attempt | — | — |
| failed（终） | `failed` | `error` | `error` |
| blocked | `blocked` | `aborted{reason}` | `aborted{reason}` |
| aborted（调用方 signal） | `aborted` | `aborted{reason}` | `aborted{reason}` |
| aborted（deadline signal） | `aborted` | `error{timeout}`（reply 区分两个 signal） | `error{timeout}` |

**abort 的 reason 一路带到 outcome**（[决策](../decisions/implemented/2026-09-01-abort-reason.md)）：`Agent.abort(reason)` 把 reason 装进 `AbortSignal.reason`（[`AbortReason`](../../packages/core/src/errors.ts#symbol=AbortReason)——必须是 `AbortError` 形状的 `DOMException`，provider 靠 `name` 识别「被中止」，裸字符串会被当成别的错误），reply 在收场时从调用方 signal 取回，落在 `agent_end` 与 `LoopResult` 的 `{ kind: "aborted", reason }` 里。宿主传的 reason 是自由字符串原样透传；core 自己发起的中断用 [`ABORT_REASON`](../../packages/core/src/errors.ts#symbol=ABORT_REASON) 里的常量：`lease-lost`（丢锁）、`dispose`（收摊）。没给理由的裸 `abort()` 与 admission 的抢占 / 收摊仍是不带 reason 的 `{ kind: "aborted" }`；run 超时不是 aborted，是 `error{timeout}`。
| — | — | 轮首硬闸：`aborted` / `error{max_iterations}` / `error{timeout}` | 同 reply |
| — | — | — | reply 之间：达 `maxReplies` 且仍有待办 → `error{max_replies}` |

## 7. 使用边界

- start / end 成对不表示各层非空：消费者必须处理零 turn 的 reply 与零 attempt 的 turn。
- agent_end 只封口 run 事件流；调用方要等 prompt/continue 返回，或观察状态变化，再判断能否发起新工作。
- attempt 回调可能在同一 turn 内多次执行，带副作用的 transform、取 key 或注入函数必须自行处理重复调用。
- 主循环的迭代上限不等同于墙钟超时，工具和 provider 还需遵守 signal。
- 存入 transcript 的失败响应不参与后续模型上下文；离线分析账本时应读取 stopReason。

## 8. 验证

loop-layers 测试使用栈式校验器检查四层嵌套、输入入账位置、失败配对、重试计数和工具结果顺序。覆盖正常文本、工具批、重试、block、abort、deadline、followUp 与 reply 预算路径；其断言不扩展到任意第三方工具的副作用。

```bash
bun test packages/core/test/loop-layers.test.ts packages/core/test/invariants.test.ts packages/core/test/intake.test.ts packages/core/test/prompt.test.ts packages/core/test/compaction.test.ts
```

历史变更前后的探针见 [复核记录](../code-review/2026-09-15-doc-probes.md)。本文只维护当前事件契约，不保留旧实现对照表。
