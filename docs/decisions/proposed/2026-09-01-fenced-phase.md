# acquire 后启动失败是否应成为显式 `fenced` phase

> 状态:proposed · 提出 2026-09-01 · 来源 [Lifecycle 与 Run Loop](../../design/lifecycle-and-run-loop.md) §9

## 现状

启动失败发生在 acquire **之前**时,`phase` 回到 `new`,允许重试;发生在 acquire **之后**时,代码同样把 `phase` 写回 `new`,但另设 `startFencedError` 永久拒绝再次启动。于是实际存在一个**没有进入 `phase` 联合类型**的 `new(fenced)` 终态。

## 不拍板的代价

状态机有两个维度,而只有一个进了类型。读代码的人看到 `phase === "new"` 会以为可以重试,实际不能;状态图为了不撒谎也画不出这条边。

## 选项

- **A. 把 fenced 变成显式 phase。** 代价:`LifecyclePhase` 联合类型加一个成员,相关分支要更新。
- **B. 把第二个状态维度写进正式契约。** 明说 phase 之外还有一个 fenced latch。代价:状态机不再是单一枚举,理解成本更高。

## 倾向

文档给的是二选一,没有倾向。

## 决定

待拍板。

## 验收

状态机可以用一张不省略任何终态的图表达;`phase` 的类型面与实际可达状态一致。
