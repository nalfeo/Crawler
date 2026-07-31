# Handoff — Weapon FOV Firing

**Date:** 2026-06-25
**Session:** weapon-fov-firing
**Persona:** Systems Engineer
**Apple estimate:** 🍎🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** 📈 over

## What Was Done

Fixed the bug where ranged weapons (especially the bow) fired at enemies through
walls into the next room. Weapons now only fire when the target enemy is in FOV
**or** has a clear, unobstructed line of sight to the player.

## Root Cause

`weaponSystem` (the ranged/magic/thrown/beam path) called
`getNearestEnemyTarget(world, playerX, playerY, inCombat)`. `inCombat` is true
whenever **any** enemy is within `COMBAT_RADIUS_PX = 1200`px. Passing
`ignoreFov = true` **completely bypassed** the FOV/visibility check, so the
nearest enemy was targeted even through walls.

The bypass existed for a real reason: FOV radius (25 tiles = 800px) is smaller
than the combat radius (1200px), so an enemy attacking from just past the FOV
edge couldn't be returned by a strict `isVisible`-only gate. The old fix threw
out the wall check entirely; the new fix keeps a sight check but allows clear
straight-line targeting beyond the FOV radius.

## The Fix

1. **`TileMap.lineOfSight(x0,y0,x1,y1)`** — deterministic Bresenham walk; returns
   `false` if any tile strictly between the endpoints is opaque
   (`!isTransparent`). Endpoint tiles never block; out-of-bounds counts as
   opaque. Pure integer math — no allocation, no RNG, no `Date.now()`.
2. **`FloorMap.hasLineOfSight(px0,py0,px1,py1)`** — pixel→tile convenience that
   delegates to `TileMap.lineOfSight`.
3. **`getNearestEnemyTarget`** — when a `floorMap` is present and FOV is not
   explicitly ignored, an enemy is eligible only if its tile `isVisible` **or**
   `hasLineOfSight(player → enemy)` is clear.
4. **`weaponSystem`** — the ranged/magic/thrown/beam call site now passes
   `false` instead of `inCombat`, so the sight gate always applies.

## Design Decisions

- **`isVisible` fast-path is intentional.** The FOV shadowcaster is more lenient
  at wall corners than a single strict center-line ray. If the enemy tile is
  already FOV-visible we fire without re-checking the line, so legitimate shots
  aren't suppressed by a ray that clips a corner. (Covered by a dedicated test.)
- **Melee left unchanged** (still `ignoreFov = true`). Melee has its own
  `inCombat` gate and a tiny gate range (sword ≈ 60px < 2 tiles); a wall between
  the player and a sub-2-tile enemy is not the reported "shoots into the next
  room" problem. Kept surgical to avoid altering melee feel. A future pass could
  apply the same LOS gate to melee for consistency if desired.
- **`weaponEntitySystem`** (multi-weapon entity path) already passed
  `ignoreFov = false`; it now benefits from the more permissive
  `isVisible || hasLineOfSight` gate (strictly more correct, no behavior loss).

## Files Changed

| File                                        | Change                                               |
| ------------------------------------------- | ---------------------------------------------------- |
| `src/core/map/TileMap.ts`                   | + `lineOfSight` (Bresenham tile LOS)                 |
| `src/core/map/FloorMap.ts`                  | + `hasLineOfSight` (pixel convenience)               |
| `src/game/weaponSystem.ts`                  | Sight gate in targeting + ranged call site fix       |
| `tests/ecs/tilemap.test.ts`                 | +8 `lineOfSight` cases (walls, doors, windows, etc.) |
| `tests/ecs/floor-map.test.ts`               | +3 `hasLineOfSight` cases                            |
| `tests/game/weapon-system-coverage.test.ts` | +3 next-room / clear-LOS / FOV-fast-path regressions |

## Validation

- `npm run verify:fast` ✓ (typecheck + lint + 440 unit tests)
- `npm run verify` ✓ (full suite: format, coverage, integration, headless
  Floor 1 gate, build)
- `bash scripts/agent/lab-gate-check.sh` ✓ (no new system; `fovSystem` and
  `weapons-lab` already cover the touched areas)

## Notes for Next Agent

- `lineOfSight` is a general-purpose primitive now available for enemy AI sight
  checks, ranged-enemy LOS gating, etc. (`enemyAISystem` currently has no LOS
  gate for its ranged shooters — a candidate follow-up for symmetry).
- No new lab was added because no new ECS system was created — only helper
  methods on existing `TileMap`/`FloorMap` plus a targeting-gate fix.
- An ADR was required (diff touches `src/core` + `src/game`): see
  `docs/knowledge/adr/0018-weapon-line-of-sight-targeting.md`.

## Apples

Estimated 🍎🍎🍎, actual 🍎🍎. Over by one: the bug had a clean, well-isolated
fix point and the existing FOV/LOS scaffolding (transparent-tile flags,
`isVisible`) meant no new ECS system, lab, or pipeline was needed — it landed
as a focused 3-file source change (`TileMap`, `FloorMap`, `weaponSystem`) plus
tests rather than a new sub-system. A cross-layer ADR was still required (see
above).

## Systems touched

ai-pathfinding, weapons
