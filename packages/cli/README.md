# echo-agent

Echo's general agent: the official CLI and interactive TUI. The same agent runs interactively
and through a Unix pipe.

> **Requires [Bun](https://bun.sh/).** The executable is TypeScript with a `#!/usr/bin/env bun`
> shebang, and the package exports resolve only under Bun. Node is not supported for this
> package. If you want the runtime as a library on Node, use
> [`@echo-agent/core`](https://www.npmjs.com/package/@echo-agent/core) instead — that one ships
> compiled JavaScript and is covered by a distribution test that installs the tarball into a
> clean project and runs it with Node.

> **Status: `0.x`.** Until `1.0`, a minor version may contain breaking changes.

## Run it

```bash
bun add -g echo-agent
MOONSHOT_API_KEY=sk-... echo-agent
```

Or run it once without installing: `bunx echo-agent`.

In a terminal this opens the interactive UI. With redirected stdin, each input line is one turn;
model text goes to stdout and operational output goes to stderr.

```bash
printf 'Introduce yourself in one sentence.\n' |
  MOONSHOT_API_KEY=sk-... echo-agent
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
Its launcher parts come from `@echo-agent/base` and its terminal shell from `@echo-agent/tui`.
[`@echo-agent/coding`](https://www.npmjs.com/package/@echo-agent/coding) is a sibling product built
from the same two packages, not on top of this one.

Full documentation, the runtime API and the two-product layout are in the
[repository README](https://github.com/echo-yiyi/echo-agent#readme).

## License

MIT. See [LICENSE](https://github.com/echo-yiyi/echo-agent/blob/main/LICENSE).
