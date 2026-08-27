# Goobers recovery partial progress

## Systems touched

agent-tooling, ci

## Summary

- Added a hosted deterministic recovery step that follows issue timeline
  cross-references to an open PR, checks out its head branch, and lets Goobers
  update it rather than creating a duplicate.
- Added an explicit `abandon_existing` manual-dispatch escape hatch that closes
  the attached open PR before starting over.
- Added a checkpoint push immediately after implementation so committed work
  survives later review or local-CI failures.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts`
- `npm run format:check -- --check tests/unit/goobers-run-workflow.test.ts`

## Limitations

Recovery depends on GitHub's issue timeline exposing a `cross-referenced`
event with a pull-request source. If no issue number is available, the hosted
run intentionally starts fresh; manual dispatch supports `issue_number`.
