# echo-agent

[English](README.md) | 中文

一个自主 agent 的运行时，以及基于它的两个产品：通用 agent `echo-agent` 与 coding agent `echo-coding`。可以装配一个 runtime、用自己的工具与 prompt 扩展它，或者给它换一个壳；同一个 agent 既能交互运行，也能接入 Unix 管道。

> **状态：尚未发布。** 尚未发布到 npm。现阶段请从源码安装；首个 `0.x` 版本发布前，公共 API 仍可能变化。

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

本仓库在同一个 runtime 上提供两个命令。两者平级，互不依赖：`echo-agent` 是通用 agent；`echo-coding` 加了文件、搜索、shell 与 web 工具，以及它自己的身份与纪律。两者都由 `@echo-agent/base` 装配起来，并选用同一个终端壳 `@echo-agent/tui`。

| | `echo-agent` | `echo-coding` |
|---|---|---|
| 能力 | 记忆、任务、schedule、skill（core 内建） | 上述全部，加文件读写、搜索、shell |
| 工具 | core 的 `echo:*` builtin | builtin 之外再加 `echo:workspace`、`echo:shell`、`echo:worktree` 与 `echo:web` |
| 命令 | `echo-agent` | `echo-coding` |

文件工具和 shell 工具只属于 `echo-coding`。一个产品自己拥有身份段、纪律段、自带的 extension 与可执行文件；启动器部件、宿主能力与管道壳来自 `@echo-agent/base`，交互形态则由它的可执行文件交进来的那个 `Shell` 实现决定。第三方基于这个 runtime 做产品走的是同一条路——自己画界面的产品只依赖 `@echo-agent/base`，不必装一个终端库。

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

重复传入 `--extensions <directory>` 可以指定 extension 搜索目录；未传时默认搜索 `./extensions`。用 `--no-memory` 关闭 Memory 与 Dream，或用 `--observe content` 把模型文本与工具参数结果也记进观测库（缺省是 `metadata`：只记形状与计数）。

每次启动都是新的一段会话。`--continue` 续本命令在当前目录的最近一段；`--resume <id>` 续指定的那一段。会话归属于「目录 + 命令」，所以 `echo-agent` 与 `echo-coding` 即使在同一目录里也不会共用一段对话；续上的会话会说明带回了多少条消息。

## 看一次 run 做了什么

每次 run 都会把自己记进会话状态根下的 `observations.sqlite`：run 的起止、回应 / 轮 / 尝试的嵌套、每一次模型生成与工具调用，以及它们背后的能力事实（记忆、任务、闹钟、收件）。记多少由 `--observe <档>` 决定。

| 档位 | 落盘的内容 |
|---|---|
| `off` | 什么都不记 |
| `metadata`（缺省） | 只有形状与计数——不含模型文本、工具参数与结果 |
| `content` | 在上面之外，再加模型文本、思考、工具参数与结果，**明文写在盘上** |

`observe` 子命令只读已落盘的记录。它不启动 agent、也不取会话锁，所以正在跑的会话它也能看——看到的是已经提交的那部分：

```bash
bun packages/cli/bin/echo-agent.ts observe last          # the most recent run, as text
bun packages/cli/bin/echo-agent.ts observe show <run-id>
bun packages/cli/bin/echo-agent.ts observe health        # where the database is, and how much is in it
bun packages/cli/bin/echo-agent.ts observe serve         # local read-only panel, Ctrl+C to stop
```

`observe serve` 会开一个面板，在 agent 跑着的时候轮询数据库。不给 `--session <id>` 时每个子命令都覆盖全部会话，所以一个面板就能看整个集群。管道形态每轮结束会在 stderr 打一行 `[run] <run-id> …`，那个 id 就是拿去 `observe show` 的。

观测永远拦不住 run：数据库写不动时 run 照跑，结果里会如实报出来。记录格式、两条 lane、失败语义与尚未做的部分，详见 [`docs/design/observability.md`](docs/design/observability.md)。

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

await echo.start();
try {
  await echo.send("Introduce yourself in one sentence.");
} finally {
  await echo.stop();
}
```

`createEcho()` 是装配 runtime 的唯一一处，所以自定义 host 从这里起步。要给运行中的 agent 加工具、prompt 段、压缩阶段或 hook，就写一条 extension：它声明自己注入什么、提供什么，生命周期归 host 管，卸载时不留残骸。壳也是一条 extension，只是它注入的是 `AgentRuntime` 这个 service 并把它渲染出来。`Agent` 类正在收进内部：已拍板、尚未实现（`docs/decisions/proposed/2026-09-07-agent-class-internal.md`），所以今天它仍然导出，但不是受支持的入口——它有相当一部分是为承载 host 专用接线而存在的，第三方需要的一切都在 extension API 上。

`echo.send()` 在返回结果的同时给出 run id，`echo.observations` 读的是 `observe` 子命令读的同一份账本——`getRun()`、`lastRun()`、`listRuns()`、`snapshot()` 与 `subscribe()`。采集档用 `createEcho({ observation: { capture: "content" } })` 设。想在不起 runtime 的情况下读一个状态根，用 `openObservationReader({ stateRoot })` 开一个不取锁的只读连接，用完关掉。观测永远拦不住 run：数据库写不动时 run 照跑，只是结果里的 `observationPersistence` 报 `degraded`。

## Packages

| Package | 职责 |
|---|---|
| `@echo-agent/core` | Runtime、engine、provider adapters、持久化、记忆、任务与 extension API |
| `@echo-agent/base` | 装配层：产品契约、启动器部件、宿主能力（凭据、设置、项目指令、observe 面板）与管道壳。不依赖任何终端库 |
| `@echo-agent/tui` | 终端壳：交互 TUI 与首次运行引导，作为壳端口的终端实现打包 |
| `echo-agent` | 通用 agent 产品：身份段与纪律段、它的 `Product`、以及 `echo-agent` 命令 |
| `@echo-agent/coding` | coding agent 产品：身份段与纪律段、`echo:workspace`、`echo:shell`、`echo:worktree`、`echo:web` 四条 extension，以及 `echo-coding` 命令 |

可运行的消费者在 [`examples/`](examples/) 中：真实 provider 的 hello world、无需凭据的 scripted agent，以及 extension 自动发现示例。分发测试会打包各 workspace，在干净项目中安装 tarball，三个样例都做类型检查，用 Bun 跑其中两个无需凭据的；Node 则另跑一段生成的冒烟脚本验证装好的包（hello 要真 key，只做类型检查）。

## 仓库目录

| 路径 | 内容 |
|---|---|
| [`packages/core/`](packages/core/) | `@echo-agent/core` runtime 与 SDK |
| [`packages/base/`](packages/base/) | `@echo-agent/base` 装配层 |
| [`packages/tui/`](packages/tui/) | `@echo-agent/tui` 终端壳 |
| [`packages/cli/`](packages/cli/) | `echo-agent`：通用 agent 产品 |
| [`packages/coding/`](packages/coding/) | `echo-coding`：coding agent 产品、它的四条工具 extension、它的 prompt pack 与命令 |
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
