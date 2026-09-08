# 状态根 = session 目录，替代「状态根用户级 agents/<agentId>/」

> 状态:implemented · 提出 2026-09-03 · 拍板 2026-09-03(口头) · 实现 2026-09-03(d893c6e;门 `packages/core/test/sessions-cross-process.test.ts`,2026-09-08 review 复核后移入) · 来源 [会话与 agent 集群](../../design/sessions.md) §2–§3 · 替代 2026-09-01「状态根用户级」(`packages/core/src/create-agent.ts` 的 `resolveStateDir()` 注释)

## 现状(拍板前)

状态根是 `~/.echo/agents/<agentId>/`,一把 `.lock` 锁整个根,lease、inbox、tasks、schedule、dream、observability、sessions 全在根下按 agent 一份。两个 echo-coding 同时起,第二个 `acquire` 返回 null 直接 fail-loud。会话之间没有通道。2026-09-01 把状态根从项目内改到用户级,理由是「workspace 成了 session 的字段之后,记忆与技能要跨项目共享」。

## 不拍板的代价

多段会话同时工作(终端里两个 echo-coding 各干各的、常驻程序里几十段)在现有布局下要么各自一个状态根(记忆不共享),要么共用一个根(lease 冲突、inbox 混在一起)。每加一段就要在 core 里补一层「按 session 分」的键,inbox、tasks、schedule 各补各的。

## 选项

- **A. 状态根 = session 目录。** `~/.echo/sessions/<id>/` 就是那段 session 的状态根,今天按状态根一份的东西自动按 session 一份,代码不动;跨 session 共享的(memory、skills)提到 project / user 两层。
- **B. 状态根不动,每个端口各自按 session 分键。** lease 缩到 `sessions/<id>/.lock`,inbox 改成 `sessions/<id>/inbox/`,tasks、schedule 同理,逐个改。
- **C. 一个容器一个状态根。** 同进程多段共用一把锁,跨进程各一个根;记忆跨容器不共享。

## 决定

**A**(2026-09-03 用户拍板)。附带:`agents/<agentId>/` 这一层退场,session 的 meta 里记着自己是哪个 agent;`SessionService` 的 meta / entries 上提到目录根,`list()` 扫 `~/.echo/sessions/`;lease 代码不改,路径随状态根变成每段一把。

## 验收

resident 集成测试的宿主程序起两个进程、两个 session id、同一个 `ECHO_HOME`,两个 `start()` 都成功,各自的 `.lock` 在各自目录里;`~/.echo/agents/` 不再被创建。
