---
title: Terrain depth validator geometry and isolated CLI evidence
date: 2026-09-06
---

## Systems touched

sprite-pipeline, terrain-packs, mapgen

## Apples

Estimated: 3; actual: 3; verdict: exact.

## Outcome

The deterministic terrain depth gate now requires mask-derived exposed edges to
contain contiguous directional wall-face bands spanning both near and far
depth layers. This rejects varied textures without coherent relief while
preserving the industrial-cave Floor 2 reference. The CLI regression now
captures reported validation issues and specifically asserts
`terrain-pack-lacks-depth` for a runtime pack with its depth assets removed.

## Evidence

- Focused committed terrain-pack tests: 22 passed.
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`
- `npm run terrain-packs:validate` accepts industrial-cave and reports the
  expected depth failures for companion-overworld, floor1-cave, and
  floor1-dungeon.
