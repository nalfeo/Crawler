# Probe lab: fix seedAvailableBossChest Floor 1 silent no-op

**Date:** 2026-07-30
**Session slug:** probe-boss-chest-floor1-silent-noop
**Apple estimate:** 🍎
**PR:** closes #2385

## Summary

Investigated the CI recovery loop failure for PR #2368. The root cause was a
deterministic code bug in `seedAvailableBossChest()` in the main-scene probe
lab: it called `spawnBossChestForDefeatedBoss(world, 'ratfolk')` which returns
`{ created: false, reason: 'notFloor2' }` silently whenever `world.floor !== 2`.
The probe lab boots on Floor 1 by default, so the chest was never added to
`world.bossChests`, `bossChestButtonVisible` stayed `false`, and the E2E test
timed out waiting for a button that never became visible.

The CI recovery automation correctly identified the E2E failure but could not
converge because the failure was a deterministic code bug — not a flake, not a
permissions gap, not a marker-parser defect. Recovery retries alone cannot fix
a code regression.

## Root cause

```
spawnBossChestForDefeatedBoss(world, 'ratfolk')
  → world.floor !== 2  →  return { created: false, reason: 'notFloor2' }
  → world.bossChests remains empty
  → bossChestButton.setVisible(false)
  → waitForState(s => s.bossChestButtonVisible) times out after 30s
```

Introduced in PR #2368, which changed `seedAvailableBossChest()` from a
direct-set approach to using the game-layer `spawnBossChestForDefeatedBoss()`
function. That function is intentionally Floor 2-only (ADR 0070 / boss-chest
economy gate).

## Fix

Restored the floor-agnostic direct-set pattern for `seedAvailableBossChest()`.
Added:

- Idempotent cleanup (delete before set)
- An explicit `// Do NOT replace` comment explaining the Floor 2-only trap
- Uses `world.elapsedMs` instead of hardcoded `0`

The probe tests button visibility and panel-open interaction only — not the
real acquisition path. The game-layer path is exercised by Floor 2-specific
tests that explicitly boot with the equipment economy enabled.

## Systems touched

labs, engine

## Files changed

- `src/labs/main-scene-probe-lab/index.ts` — `seedAvailableBossChest()` fix

## Regression risk

Low — probe lab only, no production code changed.
