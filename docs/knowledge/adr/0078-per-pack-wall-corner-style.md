# ADR 0078: Per-pack wall corner style, doors as wall neighbours, and seam-scoped cross-pack validation

## Status

Accepted

## Date

2026-07-29

## Estimated Complexity

🍎 x 3 — one shared geometry generator, one renderer mask rule, and one validator gate; no new lab, no new system.

## Context

Floor 1 renders masonry corridors (`floor1-dungeon`) with two visible defects:

1. **Rounded corners on architecture.** Every terrain pack composites its material
   onto silhouettes produced by the single shared blob47 quadrant kit
   (`scripts/sprites/terrain-packs/quadrant-kit.ts`). That kit was authored for
   caves: it rounds every exposed corner with `CORNER_RADIUS_PX = 48` of a 256px
   source cell. `floor1-dungeon`'s manifest `derivationNote` records that its alpha
   comes from the kit unchanged, so a hand-built stone dungeon inherited eroded
   cave geometry structurally, not by accident. Curves read as natural erosion and
   are wrong for cut-stone construction.

2. **Walls stop short of doors.** `computeRawMask8` in `src/engine/terrain-renderer.ts`
   built the blob47 neighbour mask from `PACK_WALL_TERRAIN_TYPES`, which does not
   include `TerrainType.DOOR`. A wall tile beside a door therefore read "floor" on
   that side, applied the standard `WALL_INSET_PX` inset (48/256 = 18.75%, i.e. 12px
   at the 64px render cell) and rounded the corner away. Door tiles render
   full-bleed, so the resulting gap was entirely wall-side: a visible notch at every
   doorway.

Both defects are geometric and shared: any fix to the kit changes every pack that
uses it, and the cave packs (`floor1-cave`, `industrial-cave`, `caeles-fixture`)
must not change.

A third problem surfaced only once the fix existed. `floor1.manifest.json` maps
`stone -> floor1-dungeon` and `cave -> floor1-cave`, so both packs are co-resident
on Floor 1. `validateCrossPackWallSilhouettes` required co-resident packs to have
**byte-identical** wall silhouettes across all 47 masks. Giving the dungeon square
corners broke that gate with 40 `cross-pack-silhouette-mismatch` errors.

## Decision

### 1. Corner style is a per-pack property of the geometry generator

Introduce `WallCornerStyle = 'rounded' | 'square'` in
`scripts/sprites/terrain-packs/wall-corner-style.ts`, with
`DEFAULT_WALL_CORNER_STYLE = 'rounded'` (preserving existing behaviour) and
`wallCornerStyleForPack(packId)`.

`generateQuadrantKit(cornerStyle)` now branches on it:

- `rounded` — unchanged: concave corners are bitten out with `eraseQuarterDisc`,
  and convex/open corners are rounded.
- `square` — concave corners are bitten out with a 48×48 `eraseRect` (new export
  in `png-buffer.ts`), and the convex rounding branch is skipped entirely.

The inset is **unchanged** in both styles. Only the corner treatment differs, so
every downstream invariant that depends on `WALL_INSET_PX` (edge sampling at
`marginFraction = 0.25`, corner sampling at `sampleFraction = 0.09`) still holds.

The style is looked up **from the pack id**, not threaded through every signature.
This keeps `validateAuthoredSilhouetteExact(manifest, atlas)` and the existing
compose entry points signature-compatible.

The registry is a `ReadonlyMap`, not a plain object: `ComposePackInput.id` is an
arbitrary string, and with a plain object a pack id of `constructor`, `toString`
or `__proto__` returns an inherited truthy value, so the `?? DEFAULT` fallback
never fires and a non-`WallCornerStyle` value reaches the geometry branch. All
four shipped packs are declared exhaustively and a test enforces that.

### 2. `TerrainType.DOOR` counts as a wall neighbour for the blob47 mask only

Add `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES` (= `PACK_WALL_TERRAIN_TYPES` +
`TerrainType.DOOR`) and use it in `computeRawMask8`. A door is a hole punched
through a wall run, so for the purpose of "is my neighbour part of this wall
mass?" it must answer yes, and the wall runs flush into the jamb.

This is deliberately scoped to the **mask** only. Wall stamping and linework keep
the narrow `PACK_WALL_TERRAIN_TYPES` — a door tile must not be painted as wall.
`src/labs/terrain-pack-lab/index.ts` imports the same exported set for its
neighbour predicate so the lab preview cannot drift from the runtime rule.

### 3. Cross-pack validation is scoped to the seam, not the whole cell

`validateCrossPackWallSilhouettes` now compares:

- **same declared corner style** — full-cell equality, as before
  (`cross-pack-silhouette-mismatch`);
- **different styles** — the outermost pixel ring only, reported as
  `cross-pack-seam-mismatch`.

The property the gate exists to protect is that a material boundary cannot create
a notch: where a cell of one pack abuts a cell of another, the two must agree on
every pixel they share. That is a statement about the outermost ring, which is
the only pixel set adjacent to a neighbouring cell. Full-cell equality was
strictly stronger than the gate's own stated purpose — free while every pack
shared one silhouette kit, and no longer free once styles diverge by design.

Measured on the real committed pair: the square and rounded Floor 1 packs differ
in **2214** pixels across the 47 masks, with **0** differences on the outermost
boundary ring and **0** in the cardinal edge bands. Every difference is strictly
interior.

## Consequences

### Positive

- Dungeon corridors read as cut stone; caves keep their eroded silhouette.
- Walls meet doors flush at every doorway on every pack.
- Corner style is one declared, tested property rather than an emergent
  consequence of which generator a pack happened to be built with.
- The cross-pack gate now states the property it actually protects, so a future
  pack with a third corner treatment does not require re-litigating it.

### Negative

- One more per-pack property authors must declare. Mitigated by an exhaustiveness
  test: adding a shipped pack without declaring its style fails.
- The strong full-cell rule no longer applies to mixed-style pairs. It is retained
  wherever it is free (same-style pairs), and a regression test pins that.

### Risks

- A future pack could rely on the interior of a co-resident pack's silhouette for
  something other than seam continuity. No such consumer exists today, and the
  boundary-ring rule plus `validateCompatibleBoundaries` (still 1.0) cover every
  known cross-cell dependency.
- `floor1-dungeon/wall-atlas.png` is regenerated, so any downstream art keyed to
  its exact pixels changes. The three cave atlases are byte-identical, verified
  by the committed-atlas tests.

## Alternatives Considered

1. **Put `cornerStyle` in the pack manifest.** Rejected: it is build-time-only
   data. Adding it to the runtime zod schema in `src/shared/terrain-pack-types.ts`
   would change every committed manifest, and `composePack` would still need an
   authoring-side registry to _generate_ the field — so the registry does not go
   away, it just gains a second copy.

2. **Fill walls edge-to-edge for the dungeon (drop the inset).** Rejected by the
   maintainer: the inset is a deliberate readability choice, and dropping it would
   change tiling, edge sampling and every corner invariant at once. Only the corner
   treatment needed to change.

3. **Fork the quadrant kit into a separate dungeon generator.** Rejected: it
   duplicates the 47-mask topology, the inset math and the sampling invariants,
   and guarantees the two copies drift.

4. **Keep full-cell cross-pack equality and give caves square corners too.**
   Rejected: it fixes the gate by destroying the feature — the maintainer's ask
   was explicitly that curves stay reserved for cave/cavern/tunnel biomes.

5. **Special-case doors in the wall stamping path instead of the mask.** Rejected:
   it would paint wall material over door tiles. The mask is the correct layer —
   the question is topological ("is this neighbour part of the wall mass?"), not
   material.
