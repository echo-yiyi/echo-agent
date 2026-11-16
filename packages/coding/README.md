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

`echo-coding` accepts the same options as `echo-agent` (`--help`). In the interactive UI, every
shell command, web fetch and any tool it does not know to be safe (MCP and extension tools
included) is first reviewed by the session's model against what you asked for: a one-word quick
check, and a careful second look only for what the quick check flags. You are asked only when the
review keeps blocking or cannot run. Shell commands run in an OS sandbox (macOS `sandbox-exec`,
Linux bubblewrap) that can write only inside the working directory, temporary directories and
package caches, and cannot read echo's credential file. Where no sandbox works (inside most
containers), each command has to run explicitly outside it and is reviewed the same way.
**Through a pipe it runs every tool without asking** — treat it there as a script that may change
files in the current directory.

Whether the review runs is your call: set `"safetyReview": false` (or `true`) in
`$ECHO_HOME/settings.json`. Unset, it is on in the interactive UI and off through a pipe; set, it
applies to both. With the review off, the sandbox still applies in the interactive UI, and a
command that asks to run outside it asks you first.

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
