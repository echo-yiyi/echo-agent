# 公开状态的每一次变化都有事件：载体是 AgentEvent

> 状态:implemented · 提出 2026-09-18（下游产品「一一」要把 agent 状态推给手机端，核对时发现 `events.ts` 文件头「不存在状态变了但外面没看见」与代码不符）· 拍板 2026-09-18（用户：载体用 AgentEvent，「没问题，改吧」）· 落地 `packages/core/src/events.ts` / `agent.ts`，判据 `packages/core/test/state-events.test.ts`

**给谁看**：写壳（TUI、Web、把状态推给远端客户端的宿主）、或改 Agent 状态字段的人。假设已知 `AgentRuntime.subscribe` / `subscribeLifecycle` 的分工（事件协议给前端，观测是插桩、不订阅事件）。

## 现状（拍板前）

`events.ts` 文件头写「`state = apply(state, event)` 是状态更新的唯一路径」，而 `agent.ts` 文件头承认还有一条直写路径，「是纪律不是门」。逐个核对，以下变化都不发事件：换模型、换思考档、切工作目录、`reset()`、启动时恢复会话、run 收尾回到 idle（以及 `compact()` / `betweenRuns()` 开门进 generating）、工具池与收紧、已激活 skill、任务清单、提问答上了、`acceptsWork` 翻转。壳只能每次重画时现读，Inbox 那批等 ack 裁决的窗口里 TUI 会一直显示「忙」，直到下一个随便什么事件。

另有四处**声明了从来不发**的 lifecycle 变体：`sessionEnd`、`equipmentChanged`（形状也不对：`timeoutMs` 不在协议上、`tools` 另有去处）、`toolCallDropped`、`notification` 的 `idle` / `task_done`。[agent_end 不是 barrier](2026-09-01-agent-end-barrier.md) 与 [run 的四层](../../design/run-loop-layers.md) 都说「订阅 `onChange` 看状态变化」，而 `onChange` 在代码里不存在。

## 不拍板的代价

一个远端客户端只拿事件流拼不出完整状态，只能定时轮询 `state`；而「哪些字段会静默变化」没有写在任何地方，每个壳都要自己踩一遍。

## 选项

- **A. 载体用 `AgentEvent`**：带 seq，是壳订阅的那条流；存储字段一律经事件归约改。
- **B. 载体用 `LifecycleEvent`**：它是 hook 的挂点词汇，不带 seq，拿来当状态广播定位不对。
- **C. 只改文字**：承认第二条路径，把会静默变化的字段列出来。

## 决定

**A**（2026-09-18 用户拍板）。形状：

| 变化 | 事件 | 归约 / 说明 |
|---|---|---|
| 换模型、换思考档 | `equipment_changed{field, model \| thinkingLevel}` | 只在 idle 换 |
| 切工作目录 | `workspace_changed{workspace}` | 入账 `workspace` entry 挪进 `persist()`，与消息同一条路 |
| `/clear` | `reset` | idle 时 inbox 若攒着，另补一条 `queue_update{inbox, 0}` |
| 启动恢复 | `session_restored{sessionId, messages, compaction, workspace}` | 新建会话也发 |
| run 开合 | `status_changed{generating, startedAt}` / `status_changed{idle}` | 只管不依附循环事件的两条边；循环里的 acting / compacting 仍由各自的事件归约 |
| 接不接活 | `availability_changed{acceptsWork, reason}` | 与 status 是两个维度 |
| 现算的视图 | `view_changed{view: tools \| activeSkills \| tasks}` | 接在集合上（`ObservedMap` / `ObservedList`），同一拍合成一条 |
| 提问答上了 | lifecycle `questionAnswered` | 与 `question` / `questionCancelled` 凑齐三拍，和权限那一族同在 lifecycle |

附五条：

1. **同步调用点也走 `processEvents()`**：归约在它的第一个 await 之前做完，setter 仍然当场生效；发出去用 [`emitDetached`](../../../packages/core/src/agent.ts#symbol=Agent.emitDetached)，订阅方抛错记诊断、不成 unhandled rejection、不打断 run 的簿记。
2. **`acceptsWork` 的判据输入，写点紧跟一次核对**（[`syncAvailability`](../../../packages/core/src/agent.ts#symbol=Agent.syncAvailability)）。这是纪律不是门：`processEvents()` 每次归约后再兜底核对，漏掉的写点最迟在下一个事件时补发（判据里用「扩展声明权限策略」这个真没接核对的输入验兜底）。
3. **工具与 skill 不走 `resource_changed`**：对象上没有来源字段可报，编一个是造数据。`resource_changed` 收窄为后台任务与 MCP 的逐项变化。
4. **删掉四处从不发的 lifecycle 变体**。仓内零引用（删后 typecheck 直接过）。`toolCallDropped` 的事实已经以 provider `warning{code: tool_call_dropped}` 随 `message_update` 发出。
5. **两处例外写进 `events.ts` 文件头**：`stop()` 收摊之后的归零不发事件；Inbox 账本无法裁决时直写 `lastError`，同一次收尾里 `availability_changed` 带着同一条消息发出。

## Non-Goals

- 不做快照 + 水位衔接（seq 覆盖 lifecycle、消息 id、实例代次）。那是下游「断线重连不重不漏」的要求，另议。
- 不把事件协议做成可直接序列化的线上格式（`state.tools` 带函数、`ThinkingBlock.signature` 外泄）。另议。
- 不改观测：观测仍是插桩，`equipment_changed` 探针与事件同一节点、各记各的。
- `state.mcp` 的变化仍靠 MCP 适配器调 `McpHost.onChanged`，core 保证不了。

## 验收

`packages/core/test/state-events.test.ts`：每类变化各一条，断言事件到达、且订阅方收到时 `state` 已是新值；切工作目录后换 Agent 续同一段，workspace 是切过去的那个；Inbox 那批的 ack 窗口里 idle 之后仍不接活、裁决后最后一条事件是接活；订阅方在同步调用点的事件上抛错不成 unhandled rejection。`loop-layers` / `admission` / `compaction` 的事件序列判据写明循环事件外面那一层（`availability_changed`、`status_changed` 各两条）。21 刀突变全红。
