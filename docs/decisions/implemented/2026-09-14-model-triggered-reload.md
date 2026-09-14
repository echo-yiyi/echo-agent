# 模型自己触发热部署：`extension_reload` 登记、run 收尾后执行、报告投回自己的 inbox

> 状态:implemented · 提出 2026-09-14 · 拍板 2026-09-14（口头：1 run 收尾执行，2 缺省 allow，3 `afterRun` 通用但不公开，4 触发放宽到「人、程序、模型」；卸载不另做工具）· 合入 2026-09-14 · 改写 [盘上扩展的热部署](2026-09-14-extension-hot-reload.md) 的拍板 ①

**给谁看**：改 `Agent` 收尾顺序、内建工具表、`createEcho()` 装配的人；写「让 agent 给自己造工具」这类场景的人。假设已知热部署那条（`replace()` / `betweenRuns()` / 快照）。

**解决什么**：热部署第一版只有人（`/reload`）和程序（`echo.reloadExtensions()`）能触发，agent 写完扩展要等人来按。做完之后：模型写完 `extensions/foo.ts` → 调 `extension_reload` → 结束回复 → 系统在两次 run 之间重载 → 报告作为下一条输入自动到达 → 模型接着用新工具验证。全程没有人。

## 现状（拍板前）

`reloadExtensions()` 要在两次 run 之间跑（`betweenRuns()` 拿 permit），而工具在 run 里执行、拿不到 permit；run 收尾后 `followUp()` 已拒收（`no-active-run`），没有现成的「系统给这段会话起一个 run」入口。热部署那条把「模型自部署」登记在 Non-Goals 的 B 项，点名两个空白：延后到 run 结束执行、结果怎么回给模型。

## 不拍板的代价

「agent as system」在这一步断掉：系统能给自己换代，却要人来按那个键。

## 选项

- **A. run 收尾执行 + inbox 自投递回传。** 工具只登记（`Agent.afterRun()`）；`finishRun()` 先 drain 登记的活、再排自主工作；重载完把报告投进本段会话自己的 inbox（`agent.ingress.deliverDurable`），紧接着的 `scheduleAutonomousWork()` 就把它消费成下一个 run。
- **B. 轮边界执行 + turnInjection 回传。** 模型在同一个 run 里接着用新工具。代价：循环里加轮边界挂点（碰 run-loop 分层）、扩展得声明 `reload: "turn"`、system 段本来就每 run 冻结——新工具的 prompt 段那一轮看不见。
- **C. 工具同步重载。** 工具执行中途换 Host，同批的别的工具可能正是被换掉的那个扩展的。不安全。

## 决定

**A**（2026-09-14 用户拍板）。附四条：

1. **`Agent.afterRun(work)` 是唯一的新缝**：登记「本 run 收尾后、自主工作之前」做的事，只在 run 进行中可登记；顺序执行、失败进诊断不抛。通用但**不公开**——不进 `AgentRuntime` 协议、不进根入口；热部署是第一个用户，watcher 以后接在同一处。
2. **权限缺省 allow**：它换的是模型自己刚经 `write_file` 审批写下的代码，再问一次是重复。产品要收紧照旧往 `rules` 里加 `extension_reload: "ask"`。
3. **`echo:reload` 只在装配层给了登记口时才装**（`builtinEntriesFor` 的第二个参数 `requestReload`）。低层 `mountBuiltinTools()` 没有热部署，「能力不在就不出条目」（与 `echo:ask` 同一口径）——不是「恒装、如实回话」。
4. **卸载不另做工具**：热部署的语义是「盘上什么样，装着的就什么样」，删掉或改名文件再调 `extension_reload`，报告里就是 `removed`。单独一件 `extension_unload` 会造出第二份真相（盘上有、运行时没有），下次重载又装回来，除非再养一张要持久化的忽略清单。工具 description 里写明这一点。

形状：`extension_reload`（无参数，`packages/core/src/extension/reload-tool.ts`）→ `toolOk("Scheduled. Finish this reply…")` 或 `toolError(reason)`（已登记 / 没有 run）；报告 `renderReloadReport(result, toolsNow)` 全英文、一行一个扩展、末尾列此刻能用的工具；投递为 `environmentMessage(report, "echo:reload")`，`dedupeKey` 每次 UUID。`RuntimeAssemblyOps.requestReload`、`ScheduleResult` 进 `/extension` 子路径。

失败姿态：`betweenRuns` 被抢（定时投递刚好起了一个 run）→ 报告写「没做，再调一次」，模型自己重试；报告投不进（收摊中）→ 一条诊断，不抛；进程在收尾与重载之间崩 → 什么都不用管，重启本来就从盘上装新的。

## Non-Goals

- 不监听文件（watcher 以后接在 `afterRun` 同一处，另拍）。
- 不在 run 中途换（B 项的理由）。
- 模型碰不到产品代码、内建、壳、角色（热部署那条的边界不变）。
- 报告到了之后做不做验证由模型自己定，系统不替它跑测试。
- 不做「同一 run 里登记多件不同的活」的排序语义：现在只有一个用户。

## 验收

`packages/core/test/extension-reload-tool.test.ts`：

1. 脚本化模型 run 1 调 `extension_reload` 后结束回复 → 自动出现 run 2，其输入是一条 `environment`（source `echo:reload`）消息，正文含 `replaced` 与新工具名；run 2 调新工具拿到新值；`echo.extensions` 里有 `echo:reload`；
2. 同一 run 里调两次 → 第二次 `toolError`「已经登记过」；
3. run 外 `agent.afterRun()` → rejected；
4. 低层 `mountBuiltinTools(agent)` 的条目里没有 `echo:reload`；
5. 登记后立刻 `echo.stop()` → 不抛、不再起 run 2。

`packages/core/test/create-echo.test.ts` 的内建清单加 `echo:reload`（排在 `echo:subagent` 之后）。
