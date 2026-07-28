# ADR 2026-07-28: Floor 2 industrial linework — edge-Wang path tiles over map topology

## Status

Accepted

## Date

2026-07-28

## Estimated Complexity

🍎 x 5 — adds a new deterministic route planner in `src/shared/`, a new manifest section and schema, a
third renderer pass in `terrain-renderer.ts`, a new Azure art harness and importer CLI under
`scripts/sprites/terrain-packs/`, a probe-seam extension, and two new deterministic guard suites.

## Context

Floor 2's `industrial-cave` pack, after the terrain-variance work (ADR 2026-07-25), read as a
_varied cave_ — not as an _industrial zone_. The human's ask was coherent long-run industrial
infrastructure: mine-cart tracks that run for long distances, pipes that make runs and enter/exit
walls and ground, plus switches and carts, concentrated near the boss dens and the central room.

The obvious implementation — a bigger ground-decal set — is wrong, and the human said so up front.
Ground decals are **independent lattice stamps**: jittered onto a lattice, rotated continuously,
NMS'd against neighbours, with no knowledge of any other stamp or of the map. That is exactly right
for cracks and exactly wrong for rails. A mine-cart track that is a scatter of independent
track-segment stamps reads as garbage.

The governing law from ADR 2026-07-25 still applies and was restated:

> **Generated art supplies texture; local deterministic code supplies only geometry, pooling,
> lighting, and validation.** Do not hand-write texture synthesis.

The human also supplied the mechanism, pointing at cr31's Wang-tile pages: a **2-edge Wang set is
exactly 16 tiles**, and cr31's canonical worked example is a _pipe_ tileset.

## Decision

### 1. Linework is a path-following mechanism over map topology, not a decal set

`src/shared/terrain-linework.ts` plans routes through the **real walkable graph** (turn-aware A\*
over the routable grid, attracted to hubs, penalised for turns and for straying from hubs). Only
after a route exists is art chosen: each occupied tile's frame is a **4-bit N/E/S/W connectivity
mask** derived from its occupied neighbours. Straight / corner / T / cross / end-cap fall out of the
mask; no stamp is ever placed independently of its predecessor and successor.

Topology is `yards + trunks`, not all-pairs trunks: all-pairs merges every yard into a single
4-connected component and collapses the "≥6 distinct runs" metric to 1.

### 2. Joins are structural and provable, not tuned

Every centreline meets its cell edge **perpendicularly at the edge midpoint**. Straights are
axis-aligned; corners are quarter arcs centred on the cell corner with radius exactly half a cell.
Rails and bores are a function of perpendicular distance to the centreline, so every frame paints an
identical boundary profile on any connected edge — by construction.

The texture ring is locked as a function of **(along-edge coordinate, depth-from-border)**, not of
raw `(x, y)`. Locking to sample offset 0 is _not_ sufficient: at offset 0, row 0 samples material row
0 while row 63 samples material row 63, so a tile's north row and its neighbour's south row still
differ. Resolving the along-coordinate from the vertical band at corners makes the lock symmetric
under both reflections, so all four corners agree.

The guard (`tests/unit/terrain-linework-committed.test.ts`) asserts this **pixel-for-pixel against
the committed art**, grouping edges by **axis** — {N,S} share one reference profile, {E,W} another —
because a tile's north row abuts its neighbour's _south_ row, never another north row. An earlier
N-to-N guard passed while every join carried a visible colour step.

### 3. Masks are reciprocal, including against wall entries

A pipe run deliberately terminates one cell **inside** a wall (`LINEWORK_WALL_ENTRY`) so it reads as
entering the rock. That terminus is pinned to exactly one edge — the bit pointing back at its parent
on the path — or an unrelated route passing beside the same rock would promote it to a straight or T
drawn over solid stone.

The pin creates a dual hazard: a ground tile adjacent to a wall entry it is _not_ the parent of would
connect to it while the entry paints nothing back. Ground masks therefore count a wall-entry
neighbour **only when that entry's pin points back at this tile**. Reciprocity is asserted for every
set bit on every occupied tile across seeds and layers.

### 4. Renderer pass, not pool, not decal

