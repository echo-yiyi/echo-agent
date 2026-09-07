# 移除还是实现 `toolExecution: "parallel"`

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-07(口头,选 B,语义见 [并行工具](2026-09-07-parallel-tools.md)) · 合入 2026-09-07 · 来源 [Lifecycle 与 Run Loop](../../design/lifecycle-and-run-loop.md) §9

## 现状

`AgentOptions` 与 `AgentLoopConfig` 都接受 `toolExecution?: "sequential" | "parallel"`,但 turn 的执行循环固定逐个 `await`,从不读这个配置。双工具阻塞探针的事件序列是 `a:start, a:end, b:start`——第二个工具在第一个结束后才开始。

## 不拍板的代价

公开接口声明了一个不存在的行为。使用者会据此做错误的时延假设,也会误以为工具之间的副作用可以并发发生。这是**接口层面的假绿**,比实现不完善更坏。

## 选项

- **A. 删掉 `"parallel"` 这个可选值。** 代价:将来要并行时需要重新引入,可能是一次破坏性变更。
- **B. 真正实现并行。** 代价:必须同时设计取消语义与结果排序——两个工具并发时,谁先返回、结果按什么顺序进 transcript、一个失败另一个是否继续,都要定。

## 倾向

文档给的方向是 A:在并行语义、取消和结果排序被完整设计并测试之前先删。

## 决定

**B,实现**(2026-09-07 用户拍板:「并行 tool 肯定需要实现」)。取消、排序、并发询问、hook 顺序四件在 [并行工具](2026-09-07-parallel-tools.md) 里逐条定;`toolExecution` 这个选项随之删掉,并不并行由工具自己声明。

## 验收

选 A:`toolExecution` 从公共类型中消失,`api-snapshot` 重录。
选 B:存在一条行为测试断言「第二个工具可以在第一个未完成时启动」。
