# 配置是运行态，不阻塞启动

> 状态:implemented · 提出 2026-09-01 · 拍板 2026-09-01（用户）· 落地 main `b7c0338`（core `packages/core/src/create-agent.ts`；cli `packages/cli/src/app.ts` / `setup.ts` / `cli.ts`）· 细化 [首次运行没有凭据时起来](2026-08-31-tui-first-run-not-exit.md) · 来源 [产品级 TUI 设计方案](../../design/tui.md) §九 D3（2026-09-08 从那张表转录成条）

## 决定

常驻 agent 的存活不以任何外围配置为前提（热部署、成熟产品）。装配不看凭据——core 的 `create-agent.ts` 用完整目录解析模型，缺 key 是运行态；key 中途失效在主界面里配，配好不用重启；管道 / CI 仍在启动前报错退出。

## 理由

pi / Claude Code 都是界面先起来、key 是进去之后的事；上一版把 SDK 的装配纪律直接暴露给了坐在终端前的人。扩展那条按同一原则另拍（见 [坏扩展不阻塞启动](2026-09-01-bad-extension-does-not-block-startup.md)）。

## 落地

`b7c0338`。装配（`createEcho()`）不读凭据；`packages/cli/src/setup.ts` 的 `CredentialSetup` 在主界面里配 key；管道形态没有 key 时启动前退出。

## 验收

没有凭据时 `createEcho()` 装配成功、模型照常解析；终端形态下配好 key 不重启就能发第一句；管道形态没有 key 退出码非零。
