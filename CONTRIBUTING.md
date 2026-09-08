# Contributing to echo-agent

Thanks for looking. This project is **pre-release**: nothing is published to npm yet, and the public
API can still change. Design mistakes get fixed at the root
rather than papered over with compatibility shims — see the pre-release section of
[AGENTS.md](AGENTS.md) for what that means in practice.

Issues and pull requests are welcome in **English or Chinese**; the maintainer reads both.

## Prerequisites

[Bun](https://bun.sh) 1.3.14 or newer. It is the only supported toolchain — please do not
introduce a second package manager or lockfile.

```bash
bun install
```

## The checks

Run the narrowest relevant check while you work; save the full suite for cross-module changes
and final integration.

```bash
bun run typecheck                # all three packages plus the repo tsconfig
bun test <relevant-test-files>   # while you work
bun test                         # before opening a pull request
bun scripts/docs-lint.ts         # after touching docs or doc comments
```

**CI blocks on `bun run typecheck` and `bun test`.** All five documentation checks — roster, links,
code, filerefs, pairing — run inside `bun test` (`test/docs.test.ts`), so a dead link or a wrong file
path in a doc comment turns the suite red. CI runs `bun scripts/docs-lint.ts` once more only to print
the per-check summary in the log; any violation exits non-zero there as well.

If the baseline is already red when you start, say so in the pull request and show that your change
adds no new failures. Do not repair unrelated scope to buy a green run, and do not report red as
green.

## Pull requests

- One concern per pull request. A description of what changed and why is worth more than a large
  diff that supposedly explains itself.
- Tests are evidence, not design authority. If you change behaviour, update the stale test in the
  same change and say why the old expectation was wrong.
- Open an issue first before deleting files, refactoring across modules, changing a public API or
  an on-disk format, adding or removing a dependency, or touching CI. A large pull request that
  gets rejected on direction costs you more than it costs the maintainer.
- **No CLA and no DCO.** There is no sign-off requirement; an ordinary commit is fine.

## Conventions

The working conventions — architecture boundaries, what counts as evidence, how documentation is
written and registered — live in [CLAUDE.md](CLAUDE.md) (English) and [AGENTS.md](AGENTS.md)
(Chinese). They are addressed to coding agents but apply to humans unchanged. Read the repository
map and the "Tests are evidence, not design authority" section before your first substantial
change.

Documentation is registered in `docs/docs.manifest.json`. Only documents that already exist and are
meant to be maintained belong there; planned files belong in issues, not in the manifest as dead
placeholders. Adding an unregistered Markdown file to the repository turns the roster check red.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
