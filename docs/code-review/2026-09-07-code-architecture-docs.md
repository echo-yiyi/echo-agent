# 代码 · 架构 · 文档三层 review（2026-09-07）

> 读者：要修这批问题、或要判断开源前还差什么的人。假设已读 [CONTEXT.md](../../CONTEXT.md) 与 [docs/architecture.md](../architecture.md)，用词照它们<br>
> 靶子：main `98922e9`（2026-09-07）。基线先跑过：`bun run typecheck` 退出码 0；`bun test` 1372 通过 / 0 失败（78 个文件）；`bun scripts/docs-lint.ts` 0 违规<br>
> 方法：切 25 条车道并行读代码与测试（代码 13 / 架构 6 / 文档 6），每条发现再经两个独立视角复核——「已有门或决策是否已覆盖」与「打开代码尽力证伪」。判据用的是仓库自己立的（[docs/review/PROMPT.md](../review/PROMPT.md) 那一套），不是通用最佳实践<br>
> 复核状态：**13 条代码车道与「公共面」那条完成了完整复核（59 条双视角确认）；5 条架构车道与 6 条文档车道只完成了「找」，复核因会话额度耗尽全部失败（60 条未经证伪）**。另有 3 条两个视角意见相反、1 条判为噪音。三个「找漏」agent 也没跑成，所以**覆盖面本身没被检查过**。下文凡未复核的都标了出来；其中多条与已复核的代码发现互相印证。作者另外亲手抽验了 4 条最要命的，全部坐实<br>
> 逐条原文（证据、复现时序、最小改法、复核修正）在 [同名 .findings.md](2026-09-07-code-architecture-docs.findings.md)；本文只做归纳<br>
> 怎么关闭：每条发现要么变成一个提交（提交信息引用本文条目），要么变成一条 `docs/decisions/` 记录（明确接受这个取舍）。本文是点时快照，不随代码维护，历史由 Git 保留

## 一句话

这是一个工程纪律相当罕见的仓库——64k 行、1372 个测试全绿、文档门 0 违规、词表和决策记录成体系；但它的**硬约定被自己的代码破了几处，而且破在最要命的地方**：single-writer 会静默丢掉别人的整个状态根，会话之间唯一的通道（inbox）上有三条会丢消息或无限重投，coding 的工作区边界只挡住一半工具。文档层的问题是同一个模式：**文档跑在代码前面**，把还没落地的决策写成了现状。

## 什么不算发现

- 测试红、门红——基线全绿，下面每条都是「门没守住而它真的会错」。
- [docs/architecture.md](../architecture.md) §7 列的「已拍板未实现」——那是已知计划。
- 已经被 `docs/decisions/` 明确接受的取舍。
- 风格、命名偏好、「可以加个抽象层」「该加一道门」。

---

## 一、代码层：真正会出事的

### 1. 一条静默毁数据的链子（作者亲手验过两段）

三处合起来会让**丢锁的那个进程删掉接班者的整个状态根，而 `stop()` 报成功**：

- `SessionService.discardIfUnused()`（`packages/core/src/session/service.ts:285`）是这个类上**唯一不查 `this.sealed` 的写路径**——`append`（:206）、`rename`（:252）、`setPhase`（:304）都查。
- 于是丢锁之后 `dispose()`（`packages/core/src/agent.ts:2940-2943`）仍会去 `remove("meta.json")`，尽管 `watchLease` 刚在 `agent.ts:1900-1903` 立过 loss fence，注释原话是「状态根已经不归本进程」。
- 接着 `removeIfEmptySession()`（`packages/core/src/create-agent.ts:676-677`）看到「没有 meta.json + 剩下的都是我们的东西」就 `rm(stateDir, { recursive: true, force: true })`——而 `SESSION_DIR_OWNED`（:654）**把 `.lock` 也算作我们的东西**。

后两段作者核实（`.lock` 确实在集合里、`rm -rf` 确实无 lease 判据）；复核 agent 用仓内 `InMemoryStateLock.simulateLost` 跑出了完整后果：接班者写了 meta → 旧实例 `stop()` 返回 OK → meta 与整个目录没了。**single-writer 和 fail-loud 同时破，且静默。** 最小改法：`service.ts:286` 那行 poisoned 判据旁边加 `this.sealed`（一行，与 `setPhase` 逐字同形）；`removeIfEmptySession` 那道 `rm -rf` 单独加一条「我还持有 lease」。

### 2. inbox 三条 P1——会话之间只有这一条通道

- **别人刚投进来的消息被撤成孤儿**：空会话收摊那道「有留言就不撤」的闸看的是**内存计数**，别的进程刚写进 `inbox/` 的 record 不在里面，而 `send()` 已经回了 `accepted`。
- **已 ack 的 record 每秒重投，无上界**：`refresh()` 不看 ack marker，`/clear` 因此形同虚设。
- **新事实永久消失**：ack barrier 立在一个 `await` 之后，那段窗口里同 `dedupeKey` 的 accept 会 dedupe 到一条即将被删的 record。

