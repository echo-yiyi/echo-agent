# 收窄收摊入口:`dispose()` 与 `stop()` 的关系

> 状态:proposed · 提出 2026-09-01 · 来源 [Lifecycle 与 Run Loop](../../design/lifecycle-and-run-loop.md) §9

## 现状

`Agent.dispose()` 是公开方法,但只做资源清理,不推进实例 phase,也不释放 `StateLock`——lease 的释放在 `stop()` 里。lifecycle-managed 的 Agent 直接 `dispose()` 之后,同一个锁的第二次 acquire 仍然返回 null(探针输出 `LEASE_STILL_HELD`)。

## 不拍板的代价

使用者按直觉调 `dispose()` 收摊,进程退出后锁还在,下一次启动被拒——而错误信息指向锁,不指向真正的原因。这类问题在生产里表现为「重启不来了」,排查成本极高。

## 选项

- **A. 让 `dispose()` 非公开。** 对外只留 `stop()`(以及装配层的 `echo.stop()`)。代价:低层 `new Agent()` 的使用者少一个显式清理入口。
- **B. 让 `dispose()` 与 `stop()` 共享同一个完整的 single-flight 终止过程。** 代价:`dispose()` 的语义从「清资源」变成「完整收摊」,与名字不符。

## 倾向

文档倾向 A。

## 决定

待拍板。

## 验收

lifecycle-managed 的 Agent 无法通过公开 API 在不释放 lease 的情况下走完收摊;有测试覆盖「dispose 之后锁已释放」或「dispose 不再可达」。
