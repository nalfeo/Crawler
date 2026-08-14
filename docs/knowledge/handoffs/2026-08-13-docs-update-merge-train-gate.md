# Docs update merge-train gate

## Summary

Changed the docs-update workflow so it runs only after the Merge Train actually
lands a promotion on `main` whose payload contains at least one
non-documentation file. Docs-only payloads now exit before dependency
installation, checks, PR creation, or report generation.

`merge-train.yml` itself runs on every raw `main` push, so a completed run with
`workflow_run.event == 'push'` is not evidence of a promotion. The gate instead
requires the durable `Merge-Train-PR: <n>` trailer that promotion writes into
the squash commit (`squashCommitMessage` in `.github/scripts/merge-train/state.mjs`),
which is the same provenance `resolve-landed-pr.mjs` already trusts.

The classifier lives in `.github/scripts/docs-update-payload-gate.mjs` so it is
directly unit-testable. It derives changed files with `git show --no-renames` so
a cross-surface rename (`src/core/foo.ts` -> `docs/foo.md`) is not collapsed to
its docs destination, and it mirrors the `docs_only` rules in
`scripts/agent/ci/detect-art-only.sh` (notably: nothing under `src/` is docs).

## Files touched

- `.github/workflows/docs-update.yml`
- `.github/scripts/docs-update-payload-gate.mjs`
- `.github/scripts/docs-update-payload-gate.test.mjs`
- `tests/unit/docs-update-workflow.test.ts`

## Verification run

- `node --test .github/scripts/docs-update-payload-gate.test.mjs` passed
  (14 table-driven gate cases: docs-only, non-doc, `src/**/*.md`, cross-surface
  rename, empty payload, failed/cancelled run, schedule and wake-up events,
  missing trailer, inline trailer mention).
- `npx vitest run --project unit tests/unit/docs-update-workflow.test.ts` passed.
- CLI smoke run against a non-train `HEAD` reported `run=false (landed commit
carries no Merge-Train-PR trailer)`, and an unreadable SHA failed closed.
- Prettier check and lint passed for the changed files.

## Unresolved issues

- None.

## Recommended next steps

- None.

## Systems touched

agent-tooling
