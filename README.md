# echo-agent

一个自主 agent 的运行时与官方 CLI。两个包：

| 包 | 是什么 | 硬约束 |
|---|---|---|
| `@echo-agent/core` | Runtime / SDK。循环、消息、状态机、工具调用、Extension 微内核、记忆与任务 | **运行时依赖恒空，不出 bin**（`packages/core/test/zero-runtime-deps.test.ts` 守着） |
| `echo-agent` | 官方默认壳，**唯一的 `echo-agent` 可执行文件**（交互 / 管道两形态） | 依赖恰好 `@echo-agent/core` + `pi-tui` |

外加 `@echo-agent/coding-agent`：一份 preset（系统 prompt + 权限策略 + `echo:workspace` / `echo:shell`
两条 Extension），把 core 装成一个能读写文件、跑命令的 coding agent。

> **状态：搬迁中，尚未发布。** npm 上的 `echo-agent@0.0.0` 只是名称占位。
> 首个真实版本会是 `0.x`——`0.x` 就是 semver 里那个意思：公共面还会变。

## 跑起来

```bash
bun install
bun run typecheck   # 四段 tsc --noEmit
bun test            # 三个包 + 分发门
```

## 两个使用高度，一个 composition root

```ts
// 高：装配好的完整 Runtime——扩展自动发现、内建能力都装上了
import { createEcho, kimiProvider } from "@echo-agent/core";
const echo = await createEcho({ provider: kimiProvider() });
await echo.agent.start();

// 低：自己给端口、自己注册工具
import { Agent } from "@echo-agent/core/engine";
const agent = new Agent({ model, streamFunction });
```

**装配只有 `createEcho()` 一处**。CLI 是它的调用方，不是第二个装配现场。

## 形态由 stdin 决定

```bash
echo-agent                    # 终端里 → 交互界面
echo "修掉失败的测试" | echo-agent   # 管道里 → 一行一轮，正文进 stdout、旁白进 stderr
```

不给 `--pipe` 这类开关：有没有人坐在终端前，进程自己看得见。

## 目录

```
packages/core/          @echo-agent/core —— Runtime / SDK
packages/cli/           echo-agent —— 官方 CLI 与 TUI 壳
packages/coding-agent/  @echo-agent/coding-agent —— coding preset
examples/               装 tarball 就能跑的样例（同时是分发门的消费者）
test/                   仓库级的门：pack → install → 真执行
```

## License

MIT
