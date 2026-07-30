# Handoff — welcome-room aspect-true prop wave (Asset Forge)

**Date:** 2026-07-25
**Agent:** Asset Forge (Graphics Designer persona)
**Scope:** Generate a second wave of Floor 1 `welcome-room` set-piece props under a
new **canvas-aspect-is-object-proportion** constraint, judge, approve and check in.
Wiring was explicitly OUT of scope — the parent session owns `set-pieces.json`.

## Apple estimate

**2 🍎.** Pure art: brief → generate → judge → approve → check-in. No engine or
gameplay code was touched, so this is review-ledger-exempt (art-only fast lane).
No PR was opened, per the parent's instruction.

## Systems touched

- `briefs/props/` — nine new prop briefs (see below).
- `data/palettes/welcome-room-tape.json` — new neutral-only palette.
- `public/assets/generated/` + `public/assets/generated/manifest.json` — six new sprites.
- `src/shared/data/sprite-catalog.json` — written by `sprites:approve` (six entries).
- **NOT touched:** `src/shared/data/set-pieces.json`, `PhaserBridge.ts`, any engine code.

## The new constraint

`PhaserBridge` is now **height-authoritative** for upright set-piece props: it
scales by `heightFt / nativeHeightPx` and the rendered WIDTH follows the PNG
canvas's own aspect. It no longer contain-fits. So **the PNG canvas aspect ratio
IS the object's real-world proportions**. A wall torch drawn on a square 64×64
canvas and declared 5.6 ft tall rendered 5.6 ft WIDE.

## Landed

| Bare sprite id                      | Canvas | Aspect | Notes                                        |
| ----------------------------------- | ------ | ------ | -------------------------------------------- |
| `welcome-room-wall-banner-var-6`    | 144×76 | 1.89:1 | requested 2.4:1 — pipeline-capped, see below |
| `welcome-room-floor-path-var-5`     | 64×64  | 1:1    | directional worn stipple track, 6.7% fill    |
| `welcome-room-call-sheet-var-3`     | 48×64  | 0.75:1 | exactly as requested                         |
| `welcome-room-merchant-board-var-6` | 54×64  | 0.84:1 | as requested (0.83:1)                        |
| `welcome-room-exit-sign-var-0`      | 96×69  | 1.39:1 | requested 2.2:1; brackets + drip add height  |
| `welcome-room-chair-turned-var-0`   | 52×64  | 0.81:1 | requested 0.63:1; see letterbox note         |

Checked in on branch `assets/checkin-20260725-215546-058fb5`, tracking issue #2056.
No PR opened.

## Not landed

- **`welcome-room-floor-tape-line`** — 3 rounds. Every round produced a solid
  rectangle with a hard dark contour, reading as an orange wooden plank. Fixing
  the palette (see below) made it grey but featureless; fixing the geometry made
  it narrower but still outlined. This remains the same unsolved defect as the
  original `welcome-room-floor-tape`.
- **`welcome-room-tally-wall`** — 3 rounds. Round 1 produced solid wooden plaques;
  the negative-space rewrite killed the plaque but the model then drew ONE giant
  group of five instead of the required six-plus small crowded groups. Judge
  `brief_match` 1/5 in the final round, correctly.
- **`welcome-room-dented-weapon`** — 2 rounds. Round 2's maces/swords are visually
  good and vertical, but the judge hard-blocked every variant on proportions and
  design language ("too short and wide", "not convincingly obsolete").

No gate was loosened to land anything; the three above were left unlanded rather
than forced through.

## Lessons (extends `2026-07-25-welcome-room-floor-decals.md`)

1. **Canvas aspect is capped by the 1024 sheet.** `azure-openai.ts` sends
   `size = ${n}x${n}` verbatim and gpt-image-1 only accepts 1024x1024 /
   1536x1024 / 1024x1536, so `nativeCanvas` must stay 1024. `sizeVariant: wide`
   reshapes the grid to 4 rows × 2 cols = 512×256 cells (**2:1**). A 2.4:1 cell
   is therefore unreachable, which is why the banner tops out near 1.9:1. Prompt
   wording cannot beat cell geometry.
2. **Prefer an axis-locking declared size over `fit`.** `resizeSpriteStrategy()`
   returns `'fit'` for moderate aspects, which letterboxes the subject into an
   exact frame — under a height-authoritative renderer that padding makes the
   prop render SHORT, and it also trips `anchor-derivable` ("no opaque pixel in
   bottom 8 rows"). Declaring `h >= 2w` (or `w >= 2h`) switches to `'height'` /
   `'width'`, which locks one axis and lets the other follow the DRAWN subject —
   **aspect-true by construction**. Fixing `welcome-room-chair-turned` was purely
   a matter of declaring 30×64 instead of 40×64.
3. **A neutral-only palette is the only reliable way to hold a decal's identity.**
   Quantization snaps to the _nearest_ entry, so a hybrid ramp containing both
   carpet-orange and taupe pulls warm-painted art back to orange. Removing the
   unwanted hue entirely _tightens_ the gate (palette-membership stays active)
   rather than loosening it. `data/palettes/welcome-room-tape.json` is
   neutral-only for exactly this reason — and it did work, the tape came out grey.
4. **The model's default is "filled shape with a house-style dark contour".**
   That single habit produced the plank (tape), the plaque (tally) and the solid
   patch (floor-path round 1). The only thing that reliably beat it was the
   floor-path recipe: reframe as _disconnected speckle_ ("do not draw a shape,
   draw scattered grain", "no solid run > 3px") AND tighten `opaqueRatio.max`
   hard so a solid shape is mechanically rejected. Prose alone never won.
5. **The VLM judge is not a substitute for eyeballing, and eyeballing is not a
   substitute for the judge.** Floor-path round 1 scored 4/4/5/4 on a sheet of
   solid orange rectangles (judge missed it); merchant-board and exit-sign both
   passed the eye but failed a real sensor (anchor / dimensions) that mattered.
6. **The content-aware slicer can merge cells.** Exit-sign round 1 sliced a whole
   column as one sprite and shipped a 96×124 PNG containing TWO stacked signs —
   it passed all seven sensors and scored 5/5/5/5. It was caught only by measuring
   the shipped PNG's dimensions against the intended aspect. **Always measure the
   processed PNG, not just the sheet.** It was unapproved and regenerated.

## Disclosures for the wiring session

- **Banner** ships at 144×76 (1.89:1), not the requested 2.4:1. Pick `heightFt`
  accordingly: at `heightFt: 2.5` it renders ~4.7 ft wide, not 6 ft. To get the
  intended ~6 ft width, use `heightFt` ≈ 3.2.
- **Banner silhouette fill is ~59%** of the canvas, below the stated ~75% floor —
  but its bounding box spans 100% of the canvas. A sagging banner is genuinely
  concave; this is not the "small object floating in a big canvas" defect.
- **Exit sign** ships at 96×69 (1.39:1) because the mounting lugs above and the
  grime drip below are part of the silhouette. At `heightFt: 0.9` it renders only
  ~1.25 ft wide; `heightFt` ≈ 1.4 gives roughly the intended 2 ft body width.
- **Chair** ships at 52×64 (0.81:1) rather than 0.63:1 — the model would not draw
  a chair that narrow. It is aspect-true to what was drawn and fills the full
  canvas height, so `heightFt: 3.2` renders a 2.6 ft-wide chair.
