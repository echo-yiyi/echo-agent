# @echo-agent/coding

Echo's coding agent: file, search, shell and web tools, as a product built from
`@echo-agent/base` and `@echo-agent/tui`. Installs the `echo-coding` command.

> **Requires [Bun](https://bun.sh/).** The executable is TypeScript with a `#!/usr/bin/env bun`
> shebang, and the package entry point is TypeScript source. Node is not supported for this
> package.

> **Status: `0.x`.** Until `1.0`, a minor version may contain breaking changes.

## Run it

```bash
bun add -g @echo-agent/coding
MOONSHOT_API_KEY=sk-... echo-coding
```

Or run it once without installing: `bunx --package @echo-agent/coding echo-coding`.

The command name stays `echo-coding` even though the package is scoped — the unscoped name was
already taken on npm by an unrelated project.

`echo-coding` accepts the same options as `echo-agent` (`--help`). **It runs every tool without
asking**, in the interactive UI and through a pipe alike — treat it as a script that may change
files in the current directory.

Sessions belong to a directory *and* a command, so `echo-agent` and `echo-coding` never share a
conversation even in the same directory.

## What this package is

A **product**, not a framework layer. It owns its identity and conduct sections, its permission
policy and the `echo:workspace`, `echo:shell`, `echo:worktree` and `echo:web` extensions; the
launcher parts come from `@echo-agent/base` and the terminal shell from `@echo-agent/tui`. It does
not depend on `echo-agent` — the two are siblings, which is exactly the path a third-party product
would take on this runtime.

Full documentation is in the
[repository README](https://github.com/echo-yiyi/echo-agent#readme).

## License

MIT. See [LICENSE](https://github.com/echo-yiyi/echo-agent/blob/main/LICENSE).