### 3. 安全：coding 的工作区边界是半道墙（作者亲手验过）

- `grep` / `glob` / `list_dir` **完全没有边界**：`packages/coding/src/tools/search.ts:29-30` 的 `resolveTarget` 对绝对路径原样放行（`isAbsolute(path) ? path : resolve(ctx.workspace, path)`），`relative()` 只用来显示。而送给模型的 system 段明说「工作区之外的路径会被拒」。
- `resolveSafe`（`packages/coding/src/tools/fs.ts:54-58`）只做字符串前缀比较、**不解 symlink**——工作区里一条软链就能读写外面。它只覆盖 `read_file` / `write_file` / `edit_file` 三处。
- `DEFAULT_PERMISSION` 自称「动手的先问」，实际只写死三件工具名：删 worktree、写 skill / schedule 都走 fallback 放行。

### 4. 观测层是状态根里唯一不受管的写者（四条车道独立指向同一件事）

观测库在**装配期**就建目录、建 SQLite、跑 DDL——那是拿到 lease 之前；它不过写入闸；丢锁之后 `stop()` 仍会把 ring flush 进已经不归自己的目录。为它准备的三处机制（canonical-observation lane、`StateLeaseLifecycle`、Sequencer 的 lost-lease）**生产侧全是死的，只有测试造过假的**。而 [architecture.md](../architecture.md) §6 和 `packages/core/src/state/write-gate.ts` 自己的注释都写着「拿到 lease 之前、revoke 之后任何状态根 I/O 都被拒」。

### 5. 声明了、验形了、观测了，就是没接上

- **thinkingLevel**（作者亲手验过）：`packages/core/src/provider/openai.ts` 里 `thinkingLevel` 一次都没出现，而 `thinkingLevelMap` 被 `provider/types.ts:45`、`admission/model-snapshot.ts:165-174`、`observability/assembly.ts:57` 三处认真处理。结果：Shift+Tab 换档、协议 `setThinkingLevel`、压缩显式要的 `"off"`，**请求体一个字节都不变**。
- **OAuth**：`checkAuth` 报「配好了（OAuth）」，`stream()` 不带任何 Authorization 头发出去，`refresh()` 全仓无人调用。
- **图片**：`ModelCapabilities.vision` 无人读，`toolResult.images` 被唯一方言默默丢掉——但压缩按 1200 token/张给它计费。
- **`--serve` 宿主**：一被叫醒干活就自己收摊，把要处理的那条消息当场掐掉；交还锁之后还每 50ms 轮询，**进程永不退出**。

另有 30 余条 P2（cron `*/N` 在日/月两段差一位、`edit_file` 空 `old_string` + `replace_all` 逐字符插入毁文件、bash 输出跨块切坏多字节字符、observe 面板不校验 Host 可被 DNS rebinding 读走、`killBackground` 宽限计时器不清除导致退出多等 5 秒……），见索引与逐条原文。

---

## 二、架构层（这一层只完成了「找」，未经证伪）

