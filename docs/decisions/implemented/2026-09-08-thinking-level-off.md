# thinking 档位的 `off` 要真关：映射表的值从 `reasoning_effort` 字符串改成请求体参数

> 状态:implemented · 提出 2026-09-08（review 批 5 顺带发现）· 拍板 2026-09-08（用户，选 B）· 实现 2026-09-08 · 来源 [`Model.thinkingLevelMap`](../../../packages/core/src/provider/types.ts#symbol=Model) 与 `packages/core/src/provider/openai.ts` 的 `buildRequest`

## 现状(拍板前)

`Agent` 新建时 `thinkingLevel` 缺省 `"off"`，TUI 里 Shift+Tab 轮到 off 状态栏什么都不显示。但方言对 off 只是**不发** `reasoning_effort`：GLM 5.3 / Kimi K3 / DeepSeek V4 服务端按各自缺省照样思考（GLM / K3 缺省 max，DeepSeek 缺省 high）。`Model.thinkingLevelMap` 的值类型是 `string | null`，只能写 `reasoning_effort`；DeepSeek / Kimi K2.6 / MiniMax M3 能真关，但要发另一个参数 `thinking: { type: "disabled" }`，表里写不下。于是 off 是假的，状态栏在模型思考着的时候显示为空。

## 不拍板的代价

用户按 Shift+Tab 到 off 以为省钱、省时间，账单与延迟不变；压缩摘要那次显式要的 off 也关不掉。

## 选项

- **A. 不改代码**，TUI 把 off 显示成「缺省」。诚实，但 off 仍然关不了任何一家。
- **B. 映射表的值改成「要合并进请求体的参数对象」**：`reasoning_effort` / `thinking.type` 之类字段名由目录按各家官方文档填，方言只做合并、不认字段。能关的模型 `off` 项写关的参数；关不掉的没有 `off` 项，壳据此显示「缺省」。改 `Model` 公共类型、重录 api 快照、落盘校验器同步。
- **C. 把 off 从 `ThinkingLevel` 里去掉。** 能关的模型失去关的入口。

## 决定

**B**（2026-09-08 用户拍板）。三张表：GLM 5.3 与 K3 共用 `LOW_HIGH_MAX_FOLD`（没有 off）；DeepSeek flash / pro 用官方兼容表加 `off = thinking.type: disabled`；K2.6 只有开关 `KIMI_K2_TOGGLE`（off 关、其余六档显式开）。`params` 仍最后合并，显式调参赢过档位。

**随之而来的行为变化**：新建 `Agent` 缺省仍是 off，所以 DeepSeek 与 K2.6 现在**一起来就是不思考**，要思考得选档（Shift+Tab / `setThinkingLevel()` / `AgentOptions.thinkingLevel`）；GLM / K3 缺省不变（关不掉）。

## 验收

`Model.thinkingLevelMap` 的值类型是 `Readonly<Record<string, unknown>> | null`；`buildRequest` 把映射值合并进请求体、不认字段名；DeepSeek flash / pro 与 K2.6 选 off 时请求体带 `thinking: { type: "disabled" }`，GLM / K3 选 off 时请求体不带任何思考参数；落盘校验器对非 plain object 的值判红；api 快照重录。判据在 `packages/core/test/openai.test.ts` 的两条 thinkingLevel 测试。
