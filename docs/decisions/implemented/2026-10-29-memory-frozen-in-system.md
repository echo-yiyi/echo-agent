# 记忆段会话内冻结：system 不随记忆变，变化以一条追加消息送到

> 状态:implemented · 提出 2026-10-28（用户报缓存命中率低，实测定位到记忆段）· 拍板 2026-10-29（用户，选项 A）· 落地 `packages/core/src/memory/harness.ts` / `agent.ts`，判据 `packages/core/test/memory.test.ts`、`packages/core/test/create-echo.test.ts`

**给谁看**：改 system 装配、记忆注入或 provider 缓存相关代码的人。假设已知 [Prompt 的刷新语义](../../design/prompt.md)（§4）与 [记忆的模块与召回](../../design/memory.md)（§3）。

## 现状（拍板前）

记忆段（order 900，system 末尾）每个主 run 重组一次。provider 的缓存按前缀命中，而记忆段之后是工具定义与整段对话：两次 run 之间记忆一变（每次回复后的提取、模型自己写、Dream、别的 session 写），下一次请求从记忆段起全部失去缓存。

实测（真实 `echo-coding` + DeepSeek，抓原始请求与原始 usage）：同一 run 内相邻请求命中 97–98%；新 run、记忆没变 98%；**新 run、记忆刚变 38%**——只剩记忆段之前那截 system 命中。对话越长，这个数越低。交互聊天每句话都是一个新 run，所以这不是边角情况。

## 不拍板的代价

记忆写得越勤（正是记忆想要的状态），缓存越差；长会话的每个新 run 都按全价重付工具定义与整段历史。

## 选项

- **A. 冻结 + 追加**：system 里的记忆段会话内只取一次；之后的变化在下一个 run 开头作为一条消息追加进 transcript。请求永远只在末尾长。
- **B. 只冻结**：不追加。简单，但长会话里模型在 system 看不到会话中新写的记忆。
- **C. 维持每 run 重组**，靠排序把损失压小：做不到，记忆段之后的东西（工具、历史）本身就最大。

## 决定

**A**（2026-10-29 用户拍板）。四条：

1. **冻结**：`memoryPromptSections` 的段渲染读 Agent 持有的冻结副本（`MemorySystemFreeze`），第一次组装时取；作用域还没绑定时组装出的不算数、不冻结。
2. **作废**：压缩落地（`compaction_end` 带阶段）、`reset`、`session_restored` 三处置回 null，下一次组装重取。压缩本来就改写了历史、缓存已断，顺势让 system 跟上；后两处换了 transcript，之前追加的更新跟着没了或换了。
3. **追加**：前台 run（prompt / inbox）组装之后，若此刻的记忆段与**模型最后看到的那一版**不同，就在本 run 输入之前追加一条 environment 消息（`source: "memory"`），正文是整段新记忆。「最后看到的」= 本次送模投影里最后一条记忆更新，没有就是 system 那份——看投影是因为被摘要掉的更新模型已经看不到；看最后一条是因为续会话后历史里较早的更新可能比重取的 system 旧。
4. **失败**：组装更新抛错与段 `render()` 抛错同一档位——留 `memory_update_failed` 诊断，不挡这个 run。

## Non-Goals

- 不改记忆提取调用的 prompt 结构（它与主循环不共享缓存、「Stored now」排在对话原文前面）：另议。
- 续跑（`runContinuation`，接被打断的 run）不追加。
- 不把冻结副本写盘：续会话时按此刻的记忆重取一次，缓存断一次，换来不必维护第二份持久状态。
- 不改 `AgentMemories` 公共类型；冻结副本由 Agent 持有。
- TUI 不显示记忆更新消息（它本来就只渲染 assistant 消息）。

## 验收

- system 跨 run 逐字不变、变化以一条消息追加在输入之前：[会话内冻结](../../../packages/core/test/memory.test.ts#test=会话内冻结run-内写记忆本-run-system-不变下个-run-system-仍逐字不变新内容以一条环境消息追加在输入之前)
- 记忆没变不追加：[记忆没变](../../../packages/core/test/memory.test.ts#test=记忆没变下个-run-什么都不追加system-逐字不变消息只在末尾长)
- 一次变化只送一次：[只送一次](../../../packages/core/test/memory.test.ts#test=一次变化只送一次之后记忆不变就不再追加再变一次再送一条)
- 压缩后重取、并压过历史里更旧的更新：[压缩后重取](../../../packages/core/test/memory.test.ts#test=压缩落地后-system-重取一次记忆历史里还看得见的旧更新比它旧就再补一条新的)
- `reset` 后重取、不追加：[reset 后重取](../../../packages/core/test/memory.test.ts#test=清空-transcriptreset后-system-重取记忆不追加更新)
- 续会话：system 按此刻重取，第一个 run 补一条压过历史里的旧更新：[续会话](../../../packages/core/test/create-echo.test.ts#test=续上一段会话system-按此刻的记忆重取历史里那条更早的记忆更新比它旧第一个-run-就补一条新的)
