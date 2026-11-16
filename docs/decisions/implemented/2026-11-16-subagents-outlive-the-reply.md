# 后台子 agent 跑完才收摊；子 agent 缺省 100 轮

> 状态:implemented · 提出 2026-11-16（用户：「有时候开几个子 agent 去做事情，感觉就被关闭了」）· 拍板 2026-11-16（用户：「第 1 条直接修，第 2 条按你建议给 100」）· 落地 `packages/core/src/agent.ts`、`packages/core/src/extension/runtime.ts` / `builtin.ts`、`packages/core/src/subagent/tool.ts`、`packages/base/src/run.ts` / `cli.ts`，判据见验收 · 承接 [subagent 的回执与模式](2026-09-14-subagent-report-and-modes.md)

**给谁看**：改子 agent、宿主收摊（管道形态、`--serve`）或运行协议的人。假设已知 [subagent 的回执与模式](2026-09-14-subagent-report-and-modes.md)。

## 现状（拍板前）

子 agent 没做完就停掉的路有四条，前两条是缺陷：

1. **宿主不等后台子 agent。** 管道形态在主回复结束后马上 `echo.stop()`（`packages/base/src/run.ts`）；`--serve` 只看主 agent 自己的状态，空闲 60 秒就收摊（`packages/base/src/cli.ts`）。`stop()` 会停掉所有后台任务——模型用 `background: true` 派出子 agent、回一句「派出去了」就结束这一轮，子 agent 跟着被停，回执与收尾永远回不来。
2. **子 agent 的预算沿用父的。** 模型没给 `max_iterations` 时，子 agent 用父的每轮上限；echo-agent 是内核缺省 20。查代码、读文件这类委派二十来次工具调用就撞顶，以「迭代上限 20」失败收场。
3. 按 Esc 停当前这一步：前台子 agent 是这一步里的工具调用，一起停（设计如此）。
4. 会话结束（退出、换段、锁被接管）时后台任务一起停（设计如此：agent 起的东西不能比 agent 活得久）。

## 决定

1. **运行协议多一个只读量** [`AgentRuntime.hasPendingWork`](../../../packages/core/src/extension/runtime.ts#symbol=AgentRuntime)：在跑的 run、在跑的后台子 agent、inbox 里会被自动消费却还没消费的消息（含正在落盘的投递）。
   - **不算后台 `bash` 作业**：dev server、watcher 不会自己结束，算进来管道形态就永远退不出——它们照旧随收摊停。
   - inbox 停了自动消费（失败、让位）时不算 inbox：没人会消费，等也等不到。
2. **管道形态**输入耗尽之后，等 `hasPendingWork` 变 false 再 `stop()`。收尾通知触发的那几轮正文照样打到标准输出；中止信号照样能打断这段等待。
3. **`--serve`** 把 `hasPendingWork` 算进「忙」：后台子 agent 还在跑、回执还没处理完时不计空闲。
4. **子 agent 缺省 100 轮**（[`SUBAGENT_DEFAULT_MAX_ITERATIONS`](../../../packages/core/src/subagent/tool.ts#symbol=SUBAGENT_DEFAULT_MAX_ITERATIONS)），不再沿用父的每轮上限；模型仍可自己给，封顶 500 不变。

## Non-Goals

- 不改 Esc 与会话结束时的停法（第 3、4 条）。
- 管道形态的等待不另设上限：子 agent 有自己的轮数预算，中止信号能打断等待。
- 交互形态不动：界面开着，后台子 agent 本来就跑完、收尾照常进来。

## 验收

去掉对应改动，这几条都是红的：

- [`hasPendingWork` 等到收尾处理完](../../../packages/core/test/subagent.test.ts#test=haspendingwork后台子-agent-在跑就算有活它的收尾通知被父处理完才变-false后台的普通作业dev-server-之类不算)、[自动消费停了不算 inbox](../../../packages/core/test/subagent.test.ts#test=haspendingworkinbox-停了自动消费时不算-inbox-里的消息没人会消费等也等不到)
- [管道形态等后台子 agent](../../../packages/cli/test/cli.test.ts#test=管道形态等后台子-agent-跑完收尾被处理完才收摊2026-11-16此前主回复一结束就-stop后台子-agent-被一起停掉结果回不来)
- [子 agent 缺省 100 轮](../../../packages/core/test/subagent.test.ts#test=子-agent-没给-maxiterations-时预算是-100不跟父的每轮上限走父只有-3-轮子做-5-轮照样做完)
- `--serve` 那一处只是把同一个量算进「忙」，没有单独的判据（纪律，不是门）。
