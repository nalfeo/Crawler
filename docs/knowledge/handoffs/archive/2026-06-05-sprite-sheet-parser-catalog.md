# Handoff: Sprite Sheet Parser & Catalog Preview

**Date:** 2026-06-05
**Branch:** `nalfeo/feat-sprite-sheet-parser-catalog`

## Summary

Added a sprite sheet parser system and live sprite preview to the sprite catalog lab. Users can now visually browse sheet frames, select tiles, and bulk-add them as individual entries to the sprite catalog.

## Files Touched

- `src/labs/sprite-catalog-lab/index.ts` — Major rewrite: added sprite preview rendering, sheet overview, and full sheet parser grid UI
- `src/labs/sprite-catalog-lab/README.md` — Updated documentation with parser workflow
- `tools/vite-plugin-save-tuning.ts` — Added `/__sprite-catalog-add` dev endpoint for bulk entry creation

## Verification

- TypeScript: `tsc --noEmit` passes
- ESLint: passes on all changed files
- Unit tests: all 580 tests pass
- No changes to `src/core/` layer

## Architecture Decisions

- **Catalog-only entries**: Parsed sprites are added only to `sprite-catalog.json`, NOT to `src/engine/sprites/registry.ts`. The catalog is a metadata/discovery layer; promoting to the runtime registry is a separate manual step.
- **Deduplication**: The bulk-add endpoint deduplicates by both ID and `(sheetKey, frame)` pair to prevent accidental duplicates.
- **Generated tag**: All auto-parsed entries are tagged `generated` for easy filtering and cleanup.
- **Stable IDs**: Generated sprite IDs follow `sprite:<sheetKey>.frame.<N>` convention.

## Unresolved Issues

- The lab-gate-check script has a pre-existing bash compatibility issue on Windows (`set -euo pipefail` not recognized). Not related to this change.
- No virtualization for very large sheets (1700+ frames) — works fine but could be optimized with lazy rendering if performance degrades.

## Recommended Next Steps

1. Add a "promote to registry" workflow for selected catalog entries (writes to `registry.ts`)
2. Consider adding batch AI metadata generation for generated sprites
3. Add property-based tests for the bulk-add deduplication logic
