# Handoff: PR #2443 review recovery

**Date:** 2026-07-31  
**Session slug:** pr2443-review-recovery  
**Issue/PR:** nalfeo/Crawler#2443  
**Apple estimate:** 2🍎

## Systems touched

weapons, ci-policy

## What was done

- Removed the last dead ECS `Weapon` plumbing left behind after retiring
  `spawnWeapon`:
  - deleted the `Weapon` tag from `src/core/components.ts`
  - removed its typed-array store allocation from `createComponentStores()`
  - removed its runtime wiring/import from `src/core/world.ts`
- Added a workflow regression test that pins the `Orphaned-system wiring guard`
  step’s GitHub-token env wiring and command in
  `tests/unit/ci-lightweight-consolidation.test.ts`.
- Hardened the orphaned-system allowlist contract by adding
  `trackedIssuePolicy` to `REQUIRED_ALLOWLIST_FIELDS`, plus a regression test
  covering a missing-policy entry in `tests/unit/orphaned-systems-guard.test.ts`.
- Investigated current PR CI state through GitHub Actions MCP:
  - branch CI run `30613973922` was already green on the pre-repair head
  - `get_job_logs` for failed jobs on that run returned `No failed jobs found`

## Verification

- `./node_modules/.bin/vitest run tests/unit/orphaned-systems-guard.test.ts tests/unit/ci-lightweight-consolidation.test.ts` ✅
- `npm run verify:fast` ✅

## Remaining work / notes

- Post the exact review-thread markers on comment IDs `3688931969`,
  `3688931990`, and `3688931950` after pushing the consolidated repair commit.
