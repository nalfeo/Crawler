# 2026-06-28 — achievements config-driven

## Systems touched

quests

## Summary

- Converted Floor 1 achievements from a hardcoded TypeScript array to external config data.
- Added runtime schema validation so malformed achievement config fails fast.
- Kept existing exports and consumer behavior unchanged.

## Changes

- Added `/home/runner/work/Crawler/Crawler/src/shared/data/achievements.floor1.json`.
- Refactored `/home/runner/work/Crawler/Crawler/src/shared/achievements.ts` to:
  - import the JSON catalog,
  - validate entries with Zod,
  - continue exporting `FLOOR1_ACHIEVEMENTS`, `FLOOR1_ACHIEVEMENT_COUNT`, `ACHIEVEMENT_ART_BACKLOG`, and `getAchievementById`.

## Validation

- `npm run verify:fast` ✅
- `npm run verify` ✅
- `parallel_validation` ✅ (CodeQL clean; review comments were advisory/non-blocking)

## Apple complexity

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎
- Verdict: exact
