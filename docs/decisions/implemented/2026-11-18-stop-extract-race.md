# 退出补提取到点后不再起提取；循环等模型时不依赖 provider 配合中止

> 状态:implemented · 提出 2026-11-18（产品方对 0.12.0 的缺陷报告：退出补提取到点后，又冒出一次提取往已卸掉的记忆模块里写，`outside_regions`、模块列表为空；provider 不理会取消时收摊被拖到它返回）· 拍板 2026-11-18（用户转来报告与验收判据，要求修复）· 落地 `packages/core/src/agent.ts`（`Agent.settleMemory`）、`packages/core/src/loop/run-turn.ts`（attempt 消费模型流），判据见验收

**给谁看**：改收摊顺序、记忆提取通道或循环 attempt 的人；在意退出时记忆是否完整的宿主。

## 现状（0.12.0）

1. [`Agent.settleMemory`](../../../packages/core/src/agent.ts#symbol=Agent.settleMemory) 的工作协程为了应对「排进通道的这次被随后排进来的一次顶掉」，最多重排 3 次。到点时它中止在跑的提取并清掉通道里排着的补跑（`MemoryChannel.settle`），然后返回 `aborted`——但**工作协程没被拦住**：它醒来发现自己那次没有结局，当成被顶掉又排一次。这时 `memoryWorkAllowed` 仍为真（`createEcho()` 的 `stop()` 卸完扩展才改相位），新的这次在 `stop()` 卸 builtin 之后开跑，往卸掉的记忆模块里写，全被拒（`outside_regions`，模块列表为空）。
2. 循环 attempt 用 `for await` 消费模型流，没有与中止信号赛跑。provider 不理会取消时，被中止的那一轮一直等它；收摊里等记忆通道停下的那几处（`settleMemory` 到点、`stop` / `dispose` / 丢锁善后里的 `settleDream`）也就跟着一直等。

## 决定

1. **到点之后工作协程不再排**：`timedOut` 在计时器回调里同步置位，工作协程每次排之前看它。到点后先中止并等通道收完，**再等工作协程本身收完**才返回——它此刻只剩收尾（通道已空、不会再排），所以这一等有界。`settleMemory` 返回之后，不会再有它排出来的提取；卸载与补提取之间的先后由这里定死。结局 `aborted`，游标不动，续会话时这段再看。
2. **循环等模型时与中止信号赛跑**：等 `streamFn(...)` 拿到流、等流的每一块，都用与授权那一步同一个 `raceAbort`。赛输了就不再等 provider：用已经流出来的半截合成一条 aborted 定稿（与 provider 自己报 aborted 时同一个 `finalizeError`），照常入账、`message_end`、`attempt_end{aborted}`；迭代器的 `return()` 只发不等。signal 照旧交给 provider，配合的 provider 照旧收得干净。
3. 单写者的保证不放松：收摊仍等记忆通道真的停下才交出租约；停下不再依赖 provider 配合。被中止的那一轮本来就不再启动工具（`runOneTool` 入口看 signal），赛输之后 provider 迟到的回复没人消费。
4. **改一条过时的测试**：`dream-schedule.test.ts` 的 P0 测试原来断言「整理卡在模型调用上时 `stop()` 不许返回」——那是旧的保证手段（陪 provider 等），不是要守的性质。现在改成直接断言性质：provider 挂着时 `stop()` 有界返回；之后放行 provider，记忆文件一笔不变、整理没有提交。

## Non-Goals

- 不给工具执行加同样的赛跑：工具收到 signal，执行体（`bash` 这类）各自负责停；这次只管等模型那一段。
- 不改 `settleDream` / `MemoryChannel.settle` 的「等到真停」语义，也不给它们另加时限：等的那一轮现在不依赖 provider，就是有界的。
- 不重试被中止的补提取：到点就是到点，没看完的那段留给续会话。

## 验收

- [到点之后不再起提取](../../../packages/core/test/create-echo.test.ts#test=退出补提取到点之后不再有提取写进卸掉的记忆模块2026-11-180120-的缺陷到点中止在跑的那次清掉排着的补跑此前还会再排一次在卸载之后跑写入全被拒结局-aborted游标不动续会话再看一次补上)：后台提取写了 A、卡在写 B 的模型调用上（收到取消就结束）时 `stop()`；到点后结局 `aborted`，提取调用停在 2 次、没有写入被拒、只有 A、没有 `memory_reviewed`；续上同一会话再说一句，B 补上、A 原文不变，`memory_reviewed` 为 `[0, 8) completed`。撤掉决定 1 这条是红的（提取调用变成 4 次）。
- [provider 永不返回时退出有界](../../../packages/core/test/create-echo.test.ts#test=provider-不理会取消永不返回时退出照样有界2026-11-18到点不再等它收摊返回-aborted之后没有提取再起)：provider 不理会取消、永不返回；`stop()` 在 3 秒内返回 `aborted`，之后没有提取再起。撤掉决定 2 这条是红的（一直在等）。
- [stop 之后整理写不进记忆](../../../packages/core/test/dream-schedule.test.ts#test=p0stop-返回之后旧-agent-的整理不能再写-memory卡在不理会中止的模型调用上也一样而且-stop-不陪它干等2026-11-18)：整理卡在不理会中止的模型调用上，`stop()` 有界返回；之后模型才返回，记忆文件不变、`lastAt` 仍为空。
- [循环不等不理会中止的 provider](../../../packages/core/test/loop-layers.test.ts#test=provider-不理会中止时循环不等它2026-11-18abort-之后这一轮照样以-aborted-收场已经流出来的半截入账)：前台 `abort()` 后这一轮以 `aborted` 收场，已经流出来的半截入账。撤掉决定 2 这条是红的。
