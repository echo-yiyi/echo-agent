# 手动压缩进 AgentRuntime 协议;AgentState 加 compaction 与 contextTokens

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-02 · 来源 [Compaction](../../design/compaction.md) §4、§7

## 现状(拍板前)

`AgentRuntime` 是封闭协议,没有压缩入口;`AgentState.checkpoint` 是一个运行前后语义不同的字符串;壳子拿不到「上下文现在多大」。

## 不拍板的代价

用户在 TUI 里只能等自动触发;封闭协议加一支就是改契约,得明确拍板;状态里没有占用信息,壳子想显示就得自己估一份,必然漂。

## 选项

- **A. 加 `compact(instructions?)` 与两个状态字段。** 手动压缩走与自动同一条流水线(reason manual、无视阈值),走 admission 拿 permit 但不是一个 run;`AgentState.compaction` 替换 `checkpoint`,新增 `contextTokens`。
- **B. 只做自动。**

## 决定

**A**(2026-09-02 用户拍板)。`CompactResult` 与 `EquipResult` 同款:不抛、不静默——忙、没注册任何阶段、admission 拒绝都以 rejected 带原因返回。TUI 的 `/compact [指令]` 接它,结果如实显示。

## 验收

compaction 测试里的「Agent.compact:走同一条流水线;忙时 rejected;没阶段 rejected」一条;`runtime-equip` 与 `tui` 测试里的假 runtime 都实现 `compact`(类型门)。
