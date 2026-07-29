# blob47 corner-coverage gate + rounded cave corners

Date: 2026-07-28
Branch: `nalfeo-literate-sniffle`
Apples: 3🍎 estimated / 4🍎 actual

## Systems touched

sprite-pipeline, mapgen

## What prompted this

The maintainer looked at the Wall Atlas canvas and said: "There should only be
2 full tiles and I think I see 12 in our implementation." That was correct, and
measuring it turned up **four** separate defects rather than one.

## The four defects, in causal order

1. **`validateCompatibleBoundaries` was structurally blind to diagonals.**
   It samples only the four cardinal edge bands. Every cell sharing the same
   four cardinal bits has identical edge bands, so a 16-tile cardinal-only
   sheet replicated across all 47 blob47 slots scores a perfect **1.000**.
   Every other defect below lived inside that blind spot — which is why they
   survived two independent art passes.

2. **`quadrant-kit.ts` carved the `concave` notch at the cell CENTRE** instead
   of the outer corner, so mask 15 rendered as a donut.

3. **`build-caeles-fixture.ts` greedily assigned cells to masks**, scored
   against the degenerate gate above. It put a half-floor cell on mask 255 —
   the one cell that MUST be solid. Note the shape of that failure: the greedy
   mapping scored ~0.94 on the broken metric while the provably-correct mapping
   scored 0.383. That is art being bent to fit a gate.

4. **`restyleWallAtlas()` read silhouette alpha VERBATIM from the very
   `wall-atlas.png` it was about to overwrite.** This is the deepest one: a
   wrong silhouette was copied forward on _every_ rebuild and could never be
   repaired by re-running the build, only by hand-editing art. It is precisely
   why the 16-shape defect survived both main's Azure art pass and PR #2164's
   rebuild.

Measured before the fix: shipped `industrial-cave` had **16 fully-solid cells**
and only **16 distinct silhouettes** across 47 slots. Shipped `caeles-fixture`
had 2 solid cells but the **wrong two** (223, 239).

## What landed

**Gate first, then fix behind it.** All three artifacts failed the new gate at
exactly `0.723 = 136/188` before any art changed — the 52 failures equal exactly
the 52 `concave` quadrant instances.

- `src/shared/terrain-pack-mask.ts` — `cornerIsWallFromMask`,
  `cornerCoverageFromMask`. A cell's extreme outer corner is wall iff that
  corner's quadrant state is `full`. 188 samples across 47 masks: 52 wall,
  136 floor.
- `scripts/sprites/terrain-packs/corner-signature.ts` (new) — corner sampling
  and nearest-reference classification.
- `scripts/sprites/terrain-packs/sample-signature.ts` (new) — a shared
  **2-channel** (mean-alpha + mean-luminance) signature. Needed because caeles
  paints walls pure white on transparent, so a luminance-only classifier reads
  wall ≈241.7 against transparent-as-255 and is unseparable. Both the edge and
  corner classifiers now run on this.
- `validate.ts` — `validateCompatibleCorners` plus a **reference-degeneracy
  pre-check**: if mask 255's cell is not meaningfully more wall-like at its
  corners than mask 0's, report that root cause instead of 47 misleading
  per-cell mismatches.
- `validate.ts` — `validateAuthoredSilhouetteExact`. Both sampling gates read
  only the cell _rim_; an interior defect (donut hole, stray erased block, hand
  edit) scores 1.000 on both. For authored packs the silhouette is a pure
  function of the mask set, so it is compared exactly, every pixel. Proven
  load-bearing: a centre-holed atlas passes both perimeter gates and fails this
  one.
- `build-caeles-fixture.ts` — `deriveTemplateCellMasks()` derives the cell→mask
  table **from the artwork itself**, replacing the greedy search.
- `rebuild-shared-base-pools.ts` — `composeCanonicalSilhouetteAtlas()`; alpha is
  now derived from `composeWallCellOutput`, making the rebuild **self-healing**.
- `wall-opacity.ts` (new) — single source of truth for the wall/not-wall alpha
  cut, shared by the rebuild and the validator.

**Rounded cave corners** (maintainer asked for these mid-session):
`CORNER_RADIUS_PX = WALL_INSET_PX = 48` of a 256px source cell. `concave` gets
a quarter-disc bite at the outer corner; `open` gets `roundConvexCorner` at the
inset intersection. `edgeA`/`edgeB`/`full` are **deliberately left square** —
rounding `edgeA`/`edgeB` would pinch every wall-to-wall seam _and_ intrude on
the sampled edge band (its box spans x∈[48,96], overlapping the 38.4px N band
at x∈[64,96]); `full` must meet its diagonal neighbour flush.

## cr31 cross-validation

The maintainer supplied the canonical Wang-blob references. Worth recording
because it is external ground truth, now locked in tests:

