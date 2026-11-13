# 删掉 `linesOf`：`@echo-agent/base` 不再导出逐行的 stdin 输入源

> 状态:implemented · 提出 2026-11-03（[管道形态整段 stdin 一条 prompt](2026-11-03-pipe-whole-stdin-one-prompt.md) 落地后它没有生产调用方，记为另议）· 拍板 2026-11-13（用户：「按照你的推荐来做」）· 落地 `packages/base/src/stdin.ts`、`packages/base/src/index.ts` · 修改 [管道形态](2026-11-03-pipe-whole-stdin-one-prompt.md) Non-Goals 里的「`linesOf` 不删」

**给谁看**：从 `@echo-agent/base` 引 stdin 输入源的人。

**一句话**：`linesOf` 从 `packages/base/src/stdin.ts` 和包的公共导出里删掉，stdin 输入源只剩 `readAll`。

## 现状（拍板前）

管道形态改成整段 stdin 一条 prompt 之后，`linesOf` 在仓库里只剩一条测试在调，生产代码没有调用方，却仍是 `@echo-agent/base` 的公共导出，文档和测试要一直带着它。

## 决定

删，不留别名。

## 影响

- **破坏性变更**：0.7.0 及之前从 `@echo-agent/base` 引 `linesOf` 的代码，升级后编译不过。要「一行一条」的调用方自己用 `node:readline` 的 `createInterface({ input, crlfDelay: Infinity })`；`signal` 已经中止时要先关掉接口再读——只挂 `abort` 监听等不到已经发生过的中止。
- 随它删掉的测试「已经 abort 过的 signal：不许卡在 stdin 上等一行永远不来的输入」测的是 `linesOf`。`readAll` 的同一件事由「readAll：已经 abort 过的 signal 不许卡在等 EOF 上」守着。

## 验收判据

`packages/` 下没有 `linesOf`（`grep -rn linesOf packages` 无结果）；`bun run typecheck` 与 `packages/cli/test/cli.test.ts` 通过。
