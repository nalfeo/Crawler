# ADR 0080: Door ownership moved from terrain packs to the global renderer

## Status

Accepted

## Date

2026-07-31

## Estimated Complexity

🍎 x 4 — touches terrain-packs, rendering, sprite-pipeline, and labs; requires
retiring 18 assets, adding a new gate, and fixing a latent orientation inversion.

## Context

Crawler had two door systems that disagreed about what a door is:

- **Terrain packs** owned door art via a `doorSet` manifest field. That art was
  drawn at a bespoke `tileSize / TERRAIN_PACK_CELL_PX` scale, bypassing all
  aspect-correct fitting. The result was a 4 ft × 4 ft square hatch in a
  side-on world, drawn against a 5.75 ft player.
- **The global renderer** owned `resolveDoorContainFit`, which contain-fits the
  art's opaque box into a `tileSize × DOOR_TARGET_HEIGHT_FT` doorway box.

Because pack art won unconditionally on Floor 1, the global renderer's fit path
never executed on a shipped floor (confirmed: 84 pack / 0 generated on seed 42).
The two systems also disagreed on *projection*: pack art was a top-down metal
hatch; generated art was a side-on elevation. Across the four packs there were
only 8 distinct decoded variants (two dungeon themes), so the pack path bought no
biome differentiation while overriding the real renderer.

## Decision

Door ownership is transferred entirely to the global renderer
(`src/engine/sprites/door-visuals.ts`):

1. **One fit.** `resolveGeneratedDoorContainFit` renamed to `resolveDoorContainFit`.
   Every art source — generated, Kenney placeholder, colour fallback — routes
   through it. No draw branch computes its own scale.
2. **Art selection carries no geometry.** `resolveDoorRenderMode` picks a texture
   key by precedence only (exact-orientation generated → cross-orientation →
   Kenney → colour). The `pack` kind is deleted from the union.
3. **`doorSet` retired.** Removed from `terrainPackDefSchema` (`.strict()` means
   a stale field now fails loudly). All four manifests updated. 16 rendered door
   PNGs + 2 build-input `door-material.png` files deleted. Pack builders stop
   emitting door art. `doorSlab` removed from `PackGenSpec`.
4. **Per-tileset door looks not currently supported.** `resolveDoorRenderMode`
   consults only the global `GENERATED_DOOR_TEXTURE_KEYS`; `MainGameScene` does
   not derive a pack-scoped key. When per-tileset art is added in the future, it
   must re-enter through the same selection and fit rules — not a bespoke scale
   branch.

## Consequences

### Positive

- Door size is decided by design (`DOOR_TARGET_HEIGHT_FT`, one cell wide), not by
  which asset happened to ship. All doors on all floors obey the same geometry rule.
- Top-down hatch art cannot re-enter: the projection contract gate
  (`tests/unit/generated-door-art.test.ts`) enforces transparent side margins,
  portrait aspect, and bottom-alignment — properties a full-bleed square hatch
  fails on two of three counts.
- A latent orientation inversion in `resolveDoorOrientationFromFlanks` — invisible
  while pack art won unconditionally — is now a live defect if not fixed. It was
  fixed as part of this change and pinned by a new end-to-end topology → texture-key
  regression test.

### Negative

- Per-tileset door art is no longer expressible in a manifest. A future biome that
  wants distinct door art must extend `resolveDoorRenderMode` with a pack-scoped
  lookup rather than adding a `doorSet` field.
- The colour fallback draws a portrait rectangle (`tileSize × DOOR_TARGET_HEIGHT_FT`)
  rather than a square cell, which is a very minor visual regression in test/debug
  contexts where no art is loaded.

### Risks

- No gate in the sprite pipeline measures viewing angle. A head-on candidate scored
  16/16 sensors and 5/5/5/5 VLM. The projection contract is deterministic but
  cannot prove a texture is truly side-on — it only rejects the known failure class
  (full-bleed square hatch).

## Alternatives Considered

- **Keep pack doors, add the shared fit.** Removing the bespoke scale from the pack
  path while keeping `doorSet` in the schema was considered. Rejected: the pack path
  adds schema/manifest/builder complexity for zero biome differentiation (two dungeon
  themes across four packs). The fit unification gains are larger if the pack path is
  simply retired.
- **Add a geometry-free per-pack key lookup.** A `doorArtKey` (texture key only,
  no scale) in the manifest would allow per-biome art without a bespoke scale.
  Deferred: no biome currently needs it and the plumbing would be unvalidated dead
  code. The comment in `terrainPackDefSchema` documents the intended re-entry path
  for when it is needed.
