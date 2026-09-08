---
title: Terrain depth validator geometry and CLI regression
date: 2026-09-06
---

## Systems touched

sprite-pipeline, terrain-packs, mapgen

## Apples

Estimated: 3; actual: 3; verdict: exact.

## Outcome

Strengthened `validateTerrainDepthAndPerspective` with per-direction,
mask-derived exposed wall-face coverage. This rejects varied textures that
merely fill the wall silhouette instead of providing directional vertical
face cues. `runValidate` now accepts an optional pack selection for isolated
CLI regression tests, and the committed test uses a temporary industrial-cave
pack with its accents removed to prove the production gate emits the depth
failure.

## Evidence

- Floor 2 industrial-cave remains accepted; Floor 1 and Floor 3 remain rejected.
- `npm test -- --run tests/unit/sprites/terrain-pack-committed.test.ts`
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`
- `npm run terrain-packs:validate` reports `terrain-pack-lacks-depth` for
  companion-overworld, floor1-cave, and floor1-dungeon and accepts
  industrial-cave.
