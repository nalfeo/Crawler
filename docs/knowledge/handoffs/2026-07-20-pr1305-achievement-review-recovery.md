# 2026-07-20 — PR #1305 achievement review recovery

## Systems touched

quests, hud-ux

## Summary

- Added `clearedFloorCount` to the run-safe achievement fact allowlist so `current_run` cross-floor clear-count rules can parse and evaluate.
- Reworked mixed-scope achievement evaluation to iterate once in `registry.all` order, preserving authored unlock/toast ordering while still choosing floor-local versus effective-run facts per achievement.
- Added regression coverage for `clearedFloorCount` parsing/evaluation and for mixed-scope authored-order preservation.
- Updated the scoped-achievements ADR so the branch diff still carries the multi-layer architectural decision required by PR preflight.

## Files touched

- `src/shared/achievements.ts`
- `src/game/systems/achievementSystem.ts`
- `tests/unit/achievements.test.ts`
- `tests/game/achievement-system.test.ts`
- `docs/knowledge/adr/2026-07-18-scoped-run-global-achievement-facts.md`

## Verification

- `npm test -- tests/unit/achievements.test.ts tests/game/achievement-system.test.ts` ✅
- `npm run format:check` ✅
- `npm run test:guards` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Unresolved issues

- None.

## Recommended next steps

- Let CI re-run on the consolidated repair commit and let the recovery reconciler resolve the marked review threads automatically.
