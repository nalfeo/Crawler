# ADR-0047: Spatial-Scoping Performance Optimizations

**Date**: 2026-07-06  
**Status**: Accepted — **decisions 2 (windowed flow-field) and 3 (Chebyshev pre-filter) removed 2026-07-06**; only decision 1 (bounded `clearVisibility`) ships. (see [Update](#update-2026-07-06-only-decision-1-ships))  
**Systems touched**: fov, flow-field, enemy-ai

---

## Update (2026-07-06): only decision 1 ships

A performance optimization must be **behavior-preserving** — byte-identical sim
results, just faster (project rules #12/#13; enforced by the
`collision-pair-parity` headless golden). Under that bar, **two of the three
decisions below were reverted before merge**. Only **decision 1 (bounded
`clearVisibility`)** ships.

### Decision 3 (Chebyshev pre-filter) — removed (shared-RNG desync)

`enemyAISystem` draws from a **single shared `world.rng` stream** — a
far/out-of-aggro enemy's normal path runs `applyIdleWander`, which consumes RNG
(wander angle + duration) and sets a wander velocity. The pre-filter's early
`continue` (velocity = 0) **skipped those RNG draws**, shifting the shared
stream for every subsequent enemy and frame (including projectile-accuracy rolls
at line ~1246). The `collision-pair-parity` seed-42 golden fingerprint drifted
from `{kills:7, damageDealt:261, damageTaken:25, finalScore:8}` to
`{kills:6, damageDealt:159, damageTaken:0, finalScore:4}` — a cascading
determinism divergence, not the "invisible" freeze this ADR originally assumed.
Because the enemy's idle-wander is both **observable** (velocity) and
**RNG-consuming**, the filter cannot be a cheap early-out _and_ byte-identical.

### Decision 2 (windowed flow-field BFS) — removed (in-window reroute)

The windowed BFS restricts flow-field distances to a `FLOW_FIELD_RADIUS_TILES`
(=44) box around the player. For an **in-aggro-range** enemy whose graph
shortest-path to the player **detours outside that window** (e.g. a winding
corridor), the windowed BFS either marks it `FLOW_UNREACHABLE` (→ A\* fallback)
or assigns a suboptimal in-window detour distance, so `flowFieldStep` picks a
different gradient step than the full-map field. That changes enemy movement →
combat/RNG cascade.

A 10-seed differential sweep (opt head **H** vs merge-base **B**, seeds
`[42,1,3,7,21,88,123,500,1000,9999]`) diverged at **seed 88**: H = `kills:9,
damageDealt:286` vs B = `kills:8, damageDealt:273`; the other 9 seeds matched. A
follow-up sweep with the windowing disabled (opt #1 on, opt #2 off) matched B on
**all 10** seeds — isolating decision 2 as the sole non-neutral change and
proving decision 1 byte-neutral. **No finite radius fixes this**: a sufficiently
winding corridor forces an arbitrarily long shortest path for a spatially-close
enemy, so windowing can always clip a behaviorally-relevant path. Removal is the
only correct byte-neutral fix.

`flow-field.ts`, `fovSystem.ts`, `enemyAISystem.ts` and `tests/ecs/flow-field.test.ts`
were reverted to their pre-optimization (merge-base) state.

### Decision 1 (bounded `clearVisibility`) — retained, proven byte-neutral

Confirmed byte-identical to merge-base across all 10 sweep seeds **and** by
construction (see _Consequences_): `setVisible` expands the bbox to the exact
union of the cells it sets, and `clearVisibility` zeros exactly that bbox, so no
`visible` cell can survive a clear. This is the only change that ships.

**Future work**: an _early-termination_ full-map BFS (stop once every current
chaser's tile is reached, no spatial bounds) could recover most of decision 2's
savings while staying byte-neutral, because it never clips a path that the
full-map BFS would have produced. It must be proven byte-neutral against
`collision-pair-parity` (and a multi-seed sweep) before landing.

See handoff `2026-07-06-spatial-scoping-perf.md`.

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

### 2. Windowed flow-field BFS — **REMOVED 2026-07-06**

> **Removed before merge** — see [Update](#update-2026-07-06-only-decision-1-ships).
> This sub-optimization was **not** byte-neutral (in-window reroute of enemies
> whose global shortest path exits the window; seed-88 divergence). It was
> reverted. The description below is retained for historical context only; it is
> **not** in the shipped code.

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

> **Removed before merge** — see [Update](#update-2026-07-06-only-decision-1-ships).
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
  (This is the only shipped change.)
- ~~Flow-field BFS array allocation and fill are bounded by the player's local
  window rather than the full map.~~ **(Removed — see decision 2.)**
- ~~Enemies well outside player range skip family-AI lookups, door queries, and
  `Math.hypot` entirely.~~ **(Removed — see decision 3.)**
- The retained bounded-`clearVisibility` change is byte-neutral: the
  `collision-pair-parity` seed-42 golden fingerprint is unchanged, and a 10-seed
  differential sweep matches merge-base on every seed.

**Negative / Risks**

- ~~Enemies outside the flow-field window (>44 tiles from player) always get
  `FLOW_UNREACHABLE` and fall back to A\*.~~ **Removed** — decision 2 was
  reverted; the flow field is full-map again, as on `main`.
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
