# CLAUDE.md

This file applies to the whole repository. echo-agent has two API heights but only one high-level composition root: products and the CLI assemble through `createEcho()`, while custom hosts wire the ports themselves around `Agent` from `@echo-agent/core`. Do not duplicate assembly logic at any other entry point.

## Pre-release: get the foundation right

**Revisit and delete or rewrite this section after the first tagged release.** There is no published version to stay compatible with. When a public API, package boundary, or on-disk format turns out to be wrong, fix the root cause and update every reference, test, and document in the same change — no compatibility aliases, no silent fallbacks papering over the problem.

This is not a license to widen the change: before altering a public API, a persistence format, a cross-package boundary, or the overall architecture, state the impact and the migration, then get confirmation.

## Repository map

| Path | Responsibility |
|---|---|
| `packages/core/` | Runtime, engine, provider adapters, state, memory, tasks, and the extension API |
| `packages/cli/` | Official CLI and interactive TUI; a consumer of the high-level assembly |
| `packages/coding-agent/` | Coding-agent preset |
| `examples/` | Runnable samples that consume the public API from tarballs |
| `test/` | Repository-level distribution and documentation gates |
| `scripts/` | Inventory, documentation checks, and repository tooling |

Use Bun to manage the workspace, run scripts, and run tests. Do not introduce a second package manager or lockfile.

## Tests are evidence, not design authority

- Tests describe current behavior; they do not by themselves prove it is correct. When a design decision changes, change the stale implementation and its tests together, and say why.
- To describe what the code *does*, cite public types, implementations, and reproducible behavior. To describe what it *should* do, cite a design decision the user confirmed.
- **A document you cannot write may be a code problem.** If one concept has two sources of truth, a boundary cannot be defined, or failure semantics conflict, report both sides with `file:line` and a reproduction command — do not invent a coherent story on the code's behalf.
- Only a precise machine criterion counts as "guarded." Comments, narrow tests, and review habits are "discipline" — say which one you mean.
- Every fact has exactly one authoritative home. Link to it from elsewhere; never copy a second version that will rot on its own.

## Writing documentation from source

1. Start from the action a reader wants to complete, or the design question they need answered.
2. Trace from the public entry point through types, implementations, error paths, and tests. Do not read only the facade or the comments.
3. Verify commands, environment variables, defaults, lifecycles, and failure behavior by running them. A fixture proves only what the fixture covers; it never stands in for a live service.
4. Write the current behavior, the reasoning, the trade-offs, and the failure modes. Do not restate the source tree in prose.
5. Comments and docs carry stable semantics, ordering, ownership, and safe usage — not reasoning history or review archaeology.

Registration and bilingual rules:

- `docs/docs.manifest.json` registers only documents that already exist and are meant to be maintained. Planned files belong in issues, not in the manifest as dead placeholders.
- When an entry is marked bilingual, the English `.md` and Chinese `.zh.md` keep the same sections, lists, tables, and code blocks, with code blocks byte-identical.
- Update `.i18n.yaml` only after a human has confirmed the two sides say the same thing. The hash proves nothing changed after that confirmation; it does not prove the translation is right.
- TypeScript samples must compile standalone. Relative links must point at targets that already exist.

## Commands and evidence

```bash
bun install
bun run typecheck
bun test <relevant-test-files>
bun test
bun scripts/docs-lint.ts
bun test test/docs.test.ts test/export-jsdoc.test.ts
```

- Run the narrowest relevant tests first when changing behavior. Do not reach for the full suite instead of locating the problem.
- Run the API snapshot when public exports change; run the distribution gate when package, export, or Node/Bun consumption surfaces change.
- Provider request shapes can be proven with mocks and fixtures. Claiming a live provider works requires evidence from the real API.
- Run the docs lint and documentation tests after documentation changes — but a green gate does not make the technical narrative or the translation correct. Human review still applies.
- Reserve the full suite for cross-module changes and final integration. Do not re-run checks that already passed in the same state.

If the baseline is already red, show separately that this change adds no new failures, and report the remaining ones. Do not repair unrelated scope to buy a green run, and never report red as green.

## Editing and handoff

Read the relevant implementation, its tests, and the current diff first. Preserve the user's in-flight edits. Ask before deleting files, refactoring across modules, changing a public API or the architecture, adding or removing dependencies, or touching CI and build configuration. Do not commit, push, or publish a package unless explicitly asked.

When handing off, state what changed, the key design judgments, the verification you actually ran, and what is still broken.
