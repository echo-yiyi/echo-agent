# echo-agent

English | [中文](README.zh.md)

An agent runtime and its official CLI: use the assembled runtime, build directly on the engine, or run the same agent interactively and through a Unix pipe.

> **Status: pre-release and not published.** The workspace packages are currently private. Install from source for now; the public API may change before the first `0.x` release.

## Quick start

[Bun](https://bun.sh/) is required to work from this repository. The default provider is Kimi.

```bash
bun install
MOONSHOT_API_KEY=sk-... bun packages/cli/bin/echo-agent.ts
```

In a terminal, the command opens the interactive UI. With redirected stdin, each input line is one turn; model text goes to stdout and operational output goes to stderr.

```bash
printf 'Introduce yourself in one sentence.\n' |
  MOONSHOT_API_KEY=sk-... bun packages/cli/bin/echo-agent.ts
```

By default, persistent state lives at `$ECHO_HOME/agents/<id>`, or `$PWD/.echo/agents/<id>` when `ECHO_HOME` is unset. Use `--state-dir <path>` to override the complete state directory.

## Use the CLI

See every option with:

```bash
bun packages/cli/bin/echo-agent.ts --help
```

Select a provider with `--provider`; override its default model with `--model`.

| Provider | Credential environment variable |
|---|---|
| `kimi` | `MOONSHOT_API_KEY` or `ECHO_LLM_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `openai` | `OPENAI_API_KEY` or `ECHO_LLM_API_KEY` |
| `zai` | `ZAI_CODING_CN_API_KEY`, `ZHIPU_API_KEY`, or `ECHO_LLM_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` or `ECHO_LLM_API_KEY` |

The MiniMax adapter is covered by fixtures but has not yet been exercised against the live service.

Use repeatable `--extensions <directory>` flags to choose the extension search directories; with no flag, the CLI searches `./extensions`. Pass `--no-memory` to omit Memory and Dream, or `--agent-id <id>` to choose the persistent agent identity.

## Use the runtime

`createEcho()` is the high-level composition root. It wires persistence, memory, tasks, and extensions, while lifecycle remains explicit:

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

For custom hosts, import `Agent` from `@echo-agent/core` and supply the model, stream function, and ports yourself. Both heights sit on the same entry point: `createEcho()` assembles the full runtime, while `Agent` leaves the ports to you.

## Packages

| Package | Role |
|---|---|
| `@echo-agent/core` | Runtime, engine, provider adapters, persistence, memory, tasks, and the extension API |
| `echo-agent` | Official CLI with interactive and piped modes |
| `@echo-agent/coding-agent` | Coding preset with workspace and shell extensions |

Runnable consumers live in [`examples/`](examples/): a real-provider hello world, a credential-free scripted agent, and extension auto-discovery. The distribution test packs the workspaces, installs the tarballs in clean projects, and runs these public entry points with Bun and Node.

## Repository layout

| Path | Contents |
|---|---|
| [`packages/core/`](packages/core/) | `@echo-agent/core` runtime and SDK |
| [`packages/cli/`](packages/cli/) | `echo-agent` CLI and TUI shell |
| [`packages/coding-agent/`](packages/coding-agent/) | Coding-agent preset |
| [`examples/`](examples/) | Executable package consumers |
| [`test/`](test/) | Repository-level distribution and documentation checks |

## Development

```bash
bun install
bun run typecheck
bun test
```

## Acknowledgements

- [Pi](https://github.com/earendil-works/pi), whose `pi-tui` package provides the terminal UI foundation used by the official CLI.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), whose open architecture and documentation informed this project's design and documentation work.

## License

Copyright © 2026 echo-yiyi.

echo-agent is released under the [MIT License](LICENSE). You may use it privately or commercially, copy it, modify it, distribute it, and sublicense it. If you distribute the software or a substantial portion of it, you must retain the original copyright and license notice.

The software is provided as-is, without warranty. Third-party components remain subject to their own licenses. If this summary differs from the license text, the [`LICENSE`](LICENSE) file controls.
