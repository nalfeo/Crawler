# Handoff — FOV/LOS Corner Seam Leak Fix

## Date

2026-07-10

## Systems touched

lighting

## Summary

Fixed corner-seam visibility leakage so both combat LOS and FOV no longer pass diagonally between two orthogonal opaque wall tiles. This prevents seeing/shooting into rooms through missing corner wall pieces.

## Files touched

- `src/core/map/TileMap.ts`
- `src/core/systems/fovSystem.ts`
- `tests/ecs/tilemap.test.ts`
- `tests/ecs/fov-system.test.ts`
- `docs/knowledge/review-ledgers/2026-07-10-fov-los-corner-seams.review-ledger.json`

## What changed

- Added diagonal corner-seam blocking to `TileMap.lineOfSight`: when a LOS step crosses diagonally, LOS now fails if both orthogonally adjacent seam tiles are opaque.
- Added LOS gating inside `fovSystem` callback before marking sub-tiles visible/discovered so FOV respects the same blocked-corner rule.
- Added TileMap regression tests for blocked-corner and one-side-open diagonal LOS.
- Updated FOV regression coverage to pin blocked diagonal seam behavior and doorway occlusion behavior under LOS-gated FOV.

## Verification run

- `npm test -- tests/ecs/tilemap.test.ts tests/ecs/fov-system.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-10-fov-los-corner-seams.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ❌ (before handoff+ledger), expected to pass after this handoff/ledger commit

## Unresolved issues

- None found in the touched scope.

## Recommended next steps

- If future tuning is needed, consider moving LOS seam logic into a shared core helper consumed by both FOV and any future tile-ray features.
