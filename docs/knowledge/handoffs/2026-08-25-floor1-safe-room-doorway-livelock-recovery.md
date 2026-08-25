# Handoff: Floor 1 safe-room doorway livelock PR recovery

## Date

2026-08-25

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

Estimated 🍎🍎🍎, actual 🍎🍎🍎 (exact).

## Summary

- Recovered PR #3559 from a dirty merge state by unshallowing the clone, fetching
  `origin/main`, and committing a true merge commit.
- Resolved the only content conflict in
  `tests/headless/floor1-release-sweep-loss-regressions.test.ts` by keeping one
  unique copy of each release-loss regression row. `origin/main` already carried
  the overlapping `fireball-13`, `baseball-bat-20`, and `baseball-bat-31` rows.
- Preserved the branch's intended runtime change in `src/game/ai/bt-ai-provider.ts`
  and its focused behavior-tree regression coverage.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/headless/floor1-release-sweep-loss-regressions.test.ts`
- `docs/knowledge/handoffs/2026-08-25-floor1-safe-room-doorway-livelock-recovery.md`
- `docs/knowledge/metrics/apples/2026-08-25-floor1-safe-room-doorway-livelock-recovery.json`
- `docs/knowledge/review-ledgers/2026-08-25-floor1-safe-room-doorway-livelock-recovery.review-ledger.json`

## Verification

- `npx vitest run tests/game/behavior-tree-ai.test.ts -t "abandons a melee NPC threat clear"` ✅
- `npx vitest run tests/headless/floor1-release-sweep-loss-regressions.test.ts -t "baseball-bat seed 31"` ✅
- `npx vitest run tests/headless/floor1-release-sweep-loss-regressions.test.ts` ✅
- `npm run verify:fast` ✅

## Unresolved issues

- Final review/security checks and `npm run verify:pr-prereqs` are still pending
  at handoff-writing time and must pass before publication.

## Recommended next steps

- Finish the pending full conflict-file regression run, review/security checks,
  and PR prerequisite gate, then publish the consolidated recovery commit.
