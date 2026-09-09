# 坏扩展不阻塞启动：盘上发现的扩展坏了就跳过并记诊断，显式传入的仍 fail-loud

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-01（用户：「没有其他 extension 都不能作为我们不能启动的原因——热部署、成熟产品」）· 落地 main（core `packages/core/src/create-echo.ts`；cli `packages/cli/src/extension.ts` 的 `TuiShell.notify` / `cli.ts`；`dc185fe`）· 同一原则的上位记录 [配置是运行态](2026-09-01-config-is-runtime-state.md) · 来源 [产品级 TUI 设计方案](../../design/tui.md) §九 D6（2026-09-08 从那张表转录成条）

## 决定

盘上发现的扩展 load / mount 失败 → 记一条 `Diagnostic`（`Echo.diagnostics`）、跳过它，agent 照起；TUI 发「[扩展] 没装上」notice，管道模式写 stderr。**显式传入的**（`opts.extensions`、inline 工具）保持 fail-loud——那是代码 bug，不是运行态配置。

## 理由

原 TUI 设计稿「待拍板 4」的三个子问题：诊断走 `Echo.diagnostics` + 壳的旁白通道；坏的跳过、其余照装；将来 reload 到来时复用同一诊断路径。

## 落地

盘上每个扩展各占一个 generation（Host mount 按代全有或全无，跨代绑定成立），坏 `apply` 只回滚自己那一代。架构总览 §2 的 mount 顺序写的就是这个。

## 验收

`<cwd>/extensions/` 里放一个 `apply` 抛错的扩展：`createEcho()` 成功、`echo.diagnostics` 一条带文件路径、其余扩展照装；`opts.extensions` 里同样的扩展让 `createEcho()` 直接抛。判据在 `packages/core/test/create-echo.test.ts`。
