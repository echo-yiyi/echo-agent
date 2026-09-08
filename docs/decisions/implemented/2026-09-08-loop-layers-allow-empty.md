# 四层事件的不变量：成对且严格嵌套，允许空层

> 状态:implemented · 提出 2026-09-07（代码 review，`docs/code-review/2026-09-07-code-architecture-docs.md` 待拍板表）· 拍板 2026-09-08（用户「继续做吧」，按 review 建议执行，未逐条口头确认）· 实现 2026-09-08（`24f45d4`）· 来源 [Run Loop 的四层](../../design/run-loop-layers.md) §5 规则 1

## 现状(拍板前)

`run-loop-layers.md` §5 规则 1 与验收判据①写「四层 start/end 严格嵌套**且每层至少一对**」，`architecture.md` §8 把它列为有门守着（`packages/core/test/loop-layers.test.ts`）。实现里两条路做不到：轮首硬闸（abort / deadline / `max_iterations`）在吸收输入之后、开 turn 之前命中，reply 里没有 turn；`turn_start` 之后、发请求之前被 abort，turn 里没有 attempt。校验器本身写对了，只是没有用例开到这两条路；而同一份文档 §6 的 outcome 表自己有「轮首硬闸」一行，等于承认 n=0——文档内部打架，门表把一件代码做不到的事标成了有门。

## 不拍板的代价

第三方按文档写栈式消费者，会在最普通的「超时 / 用户 Ctrl-C」上崩；仓内观测投影不会漏 span，但会产出没有模型调用的 turn span 和没有 turn 的 reply span。

## 选项

- **A. 保「每层至少一对」**：轮首 abort 也造一对 attempt 事件。代价：为满足文档造假事件，消费者拿到一个从未发过请求的 attempt。
- **B. 放宽成「成对且严格嵌套，允许空层」**：reply 可零 turn、turn 可零 attempt。代价：「取 turn 的最后一个 attempt」「按 attempt 数算重试率」这类非空假设不再成立，要在文档里明写。

## 决定

**B**。栈式配对消费永远成立；非空假设不成立，文档明写。

## 验收

`run-loop-layers.md` §5 规则 1 与验收①写明允许空层；`architecture.md` §8 那行同口径；`packages/core/test/loop-layers.test.ts` 的校验器不再断言「至少一对」，并有轮首 abort（零 attempt 的 turn）、`reply_start` 时 abort（零 turn 的 reply）、轮首 deadline 三个用例。
