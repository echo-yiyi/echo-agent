# `main` 才能创建 session;状态两份都在盘上(meta 的 `status` + `status.json`)

> 状态:proposed · 提出 2026-09-03 · 拍板 2026-09-03(口头,实现后移入 implemented) · 来源 [会话与 agent 集群](../../design/sessions.md) §6

## 现状(拍板前)

会话身份 = workspace + agent(2026-09-01,提交 38db907),没有「谁起的」这一维;`AgentStatus`(idle / generating / acting / compacting)只在进程内可读,别的进程看不到一段 session 在忙还是没人。`/clear` 走 `reset()` 只清内存,盘上不留痕。

## 不拍板的代价

任何一段都能开新段,扇出没有边界,会自己繁殖;`session_list` 只能列目录、说不出对方能不能马上回;`/clear` 之后 `--resume` 把清掉的对话整个带回来。

## 选项

- **A. `main` 标识 + 两份状态。** 判据是**谁调的 create**:经容器路径(cli 启动、`/clear`、宿主 API `echo.sessions.create`)建的为 main,经 extension 面(`session_create` 工具)建的都不是;只有 main 挂 `session_create`,且容器要给了 `SessionRunner`(否则工具承诺了系统不交付的事),扇出一层。runner 的返回契约是「resolve = 那段已持有 lease」;reject 或超时(缺省 30 秒)→ `create` 判红、刚建的段置 `closed` 留痕,不产生活着但不会跑的孤儿段。持久状态 `active` / `closed` 在 meta,由 `session_close` / `/clear` 写,容器退出不写;运行状态 `{ phase: idle | working }` 在 `status.json`,持有 lease 的进程在切换时写。`session_list` 一行 = meta + lease + `status.json`,在 core 合成一次:`alive === false` 时 `phase` 恒为 `null`,崩在 working 的段不会被读成正在忙。
- **B. 不分 main,靠深度上限。** 每段记 `depth`,超过 N 拒绝。
- **C. 只有持久状态。** 运行态靠 lease 判活,不写 `status.json`。

## 决定

**A**(2026-09-03 用户拍板:「给 session 一个 main 的标识,只有 main 有创建 session 的能力,同时每个 session 都有对应的状态」)。附带:一台机器可以有多个 main;宿主程序的 `echo.sessions.create` 不受 main 限制;`/clear` = 关当前段(closed)+ 新建 + attach,协议上的 `reset()` 删;`closed` 的段缺省不列、`send` 返回 rejected。

## 验收

非 main 的 session 工具表里没有 `session_create`,没给 `SessionRunner` 的容器里 main 也没有,宿主 API 的 `create` 不受限;`/clear` 后旧段 `status = closed`、新段 id 不同且 `main = true`,`--resume` 旧段回来的是清之前的对话,`--continue` 挑到新段;一段在 `working` 时 `status.json` 的 `phase` 为 working,回 idle 后为 idle;进程在 working 时被杀,`session_list` 里它 `alive = false`、`phase = null`;runner 抛错或超时,`create` 判红、那段 `status = closed`、缺省不列。
