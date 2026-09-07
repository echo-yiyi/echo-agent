# 给两种 lifecycle 分开命名

> 状态:rejected · 提出 2026-09-01 · 2026-09-07 被 [`Agent` 类收进 core 内部](../proposed/2026-09-07-agent-class-internal.md) 取代 · 来源 [Lifecycle 与 Run Loop](../../design/lifecycle-and-run-loop.md) §9

## 现状

同一个词指两件事:`Agent.start()` 表示**实例**启动,而 `agent_start` 事件表示**一次 run** 开始。公开的 `AgentStatus` 只有 `idle / generating / acting / compacting`,描述的是 run 内状态;实例阶段是另一个私有字段 `phase`。

## 不拍板的代价

订阅者按事件名推断实例状态,调用方按方法名推断事件含义,两边都会错。命名冲突不会在类型上报错,只会在理解上报错——这类问题在开源后由用户提 issue 发现,成本翻倍。

## 选项

- **A. 改事件名。** `agent_start` / `agent_end` 改成不暗示实例状态的名字(例如 `run_start` / `run_end`)。代价:破坏性变更,所有订阅者要改。
- **B. 改方法名。** `Agent.start()` 改成 `Agent.activate()` 之类。代价:同样破坏性,且 `activate()` 已被占用。
- **C. 都不改,在公开契约里显式写明两者无关。** 代价:命名歧义永久留存,文档要一直解释。

## 倾向

发布前是改名成本最低的时刻。

## 决定

**不拍,冲突消失**(2026-09-07)。`Agent.start()` 随 `Agent` 类收进内部,仓外看得到的只剩 `agent_start` / `agent_end` 这对 run 事件与 `echo.agent.start()` 这一次实例启动;两者不再在同一个公共类型上撞名。`agent_end` 保留名字,见 [`agent_end` 是否 idle barrier](../proposed/2026-09-01-agent-end-barrier.md)。

## 验收

公开 API 与事件名中,「实例生命周期」与「run 生命周期」不再共用同一个词根;或公开契约中有一节明确二者互不表示对方。
