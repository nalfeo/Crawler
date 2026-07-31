# Floor 1 welcome-room lattice fix

## Systems touched

terrain-packs, sprites-pipeline

## Why this exists

Follow-up to #2236 (`2026-07-28-floor1-biome-terrain-packs.md`), opened after the
maintainer looked at screenshots of the merged work and immediately said: _"Wtf
are all the grid lines everywhere?"_

The welcome-room floor rendered as **graph paper**. This is the most valuable
finding of the whole Floor 1 effort, and it came from a human looking at a
picture — not from any of the eight deterministic guards, all of which passed it.

## Root cause

My own prompt in `FLOOR1_SPECIAL_FLOOR_SPECS` asked for "thin brass inlay lines
and a faint engraved geometric border pattern **repeating across the surface**".
The image model complied exactly.

Because the tile is **seamless**, those lines chain across every tile boundary
into unbroken lines spanning the entire room. A 64 px artifact became a
room-scale grid. The welcome room is the spawn room, so it was the first thing a
player ever saw.

## Why all eight guards were blind (the durable lesson)

The bad tile's column standard deviation was **11.58 — LOWER than the ordinary
floor's 12.49.**

A perfect lattice is a _low-variance, high-regularity_ signal. It is
statistically **calmer** than good art while being visually far worse. The
existing guards measure mean luminance, standard deviation, silhouette geometry
and seam byte-identity; not one of them can see structure, by construction. Any
amplitude-based check will keep missing this defect class forever.

| tile               | field mean | peak col  | bright-line cols   | col SD | mean chroma |
| ------------------ | ---------- | --------- | ------------------ | ------ | ----------- |
| `floor-0` (normal) | 74.8       | 82.2      | none               | 12.49  | 24          |
| welcome **before** | 84.5       | **133.1** | **10, 21, 42, 53** | 11.58  | 21.8        |
| welcome **after**  | 84.0       | 91.4      | **none**           | 8.08   | 10.5        |

Max chroma after is 29, identical to `floor-0`'s palette clamp, so the new tile
is palette-safe despite reading grey-blue in isolation at 64 px.

## What shipped

- **Regenerated** the welcome material from an irregular-slab prompt carrying an
  explicit negative list (no inlay, no metal strips, no painted lines, no grid,
  no lattice, no geometric pattern, no regular repeating motif).
- **New `anti-lattice` guard** in `tests/unit/sprites/terrain-pack-floor1-committed.test.ts`.
  Reduces each tile to per-column and per-row mean-luminance profiles and fails
  if the brightest line exceeds **3.4 sigma** of its own axis.

Guard design notes worth keeping:

- Scored **per axis**, combined with `max`, and **never pooled**. Pooling column
  and row deltas into a single distribution was shown non-monotonic by the Floor
  2 session across six tiles — it read both high and low against per-axis truth
  — so a pooled score cannot even be read directionally.
- Threshold **calibrated on 46 committed pool tiles across three independently
  generated packs** (`floor1-dungeon`, `floor1-cave`, `industrial-cave`), whose
  worst case is 2.75.
- **Negative control run**: the guard was executed against the restored gridded
  tile and _failed_, reporting `special-welcome-0.png (z=4.11)`. An unvalidated
  guard is not a guard.

## Observe before done

- **Before:** reproduced live in the real game (`npm run dev`, not a lab) at the
  actual player spawn with lighting and FOV disabled. Grid clearly visible.
- **After:** re-observed at the same spawn. Grid gone; the floor now reads as
  mottled grey slate.
- Column-luminance probe agrees: 4 bright-line columns to 0, peak 133.1 to 91.4.

## Verification

- `terrain-pack-floor1-committed.test.ts` — 25/25 (was 23, +2 for the guard)
- `terrain-pack-floor1-biomes.test.ts` — 11/11
- `npm run terrain-packs:validate` — all four packs OK
- `npm run verify:fast` — pass

## Traps worth carrying forward

- **Cache-key isolation is the cheap-regeneration lever.** `loadMaterial` keys
  its cache on `spec.cacheKey`, so bumping exactly one key rebuilt one material
  and left every other byte identical (6 cache hits, 1 generated). Use this for a
  single-material fix; **never `--force`**, which re-requests everything.
- **`terrain-pack-lab` defaults `showGrid: true`.** Pack-lab sheets draw the
  lab's own tile-boundary overlay, so they cannot be used to judge whether art
  contains a grid. The in-game grid here was separately real, but the lab sheets
  would have shown lines either way. Screenshot the game, not the lab, for this
  class of question.
- A committed _normalized_ pool tile allows geometry recomposition but **not**
  luminance re-tuning — that needs the raw material, which is why this fix
  required a real Azure call rather than a local recompose.

## Out of scope: the welcome-sign clipping is pre-existing

The same screenshot review flagged the arrow sign as visually clipped. It is
**not** from this work: `git diff --name-only origin/main...HEAD` touches none of
`textures.ts`, `floorScenario.ts`, `PhaserBridge.ts`, `sprite-kind.ts`.

The bake is provably correct — `TEX_WELCOME_SIGN` is 48x26 px for a 6 x 3.25 ft
sprite at 8 px/ft, exactly 1:1 with no scaling, and `"WELCOME"` at
`bold 9px monospace` measures 34.64 px centred in a 48 px board (spans
6.7...41.3). So the artifact is display-side and the root cause is not
established. It deserves its own investigation rather than a drive-by fix.

## Recommended next steps

1. **Investigate the sign clipping** as a separate issue (see above).
2. Consider generalising the `anti-lattice` guard to `industrial-cave` and any
   future pack — the defect class is a property of seamless tiling, not of Floor
   1. The calibration data already covers `industrial-cave` (worst case 2.75).
3. Floor 1 still uses none of Floor 2's variance mechanisms
   (`packFloorTransformCounts: {none: 9079}`, zero accents, zero decals). Now
   that #2184 linework has landed, a variance pass would hit a stable target.
4. `industrial-cave`'s committed-art test still lacks `validateAuthoredSilhouetteExact`.
5. PR #2098 landed 7 unwired `welcome-room-floor-plate-*.png` that overlap the 4
   wired `special-welcome-*.png`.