**1. 公共面有三个互相矛盾的真源。** 随 tarball 发出去的三份 README 以现状口吻写「`Agent` 类是内部的」，而 `packages/core/src/index.ts` 仍在导出它、还在推销「两个使用高度：低 = `new Agent()`」，`CLAUDE.md` / `AGENTS.md` 开篇继续教人围着 `Agent` 自己接端口——而那条决策还躺在 `proposed/`。**刚把受众定成「第三方可装的内核」，这是第一块绊脚石。** 更硬的一条：`echo-agent` 包的 exports 只有 `bun` 一支，第三方用 Node 直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`，普通 tsconfig 拿不到任何类型。（这一条属于完成了复核的「公共面」车道。）

**2. 「一个装配现场」这条不变量有裂缝。** 给了 `stateDir` 时，`createEcho()` 的会话面按 `sessionsRoot` **另算一遍**自己那一段的目录——同一件事两个数法，后果是非 main 的会话也拿到了 `session_create`，而给了 `stateDir` 的宿主「会话面看不见自己」。另外 `echo:session-name` 这条 hook 直接注册在 `agent.hooks` 上，绕过了 ExtensionHost。

**3. 扩展 ABI 有一个安全口子。** ABI 说「single 恰好一个 provider、重复 provide fail-loud」，实际**只在同一代内成立**——盘上任一扩展能静默劫持 `AgentRuntimeService`，把壳绑到假 runtime 上。而「回答只能来自可信宿主」这句承诺没有门。

---

## 三、文档层：一个模式——文档跑在代码前面（同样未经证伪）

- **把还没落地的决策写成现状**：三份 README 说 `Agent` 是内部的（实际仍导出）；[architecture.md](../architecture.md) §7 标题写「未实现」，表里却有五行自称「已合入 / 已实现」。
- **已经拍板的没跟着走**：[lifecycle-and-run-loop.md](../design/lifecycle-and-run-loop.md) §9 九项待拍板已有八项在 9-07 拍了（四项进了 `rejected/`），文档仍写「必须在发布前解决」；`2026-09-03-session-is-the-state-root` 已完整落地并有绿测试，却还在 `proposed/`。
- **照文档实现会做反**：`2026-09-01-stop-continuation-limit` 的「验收」一节写的是**被否掉的那个选项**。
- **对贡献者说错话**：`CONTRIBUTING.md` 告诉人 docs-lint 只是 informational、filerefs 基线是红的——实际它 0 违规，且在 CI 和 `bun test` 里都是硬门。
- **`docs/review/tui-design.md` 是一份在维护的实现 spec + 八条决策记录**，却住在 manifest 自己声明「只放 prompt 与未纳入维护的 scratch」的免门目录里，而仓内八处源码把它当设计权威引用。

**最刺眼的是「声称有门、实际没有」这一类**——这恰恰是本仓自己最看重的规矩：

| 声称 | 实际 |
|---|---|
| 四层事件严格嵌套（architecture.md §8 列为有门；这条属于完成复核的 run-loop 车道） | 轮首 abort / deadline 会发出「没有 attempt 的 turn」「没有 turn 的 reply」 |
| 状态只能被事件改 | `apply` 这个方法根本不存在，`_state` 有 8 处事件路径之外的直接写 |
| 可让位交还，门在 `state-lock.test.ts` | 那个文件里一处 `preemptible` 都没有；真门 `lease-handoff.test.ts` 在门表里没登场 |
| 写入闸「任何状态根 I/O 都被拒」 | 只拦写和删，读与 list 直通 |
| key-discipline 守「`packages/cli/src/` 里」 | 只扫顶层不递归，`observe/` 三个文件在门外 |
| `zero-runtime-deps` 查「源码闭包」 | 只拦 `@modelcontextprotocol` 一个包名 |

---

## 四、作者另外核实的两条（车道没抓到）

1. **`packages/core/README.md` 的 quickstart 自相矛盾**：第 14-16 行教第三方 `await echo.agent.start()` / `echo.agent.prompt(...)`，第 32 行同一份文件又写「`Agent` 类是内部的」——而 `echo.send()` 就在旁边、正是那条第三方安全的路。
2. **同一份 README 的状态表停在三层作用域之前**：「记忆 | `<ECHO_HOME>/memory/`」是旧说法（`packages/core/src/memory/scope.ts:10,115` 已是 session / project / user 三层，project 层按 workspace hash 分）；因此第 66 行那句「换个目录起就是新的一段，**记忆与技能仍是同一份**」现在是错的。

另：`CLAUDE.md` 落后 `AGENTS.md` 两条规则（「登记表示受门约束，不表示内容已经批准」与整条「源码链接不用行号，用 `#symbol=` / `#test=`」，另一处证据措辞仍是旧的 `file:line`）——文档车道也独立发现了同一处漂移。

---

## 待拍板

1. **观测层**：纳入写入闸，还是把三处文档里「任何 I/O 都被拒」改成实话——二选一，别留半条链路。
2. **公共面**：`Agent` 类到底导不导出，三个真源要收敛成一个；这是 2026-09-07 根决策的直接后果。
3. **`docs/review/`**：`tui-design.md` 与 `architecture-draft.md` 是搬出登记还是退场。
4. **未复核的 60 条**：架构与文档两层的发现要不要补一轮证伪，还是按条目逐个人审。

## 建议的顺序

1. **先堵数据丢失**：`discardIfUnused` 补 `sealed`（一行）、`removeIfEmptySession` 补 lease 判据、inbox 那三条。这几条会静默毁用户数据，且都有最小改法。
2. **再补安全**：`search.ts` 三件工具接上边界、`resolveSafe` 换 `realpath`。coding agent 现在能读整块盘。
3. **接上没接的**：thinkingLevel 是用户按 Shift+Tab 就能发现的；OAuth 和图片两条要么接上要么把声明撤掉。
4. **观测层**：按上面待拍板第 1 条。
5. **开源前**：公共面三个真源收敛，`exports` 补 Node 一支。
6. **文档**：把「声称有门实际没有」那张表逐条改准——这条规矩是这个仓库最值钱的资产，破在自己手里最可惜。

---

## 附：123 条索引

状态含义——**双视角确认**：两个复核视角都判成立；**单视角存疑**：两个视角意见相反；**只找未验**：复核因额度耗尽未跑，只有车道自己的判断；**判为噪音**：两个视角都判不成立。每条的证据、复现时序、最小改法与复核修正见 [.findings.md](2026-09-07-code-architecture-docs.findings.md)。

**双视角确认（59 条）**

