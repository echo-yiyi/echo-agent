# 跨 provider 换模 + 记住选择

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-01（用户：「切换了之后重启还要能用」）· 落地 main（core `packages/core/src/create-agent.ts`；cli `packages/base/src/settings.ts` / `app.ts` / `cli.ts`；`75f5aab`）· 来源 [产品级 TUI 设计方案](../../design/tui.md) §六、§九 D7（2026-09-08 从那张表转录成条）

## 决定

装配全量注册五家（core 加 `CreateAgentOptions.providers`，`Models` 本来就是 map）；Ctrl+L 跨家平铺（未配 key 的标在描述最前），选了没配 key 的家照样切、**主动**弹配置段。`$ECHO_HOME/settings.json` 记 `{ model: { provider id, 模型 id } }`，向导与 Ctrl+L 都写入；显式 `--provider` / `--model` 永远赢；记忆坏了 / 过期了口信 + 回缺省、不挡启动。

## 理由

原 TUI 设计稿「待拍板 2 前半 + 待拍板 3」。

## 落地

`75f5aab`。

## 验收

Ctrl+L 列出全部五家的模型；切到没配 key 的家弹出配置段；重启后用的是上次选的模型；`--provider` / `--model` 显式给了就不读 settings；settings.json 坏了启动照常并口信。
