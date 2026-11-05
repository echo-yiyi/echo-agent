# 一条输入从收下到处理完：插话改方向、中断与停任务分两档、没处理的交还、没执行的入账、输入带身份

> 状态:implemented · 提出 2026-11-04（用户提的五个问题：生成结束、工具还没启动时怎么处理新输入；区分取消当前生成和整个任务；明确 accepted 的输入的最终归属；保留工具调用与结果的完整记录；可观测的输入和执行要关联）· 拍板 2026-11-05（用户：「按照推荐的做」）· 落地 `packages/core/src/loop/intake.ts` / `run-loop.ts` / `run-turn.ts`、`agent.ts`、`background/harness.ts`、`provider/openai.ts` / `dialect.ts`、`loop/observe.ts`、`agent-observe.ts`、`packages/tui/src/app.ts` / `keybindings.ts` · 修改 [落单 tool_use](2026-09-07-orphan-tool-use.md) 的选项 B（「账本不动、投影补齐」→ 没启动的当场入账，投影补齐退为兜底）

**给谁看**：改循环的输入与取消、工具批、观测事实或终端壳按键的人。假设已知 [Run Loop 的四层](../../design/run-loop-layers.md) §2 与 [生命周期](../../design/lifecycle-and-run-loop.md) 的 intake 一节。

**一句话**：跑的中途来的一句话，用 `steer` 是改方向（还没启动的工具不再启动），用 `followUp` 是排队；`interrupt()` 只停当前这一步、`abort()` 停整个任务（连这个 run 起的后台任务）；收下却没来得及处理的连正文交还；没启动的调用当场入账「没执行」，方言丢掉的调用留一条观测事实；每条输入带 `inputId`，观测里「这句话 → 引出的那一轮 → 那一轮的工具调用」接得上。

## 现状（拍板前）

1. **生成结束、工具还没启动时来了新输入**：turn 的入口从 `openTurn` 开到 `closeTurn`（工具批跑完之后），这段里 `steer()` 一律收下，但工具批照常全部跑完，插话下一轮开头才进上下文——看到模型要删东西补一句「别删」，删照样执行（除非权限拦下）。官方 TUI 忙时回车把字放回输入行，压根不走 steer。
2. **取消只有一档**：一个 run 一个 AbortController，`abort()` 关掉整个 run；TUI 的 Esc 就是它。这个 run 派出去的后台任务（后台子 agent、后台进程）不受影响，只在 Agent 收摊时才停。
3. **收下的输入异常结束时丢了正文**：run 被 abort / 出错 / 超时 / 到上限时，还在 steer、followUp 队列里的由 `closeRun()` 交还，`reportUnconsumed` 只报一条带条数的 `queue_dropped` 诊断。被 `userPromptSubmit` hook 拦下的同样只有诊断。
4. **账本缺两类记录**：abort 后没轮到的那几批工具调用在账本里没有结果，送模前由投影补（选项 B 的「账本只记真实发生的事」）；方言丢掉的工具调用（参数不可解析、没有名字、无主片段）只发一条 warning，不落会话，观测在 metadata 档不逐条记，warning 里也没有原始参数。
5. **输入与执行对不上**：消息没有身份；`SteerResult.turnId` 是收下时开着的那个 turn，不是吸收它的下一个；`queue_updated` 只有队列名和长度；吸收输入的 `message_committed` 不带 turn。复盘「这句话影响了哪一轮、那一轮调了哪些工具」只能按时间猜。

## 决定

