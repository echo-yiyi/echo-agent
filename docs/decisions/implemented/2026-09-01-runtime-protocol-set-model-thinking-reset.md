# P3a：`AgentRuntime` 协议开「换」那组——`setModel` / `setThinkingLevel` / `reset`，忙时拒绝不排队

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-01 · 落地 main（core `packages/core/src/extension/runtime.ts` / `builtin.ts`；cli `packages/tui/src/app.ts`；`7d4237c`）· 来源 [产品级 TUI 设计方案](../../design/tui.md) §六、§九 D5（2026-09-08 从那张表转录成条）

## 决定

协议保持**封闭**，只加三支：`setModel` / `setThinkingLevel` / `reset`。忙时返回 `rejected` 带原因、**不排队**（与 steer / followUp 同款显式结果）；绿灯 = 下一轮生效（admission 冻结 binding 保证本轮不撕裂）。UI：Ctrl+L 选择器（当前 ✓）、Shift+Tab 轮档、`/clear`（协议清真相 + 壳清投影）。跨 provider 与 `/sessions` 拆到 P3b。

## 理由

机制早在 `Agent` 上（装备 setter、`reset()`），缺的只是协议口；排队会让「我换了模型」几分钟后突然生效——那是惊吓不是功能。原 TUI 设计稿「待拍板 2」。

## 落地

`7d4237c`。之后的相邻改动：Shift+Tab 只轮映射表里发出去的参数不同的档（[thinking 档位的 off 要真关](2026-09-08-thinking-level-off.md)）；`reset()` 与 sessions.md 目标形态的关系另见 sessions.md §9。

## 验收

`AgentRuntime` 上有且只有这三支新方法（api 快照）；跑着的时候调用得到 `{ kind: "rejected", reason }` 而不是排队；空闲时调用后下一轮用新装备。判据在 `packages/tui/test/tui.test.ts` 的「换装备（P3a）」一节。
