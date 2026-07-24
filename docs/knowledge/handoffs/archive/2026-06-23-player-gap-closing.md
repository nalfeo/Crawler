# Handoff: Player Gap-Closing Fix

**Date:** 2026-06-23  
**Persona:** Game Designer (AI behavior tuning)  
**Apple estimate:** 🍎🍎 (Small) — actual: 🍎🍎 ✅

## Systems touched

ai-pathfinding

## Problem

"The player should be closing the gap" — the direct analog to the previous session's enemy fix (enemies no longer stall at tile center when player is nearby). The player AI was exhibiting two symmetric stall patterns that prevented tight pixel-level pursuit of enemies during ENGAGE.

## Root Cause

Two stall paths in `bt-ai-provider.ts` mirroring the two that were fixed in `enemyAISystem.ts`:

1. **Fallback pursuit**: When `moveToward()` exhausts its A\* path and falls to `moveWithLocalNavigation`, the direction was toward the **plan target** (16 px in front of the enemy, `engageBandPx`). After the enemy moves within the same tile, the plan target diverges from the enemy's actual pixel position.

2. **Smooth stall**: `MOVE_SMOOTH_FACTOR = 0.5` means a kite direction reversal (every `KITE_FLIP_FRAMES = 132` frames) transitions the smoothed velocity through near-zero for ~1 frame. During that frame the player effectively stops.

## Fixes Applied

Both fixes are in `src/game/ai/bt-ai-provider.ts`.

### Constants added (~line 138)

```
MIN_PLAYER_ENEMY_CONTACT_PX = 12   // mirrors MIN_MOB_PLAYER_DISTANCE in enemyAISystem
ENGAGE_STALL_VELOCITY_THRESHOLD = 0.15
```

### Helper method added

`enemyPursuitDirection(world, playerX, playerY, targetEid)` — returns `{dx, dy, dist}` toward the enemy or `null` if position unavailable or within contact range. Shared by both fix sites to eliminate duplication.

### Fix 1 — ENGAGE fallback in `moveToward()`

When path exhausted and falling through to local nav, if in ENGAGE mode and the enemy is outside `MIN_PLAYER_ENEMY_CONTACT_PX`, call `moveWithLocalNavigation` toward the enemy's current pixel position (not the plan target).

### Fix 2 — Anti-stall in `poll()` after smooth blend

After the `MOVE_SMOOTH_FACTOR` blend, if smoothed velocity magnitude < `ENGAGE_STALL_VELOCITY_THRESHOLD` while in ENGAGE with a live target outside contact range, override `state.moveX/Y` and reset `smoothMoveX/Y` to drive directly at the enemy.

## Test Results

- `npm run verify:fast` ✅ (typecheck + lint + 10 unit tests)
- Seed 7 headless: **VICTORY** in 158.5s, 23 kills — identical to pre-fix baseline
- No timing regression; fixes only activate in stall conditions (near-zero velocity)

## Files Changed

- `src/game/ai/bt-ai-provider.ts` — two constants, one helper method, two call sites

## Next Session Notes

- The headless test seed is still 7. If future AI changes alter timing significantly, try seeds 1–20 with `npm run ai:headless -- --seed N`.
- The kite logic (`computeMeleeKiteTarget`, `KITE_FLIP_FRAMES = 132`) still reverses every ~2.2s; Fix 2 now handles the resulting smooth transition gracefully.
- Consider whether `ENGAGE_STALL_VELOCITY_THRESHOLD = 0.15` should be tuned if a future smoother kite arc is implemented.