1. **steer 是改方向，followUp 是排队**（不新增动词）。`steer` 收下的那一刻 abort 本 turn 的 `steered` 信号（[`RunIntakeGate.steer`](../../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate.steer)）；工具在四个点上检查它：批与批之间、[`runOneTool`](../../../packages/core/src/loop/run-turn.ts#symbol=runOneTool) 入口、进授权闸之前、发 `tool_started` 之前——还没启动的不再启动，各记一条「没执行（superseded）」；等授权的问一并撤掉（ask 的 signal 合上 `steered`）。已经在跑的照常跑完。然后吸收插话、开下一轮，**有插话时下一轮的 cause 是 `steer`**（此前跟着工具记 `tool_use`）。
2. **中断与停任务分两档**：
   - [`AgentRuntime.interrupt(reason?)`](../../../packages/core/src/extension/runtime.ts#symbol=AgentRuntime)：只停 reply 的**当前这一步**（轮首的边界工作 + 那一个 turn）。reply 每一步 `beginStep()` 换一个新信号，`interrupt()` 只 abort 它；理由留给 reply `takeInterrupt()`，落在两步之间也不丢。被中断后：这一步里收下过插话就带着它接着跑（同一条 reply、cause `steer`）；没有就以 `aborted{理由}` 收掉这条 reply，**run 照常往下走 followUp、不问 stop hook**，没有待办就以这条的 outcome 收场。只认真被中断掉的那种：真失败、被 hook 拦下的按它们自己的结果收场；这一轮本来就要收（end_turn、没工具）时中断不改变什么。缺省理由 `ABORT_REASON.interrupted`。后台任务不动。
   - `abort(reason?)`：停整个任务——run 关门，**这个 run 起的后台任务一起停**（[`killBackgroundOfRun`](../../../packages/core/src/background/harness.ts#symbol=killBackgroundOfRun)；任务在 `startBackground` 时记下当时开着的 run，[`BackgroundTask.runId`](../../../packages/core/src/background/types.ts#symbol=BackgroundTask)）。别的 run 起的、run 外起的不动；正常收尾也不停——后台任务本来就是要比 run 活得久的。
3. **每条收下的输入恰好落在三处之一**：进 transcript（消息带 `inputId`）；**交还**——run 关门时还在队列里的，事件 `input_returned` 连原消息一起交出去，壳把字放回输入行，诊断改名 `queue_returned`；**被拦下**——`userPromptSubmit` hook 说不。不自动带进下一个 run（[`RunIntakeGate`](../../../packages/core/src/loop/intake.ts#symbol=RunIntakeGate) 头注原有的决定不变）。
4. **账本记下没执行的调用，观测记下被丢的调用**：
   - 没启动的调用当场入账一条 error 结果，正文是 [`NOT_EXECUTED`](../../../packages/core/src/loop/run-turn.ts#symbol=NOT_EXECUTED)（aborted / interrupted / superseded 三种说法），`metadata.notExecuted` 标原因；观测记 `tool.rejected{stage:"start", cause:"aborted"|"superseded"}`。这推翻选项 B 的「账本不动」：系统决定不跑它，这件事本身就发生了。[`healOrphanToolUses`](../../../packages/core/src/messages.ts#symbol=defaultConvertToLlm) 留作兜底——进程在一批中途崩掉、或那之前写下的老会话。
   - 方言丢掉调用时 warning 带上原样（`warning.toolCall: { id?, name?, args }`），循环据此记 `tool.call.dropped`：哪种丢法、哪个调用、参数多长 metadata 档就记；**参数原文只在 content 档**（它是正文，与 `tool.execute` 的参数同一口径）。
5. **输入带身份**：prompt / steer / followUp 收下的那一刻由 Agent 发 `inputId`（[`UserMessage.inputId`](../../../packages/core/src/messages.ts#symbol=UserMessage)，`in-` 开头；harness 插的话没有），随消息落盘，投影时剥掉不出门；`SteerResult` / `FollowUpResult` 的 accepted 带回它。观测：`turn_started` 带 `inputs`（紧挨着这一轮之前吸收进来的 inputId）；`agent.message.appended` 带 inputId；排队的两种收下时记 `agent.input.accepted`（带收下时的 runId / turnId），交还记 `agent.input.returned`，被拦记 `agent.input.blocked`。
6. **终端壳**（[按键](../../design/tui.md)）：跑着时回车是插话、Alt+Enter（Windows / WSL 是 Ctrl+Q，照 pi 的 `app.message.followUp`）是排队，收不下就把原文放回输入行；Esc 是 `interrupt`；空输入行上 Ctrl+C 是 `abort`（有字时仍是清空）；`input_returned` 的原文放回输入行并说一句 `[交还]`。

## Non-Goals

- **排队中的输入不落盘**：进程在它们被消费之前崩掉，照样丢。要持久就得走 inbox 那种账本，这次不做。
- **inbox 消息不发 inputId**：它们有自己的账本 id 与 ack；这次只给人经 prompt / steer / followUp 说的话。
- **插话不撤已经在跑的工具**：要停在跑的用 `interrupt()`。
- **`interrupt()` 不发 hook 事件**：没有 `interruptRequested` 这一拍（`abort()` 的 `abortRequested` 不变）。
- **不在被中断的 reply 收尾时提示「已中断」**：壳只显示交还的原文。

## 风险与代价

- 插话只是补充信息时，被跳过的只读调用要模型重发，多一轮；不想打断的用排队。
- `abort()` 会停掉这个 run 起的后台进程（比如它起的开发服务器）；只想停手上这一步用 `interrupt()`。
- 公共面变化：`AgentRuntime.interrupt`；`SteerResult` / `FollowUpResult` 的 `inputId`；`UserMessage.inputId`；事件 `input_returned`；`ProviderEvent` 的 `warning.toolCall`；观测词汇 `ToolRejectStage` 加 `start`、`ToolRejectCause` 加 `superseded`、`turn_started.inputs`、`tool_call_dropped` 与三条 `input_*`；`BackgroundTask.runId`、`BackgroundDeps.currentRunId`；`@echo-agent/core/background` 多一个 `killBackgroundOfRun`；`ABORT_REASON.interrupted`。诊断 `queue_dropped` 改名 `queue_returned`。
- 会话格式：user 消息多一个可选字段 `inputId`，老会话没有它照样读。

## 验收

- 插话改方向：[没启动的不再启动](../../../packages/core/test/input-lifecycle.test.ts#test=steer-收下的那一刻还没启动的调用不再启动记没执行superseded跑着的照常跑完下一轮-causesteer从这句话接着)、[撤掉等授权的问](../../../packages/core/test/input-lifecycle.test.ts#test=steer-撤掉等授权的问那个调用不跑记没执行superseded不留一个没人答的问)
- 中断与停任务：[中断收掉这条 reply](../../../packages/core/test/input-lifecycle.test.ts#test=interrupt没有插话没有排队在跑的工具收-signal-停下没启动的记没执行interrupted这条-reply-以-abortedinterrupted-收run-也是)、[排队的照常做](../../../packages/core/test/input-lifecycle.test.ts#test=interrupt-之后排队的-followup-照常做被中断的只是那一条-replyrun-以后面那条的结果收场)、[有插话就接着](../../../packages/core/test/input-lifecycle.test.ts#test=interrupt-时这一步里收下过插话照插话接着跑同一条-reply下一轮-causesteer不收-reply)、[abort 停这个 run 的后台任务](../../../packages/core/test/input-lifecycle.test.ts#test=abort-停整个任务这个-run-起的后台任务一起停run-外起的不动interrupt-不动后台任务)、[两步之间的中断不丢](../../../packages/core/test/input-lifecycle.test.ts#test=runintakegate中断落在两步之间也不丢下一步一开始就是-aborted取走即清不带进下一个-runsteer-收下即-abort-本-turn-的-steered)
- 交还：[连正文交还](../../../packages/core/test/intake.test.ts#test=abort-时-accepted-却没消费的-followup连正文交还inputreturned-带原消息与-inputidqueuereturned-报出队列清空下一次-prompt-不会捡到)、[壳放回输入行](../../../packages/tui/test/tui.test.ts#test=收下了却没来得及处理排队之后-ctrlc-停掉整个任务原文放回输入行说一句-交还)
- 账本与观测：[没轮到的当场入账](../../../packages/core/test/orphan-tool-use.test.ts#test=批中-abort没轮到的两件当场入账没执行metadata-标原因投影三件都配上不靠补2026-11-05-起账本记下它)、[被丢的调用](../../../packages/core/test/observability-decisions.test.ts#test=方言丢掉的工具调用记-toolcalldropped哪种丢法哪个调用参数多长-metadata-档就记参数原文只在-content-档)
- 身份与关联：[收下即发 inputId](../../../packages/core/test/input-lifecycle.test.ts#test=prompt-steer-followup-收下的那一刻发-inputid随消息入账harness-插的话没有)、[输入 → 这一轮 → 工具调用](../../../packages/core/test/observability-decisions.test.ts#test=输入-这一轮-这一轮的工具调用turnexecute-记引出它的-inputid插话收下有一条-agentinputaccepted被它撤掉的调用记-toolrejectedstart-superseded)
- 终端壳：[Esc 与 Ctrl+C](../../../packages/tui/test/tui.test.ts#test=esc-只中断当前这一步走协议的-interrupt不是-abort空输入行上-ctrlc-停整个任务abort空闲时两个键都不发)、[回车插话](../../../packages/tui/test/tui.test.ts#test=跑着时回车是插话收下后显示成用户行说明还没开始的工具不再执行那个工具真的没跑)、[Alt+Enter 排队](../../../packages/tui/test/tui.test.ts#test=跑着时-altenter-是排队不打断这件做完接着做空闲时-altenter-与回车一样发出去)
