# @echo/core

一个**持续存在的 agent** 的最小可执行内核：状态机 + 循环 + 会话持久化，零运行时依赖。

不是框架。它不替你选模型、不规定工具怎么写、不带 CLI——你给它一个 `Model` 和一组端口，
它负责「跑完一轮任务」以及「进程重启之后还记得自己是谁」。

```ts
import { createEcho } from "@echo-agent/core";

const echo = await createEcho({ provider: myProvider });
await echo.agent.start();               // 取单写锁 → 恢复会话
const result = await echo.agent.prompt("把 README 翻成英文");
await echo.stop();                      // 先卸扩展 → 等落盘 settle → 释放锁
```

`createEcho()` 是**唯一的装配现场**：它装好 Agent，再把内建能力（Task / Skill / Memory / Schedule）
与 `<cwd>/extensions/` 里你自己写的扩展，**用同一套机制**装上去。装了什么在 `echo.extensions` 里看得见。

## 两个使用高度

| 说明符 | 面向 | 里面有什么 |
|---|---|---|
| `@echo/core` | Node / Bun | `createEcho()`（唯一装配现场）、`FileDir`、文件锁、Skill 加载 |
| `@echo-agent/core/engine` | 浏览器 / Worker / Edge | **纯 Web 标准面**，不碰 `node:`。`Agent` 类、循环、消息、端口类型 |

低层用 `new Agent()`（`/engine`）：**自己给端口、自己注册工具**——它不会替你装任何默认件。
要内建工具但不想走完整装配，调 `mountBuiltinTools(agent)`（`@echo-agent/core/extension`），
那就是 `createEcho()` 内部用的同一张表、同一条路。

另有 `@echo-agent/core/testing`（FakeProvider 与脚本化流、in-memory 观测 collector）、
`@echo-agent/core/extension`（写扩展的 ABI）、`@echo-agent/core/task/fs`、`@echo-agent/core/mcp`。

`engine` 面的纯度**有门守着**（`test/engine-purity.test.ts`）：一旦有 `node:` 内建或 Node 全局
经任何路径倒灌进来，构建即红。

## 几条硬约定

- **零运行时依赖。** `dependencies` 恒空，有门守着。
- **fail-loud，绝不静默降级。** 缺凭据、拿不到锁、盘上有坏档——一律抛，不回退到「假装成功」。
- **single-writer。** 一个状态根同时只允许一个写者。锁被占着就拒绝启动，**core 不抢占**、
  不猜对面是不是死了；崩溃后需人工清锁（`inspectStateLock()` 告诉你是谁占着）。
- **`write()` resolve 即持久。** 存储端口上没有 `flush`；`stop()` 等的是未 settle 的写。
- **持久化失败会封存该会话。** 一次写失败之后拒绝继续写——继续写只会产出 parent 指向
  不存在 entry 的坏档。需人工确认盘上状态，再重新 `createOrResume`。

## 状态放在哪

`stateDir` > `$ECHO_HOME/agents/<agentId>` > `$PWD/.echo/agents/<agentId>`。

默认落在**项目内**而不是 `~/.echo`：后者会让两个不相干的项目静默共用同一份记忆，
而用户不会察觉。

## 公共面

由 `test/api-snapshot.test.ts` 锁着——增删任何导出符号都必须重录快照并人审 diff。
清点脚本是 `scripts/api-inventory.ts`，判据源与人读报告是同一份。

## 开发

```bash
bun test                 # 单测
bun run typecheck        # tsc --noEmit
bun run build            # 出 dist/（.js + .d.ts），发布前 prepack 自动跑
```

## 许可

MIT，见同目录 `LICENSE`（与仓库根那份字节一致，`files` 收它、`npm pack` 带它）。