1. [P1] `admission-hooks-bg` · postToolUse 的 block 被静默丢弃：工具结果照样入账送模，后面的 postToolUse handler 还被短路
2. [P1] `agent-lifecycle` · 丢锁之后 dispose() 仍会去删状态根的 meta.json——loss fence 漏了 discardIfUnused 这条写路径
3. [P1] `arch-public-face` · 受众决策把「基于 echo-agent 的启动逻辑建产品」列为第三方三条路之一，但 echo-agent 包的 exports 只有 bun 一支：Node 直接 ERR_PACKAGE_PATH_NOT_EXPORTED，普通 tsconfig 拿不到任何类型
4. [P1] `arch-public-face` · 随 tarball 发出去的 README 以现状口吻说「Agent 类是内部的」，而 index.ts 仍在导出它、CLAUDE.md/AGENTS.md 还写着「定制 host 直接用 Agent」——同一件事三个互相矛盾的真源
5. [P1] `capabilities` · schedule_create 的 every_seconds 收到非有限数会绕过 60 秒下限闸，落盘成 everyMs:null，重启后每一拍触发一次
6. [P1] `capabilities` · tick 在 deliver 的 await 之后不重新校验条目是否还在，已被 schedule_cancel 取消的定时任务会复活并被写回盘
7. [P1] `cli-shell` · `--serve` 宿主一开始干活就自己收摊，把它被叫醒要处理的那条消息当场掐掉
8. [P1] `cli-shell` · `sessionRunner` 拿「锁文件存在」当「宿主跑起来了」，第一拍在子进程还没启动时就成立
9. [P1] `cli-shell` · workspace 的 AGENTS.md 能关掉 `<project-instructions>` 定界符，而文件头声称这里有结构隔离
10. [P1] `coding-tools` · grep / glob / list_dir 完全没有 workspace 边界，而送给模型的 system 段明说「工作区之外的路径会被拒」
11. [P1] `coding-tools` · resolveSafe 只做字符串前缀比较、不解 symlink：经工作区内的软链可以读、也可以写工作区之外的文件
12. [P1] `compaction-memory` · memory 的 delete 不查分区归属：模型能删掉自己建不出来的文件（记忆树内任意非分区文件）
13. [P1] `extension-abi` · `agentRegistries` 随 .d.ts 发布的 JSDoc 说 optional 依赖会拿到 `undefined` 自己降级，实现是直接抛——照它写的扩展整代装不上
14. [P1] `inbox` · ack barrier 立在一个 await 之后，那段窗口里同 dedupeKey 的 accept 仍会 dedupe 到即将被删的 record，新事实永久消失
15. [P1] `inbox` · refresh() 不看 ack marker：已逻辑 ack 的 record 每秒被重新投递一次，无上界；`/clear` 也因此形同虚设
16. [P1] `inbox` · 空会话收摊时那道「有留言就不撤」的闸看的是内存计数，别的会话刚投进来的一条会被撤成孤儿
17. [P1] `observability-core` · 观测 writer 是唯一不受写入闸管的状态根写者；为它准备的三处机制（canonical-observation lane、StateLeaseLifecycle、Sequencer 的 lost-lease）全是死的，而 architecture.md §6 与 write-gate.ts 都声称覆盖它
18. [P1] `provider-messages` · thinkingLevel 一路传到方言就断了：Shift+Tab 换档、协议 setThinkingLevel、压缩显式要的 "off"，请求体一个字节都不变
19. [P1] `run-loop` · 轮首 abort / deadline 会发出「没有 attempt 的 turn」和「没有 turn 的 reply」，四层严格嵌套这条被架构文档标成「有门守着」的不变量实际不成立
20. [P1] `session-storage` · preemptible 持有者交还锁之后仍每 50ms 轮询交还请求，`--serve` 宿主进程永不退出
21. [P1] `session-storage` · 别的进程刚投进来的 inbox record，会被目标会话收摊时连目录一起删掉——而 send() 已经回了 accepted
22. [P2] `admission-hooks-bg` · HookContext 的 origin / depth / hookId 是三个写死的常量，origin 对 userPromptSubmit 还是错的
23. [P2] `admission-hooks-bg` · OutputBuffer：单个 chunk 超过 maxOutputChars 就把整段输出丢光，注释承诺的「保留上限」实际保留 0
24. [P2] `admission-hooks-bg` · announce() 里产品给的 onEnd 抛错会逃成无人接管的 rejected promise（unhandledRejection）
25. [P2] `admission-hooks-bg` · fail-closed 的 hook 失败理由把内部 entry id 与脚本绝对路径送进模型可见的 toolResult
26. [P2] `admission-hooks-bg` · killBackground 的宽限计时器从不清除：dispose() 已经 resolve，进程还得再等 graceMs（缺省 5s）才退
27. [P2] `agent-lifecycle` · beginManagedWork() 里那句 publishPhase("idle") 是死调用——起来之后 status.json 一个字都不写
28. [P2] `agent-lifecycle` · 进入 lost 吸收态之后，inbox 轮询与 schedule 两个 timer 仍挂着——丢锁善后没停自己动的东西
29. [P2] `arch-public-face` · skill/public.ts 是条死入口：自称 `@echo-agent/core/skill` 但 exports 表里没有它，还随 tarball 发出去；而两处注释声称有一道「exports 表无死条目」的门在管这件事，全仓没有这道门
30. [P2] `capabilities` · TaskCreate 不执行 in_progress 的前置约束，文件头声称的「两处强制」实际只有一处
31. [P2] `capabilities` · cron 的 */N 在「日」「月」两段起点写死为 0，与标准 cron 差一位
32. [P2] `capabilities` · cron 补跑不看 createdAt：刚建的 cron 会在下次启动时补投一次它诞生之前的那一次
33. [P2] `capabilities` · subagent 把 disabled 与 deferred 的工具原样交给子循环，绕开 ToolBase.disabled 声称的「三处联动」
34. [P2] `cli-shell` · `/resume` 的「不空就不切」在 await 之前查、await 之后不复查，仍会掐掉在飞的那一轮
35. [P2] `cli-shell` · 叫醒会话时不转发 `--provider` / `--model` / `--observe`：宿主要么换个模型跑，要么根本起不来
36. [P2] `coding-tools` · DEFAULT_PERMISSION 自称「动手的先问」，实际只写死三件工具名，删 worktree、写 skill / schedule 都走 fallback 放行
37. [P2] `coding-tools` · bash 输出按 chunk 直接 d.toString()：跨块的多字节字符被解成替换符，模型看到的是坏字
38. [P2] `coding-tools` · edit_file 收到空 old_string + replace_all 会逐字符插入，静默毁掉整个文件
39. [P2] `coding-tools` · web_fetch 的 MAX_BYTES 注释声称限住内存，实际 arrayBuffer() 先把整个响应体收进内存才截
40. [P2] `compaction-memory` · 压缩阶段失败在官方产品里完全不可见：`compactionFailed` 只走 lifecycle，TUI 的 default 分支丢掉它，观测层也不收
41. [P2] `compaction-memory` · 记忆路径路由的报错以中文原文回给模型，而这正是训练行为最常撞的那条路径
42. [P2] `extension-abi` · ACTIVE 之后登记的 Effect，`start` 失败被彻底吞掉：fiber 照旧 ACTIVE、`unmount` 报成功、一条诊断都没有
43. [P2] `inbox` · inbox 观测事实的正文预算按 code unit 算、且只管单条，一批消息照样把整条 fact 顶成 gap——注释声称的保障不成立
44. [P2] `inbox` · session_send 把写盘失败折成 `invalid`，并把宿主的原始错误文本原样交给模型
45. [P2] `observability-core` · ring 满时产生的 hole+gap 自己不计入 ringCapacity，持续溢出下未提交内存无界；而且「丢一条」并不减少提交量，ring 满起不到卸载作用
46. [P2] `observability-core` · runBoundaries 与 runIndexCache 每个 run 一条、永不释放：常驻 agent 上是无界增长面
47. [P2] `observability-store` · observation_run_index.accepted_at 是 header.acceptedAt 的第二份且不在 index_digest 覆盖内，注释却声称「任何列被改过都在这里判红」
48. [P2] `observability-store` · observe 面板不校验 Host / Origin：只绑 127.0.0.1 挡不住浏览器里的页面，DNS rebinding 能把整个只读 API 读走
49. [P2] `observability-store` · 会话根下任一段的观测库打不开，整个 observe（含面板）对全部会话失败，且失败路径上已开的 reader 没人关
50. [P2] `provider-messages` · OAuth 那半边是死接线：checkAuth 报「配好了（OAuth）」，stream() 却不带任何 Authorization 头发出去，refresh() 全仓无人调用
51. [P2] `provider-messages` · createProvider 的刷新去重会永久卡死：第一次 refreshModels 走 allowNetwork:false（或已 abort 的 signal）之后，fetchModels 再也不会被调用
52. [P2] `provider-messages` · 发给模型的工具失败标记是中文「[工具执行失败]」，与全仓已拍板的「模型面全英文」相反，而且是唯一方言的必经之路
53. [P2] `provider-messages` · 图片这条线两头都没接：ModelCapabilities.vision 声称投影层据此裁剪或拒绝（无人读），toolResult.images 被唯一方言默默丢掉（但压缩按 1200 token/张给它计费）
54. [P2] `run-loop` · stopReason 是 tool_use / max_tokens 的 turn 之后，shouldStopAfterTurn 与 prepareNextTurn 根本不被调用，与设计稿和 types.ts 写的顺序相反
55. [P2] `run-loop` · tool_execution_update 走 `void emit(...)`：订阅者抛错变成未捕获 rejection，run 还报 completed
56. [P2] `session-storage` · `FileDir.list(prefix)` 不看 prefix 一律走全树，每秒一拍的 inbox 轮询代价随 transcript 长度线性增长
57. [P2] `session-storage` · `session_close` 关掉一段还在跑的会话，会被对方下一次入账静默改回 active
58. [P2] `session-storage` · 任何一次拿不到锁的 acquire 都会先删掉别人正在等的 `.handoff`，人的让位请求被静默抹掉
59. [N] `observability-store` · sqlite-store 头注说「同进程查询用独立的 read-only connection」，实际同进程查询面用的就是 writer 那条连接（两个文件头互相打架）

