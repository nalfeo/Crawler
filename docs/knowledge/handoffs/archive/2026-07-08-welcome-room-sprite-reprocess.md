# Handoff: Reprocess welcome-room generated sprites with fixed slicer

**Date:** 2026-07-08  
**Session:** welcome-room-sprite-reprocess (branch `nalfeo-reprocess-welcome-room-sprites`)  
**Apple estimate:** 🍎🍎🍎 | **Actual:** 🍎🍎🍎 | **Verdict:** exact  
**Review ledger:** `docs/knowledge/review-ledgers/2026-07-08-welcome-room-sprite-reprocess.review-ledger.json` (valid 3🍎)

## Systems touched

sprite-pipeline, sprite-workflow, mapgen

## Summary

Added a repeatable, no-regeneration workflow to reprocess all welcome-room set-piece generated sprites with the fixed slicer pipeline, rejudge them, and reapply them through the existing catalog IDs used by the game.

The new command is `npm run sprites:reprocess:welcome-room`. It targets the welcome-room set-piece sprite IDs, resolves each asset's source run from manifest metadata, reruns postprocess with slicer-grid migration support, rejudges, approves, and reports before/after outcomes.

## What changed

- Added `scripts/sprites/reprocess-welcome-room-cli.ts` and wired `package.json` script `sprites:reprocess:welcome-room`.
- Extended `scripts/sprites/rerun.ts` with `allowGridDrift` so legacy run summaries can be salvaged when persisted grid metadata predates the fixed slicer behavior.
- Added integration coverage for grid-drift salvage in `tests/integration/sprites/rerun.test.ts`.
- Updated generated artifacts for the welcome-room set pieces:
  - `public/assets/generated/welcome-room-bookcase-var-0.png`
  - `public/assets/generated/welcome-room-desk-var-0.png`
  - `public/assets/generated/welcome-room-shop-table-var-0.png`
  - `public/assets/generated/welcome-room-velvet-rope-var-2.png`
  - plus related `manifest.json` and `src/shared/data/sprite-catalog.json` entries.
- Produced before/after comparison artifacts under session state:
  - `files/welcome-room-before-after/compare-welcome-room-*.png`

## Verification run

- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-08-welcome-room-sprite-reprocess.review-ledger.json`

## Unresolved issues / tradeoffs

- The command depends on original run artifacts still being available from manifest-linked run paths.
- For this salvage flow, stable sprite IDs are preserved and revalidated, but variant-index-to-visual identity is still tied to the post-slice output shape.

## Recommended next steps

1. Run `npm run sprites:reprocess:welcome-room` in future slicer-fix backfills for welcome-room assets instead of regeneration.
2. If a broader migration is needed later, add durable export of before/after report metadata as a committed artifact for easier audit trails.