- cr31's packing rule, verbatim: _"We can pack the complete tileset into a 6x8
  array with just a single duplicate of the 'solid' tile-255."_ That **is** the
  maintainer's "2 full tiles".
- Re-weighting our art-derived caeles table into cr31's clockwise numbering
  reproduces the **published Caeles minimum-packing layout cell for cell**.
- Our 47 masks are **closed under `index × 4 mod 255`** (cr31's 90°-CW rotation
  identity).
- **Bit-order divergence, deliberate and deferred**: cr31 weights bits as a
  clockwise cycle (`N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128`); ours is
  cardinals-then-diagonals. Both are bijections onto the same 47 shapes, but our
  mask 15 ≠ cr31 tile 15. Adopting cr31 order is a **breaking migration of every
  manifest's `maskId`** and the maintainer explicitly scoped it to a follow-up
  PR + issue.
- The original `cr31.co.uk` host **times out**. Use the mirror at
  `https://www.boristhebrave.com/permanent/24/06/cr31/stagecast/wang/<page>.html`.

## 1 solid tile vs Caeles' 2

Caeles' 48-cell layout duplicates 255, giving 2 solid tiles. Our
`industrial-cave` packing uses 47 assigned frames + 1 spare that is **not**
solid, so it measures **1**. Both are correct-by-construction. The defect was
16, and that is gone.

## Relationship to PR #2164

#2164 was open on the same art when this started. Running the new gate against
its head showed **its committed atlas failed at 0.723 with 16/47 silhouettes and
16 solid tiles** — the identical defect — while its own
`composeWallAtlas(wall-material.png)` produced 47/47 and 1 solid. Its committed
PNG was simply **stale**. The call was to let #2164 land first, then rebase and
regenerate from source rather than merge two art streams. That is what happened.
The rebase then surfaced defect #4 above, and a new `accent-spill` failure class
(its accents were masked to the old 16-shape silhouette), fixed by a self-healing
`processWallAccents()` step.

## Observe before done

Real artifact, not a lab (`npm run dev`, Floor 2, seed 42):

- Network panel confirms the game loads the corrected atlas —
  `GET /assets/terrain-packs/industrial-cave/wall-atlas.png [304]` plus all four
  accents.
- Measured the **served** atlas in-page: 512×384, **1 fully-solid cell**, 324
  anti-aliased pixels.
- 3× zoom capture of the served atlas shows rounded corners on every distinct
  silhouette.
- Before/after on the rounding change: 12,389 px changed.

Negative check on the regression test: with the old verbatim-alpha code
restored, the corrupted-atlas test reports **47,826 alpha mismatches**; 0 under
the fix.

## Gotchas for whoever is next

- **Floor 1 is not on this path.** Floor 1 has no `terrainPackId` (only
  `floor2.manifest.json` does), so it runs the legacy `TILE_SPRITES` path and no
  blob47 code applies. The black regions the maintainer noticed there are
  `TerrainType.VOID` = `0x05060f` falling through the solid-colour fallback at
  `terrain-renderer.ts:293` — a placeholder since the 2026-06-10 tile-render
  work, never a wall-top effect. Filed as follow-up. **Check nothing else keys
  off VOID being visually distinct (minimap, fog-of-war, out-of-bounds reads)
  before re-mapping it.**
- **Accents must stay binary-alpha** (every pixel 0 or 255) — asserted by
  `terrain-pack-committed.test.ts`. That constraint is why the accent clip is a
  hard threshold cut and not `min()` alpha blending. Do not "improve" it into a
  blend.
- **The corruption step in the derived-not-inherited test is load-bearing.**
  Two reviewers proposed deleting it. Without it the test passes even under the
  old broken code, because the on-disk art is now correct and both paths agree.
  It runs against a `mkdtemp` copy, never the committed pack.
- A detached `npm run dev` piped through `Select-Object -First N` gets **killed**
  when the pipeline closes the stream. Launch detached servers with no
  downstream pipe.
- `performance.getEntriesByType('resource')` caps at 250 entries and silently
  hid the asset loads; use the network panel instead. In-page `fetch()` of
  same-origin assets threw `TypeError: Failed to fetch` here — an `Image`
  element + canvas readback works. The game exposes no global Phaser handle.

## Open questions

- Whether `VENDORED_MIN_EDGE_PASS_RATE = 0.85` can be raised — the post-fix
  caeles edge rate was never measured.
- Whether the caeles spare should be cell 37 (current) or cell 13.
- Whether the `concave` r=48 bite is too deep visually (mask 15 reads as a
  plus-sign with big scoops). Single constant, trivial to reduce.

## Follow-ups filed

- Adopt cr31 bit ordering (breaking `maskId` migration).
- `TerrainType.VOID` renders as a hole on the legacy path; re-map to the biome
  wall visual.