**单视角存疑（3 条）**

60. [P2] `arch-public-face` · observability 的两处文件头断言「draft 不从公共子路径导出，露出来等于允许外部伪造 canonical identity」，而同一份 public.ts 第 15-16 行就在导出 draft 的 7 个符号
61. [P2] `cli-shell` · Ctrl+L / `/model <id>` 里 `isConfigured()` 抛错没人接：凭据文件坏掉时按一下就整进程死，锁不还
62. [P2] `extension-abi` · 架构总览与 registries.ts 头注都写「五个 registry 同名 fail-loud」，`AgentHooks` 不是：同 id 的两条 hook 并存、都跑

**只找未验（60 条）**

63. [P1] `arch-composition-root` · 装配期就在状态根里建目录、建 SQLite、跑 DDL —— 而文档三处写着「拿到 lease 之前任何状态根 I/O 都被拒」「只做一件 IO：解析模型」
64. [P1] `arch-extension-coherence` · ABI 说「single 恰好一个 provider、重复 provide fail-loud」，实际只在同一代内成立：盘上任一扩展能静默劫持 `AgentRuntimeService`，壳绑到假 runtime
65. [P1] `arch-extension-coherence` · 三份随包发布的 README 都写「`Agent` 类是内部的」，而 `Agent` 仍从根入口导出、API 快照里记着它、`index.ts` 自己还在推销「两个使用高度：低 = `new Agent()`」
66. [P1] `arch-ports-di` · 收摊时直接 `rm -rf` 状态根：绕过存储端口与写入闸，且不看自己有没有持有 lease——实测把持锁者的 `.lock` 连整个目录一起删了
67. [P1] `arch-ports-di` · 观测库是状态根里唯一既不过写入闸、也不等 lease 的写者，而 architecture.md 与闸自己的注释都写着「拿到 lease 之前、revoke 之后任何状态根 I/O 都被拒」
68. [P1] `arch-two-truths` · `--serve` 宿主把 `acceptsWork` 当「被请走/已收摊」读，结果一收到消息就自己收摊、把那条消息吞掉
69. [P1] `arch-two-truths` · 「一段 session 的目录在哪」有两处解析：`resolveStateDir` 认 `stateDir`，`createEcho` 的会话面只认 `sessionsRoot`——给了 `stateDir` 的宿主，会话面看不见自己
70. [P1] `arch-two-truths` · 「这家凭据配好了没」有两套判据：`checkAuth` 说配好了，`stream()` 当场回 auth 错——文档点名支持的「本地无 key 的服务」正好踩中
71. [P1] `docs-architecture` · §4 的「内建五件」表漏了三条真实存在的内建 echo:*（tool-search / ask / subagent），实测 echo.extensions 列出 9 条
72. [P1] `docs-architecture` · §6 说「拿到 lease 之前任何状态根 I/O 都被拒」，实测装配期就在状态根建了观测库——写入闸根本管不到它
73. [P1] `docs-decisions` · 三份 README 把仍在 proposed 的「`Agent` 类内部化」写成现状，而 `Agent` / `AgentOptions` 照旧从公共入口导出
74. [P1] `docs-design` · lifecycle-and-run-loop.md §9 里 9 项待拍板已有 8 项在 2026-09-07 拍板（4 项进了 rejected/），文档仍写着「必须在发布前解决」
75. [P1] `docs-design` · 「inbox 里还有没消费的 record 就不撤」这道闸只查内存计数，别的写者刚投进来的那条会连目录一起被删，而发送方拿到的是 accepted
76. [P1] `docs-external` · CONTRIBUTING.md 告诉贡献者 docs-lint 只是「informational」、filerefs 基线是红的——实际它 0 违规、且在 CI 与 bun test 里都是硬门
77. [P1] `docs-external` · 「`Agent` 类是不是公共面」有两个相反答案：README 说是内部的，CLAUDE.md / AGENTS.md 开篇仍教人围着 `Agent` 自己接端口
78. [P1] `docs-gate-honesty` · 「状态只能被事件改」被写成结构保证，但 `apply` 这个方法根本不存在，`_state` 有 8 处事件路径之外的直接写，且 invariants.test.ts 里那一节没有断言它
79. [P2] `arch-boundaries` · `ExtensionEntry.definition` 上的 11 处 `as never` 全是多余的强转，把跨包公共面上唯一那道编译期检查关掉了
80. [P2] `arch-boundaries` · `sqlite-store.ts` 用「分发门的 examples 走的正是普通 tsconfig」当理由，而三个 examples 全都装了 `@types/bun` 并写死 `types:["bun"]`——那道门不存在
81. [P2] `arch-boundaries` · `src/skill/public.ts` 是一条没人可达的公共入口：文件头承诺 `@echo-agent/core/skill` 子路径，`exports` 里没有它，还随 tarball 发出去
82. [P2] `arch-boundaries` · `zero-runtime-deps.test.ts` 头注声称查「源码闭包」，实际只拦 `@modelcontextprotocol` 一个包名；`./task/fs` 这类子路径上的裸 npm import 能全绿发出去
83. [P2] `arch-composition-root` · `examples/hello` 对 `createEcho()` 的两句公开描述都是错的：状态路径是已经退场的旧布局，「再跑一次它记得」与「缺省每次启动新建一段」直接冲突
84. [P2] `arch-composition-root` · `store` 与 `stateDir` 同时给时观测库落真盘，而清理逻辑按「观测库在内存里」这个不成立的前提整个跳过 —— 正是它当初要修的那个空壳问题
85. [P2] `arch-composition-root` · 给了 `stateDir` 时，`createEcho()` 的会话面按 `sessionsRoot` 另算一遍自己那一段的目录，于是非 main 的会话也拿到了 `session_create`
86. [P2] `arch-extension-coherence` · `AgentRuntimeService` 跨在 registry / 能力端口的二分之外：文档说它是「壳看得到的全部」，实现上是任何扩展都能注入的能力端口，于是「回答只能来自可信宿主」这句承诺没有门
87. [P2] `arch-ports-di` · `Agent` 是不是公共面有三个真源，而 WeakMap 侧挂的全部代价正落在这条被三方各说各话的高度上
88. [P2] `arch-ports-di` · `StateLeaseLifecycle` 端口生产侧从来没接过线：丢锁之后 `stop()` 仍会把观测 ring flush 进已经不归本进程的状态根
89. [P2] `arch-ports-di` · `createEcho()` 的会话面自己又推了一遍「这一段的目录」，忽略 `stateDir`——同一件事两个数法
90. [P2] `arch-two-truths` · 「这一段活着吗」两套定义：`isAlive` 把陈尸锁算作活着，`SendResult.accepted` 却承诺对方此刻活着——崩溃过的段收到的每条消息都进黑洞
91. [P2] `docs-architecture` · StateLeaseLifecycle 端口在生产装配里从未接线：文件头声称由它给观测 writer 封口，实际只有测试造过假的
92. [P2] `docs-architecture` · 「五件」在 §2 与 §4 指两个不同集合：§2 的五件含 session 不含 skills，§4 的五件反过来
93. [P2] `docs-decisions` · `2026-09-01-stop-continuation-limit` 的「验收」节写的是被否掉的那个选项，照它实现就会做反
94. [P2] `docs-decisions` · `2026-09-03-session-is-the-state-root` 已经完整落地并有绿测试，却仍留在 proposed/
95. [P2] `docs-decisions` · `AgentRuntime` 在 2026-09-07 加进了 `reset()`，而 2026-09-03 的决策与 sessions.md 的目标形态都写着「删 `reset()`」；相反那条决策记在不受文档门约束的 docs/review/ 里
96. [P2] `docs-decisions` · `docs/architecture.md` §7 标题写「未实现」，表里四行指向 implemented/，同时漏掉 proposed/ 里三条 2026-09-03 的记录
97. [P2] `docs-decisions` · `docs/design/lifecycle-and-run-loop.md` §7.1 提的要求与 `agent-end-barrier` 的决定相反，§9 仍把六项已拍板的事列为待拍板
98. [P2] `docs-design` · context-and-message-flow.md 的「结论先行」与 §9「当前没有门守」没跟着正文更新：已删的死接口仍列为待处理，已有测试的项仍列为没门守
99. [P2] `docs-design` · run-loop-layers.md 把 turn 之后的判决顺序写反：实现里 tool_use / max_tokens 先短路，shouldStopAfterTurn 与 prepareNextTurn 在工具链的每一轮都不会被调
100. [P2] `docs-design` · run-loop-layers.md 状态标「已实现」，§7 的「现状」整张表与 §8 的「当前输出 / 当前行为」仍是 2026-09-05 之前的样子
101. [P2] `docs-design` · sessions.md §7 的公共类型块与已导出的实现对不上，最要紧的是 SendResult 漏了 unreachable——而同一份文档的 §5、§10 又要求它
102. [P2] `docs-external` · CLAUDE.md 与 AGENTS.md 的文档规则已漂移：源码链接那条只在中文侧，且 CLAUDE.md 另一处反过来教人写 `file:line`
103. [P2] `docs-external` · README 说分发测试「用 Bun 和 Node 运行这些公共入口」——三个 examples 只用 Bun 跑，需要凭据的那个根本没跑
104. [P2] `docs-external` · `docs/review/` 被整目录豁免门禁，里面却住着一份带 8 条决策记录的在用 spec——违反 manifest 自己写的规矩，且前提已经腐烂
105. [P2] `docs-external` · `echo-coding` 到底装几条 extension，README 自己前后矛盾（两条 vs 四条），AGENTS.md 的仓库地图停在两条
106. [P2] `docs-gate-honesty` · docs/review/tui-design.md 是一份在维护的实现 spec + 八条决策记录，却住在 manifest 自己声明「只放 prompt 与未纳入维护的 scratch」的免门目录里，仓内八处源码把它当设计权威引用
107. [P2] `docs-gate-honesty` · key-discipline 门的标题和注释都说守「packages/cli/src/ 里」，实现只扫顶层 .ts，不递归——`packages/cli/src/observe/` 三个文件在门外
108. [P2] `docs-gate-honesty` · 「可让位的实例被请走时自己交还」这条硬约定挂在 state-lock.test.ts 名下，而那个文件里一处 preemptible 都没有；真门 lease-handoff.test.ts 在 §8 门表里根本没登场
109. [P2] `docs-gate-honesty` · 架构文档说写入闸「任何状态根 I/O 都被拒」，实际只拦写和删，读与 list 直通——它引的那道门自己就反着断言
110. [P2] `docs-glossary` · observe 面板的用词有第二真源：lexicon.ts 头注释声称「界面文案只在这一处翻译」「渲染层不再自己猜字面」，page.html 里仍硬编码同一批词，且没有门
111. [P2] `docs-glossary` · 「宿主」是全仓最高频的多义词却没有词表条目，与规范词「容器」在同一行混用，还进了用户可见的错误文案
112. [P2] `docs-glossary` · 同一件事三个中文词：词表规范词「可让位」在代码里一次都没出现，公共端口契约用的是被明令 Avoid 的「抢占」，且与 admission 里真实存在的「抢占」撞车
113. [P2] `docs-glossary` · 词表规范词「消息来源」全仓零使用，而代码里 `source` 在公共面上有六种含义、四个公共 `*Source` 类型，词表既不给代码名也不裁决它们
114. [N] `arch-boundaries` · `docs/architecture.md` §1 说 echo-agent 有「唯一的可执行文件」，同一节第三条又说 echo-coding 也有一个
115. [N] `arch-boundaries` · `examples/extension` 的文件头说打印出来是「五条：内建四条」，分发门断言的是十条
116. [N] `arch-composition-root` · `echo:session-name` 这条 hook 直接注册在 `agent.hooks` 上，绕过 ExtensionHost —— 与同一文件为 `agent.tools` 立的「一份注册机制、一份所有权账本」是同一个病
117. [N] `arch-extension-coherence` · CONTEXT.md 把「观测发口」当成已有的能力端口写进词表，那个口今天不存在
118. [N] `arch-ports-di` · session id 的随机尾巴用 `Math.random()`，而 inbox 的 id 源明确写了「用 `crypto.getRandomValues` 而不是 `Math.random`」——同一件事两个数法
119. [N] `docs-architecture` · §1 说 echo-agent 有「唯一的可执行文件」，同一段下一条与分发门都说 echo-coding 也有一个
120. [N] `docs-architecture` · §7 标题写「未实现」，表里却有五行自称「已合入 / 已实现」
121. [N] `docs-gate-honesty` · docs/review/architecture-draft.md 该退场：正式架构总览已存在，它是第二份会独立腐烂的架构叙述，且因免门已经烂了
122. [N] `docs-glossary` · 其余 Avoid 词残留在公共 JSDoc 与文案里：「工作集」被「菜单」压过（25:22）、「会话记录」「前端」「Runner」各一处

**判为噪音（1 条）**

123. [compaction-memory] 「哪次 usage 能当基准」有两套判据：compactor 拒绝失败/中止的 attempt，Agent 的 usage 分支照单全收 — 门覆盖：发现的前提（失败/中止的 attempt 会带着 usage 走到 agent 的 usage 分支）在本仓代码里不成立，所描述的 contextTokens / lastCalibration 被污染的场景无法复现，属于只读了 run-turn.ts 那三行、没往上游追 usage 从哪来的读码产物。  链路核实：  | 证伪：引文属实但后果不成立，被一个守卫堵死。run-turn.ts:245 的 emit 前置条件是 `final.usage !== null`，而本仓里失败/中止的定稿消息 usage 恒为 null，所以 usage 事件对 failed/aborted 的 attempt 压根不会发出，agent.ts:3079-3

