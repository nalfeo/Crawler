# Goobers recovery partial progress

## Systems touched

agent-tooling, ci

## Summary

- Added a hosted deterministic recovery step that follows issue timeline
  cross-references to an open PR, passes its validated head through the
  instance allowlist, and emits Goobers' `workspaceBranch` contract so each
  managed worktree updates that PR rather than creating a duplicate.
- Targeted recovery now rejects assigned issues before applying the in-review
  label, preserving the normal `requireUnassigned` contract.
- Added an explicit `abandon_existing` manual-dispatch escape hatch that closes
  the attached open PR before starting over.
- Added a checkpoint push immediately after implementation so committed work
  survives later review or local-CI failures.

## Verification

- `npx vitest run tests/unit/goobers-run-workflow.test.ts --project unit`
- `npm run verify:fast`

## Limitations

Recovery depends on GitHub's issue timeline exposing a `cross-referenced`
event with a pull-request source. If no issue number is available, the hosted
run intentionally starts fresh; manual dispatch supports `issue_number`.
