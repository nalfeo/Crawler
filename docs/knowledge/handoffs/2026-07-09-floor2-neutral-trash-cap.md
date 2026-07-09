# Floor 2 neutral trash cap

**Date:** 2026-07-09  
**Branch:** `nalfeo-floor2-trash-territories-timer-tuning`  
**Estimate:** 2 apples 🍎🍎

## Summary

Fixed a Floor 2 spawn-mix bug where a single seed could surface more than the four
quadrant-assigned neutral trash archetypes. The ambient director now keeps neutral
trash fallback selection inside the per-seed `trashTerritories` set, and a
regression test locks that cap in place.

## Systems touched

enemies, mapgen

## Files changed

- `src/game/floor2Scenario.ts`
- `tests/unit/floor2-director-territory.test.ts`
- `docs/knowledge/review-ledgers/2026-07-09-floor2-neutral-trash-cap.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-09-floor2-neutral-trash-cap.json`

## What changed

- Changed Floor 2 neutral-trash fallback weighting to reuse the same four
  quadrant-assigned trash archetypes already chosen for the seed, instead of the
  full neutral trash pool.
- Added a deterministic regression test that drives the Floor 2 ambient director
  across quadrant anchors and asserts every neutral trash spawn comes from the
  assigned territory set and that the distinct neutral count stays `<= 4`.

## Verification run

- `npm run -s test:unit -- tests/unit/floor2-director-territory.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-09-floor2-neutral-trash-cap.review-ledger.json` ✅
- `npm run verify` ✅ except for the missing-new-handoff preflight, resolved by this file

## Unresolved issues

- This fix only caps the neutral trash pool. It does not address broader Floor 2
  completion reliability, timeout rate, or missing end-to-end validation gaps in
  the boss/quest progression path.
