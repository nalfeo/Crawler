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
2. **Room interior corners never received FOV.** `hasBlockedCornerSeam` (in
   `src/core/map/TileMap.ts`, unchanged by this ADR) blocks a
   shadowcasting ray when a diagonal step has both orthogonal neighbours
   opaque, to stop the ray squeezing through a diagonal gap between two
   walls. `fovSystem.ts`'s `onVisible` applied this same rule to the tile
   the ray _terminates on_, not just tiles the ray passes through. A
   room's interior corner block is diagonal from the player with both
   its orthogonal wall runs opaque, so it always failed this seam check —
   the corner block was permanently unrevealed even though the two wall
   runs beside it lit up normally.

Both defects are narrow, mechanical fixes localized to a single predicate
each, but together they touch two architectural layers (`src/core/systems/fovSystem.ts`
and `src/engine/terrain-renderer.ts`, plus the shared
`src/shared/terrain-pack-mask.ts` helper), which is why this ADR exists per
the cross-system-touch policy.

## Decision

1. **Wall-mask neighbour predicate now keys on walkability, not wall-type
   equality.** `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES` (`terrain-renderer.ts`)
   is extended with `TerrainType.VOID`, `TerrainType.WOOD_WALL`, and
   `TerrainType.TREE` — the non-wall, non-walkable terrain types that
   should read as "wall" for inset purposes. `WATER` and `LAVA` are
   deliberately **excluded**: they are non-walkable but not rock, and a
   wall should still visually inset against them (you can see the liquid
   surface through the gap) per the maintainer's explicit "another wall or
   rock" framing. `TerrainType.DOOR` was already present from an earlier
   fix for the same inset behaviour and is preserved.
2. **`computeRawMask8` gained an `outOfBoundsMatches` parameter** (default
   `false`, preserving existing same-terrain-pool matching behavior for
   `neighborMask8InTerrain`). The pack wall-mask call sites in
   `terrain-renderer.ts` and `src/labs/terrain-pack-lab/index.ts` (which
   must mirror the renderer's predicate to avoid lab/game drift) now pass
   `true`, so a wall at the map edge full-bleeds instead of insetting into
   nothing.
3. **`fovSystem.ts`'s `onVisible` now checks tile opacity BEFORE the
   corner-seam check**, and an opaque terminal tile is revealed
   unconditionally (as a whole tile, matching existing opaque-reveal
   behavior) without evaluating `hasBlockedCornerSeam` at all. Transparent
   (floor) tiles are unaffected — they keep the existing seam rule,
   preserving the FOV/`lineOfSight` agreement invariant for floor tiles
   documented at the top of the function. The `firstTouchThisPass` memo
   (`state.seamGen`) still gets set on the opaque branch so it continues to
   serve its "already expanded this tile this pass" role; `state.seamValue`
   is deliberately left unset for the opaque branch since it is never read
   there. `hasBlockedCornerSeam` and `lineOfSight` themselves are
   unchanged — the seam rule that stops a ray squeezing _through_ a
   diagonal gap to see something _beyond_ it is untouched; only the
   improper application of that rule to the ray's own landing tile is
   removed.

No atlas regeneration was needed or performed — this is purely a change to
which terrain types set neighbour-mask cardinal bits, using the existing
blob47 atlas frames.

## Consequences

### Positive

- Walls adjacent to rock/void, wood walls, or trees now render full-bleed
  with no floor-pool sliver leaking into non-walkable space (hard-gated by
  new unit tests in `tests/unit/terrain-pack-renderer.test.ts`).
- Walls at the map edge full-bleed instead of insetting into nothing
  (same test file).
- Room interior corners are now visible like the rest of the room (hard-
  gated by a new test in `tests/ecs/fov-system.test.ts` asserting all four
  interior corners of a rectangular room are marked visible).
- The FOV/LOS agreement invariant is preserved for floor tiles — the fix
  cannot make FOV reveal a floor tile that `lineOfSight` would reject,
  since the seam rule for transparent tiles is untouched.
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
  inset" distinction the maintainer required; introducing one purely for
  this call site risked over-generalizing into an abstraction used
  nowhere else, for a 2🍎 fix.
- **Relax `hasBlockedCornerSeam` itself** to stop blocking diagonal-corner
  terminal tiles. Rejected per explicit maintainer instruction — the
  function is shared with `lineOfSight` and changing it there risked
  breaking the FOV/LOS agreement invariant for cases the maintainer did
  not ask to change. Instead the caller (`fovSystem.ts`) was changed to
  simply not invoke the seam check for its own terminal opaque tile.
