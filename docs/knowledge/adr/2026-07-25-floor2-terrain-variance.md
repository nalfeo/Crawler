# ADR 2026-07-25: Floor 2 terrain variance — shared-base pools, ground decals, and clip-by-overpaint

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 5 — grows a shared contract (`terrain-pack-types.ts` / `terrain-pack-variants.ts`), restructures the
renderer (`terrain-renderer.ts`), adds derivation tooling under `scripts/sprites/terrain-packs/`, and
introduces a new pack mechanism (ground decals) with its own committed art and deterministic guards.

## Context

Floor 2's `industrial-cave` pack shipped 4 floor + 4 corridor sources, one static wall autotile, and no
decoration. At Floor 2's scale (200×200 tiles) that is thousands of CAVE_FLOOR tiles drawing from 4
images. The human's verdict was blunt: "very very repetitive."

The arc of this change was driven by repeated visual rejection, and the governing law was set early by
the human after a procedural attempt was rejected:

> **Generated art supplies texture; local deterministic code supplies only geometry, pooling, lighting,
> and validation.** Do not hand-write texture synthesis.

A second law came out of the restyle: **"Rivet repeats are fine — that's industrial. But natural
surfaces should not look repetitive."** Manufactured motifs may tile visibly; rock may not.

## Decision

### 1. Weighted-rarity pools derived from a shared base

Pool variants are derived from one shared base tile. Each variant's **border pixels are byte-restored
from that base**, so every variant is edge-compatible with every other by construction — no seam
validation matrix, no per-pair compatibility table. Variants are selected by
`buildWeightedCombos` / `pickPoolCombo` (`terrain-pack-variants.ts`), which weights a common base
heavily and rare variants lightly, so the surface reads as one material with occasional incident rather
than N equally-likely textures.

This **replaced** the originally-planned disjoint parity buckets. Parity buckets guaranteed orthogonal
neighbours never matched, but at 8 sources the guarantee bought nothing visible while forcing every
tile into one of two half-pools — the human read the result as _more_ patterned, not less.

### 2. Ground decals — a new pack mechanism

Byte-restoring borders has a hard structural consequence: **no feature inside a pool tile can ever
cross a tile edge.** Cross-tile cracks are therefore impossible in the pool, at any pool size. This was
not a tuning problem; it was a property of the design.

Ground decals are a separate layer: standalone atlases stamped over the ground on a **jittered lattice
that is independent of the tile grid**. A pack declares `groundDecals` as an array of sets; Floor 2
ships four (6 / 4 / 3 / 2-tile spans) at distinct lattice pitches. Placement
(`pickGroundDecal`) is a pure function of `(floorSeed, anchor, setIndex)` and yields frame, sub-tile
offset, **continuous** rotation, and mirror.

Three properties were each found the hard way and are load-bearing:

- **Jitter must span the FULL stride**, not `stride − span`. Clamping to the slack pins every decal
  into the same sub-block of its cell and produces visible banding — the exact artefact it was meant
  to remove. Footprints from neighbouring anchors then overlap, which is the point.
- **Rotation must be continuous, not quarter-turns.** Measured: quarter turns cannot decorrelate an
  axis-aligned motif — the motif's own axes stay parallel to the grid in all four states.
- **Each set needs its own hash salt**, or all sets fire at the same anchors.

Selection of source windows during derivation uses the largest **connected** component span, not
coverage. Coverage is the wrong signal for cracks: a field of speckle scores higher than one long
fracture. Non-maximum suppression (pairwise Jaccard < 0.5) is mandatory, with a **within-set**
separation radius (0.5) distinct from the **cross-set** radius (0.25) — within a set, overlapping
windows genuinely are the same crack twice; across sets the same region yields a visibly different
decal (different scale, independent rotation and mirror).

### 3. Clip-by-overpaint: walls mask decals

Decals cannot be confined to the ground by testing their footprint. The rotated half-extent at angle θ
is `(size/2)(|cosθ|+|sinθ|)` — mean ≈ 1.27× — so requiring a clear footprint forced a 6-tile decal's
centre ≥ ~3.8 tiles from any wall. Measured effect: 2051 decals placed on Floor 2 against ~3900
expected under a centre-only rule. Every rejection was wall-adjacent, producing a clean untouched
margin ring, worst for the largest and most interesting sets.

`buildTerrainLayer` was therefore restructured from one tile pass into **three**:

1. `paintTiles('ground')` — ground/floor/corridor tiles only
2. the decal pass
3. `paintTiles('cover')` — wall/void tiles, each cell `rt.clear()`ed before stamping

The wall art itself becomes the mask. The clip is pixel-exact and costs nothing per decal — strictly
cheaper than computing a per-decal mask. The `clear` is required because the wall silhouette is
**inset** and does not fill its own cell; without it, decal pixels survive inside the transparent inset
and float over the background.

Decal acceptance is now: **centre tile is markable ground**, AND **>= `DECAL_MIN_GROUND_FRACTION` (0.35)
of the rotated AABB is markable ground**. This is explicitly _not_ a containment rule — decals are
clipped, not excluded. It exists only to stop a large set firing into a one-tile corridor where nearly
all of it clips away and the slivers read as noise.

