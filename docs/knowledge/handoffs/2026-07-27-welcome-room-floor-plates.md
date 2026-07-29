# Welcome-room studio floor plates — bespoke 4-variant tile set

**Date:** 2026-07-27
**Agent:** Asset Forge (Graphics Designer persona)
**Apples:** 2🍎 — pure art (brief + palette + generate + judge + approve + check-in + art-only PR). No engine, gameplay, or wiring code touched, so **review-ledger exempt** (art-only fast lane).
**PR:** #2099 (open, non-draft, art-only), branch `assets/batch-20260727-071345`. Check-in issue #2097.

## Systems touched

- `briefs/tiles/` — four new tile briefs (`welcome-room-floor-plate-{clean,scuffed,tape-mark,cable-run}.yaml`)
- `data/palettes/welcome-room-studio-floor.json` — new 16-step cool-cast ramp
- `public/assets/generated/` — four new 256×256 PNGs
- `public/assets/generated/manifest.json`, `src/shared/data/sprite-catalog.json` — registration (mutated by `sprites:approve`, shipped on the PR branch only; reverted in the working tree)
- **Not touched:** `data/set-pieces.json`, terrain pack config, any renderer. Placement is owned by the parent session.

## What and why

The maintainer rejected the existing Floor 1 floor ("I hate that tile, it is old and bogus"); the visual judge called it "stamped-grid slop". Root cause of the repetition is that Floor 1 has no `terrainPackId` (fixed separately). This wave is the _other_ half: bespoke `kind:'floor'` plates for the `welcome-room` set piece, whose second job is to sell the room's televised-reality-show fiction — the thing the judge flagged as barely visible.

## Measured shipped geometry (from the PNGs, not the briefs)

| sprite id                                  | canvas  | measured drawn box | aspect     | **declare**     |
| ------------------------------------------ | ------- | ------------------ | ---------- | --------------- |
| `welcome-room-floor-plate-clean-var-2`     | 256×256 | **256 × 256 px**   | 1.0000 : 1 | **4 ft × 4 ft** |
| `welcome-room-floor-plate-scuffed-var-6`   | 256×256 | **256 × 256 px**   | 1.0000 : 1 | **4 ft × 4 ft** |
| `welcome-room-floor-plate-tape-mark-var-0` | 256×256 | **256 × 256 px**   | 1.0000 : 1 | **4 ft × 4 ft** |
| `welcome-room-floor-plate-cable-run-var-4` | 256×256 | **256 × 256 px**   | 1.0000 : 1 | **4 ft × 4 ft** |

All four: `alpha0 = 0`, `partialAlpha = 0` (fully opaque full-bleed), centre-of-gravity anchor at exactly `127,127`.

Aspect cannot drift here **by construction**: `resizeSpriteStrategy()` returns `'stretch'` for `type: tile`, and `data/sprite-types/tile.json` sets `trimAndFit: false` + `minDimension: 256`, so the drawn box **is** the canvas. This is why no `sizeVariant` was used — `wide`/`tall` would break the `FEET_PER_TILE = 4` square contract.

Per-sprite colour: clean meanLuma 77.6 / chroma 0.0%; scuffed 77.3 / 0.0%; tape-mark 69.7 / 15.9%; cable-run 72.5 / 3.3%. Family luma spread collapsed from 49% (round 1) to 11% (shipped).

## Deliberate contract decisions (disclosed)

- **`type: tile`, reversing `2026-07-25-welcome-room-floor-decals.md`.** That handoff calls `tile` a trap because its hardcoded prompt blocks ("fill edge-to-edge", "no subject margin") fight a _transparent decal_. These are _opaque full-bleed plates_, so that scaffolding is exactly the requirement. `tile` stands down `opaqueRatio` and sets `edge.allowMainTouch` — a **type contract for full-bleed art, not a relaxed threshold**.
- **`sensors.anchor.mode: center-of-mass`** on all four: a flat plate has no single ground-contact point, so bottom-centre grip is meaningless. Same call as `welcome-room-cable-coil` and `welcome-room-stanchion-pair`.
- `interiorHoles` stayed at 0 and **no other sensor or judge threshold was relaxed.**

