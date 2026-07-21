# Handoff: CI conflict coordinator PR recovery (round 3)

## Date

2026-07-20

## Systems touched

ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact — two focused CI/recovery logic fixes with regression coverage updates).

## Summary

- Recovered the two still-open review-thread blockers on PR #1734 after confirming the branch was already merged cleanly with current `main` and that the earlier CI failures were historical fallout, not still-live branch failures.
- Tightened recovery-owner health so the CI conflict coordinator only treats automation ownership as healthy when the persisted recovery state `headSha` still matches the live PR head.
- Moved merge-train-disabled label cleanup ahead of the active-shepherd early exit so stale `merge-train*` labels are scrubbed even while a healthy shepherd lease owns the PR.
- Added regression coverage for both behaviors in the existing coordinator/recovery test suites.

## Files touched

- `.github/scripts/ci-conflict-coordinator/reconcile.mjs`
- `.github/scripts/ci-conflict-coordinator/state.mjs`
- `.github/scripts/ci-conflict-coordinator/state.test.mjs`
- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`
- `docs/knowledge/handoffs/2026-07-20-ci-conflict-recovery-round3.md`

## Verification

- GitHub Actions MCP: inspected run `29719333918` and failing jobs `88280254550`, `88280238227`, `88278866529`; confirmed the current branch later passed CI on run `29726297436`.
- Separate review validators confirmed both open review-thread findings were still applicable on current HEAD before the fixes.
- `node --test .github/scripts/ci-conflict-coordinator/state.test.mjs .github/scripts/ci-recovery/state.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved / next steps

- Push the consolidated repair commit, then reply in the exact review threads with the post-push HEAD SHA markers.
