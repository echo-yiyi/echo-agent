## What and why

<!-- One or two sentences: what changed, and what problem it solves. -->

## Where to start reading

<!-- The file or hunk a reviewer should open first. -->

## Verification

<!--
What you actually ran, and what it printed. If the baseline was already red,
say so and show that this change adds no new failures.
-->

```
bun run typecheck
bun test
bun scripts/docs-lint.ts
```

## Risk

<!--
Anything touching a public API, an on-disk format, a package boundary, CI, or
credential handling. Write "none" if none.
-->
