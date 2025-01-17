# Handoff: AI-runner 16× playback sticky telegraph flag

**Date:** 2026-07-16
**Session slug:** ai-runner-16x-telegraph-sticky-flag
**PR:** closes #1199

## Systems touched

engine-rendering, enemy-combat

## What was done

Implemented Option 2 from issue #1199: a per-entity `telegraphWasActiveThisFrame`
sticky flag that ensures a telegraph cue is visible for at least one rendered
frame even when the entire telegraph lifecycle (start → fire) occurs within a
single multi-step catch-up batch (AI-runner lab 16× playback).

### Root cause

`MainGameScene`'s fixed-step catch-up loop can run up to ~16 sim steps per
rendered frame at 16× speed. `bridge.sync()` (which drives all Phaser rendering,
including the enemy-projectile telegraph cue) is called only once after the whole
batch. A telegraph with a 250ms delay at 16× takes ~1 sim step to complete, so
`telegraphActive` transitions 0→1→0 between two renders and `sync()` never sees
it as 1.

### Fix

Three minimal changes:

1. **`src/core/components.ts`**: Added `telegraphWasActiveThisFrame: new Uint8Array(maxEntities)` to the `enemyBehavior` store. Default 0 is correct (cleared by `clearEntityStores()` on every `createEntity()` call).

2. **`src/core/systems/enemyTelegraph.ts`**: `startEnemyProjectileTelegraph()` now also sets `telegraphWasActiveThisFrame[eid] = 1`. This flag persists until the next `bridge.sync()` regardless of how many sim steps fire between renders.

3. **`src/engine/PhaserBridge.ts`**: The `isTelegraphing` check now reads
   `(telegraphActive === 1 || telegraphWasActiveThisFrame === 1)`. After rendering
   the entity's telegraph section (whether or not a cue was drawn), the flag is
   cleared to 0. This means:
   - Ongoing telegraphs: `telegraphActive=1` keeps the cue visible every frame.
   - Batch-skipped telegraphs: `telegraphWasActiveThisFrame=1` shows the cue for
     exactly one rendered frame, then clears.
   - Production (1× speed): unchanged; every step is followed by a sync, so
     `telegraphActive` alone is sufficient.

### Builds on

This PR includes all changes from PR #1196 (the telegraph feature) plus this fix.
It is intended to land after #1196 merges (or squash-merged as a combined branch).

## Files changed

- `src/core/components.ts` — new store field
- `src/core/systems/enemyTelegraph.ts` — set sticky flag in `startEnemyProjectileTelegraph`
- `src/engine/PhaserBridge.ts` — use sticky flag in `isTelegraphing`, clear after render

Plus test and documentation files brought in from the #1196 branch:

- `tests/unit/phaser-bridge.test.ts` — added sticky-flag scenario test
- `tests/game/enemy-projectile-telegraph.test.ts` — added `telegraphWasActiveThisFrame` unit tests

## Tests

- `tests/unit/phaser-bridge.test.ts` (46 tests): new test "renders the cue for one frame via the sticky flag when the telegraph completes within a batch (16× AI-runner lab scenario)".
- `tests/game/enemy-projectile-telegraph.test.ts` (18 tests): new `describe('telegraphWasActiveThisFrame sticky render-frame flag', ...)` with 2 tests verifying the flag is set on `startEnemyProjectileTelegraph()` and cleared on a fresh spawn.
- `npm run verify:fast` — 3971 + 1218 tests, all green.

## Apples

Estimated 2🍎, Actual 2🍎. Delta: 0 (exact).
