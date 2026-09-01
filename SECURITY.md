# Security Policy

## Supported versions

echo-agent is **pre-release**. Nothing is published to npm and there are no tagged releases, so
only the current `main` branch is supported. Fixes land on `main`; there are no backports.

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**, or go straight to
<https://github.com/echo-yiyi/echo-agent/security/advisories/new>. That creates a private advisory
visible only to you and the maintainer.

Please include:

- What an attacker gains, and what access they need before they can start.
- A minimal reproduction — a repository state, a prompt, a tool call, or a short script.
- The commit you tested against and your Bun version.

This is a pre-release project maintained by one person. Expect an acknowledgement within about a
week; a fix timeline follows once we agree on the impact. If you intend to disclose publicly, tell
us when, and we will aim to have a fix on `main` by that date.

## In scope

echo-agent is an agent runtime that runs shell commands and reads and writes files on the user's
machine by design. "The agent ran a command" is the product, not a vulnerability. What we do want
to hear about:

- **Escaping the workspace root.** File tools resolve every path against a configured root and
  reject anything outside it (`packages/coding-agent/src/tools/fs.ts`). A path, symlink, or
  encoding that gets through is in scope.
- **Bypassing the permission layer.** A tool call that should have required approval and did not
  (`packages/core/src/permission/ledger.ts`).
- **Credential leakage.** API keys must not reach diagnostics, observation records, or on-disk
  state; there is a redaction layer with tests (`packages/core/src/observability/redact.ts`). Any
  path around it is in scope, including error messages thrown by third-party listeners.
- **Prompt injection that crosses a trust boundary** — untrusted content (a file, a tool result, a
  fetched page) causing an action the permission layer should have stopped. Injection that only
  produces a wrong answer is a quality bug; open a normal issue for that.
- **State corruption across the single-writer lock** — two writers admitted to one state root, or a
  crafted on-disk record that breaks recovery.

## Out of scope

- The agent doing something the user explicitly approved.
- Vulnerabilities in a model provider's API, or in the quality of a model's output.
- Anything that requires the attacker to already have write access to the user's machine or state
  directory.
- Denial of service by giving the agent an expensive task.
