# Remove fixed-grid frameSequence slicer — ONE way to slice

## Systems touched

sprite-pipeline, generated-assets

## Summary

Removed the `sliceSheetFixedGrid` fixed-grid slicing path that was used exclusively for
`frameSequence`-enabled briefs, consolidating the pipeline to a single content-aware
slicing path (`computeSliceMap` / `sliceWithMap`) for all brief types.

The fixed-grid cutter was the root cause of ghost-bleed defects in walk-cycle sheets:
it made pixel-precise cuts at rigid `width / cols` boundaries regardless of where the
model actually drew content, so when a pose extended slightly past its nominal cell
boundary the cut split the bleed across two adjacent output frames. None of the
per-frame sensors caught this because boundary bleed isn't a fully enclosed region
and doesn't violate bbox/ratio/palette checks in isolation. The content-aware slicer
fails loud (returns a different `variantCount` than expected) when the model omits
the required gutter, surfacing the defect rather than silently shipping bled frames.

## What changed

### `scripts/sprites/slice-sheet.ts`
- **Deleted** `sliceSheetFixedGrid` (was `function sliceSheetFixedGrid`).
- **Updated** `sliceSheetFromBrief`: removed the `brief.frameSequence?.enabled` branch that
  routed to fixed-grid slicing; now always calls `sliceWithMap` (content-aware), same as
  every other brief type.
- **Updated** `sliceSheetWithGrid`: removed the `options: { readonly fixedGrid?: boolean }`
  parameter; always uses content-aware slicing. Callers no longer need to thread a
  per-brief flag through to the rerun path.

### `scripts/sprites/rerun.ts`
- Removed `fixedGrid: brief.frameSequence?.enabled === true` from the `sliceSheetWithGrid`
  call. Re-slicing a stored frameSequence run now uses the same gutter-aware path as any
  other rerun. Old frameSequence runs generated with the fixed-grid cutter (1×4 layout,
  no gutters) will produce a `variant-count-mismatch` RerunError on rerun — this is the
  correct failure mode; those runs must be regenerated with the new gutter-based brief.

### `scripts/sprites/brief-schema.ts`
- Updated frameSequence cross-validation: replaced `rows === 1` and `cols === frameCount`
  constraints with `rows * cols === frameCount`. Any rectangular layout (1×N, 2×2, 2×3,
  etc.) is now valid, provided all cells together equal `frameCount`. The content-aware
  slicer reads cells in row-major order, which maps naturally to animation frame order.

### `briefs/characters/player-walk-cycle.yaml`
- Migrated from `rows: 1, cols: 4` to `rows: 2, cols: 2` with `nativeCanvas: 1024`.
  This yields 512×512 cells (a more natural near-square aspect for a standing biped vs
  the old 256×1024 tall cells).
- Updated the frameSequence comment to explain the 2×2 layout and reading order.
- The standard `sheetConstraintsBlock` in `build-prompt.ts` already emits "a clean
  vertical background channel separates every column" for character briefs, so no
  prompt changes were needed — the gutter instruction is inherited from the type.

### Tests
- `tests/unit/sprites/slice-sheet.test.ts`: replaced `describe('sliceSheetFromBrief:
  frameSequence bypasses gutter detection', ...)` with a new block demonstrating that
  (a) a properly guttered frameSequence sheet slices cleanly via content-aware detection,
  (b) a gutter-free sheet collapses to 1 cell (quality gate — model must leave gutters),
  and (c) frameSequence and non-frameSequence briefs produce identical results on a
  guttered sheet.
- `tests/unit/sprites/brief-schema.test.ts`: updated to match new schema:
  - Replaced the "rejects rows !== 1" test with an "accepts multi-row grid" test.
  - Updated the mismatch test to check for the new `rows × cols === frameSequence.frameCount`
    error message.

## Not changed

- `postprocess.ts` `frameSequenceDisabledModules` and `computeFrameSequenceUnionCropRect`:
  both operate on already-sliced per-frame buffers and have no dependency on how the sheet
  was sliced. Verified no implicit single-row assumptions.
- `build-prompt.ts` `walkCycleSequenceLine`: the "read left-to-right" framing in the prompt
  remains useful for a 1×N layout and doesn't break a 2×2 layout because row-major order
  on a 2×2 is: top-left → top-right → bottom-left → bottom-right — a natural stride cycle.
  The existing `sheetConstraintsBlock` already requires visible background gutters for
  character-type briefs.

## Follow-ons

- The `player-walk-cycle.yaml` brief has NOT been regenerated as part of this PR. The brief
  IS wired to the player render kind via `src/shared/data/entity-sprite-mappings.json` (the
  `"player"` renderKind pins `briefId: "player-walk-cycle"`), and an approved asset from the
  old 1×4 layout exists at `public/assets/generated/entries/player-walk-cycle.json`
  (approved 2026-07-29T04:04:48). That asset is incompatible with the new 2×2 layout and
  must be regenerated through the pipeline (provider + content-aware slicer) so the four
  clean frames can be confirmed and a new approved entry committed.

## Apple estimate

2🍎 — mechanical routing change + brief migration + test updates. No new systems, no
runtime pipeline wiring changes.
