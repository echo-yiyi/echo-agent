# 让位先排空：做完手上那条再交出 lease，到时限没做完就中止、那批 inbox 消息不 ack

> 状态:implemented · 提出 2026-11-03（全仓 review）· 拍板 2026-11-03（用户：按推荐修）· 来源 [`Agent`](../../../packages/core/src/agent.ts#symbol=Agent) 的 `watchHandoff` 与 `consumeInbox`

## 现状(拍板前)

[可让位 lease](2026-09-07-preemptible-lease.md) 与 [会话与 agent 集群](../../design/sessions.md) §5 写的是「收到让位请求就把手上的活 drain 完、`stop()`、release」。代码里 `watchHandoff` 直接调 `stop()`，而 `stop()` 关 admission 时会**中止**在跑的 run；为让位写的排空接缝 `pauseManagedWork({ reason: "handoff" })` 没有调用方。

后果（review 复现）：后台宿主正在处理一条 inbox 消息，人 `--resume` 同一段，7ms 就拿到锁；后台那条 run 以 aborted 收场，消息却照样被 ack——人看到的是「那条消息 → 一条空回复」，活没做完，发件方等的回信永远不来。ack 与收摊时撤销写入资格还在赛跑：ack 输了就重投，赢了就丢。

## 不拍板的代价

设计文档与代码两说；被叫醒的会话一被人接手就可能丢掉它为之被叫醒的那条消息。

## 选项

- **A. 照设计排空，不设时限。** 人要等后台把手上的活做完，长任务时人被挂住，违背「人优先」。
- **B. 维持中止，只是被中止的那批不 ack。** 不丢消息，但短活也被打断、人接手后从头再做一遍。
- **C. 先排空，有时限；到点没做完再中止，被中止的那批不 ack。**

## 决定

**C**（2026-11-03 用户拍板「按推荐修」）。

- 收到让位请求：`pauseManagedWork({ reason: "handoff" })`——关新工作入口、等在跑的 run 与它那批 inbox 的 ack 裁决、等后台与写入落定；然后 `stop()`、release。
- 排空时限 `HANDOFF_DRAIN_MS`（7s），比请求方的等待上限 `HANDOFF_TIMEOUT_MS`（10s）短，留出收摊与释放的时间：人在上限内拿得到锁。
- 到点还没做完：中止在跑的 run（outcome 理由 `ABORT_REASON.handoff`）与后台任务；那批 inbox 消息**不 ack**、整批放回，盘上留着，接手的一方恢复时重投。代价：那条消息在 transcript 里出现两次（一次被中止、一次做完）；不会丢。

## 验收

`packages/core/test/lease-handoff.test.ts`：活在时限内做完时，后台 outcome 为 completed、消息已 ack、人接手后 transcript 里只有一条；活做不完时，到时限后 outcome 为 `{ kind: "aborted", reason: "handoff" }`、消息未 ack，人接手后重投并做完。两条在去掉排空、或去掉「被中止不 ack」时各自变红。
