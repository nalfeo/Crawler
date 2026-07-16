# Handoff: Fix rendering of short-lived visual cues during 16x playback

**Date**: 2026-07-16  
**Issue**: #1199 — Enemy telegraph cue not rendered at 16× AI-runner lab speed  
**Apple estimate**: 2🍎

## Systems touched

enemy-telegraph, rendering

## Summary

At 16× simulation speed in the AI-runner lab, the catch-up loop runs many sim steps per rendered
frame. A 250ms telegraph delay at 16× speed is only ~1 sim step, so `telegraphActive` can flip
`0→1→0` entirely within a single batch — before the next `PhaserBridge.sync()` — making the cue
invisible.

The fix adds a render-frame sticky flag `telegraphWasActiveThisFrame` that is set once by
`startEnemyProjectileTelegraph()` and cleared by `PhaserBridge.sync()` after consuming it for
rendering. This guarantees the cue is visible for at least one rendered frame even at 16×.

## CI recovery changes (this session)

Three advisory-checks CI failures were also fixed:

| Failure                                                   | Root cause                                                                                       | Fix                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| TypeScript error: `ENEMY_PROJECTILE.TELEGRAPH_MS` missing | `tuning.json` lacked `telegraphMs` field                                                         | Added `"telegraphMs": 250` to tuning.json's `enemyProjectile` section                           |
| knip dead export: `isEnemyProjectileTelegraphActive`      | Exported from `enemyTelegraph.ts` but not used in production code                                | Imported and used in `PhaserBridge.ts` (replaces direct `eb.telegraphActive[eid] === 1` access) |
| Ranged-shooting tests broke                               | New 250ms default delay means `enemyAISystem()` starts a telegraph instead of immediately firing | Updated 3 tests to pass `{ telegraphMs: 0 }` for legacy immediate-fire behavior                 |

## Files touched

- `src/shared/data/tuning.json` — added `"telegraphMs": 250` to `enemyProjectile` section
- `src/core/components.ts` — added `telegraphWasActiveThisFrame: new Uint8Array(maxEntities)` to `enemyBehavior` stores
- `src/core/systems/enemyTelegraph.ts` — set `telegraphWasActiveThisFrame[eid] = 1` in `startEnemyProjectileTelegraph()`; resolves `ENEMY_PROJECTILE.TELEGRAPH_MS` fallback
- `src/engine/PhaserBridge.ts` — imported `isEnemyProjectileTelegraphActive`; `isTelegraphing` now checks `isEnemyProjectileTelegraphActive(world, eid) || eb.telegraphWasActiveThisFrame[eid] === 1`; clears sticky flag after rendering
- `src/game/enemyAISystem.ts` — uses telegraph-aware state machine (lock aim → wait delay → fire); cancels on early-exit paths
- `tests/game/enemy-ranged-shooting.test.ts` — 3 tests updated with `{ telegraphMs: 0 }` for legacy behavior
- `tests/game/enemy-projectile-telegraph.test.ts` — full test suite for telegraph state machine (18 tests)
- `docs/knowledge/review-ledgers/2026-07-16-sticky-telegraph-flag.review-ledger.json`
