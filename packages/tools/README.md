# @echo-agent/tools

Echo's standard tool packs: the tools an agent uses to act on the machine it runs on. They belong
to no single product. A product mounts the packs it wants; `echo-coding` mounts all three.

> **Requires [Bun](https://bun.sh/).** The package entry point is TypeScript source. Node is not
> supported for this package.

> **Status: `0.x`.** Until `1.0`, a minor version may contain breaking changes.

## The three packs

| Extension | Tools | Notes |
|---|---|---|
| `ECHO_WORKSPACE` (`echo:workspace`) | `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `list_dir` | Confined to the session's workspace: a path that leads outside it, directly or through a symlink, is refused. An existing file must be read before it is changed. |
| `ECHO_SHELL` (`echo:shell`) | `bash`, `job_output`, `job_stop` | Not confined to the workspace. echo's own API keys are left out of the commands' environment; that stops a casual `$KEY`, not a command that reads the parent process's environment as the same user. With `{ sandbox: true }` they run in an OS sandbox (macOS `sandbox-exec`, Linux bubblewrap) that can write only inside the workspace, temporary directories and package caches, and cannot read echo's credential file. |
| `ECHO_WEB` (`echo:web`) | `web_fetch`, `web_search` | `web_fetch` reaches public internet addresses only. `web_search` uses Brave Search and needs `BRAVE_API_KEY` or a `brave` entry in the credential store. Both are deferred tools. |

## Mount them

Each pack is an extension entry for `createEcho()`. `ECHO_WORKSPACE` and `ECHO_WEB` take their
tools, and optionally prompt sections, as config; `ECHO_SHELL` builds its own, because `bash`
needs the agent's background queue.

```text
import { createEcho } from "@echo-agent/core";
import { ECHO_SHELL, ECHO_WEB, ECHO_WORKSPACE, makeFsTools, makeSearchTools, makeWebTools, workspaceToolsSection } from "@echo-agent/tools";

const echo = await createEcho({
  provider,
  workspace: process.cwd(),
  extensions: [
    { entryId: "echo:workspace", definition: ECHO_WORKSPACE, config: { tools: [...makeFsTools(), ...makeSearchTools()], sections: [workspaceToolsSection()] } },
    { entryId: "echo:shell", definition: ECHO_SHELL, config: { sandbox: true } },
    { entryId: "echo:web", definition: ECHO_WEB, config: { tools: makeWebTools() } },
  ],
});
```

Nothing here decides whether a call is allowed. That is the permission policy the product passes
to `createEcho()`: `bash` can reach outside the workspace, so a product that mounts `ECHO_SHELL`
should say who approves it.

Full documentation is in the
[repository README](https://github.com/echo-yiyi/echo-agent#readme).

## License

MIT. See [LICENSE](https://github.com/echo-yiyi/echo-agent/blob/main/LICENSE).
