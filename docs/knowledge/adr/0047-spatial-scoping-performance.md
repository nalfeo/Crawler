# ADR-0047: Spatial-Scoping Performance Optimizations

**Date**: 2026-07-06  
**Status**: Accepted — **decision 3 (Chebyshev pre-filter) removed 2026-07-06** (see [Update](#update-2026-07-06-chebyshev-pre-filter-removed))  
**Systems touched**: fov, flow-field, enemy-ai

---

## Update (2026-07-06): Chebyshev pre-filter removed

Decision 3 below (the `enemyAISystem` Chebyshev pre-filter) was **reverted**
before merge because it was **not behavior-preserving**, which a performance
optimization must be.

`enemyAISystem` draws from a **single shared `world.rng` stream** — a
far/out-of-aggro enemy's normal path runs `applyIdleWander`, which consumes RNG
(wander angle + duration) and sets a wander velocity. The pre-filter's early
`continue` (velocity = 0) **skipped those RNG draws**, shifting the shared
stream for every subsequent enemy and frame (including projectile-accuracy rolls
at line ~1246). The `collision-pair-parity` seed-42 golden fingerprint drifted
from `{kills:7, damageDealt:261, damageTaken:25, finalScore:8}` to
`{kills:6, damageDealt:159, damageTaken:0, finalScore:4}` — a cascading
determinism divergence, not the "invisible" freeze this ADR assumed under
_Consequences → Negative_.

Because the enemy's idle-wander is both **observable** (velocity) and
**RNG-consuming**, the filter cannot be a cheap early-out _and_ byte-identical.
Decisions 1 (bounded `clearVisibility`) and 2 (windowed flow-field BFS) were
confirmed byte-neutral by bisecting the parity test and are **retained**. Only
decision 3 was removed. See handoff `2026-07-06-spatial-scoping-perf.md`.

---

## Context

The player is almost never stationary in Crawler. This means any cache that
invalidates on player movement is effectively rebuilt every frame. Three hot
paths were identified where the per-frame work was proportional to the full map
size rather than the active player region:

1. `FloorMap.clearVisibility()` zeroed 134,400 sub-tile cells (480×280 at
   subFactor=2) even though the FOV radius only ever touches ≤10,201 cells
   (2×50+1)² for radius=25 tiles.

2. `computeFlowField` allocated a 33,600-tile `Int32Array` and BFS'd the entire
   reachable map every time the player moved to a new tile — roughly every
   0.2–0.5 s at walking speed.

3. `enemyAISystem` iterated all enemies doing family-AI lookups, door queries,
   `Math.hypot`, and aggro checks before establishing whether an enemy could
   possibly be relevant.

---

## Decision

### 1. Bounded `clearVisibility()` (FloorMap)

Track a per-frame bounding box of sub-tile cells set by `setVisible()`. On the
next `clearVisibility()`, zero only that box instead of the full bitmap. The
box is reset to the "empty" sentinel (`minX=subWidth, maxX=-1`) after each clear
so a fresh BFS starts with an empty box.

`revealAll()` marks the box as the full extent so that a subsequent
`clearVisibility()` still zeros everything. `setSubFactor()` resets the box to
the empty sentinel whenever sub-tile resolution changes.

Expected improvement: ~13× reduction in cells zeroed per frame (10 K vs 134 K).

### 2. Windowed flow-field BFS

`FlowField` gains `originX: number; originY: number` fields (absolute tile
offset of the array's top-left corner). `FlowFieldOptions` gains an optional
`bounds` rectangle that, when provided, restricts the BFS to that window. Tiles
outside the window stay `FLOW_UNREACHABLE`; enemies there fall back to per-entity
A\* or direct steering — the same path as any other unreachable tile today.

`flowFieldStep` is updated to accept absolute tile coordinates and translates
internally via `lx = x - field.originX`. Full-map fields remain backward-
compatible (`originX=0, originY=0, width=mapWidth`).

`enemyAISystem.getGroundFlowField` computes the window as `playerTile ±
FLOW_FIELD_RADIUS_TILES (=44)` and stores a `floorMap` reference in
`GroundFlowCache` (replacing the `field.width/height` equality check) to
correctly detect map rebuilds.

Expected improvement: BFS array ~7,900 cells at R=44 ((2·44+1)²) vs 33,600
full-map — ~4× reduction; the active-enemy portion is smaller still.

### 3. Chebyshev pre-filter in `enemyAISystem` — **REMOVED 2026-07-06**

> **Removed before merge** — see [Update](#update-2026-07-06-chebyshev-pre-filter-removed).
> This sub-optimization broke sim determinism (shared-`world.rng` desync via the
> skipped `applyIdleWander` draws) and was reverted. The description below is
> retained for historical context only; it is **not** in the shipped code.

After the `DeathTimer` skip block, a cheap Chebyshev lower-bound filters enemies
that are provably out of range:

- Bypass conditions: `permanentAggro`, `aggroRange ≤ 0` (infinite aggro),
  `FamilyMembership` (may hold a virtual non-player target).
- Threshold: `max(aggroRange, fovRadiusFt) + CULL_DEAD_ZONE_FT (=8)` where
  `fovRadiusFt = DEFAULT_FOV_RADIUS × tileSizeFt`. Using the FOV radius as
  a floor ensures enemies the player can see still run idle/wander AI.
- Check: `|dx| > threshold || |dy| > threshold` (Chebyshev lower-bound on
  Euclidean distance).
- Effect: `setVelocity(0,0)`, delete path + slime state, `continue`.

---

## Consequences

**Positive**

- clearVisibility cost drops from O(W×H×subFactor²) to O(radius²) per frame.
- Flow-field BFS array allocation and fill are bounded by the player's local
  window rather than the full map.
- Enemies well outside player range skip family-AI lookups, door queries, and
  `Math.hypot` entirely. **(Removed — see decision 3.)**
- The retained bounded-FOV and windowed-flow-field changes are byte-neutral:
  the `collision-pair-parity` seed-42 golden fingerprint is unchanged.

**Negative / Risks**

- Enemies outside the flow-field window (>44 tiles from player) always get
  `FLOW_UNREACHABLE` and fall back to A*. For very aggressive enemies that
  patrol far corners, this may increase A* load — acceptable because
  `FLOW_FIELD_RADIUS_TILES=44` is larger than any aggro range in the game.
- ~~The Chebyshev pre-filter freezes distant-out-of-range enemies~~ **Removed.**
  This freeze was _not_ invisible: the skipped `applyIdleWander` also skipped
  shared-RNG draws, desyncing the deterministic stream. That is why decision 3
  was reverted.
- `clearVisibility` with an empty bounding box (no FOV pass yet) is now a no-op
  rather than a full clear. This is correct — the bitmap is already all-zero
  at construction — but callers that manually set `visible` cells without going
  through `setVisible` will not have those cells cleared. No such caller exists.

**Alternatives considered**

- Incremental FOV diff (only clear cells that turned invisible): more complex,
  requires storing previous FOV result; bounding-box approach achieves most of
  the benefit with trivial code.
- Portal-culled flow field (BFS only through visible rooms): requires the room
  graph to be tightly integrated with the flow-field BFS; the rectangular window
  is simpler and sufficient.
- Spatial hash for enemy iteration: would help the iteration overhead. The
  Chebyshev pre-filter was tried as a cheaper alternative but reverted for the
  determinism reason above; a future iteration-scoping optimization must be
  proven byte-neutral against `collision-pair-parity` before landing.
