# Floor 2 industrial linework — art-quality polish round

**Date:** 2026-07-28
**Apples:** 3🍎 estimated / 3🍎 actual
**Branch:** `nalfeo-floor2-industrial-linework`

## Systems touched

terrain, rendering, asset-pipeline

## What this was

A polish round on the Floor 2 industrial linework that shipped in PR #2184. The human reviewed it
on a gameplay screenshot and raised five defects. All five are fixed. The Wang mechanism, the join
contract, the route planner, and the shared terrain-pack contracts are unchanged.

| #   | Complaint                                    | Resolution                                                              |
| --- | -------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | tracks too light and too narrow              | wider silhouette + higher contrast, luminance deliberately held         |
| 2   | tracks that do not end in a wall just stop   | real buffer stops (beam + two buttresses), cut from the timber material |
| 3   | pipe valve prop looks awful                  | new 3x2 Azure prop sheet; three axis-agnostic circular pipe fittings    |
| 4   | pipes need rivet bands, rust streaks, cracks | collars now wrap the bore; new generated corrosion overlay              |
| 5   | pipes must go under the track for real       | burial pass inside the plan, not a draw-order trick                     |

## The one thing to know

**Burial is a planning decision.** A tile a pipe shares with an already-placed track becomes a
third occupancy value `LINEWORK_BURIED`, and the plan exposes a second parallel view of itself
(`renderOccupancy` / `renderMasks` / `renderRuns` / `buriedCount`) that the renderer consumes
instead of the topological arrays. Doing it as draw order would have left the buried tile counted
in the run metrics and left its neighbours pointing stubs into a tile that reads as track.

Two invariants keep it safe, both tested:

- Burial cannot **strand** a tile. Removing a tile drops a bit from each neighbour's mask, so a
  neighbour can reach mask 0 and stamp as an isolated blob. The pass is a monotone fixpoint —
  rebuild masks, bury anything visible at mask 0, repeat — bounded by the tile count.
- Burial cannot **sever a branch**. Margin growth is restricted to tiles with exactly two set bits,
  because sinking a T-junction or cross would orphan the branch that was not part of the crossing.

`LINEWORK_BURIED` is **truthy**. Every previously-adequate `!occupancy[i]` test was a latent bug;
`groundMask()` and `measureRuns()` now compare against the value explicitly. If you add code that
reads linework occupancy, compare against the value — do not test for falsiness.

## Traps hit (do not re-learn these)

- **`stubCurve()` caps arc length at the cell centre.** The end-cap test therefore only ever
  painted the near half of its beam, and anything behind it was silently discarded. This shipped,
  was ADR'd, and went unnoticed. Buffer stops needed a dedicated `capCurve()` with a longer reach,
  used _only_ to classify cap pixels so no connected edge profile can move.
- **Raising `targetMeanLuminance` makes linework brighter, not bolder.** `restylePixelArtMaterial()`
  normalises _toward_ the target. "Too light" meant too weak. Boldness came from `targetStdDev`,
  the rim scale, and the band ramp.
- **Do not erode before labelling connected components.** Erosion severs a cart's thin wall from
  its floor, so "the six largest blobs" stops being the six objects. Label first, erode per
  component.
- **Chroma-key tolerance is per-sheet.** The v2 prop sheet's darker crimson field needed the
  tolerance dropped 110 → 58 or the flood leaked into the brown cart interiors.
- **The cap pre-pass must not `break` the curve loop.** The tie branch uses `continue` precisely so
  a _later_ curve's rail can override; an early break would change T-junction and cross frames.
  Substituting an empty curve list preserves that.

## Deviation from the reviewed plan

Item 4 was planned as a `variants` schema field with a 48-frame pipe atlas and a picker. It was
**not** built. A single wear overlay on the existing 16 frames delivers the same visual outcome
with no schema change, no 3x atlas, and no variant-sweep guard extension, and preserves the join
contract for free because it samples through the same `sampleTile` edge lock. The `variants`
design is still valid if per-tile variation is wanted later.

## Observation (real MainGameScene, not a lab)

Booted the game, paused the sim, disabled the lighting overlay, and screenshotted at three
locations plus three real pipe/track crossings found via a new `packLineworkBuriedSample` probe
field. `getTerrainRenderSummary()` on Floor 2:

```
packLineworkTileCount: 1589
packLineworkPropCount: 60
packLineworkBuriedCount: 69
```

11 visible runs of >= 40 tiles (gate: >= 6), concentration ~97% near boss dens and the heart
(gate: >= 60%). Both gates survive burial, which was the largest open risk. Screenshots confirm
bold rails with clear sleepers, buffer stops, wrapped rivet bands, a handwheel fitting on a run,
and a pipe terminating in a ground flange where a track crosses over it.

## Follow-ups not taken

- True per-tile pipe variants (the `variants` schema design above).
- The bolted-collar prop's centre hole is filled rather than transparent — the background flood
  deliberately protects enclosed pixels. It reads as a solid flange plate, which is acceptable.
- Stone-wall/filler repetition pass and the second-floor pass are owned by the parent session.
