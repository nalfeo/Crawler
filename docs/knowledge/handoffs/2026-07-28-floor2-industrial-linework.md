# Session Handoff: Floor 2 industrial linework — 2-edge Wang path tiles over map topology

## Date

2026-07-28

## Persona

Graphics Designer / Terrain Engineer (schema + geometry + Azure art + renderer + deterministic guards)

## Systems touched

sprite-pipeline, engine (terrain-renderer, MainGameScene, labs)

## Apples

5🍎 estimated. New pack mechanism + schema + topology-driven renderer pass + new Azure art briefs +
deterministic guards + probe seam.

## What Was Done

Floor 2 after #2164 had texture variety but no authored structure — it read as "a cave with cracks".
This session adds **industrial linework**: mine-cart track and steam-pipe runs, plus carts, a switch
lever and a pipe valve, concentrated around the boss dens and the resource heart.

The critical design point, set by the human up front: this is **not** a bigger ground-decal set.
Ground decals are independent lattice stamps with no knowledge of each other or of the map — correct
for cracks, catastrophically wrong for a rail line. Linework is a **path-following mechanism over map
topology**.

- **2-edge Wang path tiles.** After the human pointed at cr31's Wang-tile pages, the mechanism was
  fixed: edge-matching Wang tiles produce paths (corner-matching produce terrain patches — our
  `wallAutotile` is already a corner/blob47 set, so this is the same idea with the opposite matching
  rule). A 2-edge set is exactly 2⁴ = 16 tiles indexed by a 4-bit N/E/S/W mask, and that set _is_
  {empty, 4 end-caps, 2 straights, 4 corners, 4 T-junctions, 1 cross}. The renderer does **zero**
  orientation bookkeeping: compute the mask, index the atlas. cr31 ships a _pipe_ tileset as the
  canonical worked example, so this is the textbook case rather than an improvisation.
- **Route planning over the real walkable graph** (`src/shared/terrain-linework.ts`). A turn-aware A\*
  (state = tile + incoming direction) plans **hub yards** — short spurs local to each boss den /
  resource heart, which create the density — plus **trunk lines** between hub pairs, which create the
  length. Routes rasterise into one shared occupancy grid per layer, so junctions between two routes
  fall out as T/cross frames for free.
- **Geometry local, texture from Azure.** `gen/linework-geometry.ts` rasterises the 16 frames as pure
  geometry (`{cls, shade}` per pixel); `import-floor2-linework.ts` samples generated Azure metal into
  those masks. No hand-written texture synthesis, per the governing law.
- **A renderer pass, not a pool and not a decal.** Ordered `paintTiles('ground')` -> ground decals ->
  **linework** -> `paintTiles('cover')` -> deferred pipe wall-entry stamps -> `rt.render()`. Cracks
  therefore sit _under_ the rails (the rails were laid on cracked stone), and clip-by-overpaint is
  free. Pipes deliberately break that clip: a pipe's terminal cell sits one tile _inside_ the rock and
  is stamped after `'cover'`, so it reads as plumbing that goes somewhere. Track never does this.
- **Probe seam** for headless measurement: `packLineworkTileCount`, `packLineworkPropCount`,
  `packLineworkRuns[]`, `packLineworkHubs[]` threaded through `MainGameScene.terrainRenderSummary` into
  `main-scene-probe-lab`.

## Done-state (agreed with the human, and met)

> ≥ 6 distinct runs of ≥ 40 contiguous tiles each, with ≥ 60% of total run length within 25 tiles of a
> `BOSS_DEN` or `RESOURCE_HEART` room.

Measured in the **real booted scene** (`lab.html?lab=main-scene-probe-lab&floor=floor2`):
`1658 tiles, 61 props, 18 runs, 11 runs >= 40` (lengths up to 478), **concentration 0.945**.
Comfortable headroom on both halves of the gate.

## Observe before done

Real booted scene, not a lab-only check. Screenshots in `files/lw-sweep-*.png`. The strongest frame is
`files/lw-sweep-126-36.png`: a horizontal steam-pipe run with a corner, a mine-track corner into a long
horizontal run, carts oriented **along** the rails, and a valve wheel on the pipe. `lw-sweep-112-100.png`
shows a long vertical track run reading as continuous rail with ties.

## Key Decisions

1. **Joins are correct by construction and asserted pixel-for-pixel.** Every centreline meets its cell
   edge perpendicularly at the edge midpoint; corners are quarter arcs centred on the cell corner with
   radius exactly `HALF`. Coherence is therefore an **invariant**, not a tunable, and
   `tests/unit/terrain-linework-committed.test.ts` asserts it against the shipped bytes.
2. Geometry deterministic and local; texture generated. Mirrors `buildWallAccents`.
3. Renderer pass, not pool: pool tiles cannot carry cross-tile features (borders are byte-restored from
   the shared base).
