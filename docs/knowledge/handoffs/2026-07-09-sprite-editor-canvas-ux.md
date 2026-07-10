# 2026-07-09 - Sprite editor canvas UX upgrades

## Systems touched

sprite-workflow, mcp-tooling

## Summary

- Added a local-only `sprite-editor` canvas extension for checked-in sprites under `.github/extensions/sprite-editor/`.
- Implemented editor UX upgrades requested in-session: undo/redo, collapsed-variant counts, prev/next variant navigation, standalone eyedropper tool, and right-click context menus.
- Hardened interaction flows after review feedback: dirty-state leave guards, async load/save/revert token guards, selection consistency when collapsed by variant group, and preservation of unsaved form draft values across rerenders.
- Fixed backend cache-invalidation safety around save/revert so failed writes cannot leave stale mutated in-memory cache state.

## Files touched

- `.github/extensions/sprite-editor/extension.mjs`
- `.github/extensions/sprite-editor/renderer.mjs`
- `.github/extensions/sprite-editor/lib/canvas-harness.mjs`
- `.github/extensions/sprite-editor/lib/image-cache.mjs`
- `docs/knowledge/review-ledgers/2026-07-09-sprite-editor-canvas.review-ledger.json`

## Verification run

- `npm run verify:fast`
- `npm run verify`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-09-sprite-editor-canvas.review-ledger.json`

## Unresolved issues

- None noted in this scope.

## Recommended next steps

- Do a focused UX pass in the live canvas for micro-polish (copy/tone/spacing) without changing behavior contracts.
