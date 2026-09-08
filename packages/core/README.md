# @echo-agent/core

一个**持续存在的 agent** 的最小可执行内核：状态机 + 循环 + 会话持久化，零运行时依赖。

不是框架。它不替你选模型、不规定工具怎么写、不带 CLI——你给它一个 `Model` 和一组端口，
它负责「跑完一轮任务」以及「进程重启之后还记得自己是谁」。

```ts
import { createEcho, type Provider } from "@echo-agent/core";

declare const myProvider: Provider;

const echo = await createEcho({ provider: myProvider });
await echo.agent.start();               // 取单写锁 → 恢复会话（今天还得经 echo.agent：Echo 自己没有 start()）
const result = await echo.send("把 README 翻成英文"); // = agent.prompt() + 观测三元组，第三方走这条
await echo.stop();                      // 先卸扩展 → 等落盘 settle → 释放锁
```

`createEcho()` 是**唯一的装配现场**：它装好 Agent，再把内建能力（Task / Skill / Memory / Schedule）
与 `<cwd>/extensions/` 里你自己写的扩展，**用同一套机制**装上去。装了什么在 `echo.extensions` 里看得见。

## 三条正门

**都在 `@echo-agent/core` 这一条入口上**：

| 要做什么 | 从哪进 |
|---|---|
| 起一个能跑的 agent | `createEcho()`——只给 provider，端口、内建能力与扩展装配都已备好；它是**唯一**的装配现场 |
| 给它加工具 / prompt 段 / 压缩阶段 / hook | 写一条 extension（`@echo-agent/core/extension`）：声明注入什么、提供什么，生命周期归 host，卸载不留残骸 |
| 换一个壳（Web、别的终端） | 同样是一条 extension，注入 `AgentRuntime` 这个 service 并把它渲染出来 |

**`Agent` 类将收进内部**（2026-09-07 拍板、尚未实现，记录在仓库 `docs/decisions/proposed/2026-09-07-agent-class-internal.md`；今天它还在公共面上，api-snapshot 里能看到）：它有相当一部分是为承载 host 专用接线（写入闸、所有权账本、观测 writer）而存在的，把它当公共面等于承诺那些。第三方要的深度在 extension ABI 上——那条路带 `hostAbiVersion` 校验、Fiber/Effect 所有权与整代回滚，比裸类安全。别在新代码里 `new Agent()`。

另有 `@echo-agent/core/testing`（FakeProvider 与脚本化流、in-memory 观测 collector）、
`@echo-agent/core/extension`（写扩展的 ABI）、`@echo-agent/core/task/fs`、`@echo-agent/core/mcp`。

## 几条硬约定

- **零运行时依赖。** 运行时依赖三字段（`dependencies` / `optionalDependencies` / `peerDependencies`）恒空，有门守着。
- **fail-loud，绝不静默降级。** 缺凭据、拿不到锁、盘上有坏档——一律抛，不回退到「假装成功」。
- **single-writer。** 一个状态根同时只允许一个写者。锁被占着就拒绝启动，**core 不猜对面是不是死了**，
  也不抢占没有自称可让位（`preemptible`）的持有者——可让位的实例被请走时自己交还并退出（2026-09-07：人优先，后台让位）；
  崩溃后需人工清锁（`inspectStateLock()` 告诉你是谁占着）。
- **`write()` resolve 即持久。** 存储端口上没有 `flush`；`stop()` 等的是未 settle 的写。
- **持久化失败会封存该会话。** 一次写失败之后拒绝继续写——继续写只会产出 parent 指向
  不存在 entry 的坏档。需人工确认盘上状态，再重新 `createOrResume`。

## 状态放在哪

**状态根 = 一段 session 的目录**（2026-09-03 起）：`stateDir` > `<sessionsRoot>/<sessionId>` >
`$ECHO_HOME/sessions/<sessionId>` > `~/.echo/sessions/<sessionId>`。

一段 session 就是一个独立在跑的 agent，所以按状态根一份的东西——lease、会话账本、inbox、任务清单、
闹钟、观测库——都变成按 session 一份。同一台机器上两段 `echo-coding` 因此各拿各的锁、能同时起来；
在旧布局（`agents/<agentId>/`）下第二段直接 fail-loud。

跨 session 共享的记忆与技能**不在**状态根下，在 `$ECHO_HOME`（缺省 `~/.echo`）下面：

| 放什么 | 在哪 |
| --- | --- |
| 这一段的账本、inbox、tasks、schedule、lease、观测库 | `<ECHO_HOME>/sessions/<id>/` |
| 记忆 · user 层（这个用户的所有 session） | `<ECHO_HOME>/memory/` |
| 记忆 · project 层（在同一个目录下工作的 session） | `<ECHO_HOME>/projects/<workspace 哈希>/memory/` |
| 记忆 · role 层（跑同一个角色定义的 session；没有角色名就没有这层） | `<ECHO_HOME>/agents/<角色名>/memory/` |
| 技能 | `<ECHO_HOME>/skills/` |
| 凭据、设置、扩展 | `<ECHO_HOME>/` |

记忆作用域**由产品声明**，core 不认识具体层名；上面三层是 core 的缺省表（`DEFAULT_MEMORY_SCOPES`，`packages/core/src/create-agent.ts`），
产品给 `memoryScopes` 就整份替换。

工作目录是 **session** 的字段（`SessionInfo.workspace`），不是状态根的一部分——换个目录起就是新的一段，
user 层记忆与技能仍是同一份，project 层按 workspace 哈希换一套。**要整体隔离（评测、单测）就设 `ECHO_HOME`**：只给 `stateDir` 只挪走 session 那一半。

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
