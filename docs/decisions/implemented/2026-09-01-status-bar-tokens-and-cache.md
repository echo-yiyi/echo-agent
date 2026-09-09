# 状态栏只显示 token 不显示 $，加缓存命中一格

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-01（用户：「token 就够，但要看到 cache 缓存情况」）· 落地 main（core `packages/core/src/messages.ts` / `provider/openai.ts` / `agent.ts`；cli `packages/tui/src/app.ts`；`843d260`）· 来源 [产品级 TUI 设计方案](../../design/tui.md) §四、§九 D8（2026-09-08 从那张表转录成条）

## 决定

状态栏**只显示 token，不显示 $**；加**缓存命中**一格（`缓存 600 (60%)`）。`Usage` 加可选 `cachedInputTokens`——provider 没报就缺席（0% 是没命中、缺席是没报，两回事）；方言认 OpenAI 系与 DeepSeek 两种上报形状。

## 理由

$ 若将来要，走目录里的 `Model.cost`（唯一真源），不建 CLI 价格表。原 TUI 设计稿「待拍板 1」。

## 落地

`843d260`。

## 验收

provider 报了缓存命中时状态栏出现「缓存 N (P%)」；没报时那一格不出现而不是显示 0%；状态栏任何位置不出现货币符号。
