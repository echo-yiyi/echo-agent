# 给远端客户端的投影：纯函数 + `state.lastSeq` 这条水位，不动壳协议

> 状态:implemented · 提出 2026-09-20（下游产品「一一」的 MVP 边界：接受断线后整份重拉快照，不要求补播；要可序列化、过滤签名与私有内部数据的公开输出；确认快照与订阅的衔接语义）· 拍板 2026-09-20（用户）· 落地 `packages/core/src/client-view.ts` / `agent.ts`，判据 `packages/core/test/client-view.test.ts`

**给谁看**：把 agent 状态推给进程外客户端（手机、Web）的宿主。假设已知[状态变化都有事件](2026-09-18-state-changes-emit-events.md)。

## 现状（拍板前）

事件协议本身就是给前端的，但**送不出进程**：`state.tools` 是带 `execute` 的对象、`pendingToolCalls` 是 `Set`（`structuredClone` 直接抛）；`ThinkingBlock.signature` / `origin` 是 provider 的回放数据，随 `messages` 与六支事件一路往外走；流里跑的 `message_update.delta` 还挂着 runtime 用的 `partial`。

衔接也没法照实承诺：`processEvents()` 是「归约 → 落盘 → 派发」，在落盘那一段挂上订阅，客户端会**先在快照里看到这条变化、再收到同一条事件**。`message_end` 重复意味着对话里凭空多一条消息。

## 不拍板的代价

每个宿主自己写一份投影，各洗各的——漏一个字段就是把 provider 回放数据发到公网；而「快照之后从哪接」没有判据，只能靠时间戳或内容去重猜。

## 选项

- **A. 纯函数 + 水位**：core 出 `clientSnapshot()` / `clientEvent()`，`AgentState` 加 `lastSeq`。
- **B. 往 `AgentRuntime` 加 `snapshot()`**：协议是封闭的，加一支所有壳与替身都要跟上，而这件事不需要 Agent 的任何内部状态。
- **C. 只出文档**，让宿主各自实现投影。

## 决定

**A**（2026-09-20 用户拍板）。四条：

1. **投影是纯函数**：`clientSnapshot(runtime)` / `clientState(state)` / `clientEvent(event)`，配 `ClientSnapshot` / `ClientState` / `ClientTool` / `ClientEvent` 四个类型。传输、重连、归并、A2UI、产品 UI 协议都在宿主侧（一一自己划的边界）。
2. **洗三类**：进不了 JSON 的（`tools` → 可显示面、`pendingToolCalls` → 数组）；provider 回放数据（`signature` / `origin`）；流里的 runtime 附加物（`delta.partial`）。**`redacted` 留着**——「这段思考被安全过滤器抹掉了」是展示事实，不是内部数据。工具结果的 `metadata` 也留着：它是宿主自己的载荷（A2UI 走的就是它）。
3. **水位是 `AgentState.lastSeq`**（构造为 -1）：状态已经吸收到第几号事件。归约那一步就落，早于落盘与派发。衔接规则：同一拍里取快照再订阅，`seq > lastSeq` 的才送。断线重取快照，core 不留事件日志、不补播。
4. **带消息的事件靠一张穷举表挡漏**（`CARRIES_MESSAGES`）：`Record<CoreAgentEvent["type"], boolean>`，加一支新事件变体这张表就编译不过，逼着作者回答「它带不带消息」；`MESSAGE_CARRYING_EVENTS` 导出给判据用，不靠人读两遍。

## Non-Goals

- 不做 `messageId` / `inputId` 写盘，不统一两条事件流的序号（一一 MVP 明确不要求）。
- 不补播断线期间的增量：没有事件日志，重连就是重取快照。
- 权限与提问走 `LifecycleEvent`，**没有 seq**：快照里的 `pendingPermissions` / `pendingQuestions` 是权威，lifecycle 只当提示，客户端按 id 覆盖、别按到达顺序追加。
- 不动 `AgentRuntime`，不改 `AgentState` 现有字段的形状（只加 `lastSeq`）。

## 验收

`packages/core/test/client-view.test.ts`：原始 `state` 过不了 `structuredClone`、投影过得去（对照组不能少）；原始消息与事件里确实带 `signature`，投影后 `signature` / `origin` / `partial` 一个都找不到，思考正文仍在；这一轮真的跑到了会带签名的五支事件；在「归约完、还没派发」那一拍取快照并订阅，`seq <= lastSeq` 的确实重复、切掉之后重建出的消息序列与最终状态逐条相同；`lastSeq` 构造为 -1、与最后一个事件的 `seq` 相等。11 刀突变全红。
