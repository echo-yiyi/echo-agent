# @echo-agent/coding

Echo's coding agent: file, search, shell and web tools mounted on top of
[`echo-agent`](https://www.npmjs.com/package/echo-agent). Installs the `echo-coding` command.

> **Requires [Bun](https://bun.sh/).** The executable is TypeScript with a `#!/usr/bin/env bun`
> shebang, and the package entry point is TypeScript source. Node is not supported for this
> package.

> **Status: pre-release.** Nothing is published to npm yet and the public surface may change
> before the first `0.x` release. Install from source for now.

## Run it

```bash
git clone https://github.com/echo-yiyi/echo-agent.git
cd echo-agent
bun install
MOONSHOT_API_KEY=sk-... bun packages/coding/bin/echo-coding.ts
```

The command name stays `echo-coding` even though the package is scoped — the unscoped name was
already taken on npm by an unrelated project.

`echo-coding` accepts the same options as `echo-agent` (`--help`). **It runs every tool without
asking**, in the interactive UI and through a pipe alike — treat it as a script that may change
files in the current directory.

Sessions belong to a directory *and* a command, so `echo-agent` and `echo-coding` never share a
conversation even in the same directory.

## What this package is

A **product**, not a framework layer. It owns its system prompt, its permission policy and the
`echo:workspace`, `echo:shell`, `echo:worktree` and `echo:web` extensions, then hands that preset
to `echo-agent`'s startup logic. It does not change a line of `echo-agent` — which is exactly the
path a third-party product would take on this runtime.

Full documentation is in the
[repository README](https://github.com/echo-yiyi/echo-agent#readme).

## License

MIT. See [LICENSE](https://github.com/echo-yiyi/echo-agent/blob/main/LICENSE).