Pool tile borders are byte-restored from the shared base, so **no pool tile can carry a cross-tile
feature**. Linework is therefore a renderer pass, ordered:

`paintTiles('ground')` → ground decals → **linework** → `paintTiles('cover')` → deferred wall entries
→ `rt.render()`

Track clips against walls by overpaint, exactly like the decal pass. Pipes deliberately break that
clip: their wall-entry tiles are stamped **after** `'cover'`, so the wall does not overpaint them.

### 5. One 16-frame atlas per layer; wall entry is stamp ordering, not extra art

A Wang frame's identity **is** its edge signature, so `buildLineworkStampConfig` takes no rotation
and no flip. Props are not Wang tiles, so `buildLineworkPropStampConfig` _does_ rotate — a cart is
turned a quarter turn on east-west runs, and props are only placed where `lineworkRunAxis(mask)`
gives an unambiguous direction.

### 6. Pipe roundness is screen-space, quantised, and dominant-axis

`p.off`'s sign is **curve-relative**: a straight entered from the north has `off = -(x - 32)`, one
entered from the west has `off = +(y - 32)`. Shading from `off` lights vertical and horizontal runs
from opposite screen directions, which is precisely the "flat plates" the human rejected. The
rasteriser therefore projects to **screen-space** displacement and takes the **dominant axis**:
`|dx| >= |dy| ? -sign(dx) : -sign(dy)`.

A continuous 45° dot product must **not** be used. On a boundary row an arc's normal is only
_nearly_ axis-aligned (the pixel centre sits half a pixel inside the cell), so a corner frame would
land in a different shading band from the straight it butts against — breaking the join contract.
Dominant-axis collapses that error to exactly zero.

Band stops are **non-uniform**; equal fifths give five identically-weighted stripes, which reads flat.

### 7. Pixel-art style law

The human rejected the first lit pass as "looking like Factorio". The resulting law:

1. Smooth cross-section gradients read as a 3D render — use **hard quantised bands**.
2. **Flattening local contrast before banding is the single most important step.** Band steps are
   ~15%; raw generated metal carries far more local contrast and swamps them.
3. Sample offsets are multiples of the pixel-block size, so blocks are never cut in half.
4. Linework must sit **near floor tone** — it is infrastructure in the scene, not a highlight on top
   of it.
5. Rim detection treats out-of-bounds as **solid**, not empty; rimming the cell border would draw a
   dark seam across every join.

## Consequences

**Good**

- Runs read as coherent infrastructure at gameplay zoom. Measured on the real booted scene:
  1658 tiles, 61 props, 18 runs, **11 runs ≥40 tiles**, concentration **0.945** — against a gate of
  ≥6 runs ≥40 and ≥60% concentration.
- Coherence is a **structural invariant asserted against shipped bytes**, not a tuning knob that can
  drift.
- Adding a third linework layer is a manifest edit plus one Azure material — no new code.
- Density is measurable headlessly through the probe seam
  (`packLineworkTileCount`, `packLineworkPropCount`, `packLineworkRuns`, `packLineworkHubs`).

**Costs**

- A third renderer pass over the floor grid at pack-build time.
- Two more committed atlases plus a props atlas per pack that opts in.
- The placement gate runs against a **synthetic** map in CI, not a real generated floor; the real-map
  measurement is a manual observation step. This is a known limitation, recorded rather than fixed.

## Alternatives considered

- **Semantic infrastructure forest** — deterministic ports on room boundaries plus a Steiner forest
  preserving route identity. Rejected: it merges every yard into one component, collapsing the
  "≥6 distinct runs" metric to 1.
- **Whole-run textured ribbon rasterisation** of polylines instead of per-tile frames. Rejected: it
  cannot be atlased or pooled, and it breaks the binary-alpha stamp contract the pack relies on.
- **A bigger ground-decal set.** Rejected by the human before work started, and correctly — decals
  have no knowledge of each other or of the map.

## References

- ADR 2026-07-25: Floor 2 terrain variance — shared-base pools, ground decals, and clip-by-overpaint
- `docs/knowledge/handoffs/2026-07-28-floor2-industrial-linework.md`
- cr31's Wang-tile pages (2-edge set = 16 tiles; pipes as the canonical example)

