# `agent_end` 是否 idle barrier

> 状态:proposed · 提出 2026-09-01 · 来源 [Lifecycle 与 Run Loop](../../design/lifecycle-and-run-loop.md) §9

## 现状

run loop 先原子关闭 intake、发出 `agent_end` 并返回;admission ticket settle 之后,Agent 才把公开 status 设回 `idle` 并调度 inbox/dream。所以 listener 在处理 `agent_end` 时仍可能看到 `generating`(探针:`STATUS_AT_AGENT_END=generating`,`STATUS_AFTER_PROMPT=idle`)。

## 不拍板的代价

这个顺序在实现里是有意的,但事件名容易被理解成「Agent 已经空闲」。订阅者据此发起下一次 prompt 会撞 busy。

## 选项

- **A. 改名。** 若它表示的是「run 的事件流已封口」,就用不暗示实例状态的名字。代价:破坏性变更(与 lifecycle-naming 相关,可一并决定)。
- **B. 保留名字,但公开契约明确它不构成 idle barrier,并提供一个真正可等待的 barrier。** 代价:多一个公共 API。

## 决定

待拍板。

## 验收

公开契约里写明 `agent_end` 与 `idle` 的关系,并有一条面向订阅者的契约测试;若提供 barrier,它有自己的测试。