## The four levers that actually moved things

1. **`cable-run` went 16.2% yellow** — a field, not an accent. Prose did nothing. The bug was in the ramp: warm tans topping at `[174,158,134]` sat next to a yellow mid `[186,166,44]`, so nearest-colour quantization snapped every warm mid-tone to yellow. **Lever: rebuild the ramp with a cool base cast** so no plate pixel is near yellow in hue, isolating the accents. 16.2% → 3.3%. _Palette quantization is the only working colour lever, but a naive ramp creates colour bugs._
2. **`tape-mark` drew giant clean typographic letterforms** (T/X/Y/+); judge failed 7 of 8 hard. **Lever: re-specify as two separate overlapping physical strips** with ragged blunt ends, wobbling width, kinks, lifted corners, both at loose diagonals — plus an explicit ban on anything that "merely READS as a capital T, X, Y or plus sign."
3. **`scuffed` collapsed to a 1×1 grid twice** — one unusable "variant" per sheet. `slice-sheet.ts` (`chooseAxisCuts`, L575-613) **never invents a cut**; it only uses real detected gutters, and the commanded rows×cols is a soft tiebreak anchor. The model butted the plates together. **Lever: an explicit SHEET LAYOUT paragraph demanding a ≥12 source-px flat bright-magenta gutter between all cells.** 1 variant → 16. Diagnose this class via `summary.json` → `.grid`.
4. **Family incoherence** (four different floors) — **lever: a verbatim-identical FAMILY LOCK paragraph** in all four briefs.

Regeneration count: `clean` 1, `cable-run` 1, `tape-mark` 2, `scuffed` 3.

Also reconfirmed: correct **one axis at a time, in source pixels** ("roughly 120 of the 256 source pixels long"). Restating both axes yields the width and a wrong height.

## Residual defects (accepted, not hidden)

- **`tape-mark` spans ~80% of the plate** vs. the briefed ~50% (15.9% chroma). Accepted because the deliverable demanded it be unmistakable at true game scale and it is. If it dominates in situ, the fix is another one-axis correction, not a palette change.
- **A perimeter keyline persists on `clean`/`scuffed`** despite two rounds of prose banning it. Accepted as a consistent _family_ trait (the brief allows "self-contained plates with a consistent border"), but a solid field of `clean` will still read slightly grid-like.
- **`clean` variant diversity was only 0.051** (near-identical candidates) — acceptable for the deliberately quiet base plate.

## Verification performed

- Judged at true game scale on a dark `[18,16,20]` floor, tiled 3×3 at 24px/tile (safe-room lab) and 16px/tile (`SET_PIECE_TILE_SIZE`, the harsh bar) — not zoomed.
- `npm run check:tile-mattes` — 390 sprites, no magenta matte leaked, 1 non-blocking finding.
- **Observe-before-done:** on the pushed branch, all four PNGs decode at 256×256, are tracked (`git ls-tree` / `git cat-file`), and have both a `manifest.json` entry and a `sprite-catalog.json` entry with the centre-of-gravity anchor at `127,127`. Untracked-but-referenced PNGs have broken this room twice; this was checked against the _remote branch_, not the working tree.

## Follow-ups for whoever picks this up

- **Wiring is not done and is intentionally out of scope** — the parent session owns placing these as `kind:'floor'` props in the `welcome-room` set-piece def. Declare **4 ft × 4 ft** for all four.
- PR #2099 is **not** auto-merge-armed.
- **Sanity-check before merge:** `sprites:checkin` folded 61 queued assets (stale entries from earlier waves this session), so the PR title says "61 approved assets" though only 6 files changed — most were already on main. Worth a glance.
