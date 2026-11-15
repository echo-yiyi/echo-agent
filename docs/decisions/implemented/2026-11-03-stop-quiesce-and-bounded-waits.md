# echo.stop() 先停接活再卸 extension；热部署装载与收摊卸载各有等待上限

> 状态:implemented · 提出 2026-11-03（全仓 review）· 拍板 2026-11-03（用户：按推荐修）· 来源 [`createEcho`](../../../packages/core/src/create-echo.ts#symbol=createEcho) · **后续** 2026-11-13 [装载的时限放进 Host](2026-11-13-host-apply-limit.md)：选项 B 在装载这一半改为采纳；「热部署」一条里装配层的限时与迟到补记、「不覆盖」一条、验收里热部署报 `lost` 的说法已被它取代，收摊卸载的上限不变

## 现状(拍板前)

`echo.stop()` 的顺序是：补提取 → 逆序卸所有 extension 代 → `agent.stop()`。两处问题（review 复现）：

1. 卸载是逐代 await 的，disposer 有 I/O（关连接、杀子进程）时要几百毫秒。这期间 Agent 照收新工作：新 prompt 跑在产品工具与身份段已经卸掉的 agent 上，回答落进 transcript。
2. 热部署整个跑在 admission 的 permit 里，扩展的 apply 等一个永远不来的连接时，permit 一直不放，之后所有 prompt 被拒；用户按 Ctrl+C，`echo.stop()` 的卸载排在那次挂住的换代后面（同一条 Host 队列），`agent.stop()` 永远轮不到，lease 不还。

## 不拍板的代价

收摊窗口里产出没有产品身份的回答；一个不合作的扩展能让会话再也不接活、进程退不掉、状态根的锁被扣住。

## 选项

- **A. 先停接活再卸；两处等待设上限。** 事务本身中断不了，只是不再等它；迟到的结果补记进账。
- **B. 给 Host 加通用的 start / dispose 超时与强制中止。** 改 Host 语义，且强制中止不了不合作的代码，收益与 A 相同。

## 决定

**A**（2026-11-03 用户拍板「按推荐修」）。

- `echo.stop()`：`Agent.quiesce()`（Host-internal：不接新工作、不收新的 durable 投递、中止在跑的 run 并等它与它那批 inbox 的 ack 收尾；不改相位、不还 lease）→ 补提取 → 逆序卸，限时 `STOP_UNMOUNT_LIMIT_MS`（10s），到点不再等 → `agent.stop()`。卸载超时时 `stop()` 以这条错误 reject，lease 照常交还。
- 热部署：每个扩展的 mount / replace 与 `RELOAD_APPLY_LIMIT_MS`（30s）及 permit 的 signal 赛跑；到点新文件报 `failed`、换代报 `lost`，诊断 `extension_apply_timeout`，permit 交还；事务迟到的结果（装上 / 装回旧版）补记进账，收摊照样卸得到。
- 不覆盖：启动时盘上扩展的 apply 挂住仍会让 `createEcho()` 一直等——后面的代排在同一条 Host 队列上，绕不过去。机制以 [扩展、装配与所有权](../../design/extensions.md) 为准。

## 验收

`packages/core/test/create-echo.test.ts` 的「stop() 卸 extension 期间不接新工作」：慢 disposer 卸载期间 `acceptsWork` 为 false、`prompt()` 被拒。`packages/core/test/extension-reload.test.ts` 的「热部署时新版 apply 挂住」：到 `RELOAD_APPLY_LIMIT_MS` 后 reload 返回、该文件报 `lost`、诊断含 `extension_apply_timeout`，随后 `send()` 能完成；`stop()` 在 `STOP_UNMOUNT_LIMIT_MS` 后以「卸 extension 超过」reject，Agent 不再接活。