"Markable" is **family-scoped**. A pack's decals only land on ground its own family paints, and each
pack in `packsByFamily` gets its own pass (entries resolving to the same pack are deduped, so the
common single-`terrainPackId` floor still stamps exactly once over all its ground). Corridors are
attributed to `stone ?? cave`, matching how the corridor _pool_ is resolved. Without this, a
mixed-biome floor would stamp one pack's cracks across the other biome's ground and silently drop the
second pack's decals entirely — not reachable on Floor 2's single pack, but immediately reachable by
the two-pack Floor 1 work that follows.

Measured: 2051 -> 3891 decals, matching the centre-only prediction. Density was then tuned down at the
human's request (small sets cut hardest) to 2285, keeping the long cracks and dropping the speckle.
The family-scoping refactor is behaviour-preserving on Floor 2: re-measured in the booted game via the
`packGroundDecalCount` probe seam, still exactly 2285.

### 4. Mask-aware wall accents

A pack ships 4 accent atlases sharing `wallAutotile`'s grid and `maskId -> frameIndex` table.
`buildWallAccentAtlas` clips one motif to each mask's own wall-cell alpha, so an accent can never spill
past valid wall topology — provable by construction and checked pixel-for-pixel by
`validateWallAccentTopology`. Accented tiles get a second stamp at the same frame index;
`WALL_ACCENT_DENSITY = 0.2`.

### 5. Value hierarchy inverted to give walls verticality

Five procedural wall iterations were rejected ("walls read as floors", then "no verticality"). The
accepted fix was not more detail but a **value inversion**: floor brightest, wall dark. Wall lighting
is applied during pool rebuild, deterministically.

### 6. Derivation is committed, not generated at build time

`import-floor2-materials.ts` turns cached Azure output into committed pack art;
`rebuild-shared-base-pools.ts` regenerates pools and applies wall lighting. A clean checkout renders
Floor 2 with **no Azure key**. The generation -> derivation boundary is the seam: Azure output is cached
and imported, never fetched during a build or test.

The two stages are **chained, not documented**. `import-floor2-materials.ts` used to end by printing
"now run rebuild-shared-base-pools.ts"; a half-run then shipped raw pre-lighting material whose pool
borders no longer matched the new base, and the floor rendered as speckle on a visible grid. That
state shipped undetected in this session because only the running game caught it. `main()` now calls
`applySharedBasePoolRestyle()` directly, and a **fixed-point guard** asserts the committed pool and
atlas bytes equal what the rebuild re-emits — so an import-only state or a stale derivation fails a
test. The guard covers only re-emitted files; the ground-decal atlases and in-threshold accents are
covered structurally by sibling assertions instead, and a coverage check pins the emitted set so the
guard cannot silently shrink.

## Consequences

### Positive

- Floor 2's ground carries cracks that visibly cross tile boundaries and run up to and under walls —
  structurally impossible before this change.
- Every pool variant is edge-compatible with every other by construction, so pool growth is free.
- The decal mechanism is pack-agnostic; any future pack can declare `groundDecals`.
- The whole art defect class is pinned by a deterministic committed-art guard
  (`tests/unit/sprites/terrain-pack-committed.test.ts`, 16 assertions) — span, coverage, pairwise
  Jaccard, stroke boldness, absence of enclosed 1-2px pinholes, and a byte-exact fixed-point check
  against the rebuild — so a bad regeneration fails a test rather than needing an eyeball.
- Decals are family-scoped, so the mechanism is safe for multi-pack floors before the first one exists.

### Negative

- `caeles-fixture` grew a `wallAccents` field (4 no-op transparent atlases) purely to satisfy the
  shared schema.
- The 1024x1024 source material hard-caps decal span at 2x sampling, so the 4- and 6-tile sets use
  `windowScale: 1` and their grain is 2x the ground's. Defensible (larger cracks _are_ wider) but only
  eyeballed.
- `import-floor2-materials.ts` rewrites `floor-0`, `corridor-0` and the accents with raw pre-lighting
  material, so the rebuild **must** follow it. It now chains automatically and the fixed-point guard
  catches a half-run, but the two-stage shape itself remains a hazard for anyone invoking the import's
  internals directly.

### Risks

- `DECAL_MIN_GROUND_FRACTION = 0.35` is a judgement call validated by screenshots, not a derived bound.
- Long cracks read slightly root/branch-like rather than fractured-stone at `windowScale: 1` — the
  source material's crack network amplified by scale. Flagged to the human, accepted for now.

## Alternatives Considered

- **8 independent materials** — rejected on gameplay screenshots: variety without cohesion reads as
  noise, not as one place. Led to replacing the >=24-combinations metric with a cohesion metric.
- **Disjoint parity buckets** — implemented, then removed (see Decision 1).
- **Bigger pools / more variants** — cannot produce a cross-tile crack at any size (Decision 2).
- **Per-decal masking against the wall map** — correct but strictly more expensive than
  clip-by-overpaint, which gets a pixel-exact clip for free from art that is drawn anyway.
- **Rejecting wall-overlapping decals** (the original rule) — the bug this change fixes.
- **Procedural texture synthesis in TypeScript** — rejected by the human by name; it is what produced
  the five rejected wall iterations.
