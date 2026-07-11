# Session Handoff: Floor 1 staircase boss lock-in survival (seed 8 sword + bat)

## Date

2026-07-11

## Systems touched

ai-behavior-tree, boss-rooms, ci-policy

## Summary

Fixed the deterministic Floor 1 staircase boss-room failure signature for seed 8 (sword and baseball-bat) by changing boss lock-in melee behavior from orbit-heavy kiting to direct pressure, while adding survival-aware add handling in lock-in logic. The fix is structural AI behavior (no player/enemy stat tuning), and both required repro gates now end in staircase-boss defeat + Floor 1 victory.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
- `src/game/ai/bt-ai-tuning.ts`
- `tests/unit/ai/bt-arena-lockin-priority.test.ts`
- `docs/knowledge/review-ledgers/2026-07-10-floor1-staircase-boss-lockin-survival.review-ledger.json`

## Verification run

- `npx vitest run tests/unit/ai/bt-arena-lockin-priority.test.ts tests/headless/floor1-staircase-boss-lockin-seed8.test.ts`
- `npm run ai:headless -- --seed 8 --weapon sword --floor floor1 --json` → victory
- `npm run ai:headless -- --seed 8 --weapon baseball-bat --floor floor1 --json` → victory
- `npm run verify:fast` → pass
- `npm run verify` → pass
- `npm run verify:pr-prereqs` → pass
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-10-floor1-staircase-boss-lockin-survival.review-ledger.json` → valid 4-apple ledger

## Unresolved issues

- None.

## Recommended next steps

1. Proceed with PR review/merge flow.
