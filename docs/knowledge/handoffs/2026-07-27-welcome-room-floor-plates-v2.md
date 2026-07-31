# Handoff — welcome-room floor plates v2 (full-bleed rework)

Date: 2026-07-27 · Agent: Asset Forge (Graphics Designer persona) · Apples: 3🍎

## What shipped

PR **#2124** (art-only, open, not draft) — 3 of 4 v2 floor crops, plus the four v2
briefs. v1 plates left untouched in the catalog per the maintainer's "all art is
useful art until rejected outright" rule.

| brief id                                | run dir                        | worst edge delta                | verdict                    |
| --------------------------------------- | ------------------------------ | ------------------------------- | -------------------------- |
| `welcome-room-floor-plate-clean-v2`     | `2026-07-27T16-41-40-4506cad3` | **9.1%**                        | approved                   |
| `welcome-room-floor-plate-scuffed-v2`   | `2026-07-27T18-58-24-b893bd24` | **8.7%**                        | approved                   |
| `welcome-room-floor-plate-cable-run-v2` | `2026-07-27T18-50-22-91760a5d` | **9.2%**                        | approved                   |
| `welcome-room-floor-plate-tape-mark-v2` | —                              | best **19.8%** over 48 attempts | **ESCALATED, not shipped** |

All three approved plates measure drawn box **256×256 at (0,0), 100% opaque** =
a truthful **4 ft × 4 ft** at the project's 64 px/ft tile scale.

Cable geometry measured on the shipped pixels: enters mid-left at y=133, exits
mid-right at y=138 (ideal 128). 5 px disagreement between the two sides — two
copies placed side by side join with a ~2% kink.

## The v1 failure had TWO independent causes

1. **Sheet gutter × slicer.** On the default 4×4 sheet the model draws near-black
   separator gutters between cells. `scripts/sprites/slice-sheet.ts` cuts at the
   _centre_ of each detected background band, so ~7 px of gutter is baked into
   every sliced cell on all four sides. Tell: all 16 variants failed _identically_
   at exactly luma 25.0. Art does not fail that uniformly.
2. **Model lighting prior.** With no gutter at all, the model still shades the
   image like a photograph, darkening the outer ~20 px. This is a _lighting_
   defect, not a drawn border, and prose banning "border / frame / rim" does not
   touch it. v1 already contained such a ban and got a frame anyway.

## The lever that actually worked

Measured, in order:

- crop reframe prose alone (4×4 sheet): 0/16 pass, still ~74.5%
- **`generation.sheet: {rows:1, cols:1, nativeCanvas:1024}`**: 74.5% → ~30%
- **"THE LIGHTING IS PERFECTLY FLAT AND PERFECTLY EVEN" block**: ~30% → first
  passes, roughly 1-in-3 yield

So it is the **pair**: the 1×1 sheet removes the pipeline-baked gutter, the
flat-lighting clause removes the model's photographic vignette. Neither alone is
sufficient. Draw-order and flatbed-scanner-metaphor levers produced no measurable
improvement. 1024→256 is exact 4:1 nearest-neighbour decimation, so nothing is
softened and no post-crop-and-rescale was performed.

## Things worth not relearning

- **Magenta chroma gutters are actively harmful for `type: tile`.** That pipeline
  (`transparent-trim → resize-nearest → speckle-cleanup → palette-quantize →
alpha-threshold → trim-and-fit`) has **no background-removal module**, so a
  magenta gutter is not keyed out — it is quantized to the nearest palette step.
  That is exactly why v1 `scuffed` (the only brief demanding one) shipped a _pale_
  rim at luma 136 = palette entry `[132,136,142]` while its siblings shipped
  near-black rims at luma 25 = `[24,25,28]`.
- **A family check that samples only interiors cannot see an edge-family
  failure.** v1's "FAMILY LOCK" luma spread was measured on interiors and passed
  while the edges were wildly incoherent (one pale rim, three dark rims).
- **Passing the edge gate is necessary but not sufficient.** Two candidates passed
  while being unusable: a warm-confetti field at 7.9%, and a cable-run with _no
  cable_ at 0.4%. Every pass still needs the eyeball + brief-match check.
- **The recurring art failure for this family is warm tan confetti** — an even
  all-over scatter of ochre specks. The "BROAD AND SOFT, NOT CONFETTI" block
  reduces but does not eliminate it; still roughly 1 in 2 passers.
- `scripts/sprites/cli.ts` does not load `.env.local`; every shell invocation must
  parse it into the process env first.
- Provenance note: the approved `clean-v2` pixels predate the draw-order clause
  later added to that brief. Every later `clean-v2` run that passed the edge gate
  failed the palette eyeball, so the better art was shipped and the mismatch is
  recorded here rather than hidden.

## tape-mark-v2 — open, escalated

48 attempts across five lever families (fraction-based sizing, draw-order,
anti-spotlight + edge-severed arm, flatbed-scanner metaphor, and finally a
near-verbatim clone of the cable-run brief body with only the subject swapped).
Never below **19.8%** against a <10% bar. Failure mode is consistent and visible:
the model renders the mark as a **spotlit composition** — bright centre behind the
tape, corners sunk into darkness. It is lighting a hero subject. Its sibling
`cable-run-v2`, which has an equally loud subject, passes routinely, so the
difference is not "there is a subject" — it appears to be that a _compact,
centred, saturated_ mark invites a vignette in a way a _linear_ subject crossing
the frame does not.

Untried next levers, in the order I would try them: (a) make the tape mark
linear and edge-to-edge like the cable, i.e. a long strip crossing the whole
crop rather than an L in one quadrant; (b) generate it as a `clean` plate and
composite the mark separately; (c) accept it as a non-tiling one-off accent.

## Tooling added (not in the art PR)

`scripts/agent/art/edge-frame-check.mjs` — implements the maintainer's exact
criterion (interior = rows/cols 24…N-25, outer 6 rows/cols per side, threshold
0.10) and exits 1 on failure. Left out of the art-only PR deliberately; the
maintainer is closing the same gap in `scripts/sprites/check-tile-seams.ts`,
whose docstring currently declares seam/border continuity out of scope.

## Systems touched

- `briefs/tiles/` — four new v2 briefs (content only, no schema change)
- `public/assets/generated/` + `manifest.json` — three new PNGs
- `src/shared/data/sprite-catalog.json` — three new catalog entries
- `scripts/agent/art/` — new local checker, uncommitted
- **No engine or gameplay code touched. Nothing wired — placement is the
  maintainer's.**
