# 内容被安全过滤拦下有自己的错误码 `content_filter`

> 状态:implemented · 提出 2026-11-03（全仓 review 留下的待拍板）· 拍板 2026-11-13（用户：「按照你的推荐来做」）· 落地 [`ErrorCode`](../../../packages/core/src/errors.ts#symbol=ErrorCode)、`packages/core/src/provider/openai.ts` 的 `mapStop` · 判据 `packages/core/test/openai.test.ts`

**给谁看**：按 `AgentError.code` 分支的人（重试、提示文案、观测上的归类）。假设已知 [四层循环](../../design/run-loop-layers.md) 里 provider 错误的归类表。

**一句话**：上游以 `finish_reason: content_filter` / `sensitive` 收尾时，错误码从 `protocol` 改成新增的 `content_filter`；不可重试不变。

## 现状（拍板前）

内容过滤收尾报 `protocol`、不可重试。`protocol` 的本义是后端违约（缺终结事件、响应不可解析），其余 4xx 也归在它名下，调用方按 code 分不出「后端坏了」和「这份内容过不了对方的审核」——前者该换后端或报给运维，后者换个后端重发同样的内容多半还是被拦，得改输入。

## 选项

- **A. `ErrorCode` 加一个成员 `content_filter`。**
- **B. 不加码，调用方从 `message` 里认。** `message` 是给人读的，不是契约。

## 决定

**A**。

1. `ErrorCode` 的 provider 侧加 `content_filter`。`ErrorCode` 仍是闭集，这次只多一个成员。
2. `mapStop` 对 `content_filter`、`sensitive` 报 `{ source: "provider", code: "content_filter", retryable: false }`；已流出的正文照旧留在失败消息里。
3. 循环不为它加分支：不可重试的错误按现有路径让这条 reply 以 error 收场。

## Non-Goals

- 不改重试、压缩、记忆提取对错误的处理。谁要按这个码分支，另议。
- 请求阶段被拒（HTTP 4xx、正文说内容违规）仍归 `protocol`：各家说法不一，没有可靠的识别依据。

## 验收判据

`packages/core/test/openai.test.ts`「finish_reason 的异常值不当正常结束…」：`content_filter` 与 `sensitive` 两种收尾的 `error.code` 都是 `content_filter`、`retryable` 为 false。把 `mapStop` 改回 `protocol`，这条会红。
