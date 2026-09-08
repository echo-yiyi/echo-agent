# echo-agent

[English](README.md) | 中文

一个自主 agent 的运行时，以及基于它的两个产品：通用 agent `echo-agent` 与 coding agent `echo-coding`。可以装配一个 runtime、用自己的工具与 prompt 扩展它，或者给它换一个壳；同一个 agent 既能交互运行，也能接入 Unix 管道。

> **状态：尚未发布。** workspace 中的 packages 目前均为 private。现阶段请从源码安装；首个 `0.x` 版本发布前，公共 API 仍可能变化。

## 快速开始

从本仓库运行需要 [Bun](https://bun.sh/)。默认 provider 是 Kimi。

```bash
bun install
MOONSHOT_API_KEY=sk-... bun packages/cli/bin/echo-agent.ts
```

在终端中运行会打开交互界面。stdin 被重定向时，每一行输入是一轮对话；模型正文写入 stdout，运行信息写入 stderr。

```bash
printf 'Introduce yourself in one sentence.\n' |
  MOONSHOT_API_KEY=sk-... bun packages/cli/bin/echo-agent.ts
```

每一段会话就是一个独立的状态根：`$ECHO_HOME/sessions/<session-id>`；未设置 `ECHO_HOME` 时是 `~/.echo/sessions/<session-id>`。它的对话账本、inbox、任务清单、闹钟与锁都在那儿，所以两段会话可以并排跑、不抢同一把锁。记忆与技能是跨会话共享的，放在上一层的 `$ECHO_HOME`。用 `--state-dir <path>` 可以把会话目录挪到别处。

## 两个产品

本仓库在同一个 runtime 上提供两个命令。`echo-agent` 是通用 agent，不认识任何具体产品；`echo-coding` 依赖 `echo-agent`，在它之上加了文件、搜索与 shell 工具。

| | `echo-agent` | `echo-coding` |
|---|---|---|
| 能力 | 记忆、任务、schedule、skill（core 内建） | 上述全部，加文件读写、搜索、shell |
| 工具 | core 的 `echo:*` builtin | builtin 之外再加 `echo:workspace`、`echo:shell`、`echo:worktree` 与 `echo:web` |
| 命令 | `echo-agent` | `echo-coding` |

文件工具和 shell 工具只属于 `echo-coding`。`echo-coding` 不改 `echo-agent` 一行代码：它把自己的 preset（系统 prompt、权限策略、那两条 extension）交给 `echo-agent` 的启动逻辑——第三方基于这个 runtime 做产品也是同一条路。

```bash
MOONSHOT_API_KEY=sk-... bun packages/coding/bin/echo-coding.ts
```

两个命令接受同一套选项（`--help`）。`echo-coding` 的所有工具都不询问、直接执行，交互界面和管道形态一样——把它当作一个会改当前目录文件的脚本来用。

## 使用 CLI

查看全部选项：

```bash
bun packages/cli/bin/echo-agent.ts --help
```

用 `--provider` 选择 provider；用 `--model` 覆盖该 provider 的默认模型。

| Provider | 凭据环境变量 |
|---|---|
| `kimi` | `MOONSHOT_API_KEY` 或 `ECHO_LLM_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `openai` | `OPENAI_API_KEY` 或 `ECHO_LLM_API_KEY` |
| `zai` | `ZAI_CODING_CN_API_KEY`、`ZHIPU_API_KEY` 或 `ECHO_LLM_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` 或 `ECHO_LLM_API_KEY` |

MiniMax adapter 目前有 fixture 覆盖，但还没有用真实服务验证。

重复传入 `--extensions <directory>` 可以指定 extension 搜索目录；未传时默认搜索 `./extensions`。用 `--no-memory` 关闭 Memory 与 Dream，或用 `--agent-id <id>` 选择记进锁里的持有者身份。

每次启动都是新的一段会话。`--continue` 续本命令在当前目录的最近一段；`--resume <id>` 续指定的那一段。会话归属于「目录 + 命令」，所以 `echo-agent` 与 `echo-coding` 即使在同一目录里也不会共用一段对话；续上的会话会说明带回了多少条消息。

## 使用 runtime

`createEcho()` 是高层 composition root。它装配持久化、记忆、任务和 extensions，但生命周期仍由调用方显式控制：

```ts
import { createEcho, kimiProvider } from "@echo-agent/core";

const echo = await createEcho({ provider: kimiProvider() });

echo.agent.subscribe((event) => {
  if (event.type === "message_update" && event.delta.type === "text_delta") {
    process.stdout.write(event.delta.text);
  }
});

await echo.agent.start();
try {
  await echo.agent.prompt("Introduce yourself in one sentence.");
} finally {
  await echo.stop();
}
```

`createEcho()` 是装配 runtime 的唯一一处，所以自定义 host 从这里起步。要给运行中的 agent 加工具、prompt 段、压缩阶段或 hook，就写一条 extension：它声明自己注入什么、提供什么，生命周期归 host 管，卸载时不留残骸。壳也是一条 extension，只是它注入的是 `AgentRuntime` 这个 service 并把它渲染出来。`Agent` 类本身是内部的：它有相当一部分是为承载 host 专用接线而存在的，第三方需要的一切都在 extension API 上。

## Packages

| Package | 职责 |
|---|---|
| `@echo-agent/core` | Runtime、engine、provider adapters、持久化、记忆、任务与 extension API |
| `echo-agent` | 通用 agent：官方 CLI，支持交互与管道两种形态；不认识任何具体产品 |
| `@echo-agent/coding` | coding agent：依赖 `echo-agent`，加 `echo:workspace`、`echo:shell`、`echo:worktree`、`echo:web` 四条 extension 和 `echo-coding` 命令 |

可运行的消费者在 [`examples/`](examples/) 中：真实 provider 的 hello world、无需凭据的 scripted agent，以及 extension 自动发现示例。分发测试会打包各 workspace，在干净项目中安装 tarball，再用 Bun 和 Node 运行这些公共入口。

## 仓库目录

| 路径 | 内容 |
|---|---|
| [`packages/core/`](packages/core/) | `@echo-agent/core` runtime 与 SDK |
| [`packages/cli/`](packages/cli/) | `echo-agent` CLI 与 TUI shell |
| [`packages/coding/`](packages/coding/) | `echo-coding` CLI：coding preset、它的两条 extension 与命令 |
| [`examples/`](examples/) | 可执行的 package consumers |
| [`test/`](test/) | 仓库级分发门与文档检查 |

## 开发

```bash
bun install
bun run typecheck
bun test
```

## 致谢

- [Pi](https://github.com/earendil-works/pi)：其 `pi-tui` package 为官方 CLI 提供了终端 UI 基础。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：其开放的架构与文档为本项目的设计和文档工作提供了参考。

## 许可

Copyright © 2026 echo-yiyi。

echo-agent 使用 [MIT 许可证](LICENSE)。你可以将它用于个人或商业项目，也可以复制、修改、分发或再许可。分发本软件或其实质部分时，必须保留原始版权与许可声明。

本软件按现状提供，不附带任何担保。第三方组件分别适用其自身的许可证。如果本段说明与许可证原文存在差异，以 [`LICENSE`](LICENSE) 文件为准。