## Amendment 2026-07-28: art-quality polish round

The initial implementation shipped and was reviewed on a gameplay screenshot. The human raised
five defects, all of which are addressed without changing the Wang mechanism, the join contract,
or the route planner.

### Burial is a planning decision, not a draw-order trick

The most structural of the five was "pipes must go _under_ the track for real". Drawing the pipe
first and letting the track overpaint it would satisfy the screenshot but not the model: the pipe
tile would still be a member of its own visible network, so the run-length and concentration
metrics would count tiles nobody can see, and the pipe's neighbours would still present a stub
pointing into a tile that reads as track.

Instead `buryCrossings()` runs inside the plan. Tiles a pipe shares with an already-placed track
become a third occupancy value `LINEWORK_BURIED`, distinct from both empty and visible. The plan
then exposes a **second, parallel view** of itself — `renderOccupancy`, `renderMasks`,
`renderRuns`, `buriedCount` — alongside the original topological arrays. The renderer consumes
only the render view.

Two properties make this safe and are now tested:

- **Burial cannot strand a tile.** Removing a tile from the visible network removes a bit from
  each neighbour's mask. A neighbour can therefore drop to mask 0 — a tile connected to nothing,
  which would stamp as an isolated blob. The pass is a monotone fixpoint: rebuild the render
  masks, bury any visible tile that reached mask 0, repeat. It terminates because burial only
  ever adds tiles to a finite set.
- **Burial cannot sever a branch.** Growth along the run by `BURY_MARGIN` is restricted to tiles
  with exactly two set bits. Sinking a T-junction or a cross would orphan whichever branch was
  not part of the crossing.

`LINEWORK_BURIED` is a truthy occupancy value, so every previously-sufficient `!occupancy[i]`
test became a latent bug. `groundMask()` and `measureRuns()` now compare against the value.

Layers are sorted track-kind-first before planning. That is a no-op against today's manifest, but
it makes "track is placed before pipe" a property of the renderer rather than of the layer order
someone happened to author.

### Art-side changes

- **Track boldness came from contrast, not brightness.** `restylePixelArtMaterial()` normalises
  _toward_ `targetMeanLuminance`, so raising it would have made the track literally brighter — the
  opposite of the complaint, and a violation of the near-floor-tone style law. Boldness came from
  a wider silhouette, `targetStdDev` 24 → 34, a darker rim (`0.34`), and a steeper rail band ramp.
- **Buffer stops** required a dedicated `capCurve()` because the shared stub curve caps arc length
  at the cell centre, which had been silently painting only the near half of every end cap since
  the original merge. The cap is a pre-pass that wins over rail — a buffer stop's beam sits
  _across_ the rails — implemented via an empty-curve-list substitution rather than an early
  `break`, so T-junction and cross frames keep their existing multi-curve override behaviour.
- **Rivet collars now wrap the bore.** They previously rendered as two tabs stuck to the pipe
  silhouette because rail was classified first. For round profiles only, the collar now wins over
  the body and keeps the cylinder cross-coordinate. Track sleepers still pass _under_ their rails,
  which is correct.
- **Props are cut by connected component, not by grid cell.** The generator does not respect
  notional cell boundaries and adds contact shadows that key as foreground, so rigid slicing
  truncated overhanging objects and let shadow crumbs blow out bounding boxes. Components are
  labelled on the _un-eroded_ mask (eroding first severs thin structures), then each component is
  eroded individually.

### Deviation from the reviewed plan

The plan called for a `variants` schema field with a 48-frame pipe atlas and a variant picker.
This was **not** built. A single wear overlay — a generated corrosion material thresholded into a
multiplicative darkening of the pipe bore — delivers the requested rust and cracking at a fraction
of the risk: no schema change, no 3x atlas, no variant-sweep guard extension. It preserves the
join contract for free because it is sampled through the same `sampleTile` edge lock, so every
frame's stub band receives an identical overlay. If genuine per-tile variation is wanted later,
the `variants` design remains valid.
