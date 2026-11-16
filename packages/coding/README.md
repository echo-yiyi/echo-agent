# @echo-agent/coding

Echo's coding agent: file, search, shell and web tools, as a product built from
`@echo-agent/base`, `@echo-agent/tools` and `@echo-agent/tui`. Installs the `echo-coding` command.

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

`echo-coding` accepts the same options as `echo-agent` (`--help`). In the interactive UI, the
runtime's safety classifier checks every shell command, web fetch and any tool not known to be
safe (MCP and extension tools included) against what you asked for, before it runs: a one-word
quick check, and a careful second look only for what the quick check flags. You are asked only when
the classifier keeps blocking or cannot run. **Through a pipe it runs every tool without asking** —
treat it there as a script that may change files in the current directory.

Both switches are yours, in `$ECHO_HOME/settings.json`:

- `"safetyClassifier"`: unset, it is on in the interactive UI and off through a pipe; set, it applies
  to both.
- `"sandbox": true`: shell commands run in an OS sandbox (macOS `sandbox-exec`, Linux bubblewrap)
  that can write only inside the working directory, temporary directories and package caches, and
  cannot read echo's credential file. Off by default, because the usual setup already runs the whole
  agent inside a container. Where no sandbox can start, each command has to run explicitly outside
  it and is checked by the classifier; with the classifier off, such a command asks you first.

Sessions belong to a directory *and* a command, so `echo-agent` and `echo-coding` never share a
conversation even in the same directory.

## What this package is

A **product**, not a framework layer. It owns its identity and conduct sections, its permission
policy and the `echo:worktree` extension (git worktree isolation). The file, search, shell and web
tools are not its own: the `echo:workspace`, `echo:shell` and `echo:web` extensions come from
`@echo-agent/tools`, and this product mounts them. The launcher parts come from `@echo-agent/base`
and the terminal shell from `@echo-agent/tui`. It does not depend on `echo-agent` — the two are
siblings, which is exactly the path a third-party product would take on this runtime.

Full documentation is in the
[repository README](https://github.com/echo-yiyi/echo-agent#readme).

## License

MIT. See [LICENSE](https://github.com/echo-yiyi/echo-agent/blob/main/LICENSE).
