# ADR 0079: Dynamic wall inset against non-walkable neighbours + FOV corner terminal-tile exemption

## Status

Accepted

## Date

2026-07-30

## Estimated Complexity

🍎 x 2 — two small, independent single-file fixes (mask predicate + FOV reorder) plus tests and one scene-coverage extension; touches `src/core` and `src/engine` but neither is architecturally deep.

## Context

Floor 1 had two visual terrain defects:

1. **Wall inset bled floor into rock.** `src/shared/terrain-pack-mask.ts`'s
   `computeRawMask8` computes a blob47 neighbour mask; a bit is set when a
   cardinal neighbour "matches" (counts as wall for autotiling). The pack
   renderer (`src/engine/terrain-renderer.ts`) treats an ABSENT cardinal as
   "inset this edge, stamp the pack's floor pool underneath." The predicate
   for "is wall" only checked terrain-type equality against actual wall
   tiles (plus `DOOR`, added previously for the same class of bug). Any
   other neighbour — including `TerrainType.VOID` (solid rock) — read as
   "absent," so a wall bordering rock inset away from it and exposed a
   sliver of authored room floor sitting inside the void. The same
   function also treated an out-of-bounds neighbour (map edge) as
   non-matching by default, so edge walls inset into nothing with the same
   floor-bleed symptom.
2. **Room interior corners were never revealed, and were never lit.**
   `hasBlockedCornerSeam` (in `src/core/map/TileMap.ts`) blocks a
   shadowcasting ray when a diagonal step has both orthogonal neighbours
   opaque, to stop the ray squeezing through a diagonal gap between two
   walls. This rule was also applied to the tile the ray _terminates on_,
   not just tiles the ray passes through. A room's interior corner block is
   diagonal from the player with both its orthogonal wall runs opaque, so it
   always failed this seam check — the corner block was permanently
   unrevealed even though the two wall runs beside it lit up normally.

   The same misapplication exists in `lineOfSight`, which is why revealing
   the corner in FOV alone was not enough: `src/engine/lighting/light-field.ts`
   gates a cell's source illumination on `map.hasLineOfSight(...)` (reaching
   `TileMap.lineOfSight` through the `FloorMap` wrapper), so a corner fixed
   only in FOV was revealed but still fell back to `ambient`. The reported
   symptom was "corners don't get FOV/**lighting**".

Both defects are narrow, mechanical fixes localized to a single predicate
each, but together they touch two architectural layers (`src/core/systems/fovSystem.ts`
and `src/engine/terrain-renderer.ts`, plus the shared
`src/shared/terrain-pack-mask.ts` helper), which is why this ADR exists per
the cross-system-touch policy.

## Decision

1. **Wall-mask neighbour predicate now keys on walkability, not wall-type
   equality.** `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES` (`terrain-renderer.ts`)
   is extended with `TerrainType.VOID`, `TerrainType.WOOD_WALL` and
   `TerrainType.TREE` — the non-wall, non-walkable terrain types that should
   read as "wall" for inset purposes, per the stated rule "only inset toward
   walkable space".
   `WATER` and `LAVA` are deliberately **excluded**: they are non-walkable
   but not rock, and a wall should still visually inset against them (you
   can see the liquid surface through the gap). `TerrainType.DOOR` was
   already present from an earlier fix for the same inset behaviour and is
   preserved.
