# 热部署的两处一致性：段替换按层恢复；后台子 agent 在跑时推迟

> 状态:implemented · 提出 2026-11-03（全仓 review）· 拍板 2026-11-03（用户：按推荐修）· 来源 [`agentRegistries`](../../../packages/core/src/extension/registries.ts#symbol=agentRegistries) 的 prompt registry、[`createEcho`](../../../packages/core/src/create-echo.ts#symbol=createEcho) 的 `reloadExtensions`

## 现状(拍板前)

1. **段替换**：`section(…, { replace: true })` 的 disposer 只认「当前是不是我」，是就放回自己替换那一刻看到的段。两个盘上扩展都替产品的 `environment` 段（叠成 P → A → B），删 A 再 `/reload`：A 的 disposer 看到当前是 B，什么都不做；再删 B：B 放回它记下的 A——A 已经不在 `echo.extensions` 里，它的段却回到了 system，P 直到重启都回不来（review 复现）。
2. **后台子 agent**：它在派出那一刻拿走父池里的工具实例，不占 admission。热部署拿得到 permit、换掉那件工具所属的扩展（disposer 跑过、快照删了），报 `replaced`；子 agent 接着调的仍是旧代的闭包，资源已经关了（review 复现：子 agent 记下的全是 `open=false`）。

## 不拍板的代价

热部署之后 system 里出现已删扩展的段；后台子 agent 在已释放的资源上继续干活。

## 选项

- 段替换：**A. 每个段名一份替代层**，disposer 只摘自己那层、生效的是最上一层；B. 第二次 replace 同一段直接报错——改公共语义，且角色加盘上扩展叠用的正当场景被挡。
- 后台子 agent：**A. 有后台子 agent 在跑时热部署 rejected**（与「忙就 rejected」同口径），等它们结束再来；B. 热部署时中止它们——用户派的活被一次重载打断。

## 决定

两处都选 **A**（2026-11-03 用户拍板「按推荐修」）。

- 段替换层挂在段表上（同一张表的各个 registry 实例共用），原段先卸时只腾空底那一位：之后最后一层卸掉时这个名字整个消失，不复活原段。
- `reloadExtensions()` 开头数还在跑的后台子 agent（`kind: "subagent"`），大于 0 就 `{ kind: "rejected", reason }`，原因里写明个数。后台进程类任务不在此列（它们不持有扩展的工具实例）。

机制以 [扩展、装配与所有权](../../design/extensions.md) §6 为准。

## 验收

`packages/core/test/prompt.test.ts`：「两层 replace 叠在同一段上、按任意顺序卸」两种卸载顺序最后都回到原段；「原段先卸、替代层后卸」最后这个名字不在表里。`packages/core/test/extension-reload.test.ts`：「后台子 agent 还在跑时热部署推迟」——子 agent 卡在旧代工具里时 reload 为 rejected 且原因含「后台子 agent」，子 agent 看到的仍是活着的那一代；它结束后再 reload 为 `replaced`。
