# 首次运行走引导设置：欢迎 → 选 provider → 贴 key → 选模型

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-01（用户：「进来是欢迎，然后指导用户去设置 api，可以选择模型」）· 落地 main `5a6c417`（`packages/tui/src/first-run.ts`）· 细化 [首次运行没有凭据时起来](2026-08-31-tui-first-run-not-exit.md) · 来源 [产品级 TUI 设计方案](../../design/tui.md) §三、§九 D4（2026-09-08 从那张表转录成条）

## 决定

首次运行走引导设置：欢迎 → 选 provider → 贴 key → 选模型（缺省 ✓ 预选中），样子照 Claude Code 的选择器，列表在说明下面；跑在装配前。

## 理由

选哪家 / 哪个模型只能在装配前定（运行中换模型是 P3 的事，见 [P3a 协议开三支](2026-09-01-runtime-protocol-set-model-thinking-reset.md)）；同时修掉「还没有凭据」说两遍的重复。

## 落地

`5a6c417`：`packages/tui/src/first-run.ts`。

## 验收

没有任何凭据、终端形态启动：先出欢迎，再依次选 provider、贴 key、选模型，之后进入对话；选好的 provider / 模型写进 `$ECHO_HOME/settings.json`（见 [跨 provider 换模 + 记住选择](2026-09-01-cross-provider-model-switch.md)）。