2. **`computeRawMask8` gained an `outOfBoundsMatches` parameter** (default
   `false`, preserving existing same-terrain-pool matching behavior for
   `neighborMask8InTerrain`). The pack wall-mask call sites in
   `terrain-renderer.ts` and `src/labs/terrain-pack-lab/index.ts` (which
   must mirror the renderer's predicate to avoid lab/game drift) now pass
   `true`, so a wall at the map edge full-bleeds instead of insetting into
   nothing.
3. **The terminal-step seam exemption lives in `TileMap.ts`, shared by
   `hasBlockedCornerSeam` and `lineOfSight`.** Both hoist
   `const targetOpaque = !this.isTransparent(x1, y1)` before the walk and,
   after each step, break when `reachedTarget && targetOpaque` — before the
   seam check. Only the seam formed by the **final** step into an opaque
   target is exempted; every earlier seam still applies. `fovSystem.ts`'s
   `onVisible` runs the seam check for **every** tile and then performs the
   opaque whole-tile fill.

   The exemption keys off the **target**, never the origin. Exempting an
   opaque origin would let a wall-mounted light source leak through diagonal
   gaps; a dedicated test gates this.

   This makes LOS asymmetric when exactly one endpoint is opaque. That is
   safe because nothing ever occupies an opaque tile — every gameplay
   consumer (`meleeSwingSystem`, `npcSystem`, `enemyAISystem`,
   `weaponSystem`) passes entity positions on walkable floor. The only
   opaque-target consumer is the light field, which is precisely what must
   light the corner.

No atlas regeneration was needed or performed — this is purely a change to
which terrain types set neighbour-mask cardinal bits, using the existing
blob47 atlas frames.

## Consequences

### Positive

- Walls adjacent to rock/void or wood walls now render full-bleed
  with no floor-pool sliver leaking into non-walkable space (hard-gated by
  new unit tests in `tests/unit/terrain-pack-renderer.test.ts`).
- Walls at the map edge full-bleed instead of insetting into nothing
  (same test file).
- Room interior corners are now both revealed **and lit** like the rest of
  the room. Because the light field consumes the same `lineOfSight`, fixing
  the rule once fixes reveal and illumination together.
- FOV and `lineOfSight` are brought back into **agreement** rather than
  diverging: the exemption is applied identically in both, so neither can
  reveal something the other rejects.
- The seam algorithm is not duplicated. An earlier attempt added a second
  Bresenham walk inside `fovSystem`; keeping the rule in `TileMap` means
  there is exactly one copy to maintain.
- Scene coverage: `TERRAIN_JUNCTION_SLICE` in
  `src/labs/ai-runner-lab/scenario-presets.ts` now includes a VOID-
  bordered wall run and a fully-enclosed room with visible interior
  corners, so both fixes are visually inspectable via
  `/lab.html?lab=ai-runner&scenario=terrain-wall-junctions`.

### Negative

- `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES` is a second, hand-maintained list
  that must be kept consistent with any future non-walkable terrain type;
  it is not derived from a single shared `isWalkable`/`TileFlags.WALKABLE`
  helper because no such single source of truth existed covering exactly
  this rock-vs-liquid distinction (an `isWalkable`-only helper would have
  incorrectly pulled `WATER`/`LAVA` in, defeating the deliberate carve-out).

### Risks

- If a new non-walkable, non-liquid terrain type is added in the future
  (e.g. a chasm or pit type) without updating
  `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES`, walls bordering it would revert
  to the old floor-bleed bug. Mitigated by the doc comment on the constant
  explaining the walkability rule and the water/lava carve-out rationale.

## Alternatives Considered

- **Reuse a generic `isWalkable`/`TileFlags.WALKABLE` predicate directly**
  instead of an explicit terrain-type list. Rejected: no existing helper
  encodes the specific "rock is not-wall but water/lava should still
  inset" distinction this fix requires; introducing one purely for
  this call site risked over-generalizing into an abstraction used
  nowhere else.
- **Exempt opaque tiles from the seam check inside `fovSystem` only**,
  leaving `hasBlockedCornerSeam`/`lineOfSight` untouched. This was
  implemented first, under an explicit scoping constraint ("do NOT relax
  `hasBlockedCornerSeam` itself or change `lineOfSight`") that turned out to
  be wrong. It was **rejected on review**, for two independent reasons:
  1. It fixed reveal but not lighting. `light-field.ts` gates source
     intensity on `lineOfSight`, so corners stayed at `ambient` — the
     user-visible symptom persisted.
  2. Returning early for an opaque tile skipped the seam check for the
     **entire ray**, not just its final step. `lightPasses` only halts
     propagation _past_ an opaque tile and never re-applies an earlier
     seam, so a wall genuinely peeked at through an earlier diagonal pinch
     became visible. Found independently by the adversarial plan review, the
     GitHub PR reviewer, and the implementing session itself.

  The constraint was the mistake, not the implementation: the corner cannot
  be lit without changing `lineOfSight`, because lighting consumes it. The
  scoping was revised rather than the requirement weakened.

- **Add a second seam walk inside `fovSystem`** that checks only
  pre-terminal steps. Rejected: it fixes the leak but still not lighting,
  and it creates a duplicate copy of the Bresenham seam algorithm that must
  be kept in sync with `TileMap`'s.
