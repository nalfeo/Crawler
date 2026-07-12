# ADR: 47-Mask Blob Terrain Packs — Shared Normalizer, Per-Surface Manifest, and Runtime Atlas Stamping

## Status

Accepted

## Date

2026-07-11

## Estimated Complexity

🍎🍎🍎🍎🍎 x 1 — spans shared/, engine/, scripts/sprites/ tooling, and floor-manifest runtime data;
new deterministic asset-build pipeline; new registry-backed schema.

## Context

Floor 1's walls/floors use a legacy fixed set of 16-mask Kenney-sheet autotile frames plus a small
number of approved "generated" single-PNG textures (`TILE_SPRITES` path in
`src/engine/sprites/tile-visuals.ts`), selected per-tile via `resolveFrame`. This works, but:

- It has no notion of a swappable "terrain pack" — wall material, floor variety, corridor variety,
  and door art are all baked into the same fixed sheet/texture-key wiring.
- The 16-mask autotile scheme cannot represent the full 47-state blob-autotile vocabulary (distinct
  concave-corner cases), which the approved Floor 2 industrial-cave material needs to read cleanly.
- There is no vendored, provenance-tracked open art in the repo to validate the pipeline against
  real (not just hand-authored) line art.

The approved 5-apple feature: build one authored "industrial-cave" wall/floor/corridor/door pack and
import one vendored CC0 fixture pack (`caeles`'s "Seamless Tileset Template II" from OpenGameArt),
both validated as 64×64-per-cell 47-mask atlases, and wire Floor 2 to render via the new pack path
while leaving Floor 1's legacy behavior byte-for-byte intact.

## Decision

1. **One shared, pure raw-mask normalizer** (`src/shared/terrain-pack-mask.ts`) is the single source
   of truth for the 256→47 blob-mask reduction, used by BOTH the runtime renderer and the offline
   build/validate tooling (no duplicated logic to drift):
   - Bit order pinned: `N=1, E=2, S=4, W=8, NE=16, SE=32, SW=64, NW=128`.
   - Diagonal gating: a diagonal bit survives normalization only if **both** adjacent cardinal bits
     are set (matches standard blob-autotile convention — a corner tile is only "closed" if the two
     edges framing it are also closed).
   - Out-of-bounds neighbors are treated as non-matching (an edge of the map reads as "open", not
     "solid" nor an error) — `computeRawMask8`/`neighborMask8InTerrain` implement this explicitly.
   - `BLOB47_CANONICAL_MASKS` is a fixed, explicit, ascending-order array of the 47 canonical values
     (every raw 8-bit mask normalizes to exactly one of these). This ordering is reused verbatim by
     `buildMaskFrameAssignments()` in the tooling to assign `frameIndex` 0..46, so both packs (and any
     future pack) share the identical mask→frame layout — only pixel content differs between packs.

2. **Per-surface manifest contract, not one coarse "topology" mode.** Each terrain pack
   (`src/shared/terrain-pack-types.ts`'s `terrainPackDefSchema`) declares four independent surfaces:
   `wallAutotile` (the 47-mask atlas + explicit `{maskId, frameIndex}` table — never inferred from
   atlas position), `floorPool` (3-5 variants), `corridorPool` (3-5 variants, kept separate from
   `floorPool` since a floor material and a corridor material are visually and semantically distinct
   even within one pack), and `doorSet` (exactly the four `open/closed × horizontal/vertical`
   combinations — no locked-door variant, out of scope per the approved design).

3. **Registry-backed terrain pack IDs.** `TERRAIN_PACK_IDS`/`terrainPackIdSchema` in
   `terrain-pack-types.ts` is a closed enum (`'industrial-cave' | 'caeles-fixture'`), reused by the
   floor-manifest schema's optional `terrainPackId` field
   (`src/shared/floor-manifest.ts`/`floor-registry.ts`-style fail-fast static parse). A typo'd or
   unknown pack id fails Zod validation at manifest-load time rather than silently falling back to
   legacy rendering at runtime — this was an explicit reviewed-design requirement (refinement #6).

4. **Explicit source size + deterministic nearest-neighbor scaling, no implicit resizing.** The
   vendored fixture's source cells are 32×32 (`SOURCE_CELL_PX` pinned in
   `build-caeles-fixture.ts`); `nearestNeighborResize` in `png-buffer.ts` performs an explicit, pure
   32→64 upscale (factor 2) with no browser/canvas-driven implicit resize path. The authored pack's
   quadrant-kit composes wall cells directly at the 64px `TERRAIN_PACK_CELL_PX` target size.

5. **Vendored fixture provenance is immutable and complete**, carried on the manifest's
   `provenance` field (`kind: 'vendored'`): `originalFilename`, `sourceUrl` (content page),
   `fileUrl` (direct download), `title`, `author`, `license: 'CC0'`, `licenseUrl`, `sha256` (the
   exact verified hash — `34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76`), and a
   `derivationNote` documenting the cell→mask assignment algorithm below. The vendored source PNG is
   checked in at `public/assets/vendor/terrain-packs/caeles-seamless-template-ii/template8x6.png`
   with sibling `LICENSE`/`SOURCE` documentation files.

6. **Deterministic two-phase greedy cell→mask assignment for the vendored fixture.** The vendored
   template is a _line-art guide template_ for a blob47 set, not a pre-indexed 47-sheet — its 48
   cells (row-major) have no declared mask identity. `assignPoolCellsToMasks` in
   `build-caeles-fixture.ts`:
   - Phase 1 bootstraps provisional open/solid edge references from pool-cell 0 and the reserved
     48th ("spare") cell, and locks in the best-matching cells for canonical masks 0 (all-open) and
     255 (all-solid) using those references.
   - Phase 2 rebuilds the open/solid references from the cells **actually assigned** to masks 0/255
     (so the build's own optimization target is self-consistent with what the post-hoc
     compatible-boundary validator will independently measure from the assembled atlas), then
     greedily assigns every remaining canonical mask in fixed ascending mask-value order, breaking
     ties by lowest remaining cell index.
   - This is fully deterministic (no randomness) and reaches ~0.93-0.94 on the documented
     compatible-boundary edge-match metric, vs ~0.55-0.65 for a naive positional assignment — see
     `docs/knowledge/adr` context and `validate.ts`'s module doc for the measurement design. The
     final `{maskId, frameIndex}` table is written into the manifest as a literal array; the runtime
     renderer never re-derives it from atlas position.
   - The template has no dedicated floor/corridor/door art, so those pool/door tiles are derived by a
     deterministic, documented per-(kind, index[, orientation]) RGB tint applied to the spare cell
     (`recolorDerivedTile`) — pure pixel math, not additional vendored artwork, and explicitly
     disclosed in `derivationNote` rather than silently invented.

7. **Compatible-boundary validator in place of byte-exact RGBA seam matching.** Exact pixel-seam
   matching is inappropriate for the vendored line-art template (real external art the assignment
   doesn't control) but IS provable by construction for the authored quadrant-kit pack. `validate.ts`
   implements one shared, documented edge-consistency check
   (`validateCompatibleBoundaries`/`edge-signature.ts`): classify each cell's 4 edges as
   "solid"/"open" by luminance proximity to mask-0/mask-255 reference cells, and assert the
   classification agrees with the cardinal bits implied by that cell's canonical mask.
   `AUTHORED_MIN_EDGE_PASS_RATE = 1.0` (provable by construction) vs
   `VENDORED_MIN_EDGE_PASS_RATE = 0.85` (a floor below the measured ~0.93-0.94, chosen to catch real
   regressions without demanding perfection from external line art) are separate, named, reviewable
   constants — never silently relaxed to make a run green.

8. **Runtime wiring, gated entirely on an optional `terrainPackId`.** `buildTerrainLayer`
   (`src/engine/terrain-renderer.ts`) resolves the pack once per bake
   (`options?.terrainPackId ? getTerrainPack(...) : null`) and, when non-null, stamps WALL tiles via
   an explicit `maskId → frameIndex` lookup (bypassing the legacy generated/Kenney/color path
   entirely — this `packWallCount` diagnostic is the runtime assertion seam proving Floor 2 walls use
   atlas frame stamping, not the old generated-single-image bypass), FLOOR/CORRIDOR tiles via
   `pickPoolVariant` (deterministic `SeededRandom`-driven pick keyed on `(floorSeed, tx, ty)` — never
   `Math.random()`), all gated with `continue` so a pack hit never falls through to the legacy path.
   When `terrainPackId` is omitted (Floor 1), every pack branch is inert and rendering is
   byte-for-byte identical to pre-existing behavior. `MainGameScene.ts`'s door overlay mirrors this
   precedence using the pure `resolveDoorPoolVariant` resolver before the existing
   generated/Kenney/color door fallback chain.

9. **Static preload registry at BootScene**, not a per-floor dynamic fetch. Every asset referenced by
   every registered pack's manifest (wall atlas spritesheet, all floor/corridor pool images, all four
   door images) is derived directly from the parsed manifests
   (`collectTerrainPackPreloadEntries()`/`preloadTerrainPacks()` in
   `src/engine/sprites/terrain-pack-visuals.ts`) and queued at `BootScene.preload()`, before any floor
   loads — so switching onto a pack-using floor (Floor 2) never hits a missing-texture transition
   miss, and there is no second hand-authored asset list that can drift from the manifests.

## Consequences

### Positive

- Floor 2 gets a materially richer wall/floor/corridor/door visual vocabulary without touching Floor
  1's legacy rendering path at all (proven by dedicated "pack omitted → byte-identical" unit tests).
- The shared mask normalizer + explicit frame table make the 47-mask contract fully testable
  (exhaustive 256→47 unit coverage) and fully deterministic (no runtime inference from atlas pixel
  position).
- The vendored CC0 fixture proves the pipeline against real external art, not just hand-authored
  content, with full immutable attribution and a documented (not hand-waved) assignment/validation
  methodology.
- Any future pack (a third biome's material) only needs a new manifest + asset set; no engine or
  registry code changes required.

### Negative

- The vendored fixture's floor/corridor/door art is a derived tint of a single "spare" cell rather
  than dedicated art — visually flat compared to the authored pack. Documented explicitly in
  `derivationNote`; acceptable because `caeles-fixture` is a validation fixture, not a shipped
  gameplay pack (Floor 2 opts into `industrial-cave`, not `caeles-fixture`).
- Two parallel "authored" vs "vendored" edge-pass-rate thresholds are cognitive overhead future
  authors must understand before adding a third pack.

### Risks

- If a future authored pack's quadrant-kit compositor has a bug that breaks the "provable by
  construction" 100% edge-pass guarantee, the authored floor (`AUTHORED_MIN_EDGE_PASS_RATE`) would
  need lowering — a signal to fix the compositor, not the threshold.
- `PACK_CORRIDOR_TERRAIN_TYPES` is currently only exercised by synthetic unit tests, since Floor 2's
  `cave_system` generator never emits `TerrainType.CORRIDOR` today; the corridor pack-branch is
  correct but unobserved in real Floor 2 gameplay until a corridor-emitting biome exists.

## Alternatives Considered

- **Atlas-first, no assembler tooling (v1)** — hand-place all 47 frames directly as the checked-in
  atlas PNG. Rejected: the approved target explicitly requires a deterministic quadrant/parts
  assembly step (20-quadrant kit) that must remain reproducible from source, not a single opaque
  binary asset.
- **Extend the existing `generatedAssets` pipeline** to also emit terrain packs. Rejected: approved
  single-sprite generated assets and multi-surface terrain-pack topology have materially different
  schemas/lifecycles (one PNG with a scale factor vs. a 4-surface manifest with an explicit 47-entry
  mask table); forcing them through one pipeline would blur that contract.
- **Boot-time (runtime) composition of the wall atlas from quadrants**, instead of a build-time CLI.
  Rejected: deterministic build artifacts should be validated (schema, dimensions, mask coverage, seam
  check) before they ever reach the runtime; a runtime-composed atlas can't be pre-validated or
  diffed in review the same way a committed PNG can.
