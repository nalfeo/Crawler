# Handoff: Spatial-Scoping Performance Optimizations

**Date**: 2026-07-06  
**Branch**: `copilot/investigate-cpu-intensity-optimizations`  
**Apple estimate**: 🍎🍎 (actual: 🍎🍎)

## Systems touched

fov, ai-pathfinding, ai-behavior-tree

## What changed

Three CPU optimizations targeting systems that rebuild every frame because the
player is almost never stationary.

### 1. FloorMap.clearVisibility() — bounded bounding box

`src/core/map/FloorMap.ts`

`clearVisibility()` previously zeroed the full sub-tile bitmap (134,400 cells at
480×280 with subFactor=2). The fix tracks a bounding box of sub-tile cells set
by `setVisible()` and zeros only that box on the next clear. With FOV radius=25
tiles this caps the clear to ≤10,201 cells — ~13× reduction.

New private fields: `lastFovMinX/Y/MaxX/Y`. Initial state is the "empty"
sentinel (minX=subWidth, maxX=-1). `revealAll()` sets the box to the full
extent; `setSubFactor()` resets it to empty on reallocation.

### 2. Windowed flow-field BFS

`src/core/map/flow-field.ts`, `src/game/enemyAISystem.ts`

`FlowField` now carries `originX/Y` fields (absolute tile offset of the array's
top-left corner). `FlowFieldOptions` accepts an optional `bounds` rectangle to
restrict the BFS. `flowFieldStep` was updated to accept **absolute** tile coords
(was accidentally field-local only because originX=0 for full-map fields).

`getGroundFlowField` computes a `playerTile ± 50` window, reducing BFS from
33,600 to ~14,400 cells. Cache invalidation now uses a `floorMap` reference
instead of `field.width/height` equality.

Guard: `winWidth ≤ 0 || winHeight ≤ 0` after clamping returns a 0-size
all-UNREACHABLE field (prevents crash for off-map bounds).

### 3. Chebyshev pre-filter in enemyAISystem

`src/game/enemyAISystem.ts`

After the `DeathTimer` block, a Chebyshev lower-bound check skips enemies at
`max(|dx|,|dy|) > max(aggroRange, fovRadiusFt) + 8`. Using `fovRadiusFt` as a
floor ensures enemies the player can see still run idle/wander AI. Bypassed for
`permanentAggro`, infinite-aggro (`aggroRange ≤ 0`), and `FamilyMembership`
entities (may hold a virtual non-player target).

`DEFAULT_FOV_RADIUS` was exported from `fovSystem.ts` for use here.

### Tests added (13 new)

- `flow-field.test.ts`: 7 windowed-BFS tests (originX/Y, reachability inside/outside window, absolute-coord step, off-map bounds crash guard)
- `fov-system.test.ts`: 3 bounded-clearVisibility tests (targeted clear, empty-bbox no-op, revealAll full-clear)
- `enemy-ai.test.ts`: 2 Chebyshev filter tests (cull at 200ft, no-cull at 36ft)
- `enemy-ai-coverage.test.ts`: 1 inside-FOV-outside-aggro regression (enemy 48ft away with 2ft aggro range must still wander)

### ADR

ADR-0047: `docs/knowledge/adr/0047-spatial-scoping-performance.md`

## Review

🍎🍎 → plan review. Reviewer: `gpt-5.4`. 2 concerns found + resolved:

1. Empty/off-map bounds crash in `computeFlowField` → guard added
2. Missing regression for inside-FOV-but-outside-aggro wander → test added

Ledger: `docs/knowledge/review-ledgers/2026-07-06-spatial-scoping-perf.review-ledger.json`

## Verify

`npm run verify:fast` — 3889/3889 pass  
`npm run verify` — clean (no guard failures after ADR + ledger committed)

## Known non-issues

- Enemies >50 tiles from player always get FLOW_UNREACHABLE and fall back to A\*.
  Acceptable — `FLOW_FIELD_RADIUS_TILES=50` exceeds the max aggro range (≤70ft/4ft=17.5 tiles).
- Distant out-of-range enemies (beyond `max(aggroRange, 100ft) + 8ft`) have
  velocity frozen at 0 and don't wander. They're outside FOV — player can't see
  this. When the player approaches, the filter stops culling them automatically.
