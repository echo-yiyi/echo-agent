# 记忆三级作用域(session / project / user),`remember` 带 scope,替代「记忆用户级」

> 状态:proposed · 提出 2026-09-03 · 拍板 2026-09-03(口头,三级作用域) · **切法拍板 2026-09-07**(口头,分区与作用域怎么对、选层、顺序、落地次序,见「决定」末段;实现后移入 implemented) · 来源 [会话与 agent 集群](../../design/sessions.md) §2 · 替代 2026-09-01「记忆用户级、跨项目共享」

## 现状(拍板前)

memory 一层,在状态根下(`~/.echo/agents/default/memory/`),所有会话共用;dream 在每个 `Agent` 实例 idle 时整理这一份。状态根变成 session 目录之后(见 [状态根 = session 目录](2026-09-03-session-is-the-state-root.md)),memory 若跟着下去就变成每段一份、互不可见;若留在共享层,N 段 session 的 dream 同时整理同一份是真冲突。

## 不拍板的代价

要么记忆不共享(换个会话就失忆),要么给共享的 memory 加一把全局锁、dream 变成抢锁的 daemon——后者是往单写者设计里再加一种锁,而且「这个 HR 偏好周二面试」和「这个仓库跑测试用 bun test」本来就不该在同一层。

## 选项

- **A. 三级。** session 级(`~/.echo/sessions/<id>/memory/`)、project 级(`~/.echo/projects/<hash>/memory/`,按 workspace 分、存 home 下)、user 级(`~/.echo/memory/`)。`remember` 加 `scope` 参数由 agent 指定;dream 只整理 session 级。
- **B. 两级。** 只有 session 与 project,用户事实记进 project。
- **C. 一级共享 + 全局锁。** memory 留共享层,dream 抢 `memory/.lock`,拿到的跑。

## 决定

**A**(2026-09-03 用户拍板)。附带:project 一层存 home 下、不放进仓库(agent 自动写的东西不进 git);目录名是 workspace 的 48 位哈希,撞了没人会发现,所以目录里放 `workspace.json` 记原路径、打开时对一遍、不匹配判红;dream 不跨级提升;project / user 级的多写者保护归 memory 线,不在会话设计里解。

**切法(2026-09-07 用户拍板)。** 两个轴分开:**分区**是记的是什么(`agent.md` / `user.md` / 笔记与其索引 `INDEX.md`),**作用域**是谁看得见(session / project / user)。不是笛卡尔积,按下面两张表:

落盘(哪层有什么):

| 作用域 | `agent.md` | `user.md` | 笔记 + `INDEX.md` |
|---|---|---|---|
| user | 有 | 有 | 有 |
| project | 有 | 有 | 有 |
| session | 无 | 无 | 有(dream 只整理这份) |

注入(system prompt 里给模型看什么):

| 分区 | 注入哪几层 |
|---|---|
| `agent.md` | user + project |
| `user.md` | user + project |
| `INDEX.md` | user + project + session |

四条附带:
1. **选层走路径前缀,工具不加参数**:`/memories/user/agent.md`、`/memories/project/user.md`、`/memories/session/memory/x.md`。六动词文件工具的形状不变;注入的每段带自己的路径,模型改哪份就写哪个路径。
2. **顺序**:先 `agent.md` / `user.md`,后索引;同一分区内多层按 user → project → session,都渲染、不去重、各带路径标题。
3. **project / user 层多段 session 同时写先接受**:文件不会写坏(tmp + rename),后写的盖掉先写的改动,记成已知限制;dream 只碰 session 层,等常驻程序那种真多段场景出现再看。
4. **落地次序**:今天盘上那一层就是 user 层。先落 session 层(dream 改成只整理它,解掉 user 层多段同跑 dream 的冲突),project 层第二并带上 `remember` 的 `scope`。project 目录解析(`projects/<hash>/` 与 `workspace.json` 校验)core 里还没有,随这次一起做。

## 验收

`remember` 的三种 `scope` 各落到对应目录;两段不同 workspace 的 session 看不到彼此的 project 级记忆、看得到同一份 user 级;dream 跑完只有 session 级目录有变化。切法补三条:`memory` 工具对 `/memories/session/agent.md` 判红(session 层没有这个分区);同一 run 的 system prompt 里 `user.md` 恰好出现两段(user、project)、`INDEX.md` 恰好三段且顺序 user → project → session;两段 session 的 dream 同时跑,各自只改自己目录下的 `INDEX.md`。
