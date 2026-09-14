# subagent 的回执与模式：`report` 多次提交不停循环、fork 继承父上下文、并行扇出

> 状态：proposed · 提出 2026-09-14 · 拍板 2026-09-14（口头）· 实现在分支 `worktree-subagent-report-modes`，合入时移入 implemented · 相关 [并行工具](../implemented/2026-09-07-parallel-tools.md)（`concurrent` 声明制，本条照抄它的形）、[角色定义](../implemented/2026-09-07-role-agent.md)（那条挂着的「subagent 要不要接受角色名」由本条关闭）

## 现状（拍板前）

`subagent` 工具（`packages/core/src/subagent/tool.ts`）只有一种形态：空白上下文，prompt / system / 工具集由模型在调用时给；结果是子的最后一条 assistant 正文（`subagentOutcome`）。父分不出「做完了」「做不了」「卡住等父定夺」；子说「我再看一眼」然后停了，父拿到的就是那句话。子拿的是父池里**同一个工具实例**；`subagent` 没声明 `concurrent`，同一条 assistant 消息里的多个委派串行跑。角色定义那条留了一个待拍板：subagent 要不要接受角色名。

## 不拍板的代价

结果语义留在「末条正文」上，父那边任何按状态分流的逻辑（卡住了转问人、失败了换个派法）都只能靠正则猜；fork 与并行各自就地长出来的话，「子看到多少父的上下文」「哪些工具交不出去」会在两处各定一遍。

## 决定（2026-09-14 用户拍板）

1. **角色文件不套 subagent。** CONTEXT.md 的定义不变：由模型在调用时定形。角色是 session 的事，角色定义那条的待拍板关闭为「不做」。
2. **回执工具 `report`。** 只挂在子循环的菜单上（`makeReceiptBook`，每次子循环一份），父没有它。**不停循环、允许多次提交**：工具结果只回一句「记下了」，子自己 end_turn 或用完 `max_iterations` 才停；不给 loop 开「工具批次后硬停」的口（`shouldStopAfterTurn` 只在 end_turn 后有发言权，这是有意的）。每条回执 `{ seq, status, summary, details? }`，`status` 四档**封闭**：`working | done | blocked | failed`——扩第五档要改工具 schema 与父的解读，按公共面集合的规矩另拍。最后一条的 status 就是这次委派的终态；一条没交 = `reported: false`、退回末条正文；末条仍是 `working` = 标注「没有终态回执」并附末条正文。`blocked` 是子向父提问的通道。前台：回执累在槽里、每条推一行进度，工具结果 = 全部回执按序，metadata 带 `receipts` / `finalStatus`；后台：每条当场投一条环境消息进父的 inbox（ref 带 seq，去重按 source + ref），结束再投一条收尾（终态与条数；没交过回执才带末条正文）。**不另加节流**：父空闲时每条回执都会唤醒一轮，这是「允许多次提交」自带的。失败 / 中断也把已交的回执带回父手里。
3. **模式 `mode: "fresh" | "fork"`。** fresh 是原来的形。fork：子继承父这次 run 的 system（同一份装配、同一个冻结的模型，前缀一样）、父的 working context（压缩后的视图，**截到最后一条 assistant 之前**——那条正是派出它的这一轮，tool_use 还没结果，不给子看半截；同批兄弟的结果也一并截掉）、父此刻可委派的整套工具，每轮注入照父的来；任务追加成一条 user 消息。fork 不收 `system` / `tools`，给了判红不静默忽略。种子在派出那一刻定格：后台子跑起来之后父的 transcript 还在长，子看到的是派它时的那份。
4. **并行扇出。** `subagent` 声明 `concurrent: true`：同一条 assistant 消息里连续的委派同批同跑（切批规则归并行工具那条）。前置是把共享实例的门立起来：`ToolBase.delegable?: boolean`，与 `deferred` / `concurrent` 同一条规矩（状态住在工具身上），**只有显式 `false` 才挡**；可委派清单（fresh 点名）与 fork 的整套继承都过滤它。coding 的 `worktree_enter` / `worktree_exit` 标 `false`——它们切的是父的 workspace，子调一下父就跟着换了目录。
5. **登记、本条不做。** 续聊已派出的子（改的是「一次性」的定义，不是参数）；bash 的 cwd 是父子共享的一份 `ShellState`，工具 ctx 里没有 runId、bash 分不清父子——先登记，不在本条修；子指定模型、子指定工作目录是参数不是模式，等模式落了再看。

为什么回执优先于末条正文：回执是子**主动交**的，末条正文是子**停下来时恰好在说**的；两者都在时前者才是它的交付。为什么 fork 截到最后一条 assistant 之前而不是把 tool_use 剥掉：剥掉是造一条模型没说过的消息，截掉是少看一句。

## 验收

`bun test packages/core/test/subagent.test.ts packages/coding/test/coding-agent.test.ts`：

- 子连续两次 `report`（working、done）再收尾：父的工具结果恰是两条回执按序，不含子的收尾正文；第一条回执之后子还发了请求（不停）。
- 末条 `working`：父看到「没有终态回执」的标注与末条正文；`status` 不在四档里判红、不记。
- 子半路失败：父的错误结果里带已交的回执。
- 后台：两条回执各投一条环境消息、收尾一条带条数与终态，父后续的请求里三条都出现，收尾不带末条正文。
- fork：子的 system 与父同一次 run 的相同；子看得到父之前的 user 消息、看不到派它的那条 assistant 的 tool_use；工具集 = 父菜单去掉 subagent / tool_search、加上 report；fork 带 system / tools 判红。
- 并行：同一条 assistant 消息里两个 `subagent`，第二个子的请求在第一个子结束之前发出（门控超时即红）。
- `delegable: false` 的工具：fresh 点名判红、清单里没有；fork 不带它；coding 的两件 worktree 工具标了 `false`，`bash` 没标。
