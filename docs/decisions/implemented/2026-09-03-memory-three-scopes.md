# 记忆三级作用域(session / project / user),`remember` 带 scope,替代「记忆用户级」

> 状态:implemented · 提出 2026-09-03 · 拍板 2026-09-03(口头,三级作用域) · **切法拍板 2026-09-07**(口头,分区与作用域怎么对、选层、顺序、落地次序,见「决定」末段) · **project 层跟谁走拍板 2026-09-07**(口头,跟 resume、不跟 `setWorkspace()`,见「决定」的「project 层指哪个目录」) · 合入 2026-09-07 · 来源 [会话与 agent 集群](../../design/sessions.md) §2 · 替代 2026-09-01「记忆用户级、跨项目共享」

## 现状(拍板前)

memory 一层,在状态根下(`~/.echo/agents/default/memory/`),所有会话共用;dream 在每个 `Agent` 实例 idle 时整理这一份。状态根变成 session 目录之后(见 [状态根 = session 目录](../proposed/2026-09-03-session-is-the-state-root.md)),memory 若跟着下去就变成每段一份、互不可见;若留在共享层,N 段 session 的 dream 同时整理同一份是真冲突。

## 不拍板的代价

要么记忆不共享(换个会话就失忆),要么给共享的 memory 加一把全局锁、dream 变成抢锁的 daemon——后者是往单写者设计里再加一种锁,而且「这个 HR 偏好周二面试」和「这个仓库跑测试用 bun test」本来就不该在同一层。

## 选项

- **A. 三级。** session 级(`~/.echo/sessions/<id>/memory/`)、project 级(`~/.echo/projects/<hash>/memory/`,按 workspace 分、存 home 下)、user 级(`~/.echo/memory/`)。`remember` 加 `scope` 参数由 agent 指定;dream 只整理 session 级。
- **B. 两级。** 只有 session 与 project,用户事实记进 project。
- **C. 一级共享 + 全局锁。** memory 留共享层,dream 抢 `memory/.lock`,拿到的跑。

## 决定

**A**(2026-09-03 用户拍板)。附带:project 一层存 home 下、不放进仓库(agent 自动写的东西不进 git);目录名是 workspace 的 48 位哈希,撞了没人会发现,所以目录里放 `workspace.json` 记原路径、打开时对一遍、不匹配判红;dream 不跨级提升;project / user 级的多写者保护归 memory 线,不在会话设计里解。

**切法(2026-09-07 用户拍板)。** 两个轴分开:**分区**是记的是什么(`agent.md` / `user.md` / 笔记与其索引 `INDEX.md`),**作用域**是谁看得见(session / project / user),**不是笛卡尔积**。

**哪层有哪些分区、每种分区注入哪几层、怎么选层、什么顺序,两张表加三条配套规矩在 [会话与 agent 集群](../../design/sessions.md) §2**,本条不复述。

为什么这么切:`user.md`(这个人是谁)与 `agent.md`(我是谁)在换一个项目之后仍然成立,所以它们要跨 session 活着——落 session 层就是每开一段失忆一次;而笔记是 dream 的工作面,dream 一旦整理跨 session 共享的那份,多段同时跑就是多写者,今天挡它的只有一个带过期的软锁。**session 层只放笔记**,正是为了让 dream 的整理范围与它的写者数量对上——一段 session 只有一个写者,冲突从结构上没有了。选层走路径前缀而不是给工具加参数,是因为六动词文件工具的形状不该为了作用域这件事变;路径本来就要出现在注入的文本里,让它同时当选择器,不多一个概念。

**project 层指哪个目录(2026-09-07 用户拍板)。** 切法落地时它按**装配期**的 `opts.workspace` 定死,而 workspace 是 session 级事实,于是两处不对:

- **跟 resume**:`--resume` 一段在别的目录建的会话时,真实 workspace 要到 `start()` 里 `createOrResume` 返回才知道(盘上为准)。指着装配期那个 = 读写了错误项目的记忆。**修**:`start()` 拿到权威值之后**重指一次**。
- **不跟 `setWorkspace()`**:运行中换工作目录(echo-coding 的 worktree 隔离)**故意不重指**——同一个仓库换个 worktree 路径就换一套项目记忆,不是想要的行为。

守住四条:
1. **重指只发生一次**,在 `start()` 里 session 恢复之后、任何自主活动(skill 发现、闹钟补跑、inbox 重放)与 `sessionStart` 钩子之前。「一次」由 [`projectScopeBinding`](../../../packages/core/src/memory/scope.ts#symbol=projectScopeBinding) 自己保证,不靠调用点只调一次。
2. **撞车检查不写第二套**:重指走的还是装配期那条 [`assertProjectWorkspace()`](../../../packages/core/src/memory/scope.ts#symbol=assertProjectWorkspace),新目录里 `workspace.json` 与新 workspace 对不上就抛,于是 `start()` 判红;抛出去时这次重指不算生效。
3. **装配期那次检查保留**:不给 `sessionId` 时(缺省每次新建一段)workspace 就是装配期这个,早点判红比晚点好。
4. **写入闸不动**:重指本身一个字节都不写,`workspace.json` 的留痕仍归 `withWorkspaceStamp` 的「第一次真写时才落」——重指时租约刚拿到、`restore-migration` 才开,不该顺手在 home 下建一个没人写过的空目录。

重指口是 host-internal 接线(`memory/host-wiring.ts`),与写入总闸、观测 writer 同一个模式:不进公共 `AgentOptions`,只由同包的 composition root 在构造之后挂上。低层 `new Agent({ memory })` 自己装记忆的宿主没有这一层,那一步是空操作。

## 验收

`remember` 的三种 `scope` 各落到对应目录;两段不同 workspace 的 session 看不到彼此的 project 级记忆、看得到同一份 user 级;dream 跑完只有 session 级目录有变化。切法补三条:`memory` 工具对 `/memories/session/agent.md` 判红(session 层没有这个分区);同一 run 的 system prompt 里 `user.md` 恰好出现两段(user、project)、`INDEX.md` 恰好三段且顺序 user → project → session;两段 session 的 dream 同时跑,各自只改自己目录下的 `INDEX.md`。

「project 层指哪个目录」补三条:resume 一段 workspace 与装配期不同的会话,`start()` 之后往 project 层写的东西落在**新** workspace 的哈希目录下、装配期那个目录一次都没被创建;同一段里再 `setWorkspace()` 到第三个目录,project 层不动;新目录里 `workspace.json` 记的是别的路径时 `start()` 判红。
