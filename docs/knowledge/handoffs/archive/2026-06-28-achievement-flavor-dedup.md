# 2026-06-28 — achievement flavor dedup

## Systems touched

quests

## Summary

- Clarified achievement flavor handling by removing unlock-criteria text duplication from Director flavor at load time.
- Added a unit test guard to prevent criteria duplication regressions.

## Code changes

- Updated `/home/runner/work/Crawler/Crawler/src/shared/achievements.ts`:
  - Added normalization/sanitization logic for `directorFlavor`.
  - Replaced duplicated phrase patterns (`Trigger condition: <unlockCriteria>`) and direct criteria echoes.
- Updated `/home/runner/work/Crawler/Crawler/tests/unit/achievements.test.ts`:
  - Added assertion that `directorFlavor` does not contain `unlockCriteria` verbatim.

## Validation

- `npm run verify:fast` ✅
- `npm run verify` ✅

## Apple complexity

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: exact
