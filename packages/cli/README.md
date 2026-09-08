# echo-agent

Echo's general agent: the official CLI and interactive TUI. The same agent runs interactively
and through a Unix pipe.

> **Requires [Bun](https://bun.sh/).** The executable is TypeScript with a `#!/usr/bin/env bun`
> shebang, and the package exports resolve only under Bun. Node is not supported for this
> package. If you want the runtime as a library on Node, use
> [`@echo-agent/core`](https://www.npmjs.com/package/@echo-agent/core) instead — that one ships
> compiled JavaScript and is covered by a distribution test that installs the tarball into a
> clean project and runs it with Node.

> **Status: pre-release.** Nothing is published to npm yet and the public surface may change
> before the first `0.x` release. Install from source for now.

## Run it

```bash
git clone https://github.com/echo-yiyi/echo-agent.git
cd echo-agent
bun install
MOONSHOT_API_KEY=sk-... bun packages/cli/bin/echo-agent.ts
```

In a terminal this opens the interactive UI. With redirected stdin, each input line is one turn;
model text goes to stdout and operational output goes to stderr.

```bash
printf 'Introduce yourself in one sentence.\n' |
  MOONSHOT_API_KEY=sk-... bun packages/cli/bin/echo-agent.ts
```

See every option with `--help`. Select a provider with `--provider` and override its default
model with `--model`; the default provider is Kimi.

| Provider | Credential environment variable |
|---|---|
| `kimi` | `MOONSHOT_API_KEY` or `ECHO_LLM_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `openai` | `OPENAI_API_KEY` or `ECHO_LLM_API_KEY` |
| `zai` | `ZAI_CODING_CN_API_KEY`, `ZHIPU_API_KEY`, or `ECHO_LLM_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` or `ECHO_LLM_API_KEY` |

## What this package is

This is the **general** agent: it knows no specific product and ships no file or shell tools.
It is also the startup logic that products build on — [`@echo-agent/coding`](https://www.npmjs.com/package/@echo-agent/coding)
hands it a preset and reuses this launch path without changing a line of it.

Full documentation, the runtime API and the two-product layout are in the
[repository README](https://github.com/echo-yiyi/echo-agent#readme).

## License

MIT. See [LICENSE](https://github.com/echo-yiyi/echo-agent/blob/main/LICENSE).
