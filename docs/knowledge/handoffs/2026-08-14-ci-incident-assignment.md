# CI incident assignment wiring

## Summary

Harvest-liveness incidents now assign Copilot through the shared GraphQL assignment helper after creating or updating the managed issue. Issue creation and liveness detection continue using the independent workflow token; Copilot assignment uses `CRAWLER_CI_PAT`, which is required for agent assignment.

## Systems touched

ci-recovery

## Files touched

- `.github/scripts/ci-recovery/harvest-liveness.mjs`
- `.github/scripts/ci-recovery/harvest-liveness.test.mjs`
- `.github/workflows/ci-liveness-sweep.yml`
- `docs/knowledge/handoffs/2026-08-14-ci-incident-assignment.md`

## Verification run

- Shared issue-intake tests: passed (26/26).
- Direct liveness assignment smoke test: passed.
- JavaScript syntax checks: passed.
- `git diff --check`: passed.
- `npm run verify:fast`: blocked because dependencies could not be restored (`@eslint/js` and TypeScript unavailable after the package feed failed).
- Harvest-liveness test file: blocked because the `yaml` package is unavailable for the same dependency restoration failure.

## Unresolved issues

Full fast verification and the harvest-liveness test file remain unrun until the worktree dependencies can be restored.

## Recommended next steps

Run the full CI recovery test suite in GitHub Actions, then confirm a newly created `ci-incident` issue has the `Copilot` assignee.