4. ONE 16-frame atlas per layer. Wall entry is achieved by stamp **ordering**, not extra art.
5. `buildLineworkStampConfig` takes **no rotation and no flip** — a Wang frame's identity _is_ its edge
   signature, so rotating one relabels its edges and silently breaks the contract. Props are separate:
   they carry no edges, so `buildLineworkPropStampConfig` _does_ rotate.
6. Yards + trunks, **not** all-pairs trunks — an all-pairs network merges every yard into one giant
   component and collapses the run-count metric.

## Traps A Future Session Will Hit

- **A tile's north row abuts its neighbour's SOUTH row.** The first join guard compared N-against-N and
  E-against-E, so it passed happily while every join on the map showed a colour step (track: 4 N/S +
  3 E/W mismatching pixels; pipe: 11 + 10). The adversarial plan review caught this. Two things were
  needed: the guard groups connected edges by **axis**, and the generator's `sampleTile()` locks a 2px
  edge ring to `(along-edge coordinate, depth-from-border)` — locking to sample offset 0 is **not**
  enough, because at offset 0 row 0 still samples material row 0 while row 63 samples material row 63.
- **Do not shade the pipe from `project()`'s `off`.** Its sign is defined relative to each curve's own
  travel direction, so vertical and horizontal pipes get lit from opposite screen sides and both read
  as flat plates. Shade from screen-space displacement via `litFraction(dx, dy)`, which returns ±1 by
  **dominant axis**. A continuous 45° dot product must NOT be used: on a boundary row an arc's normal
  is only _nearly_ axis-aligned, so a corner frame would land in a different shading band from the
  straight it butts against, breaking the join contract. Dominant-axis collapses that to exactly zero.
- **Pixel-art style is four hard-won rules.** (a) Smooth cross-section gradients read as Factorio —
  use hard quantised bands. (b) `flatten(tile, TEXTURE_KEEP = 0.34)` _before_ banding is the single
  most important step: band steps are ~15%, and raw generated metal carries far more local contrast,
  which swamps them. (c) `chunkify(tile, 2)` for a visible 2px pixel size, with per-frame sample offsets
  kept to multiples of 2 so blocks are never cut in half. (d) `PIPE_STOPS` band widths must be
  **non-uniform** — equal fifths give five stripes of identical weight, which is exactly the "flat"
  read the human rejected.
- **`isRim()` must treat out-of-bounds as SOLID**, not empty. Rimming the cell border draws a dark seam
  across every join.
- **Concentration 0.9 does not mean the screenshot will show linework.** The metric is "within 25
  tiles of a hub"; the gameplay viewport is only ~32×17 tiles, so a hub-centred screenshot often frames
  an empty part of the neighbourhood. Screenshot a **known-occupied** tile.
- `scripts/sprites/terrain-packs/import-floor2-materials.ts` requires ALL cached ground materials and
  has a known half-run hazard, which is why linework got its own `import-floor2-linework.ts` CLI.
- `azure-image.ts` does **not** auto-load `.env.local`; callers must `loadEnvLocal(REPO_ROOT)` first.
- `sharp` is NOT installed — use `scripts/sprites/terrain-packs/png-buffer.ts` for image inspection.
- Any Playwright observation script must live at the **repo root** or module resolution fails. Probe
  readiness is `getTerrainRenderSummary()?.packFloorCount > 0`; there is no `probe.ready`.

## Known Limitations

- The CI placement gate (`tests/unit/terrain-linework-placement.test.ts`) runs against a **synthetic**
  cavern, not a booted Floor 2. A future map-gen change could violate the agreed gate on the real floor
  while CI stays green. A headless real-Floor-2 fixture under `tests/headless/` would close this; it was
  scoped out here.
- All visual observation used `setLightingOverlayVisible(false)`. The darkened pipe rim has not been
  evaluated against the _lit_ scene.
- The prop sheet is loaded twice (once per layer textureKey) because the two layers draw disjoint
  semantic frame ranges from one 256×64 image. Cheap, but it is a duplicate texture.

## Follow-ups The Human Asked For (explicitly out of scope here)

- A stone-wall / filler repetition pass, using the same shared-base procedure.
- A second floor pass, likewise.

## Where To Look

| What                                | Where                                                         |
| ----------------------------------- | ------------------------------------------------------------- |
| Route planner (pure, deterministic) | `src/shared/terrain-linework.ts`                              |
| Frame geometry + the join proof     | `scripts/sprites/terrain-packs/gen/linework-geometry.ts`      |
| Art import CLI (Azure texture)      | `scripts/sprites/terrain-packs/import-floor2-linework.ts`     |
| Renderer pass                       | `src/engine/terrain-renderer.ts` (search `packLinework`)      |
| Schema                              | `src/shared/terrain-pack-types.ts` (`lineworkLayerSchema`)    |
| Tunables                            | `src/shared/data/terrain-packs/industrial-cave.manifest.json` |
| Join-contract guard                 | `tests/unit/terrain-linework-committed.test.ts`               |
| Placement gate guard                | `tests/unit/terrain-linework-placement.test.ts`               |
| Headless measurement seam           | `src/labs/main-scene-probe-lab/index.ts`                      |
