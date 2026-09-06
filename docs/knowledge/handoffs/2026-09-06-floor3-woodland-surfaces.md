# Handoff: Floor 3 woodland surfaces

## Date

2026-09-06

## Persona

Producer

## Systems touched

sprite-pipeline, mapgen, lighting

## Apples

Estimated 3🍎, actual 3🍎.

## What Was Done

- Added dedicated woodland floor variants to the deterministic companion-overworld
  terrain builder and regenerated the committed Floor 3 assets/manifest.
- Added a committed-art guard requiring both woodland variants to remain
  green-dominant, plus a real-scene guard requiring the Floor 3 bake to stamp
  woodland sources.
- Preserved the existing grass/dirt weighting, bright lighting, studio/set-piece
  separation, and canonical blob47 wall geometry.

## Validation

- `npm run terrain-packs:validate`
- `npm run test:sprites -- tests/unit/sprites/terrain-pack-companion-overworld-committed.test.ts`
- `npm run test:unit -- tests/unit/floor-manifests-lighting.test.ts tests/unit/floor3-overworld.test.ts`
- `npm run test:e2e -- tests/e2e/terrain-generated-tiles.test.ts`
- `bash scripts/agent/verify-fast.sh`
- Before the fix, the real Floor 3 probe covered the companion-overworld pack
  but had no forest-specific source contract. After the fix, it stamped both
  dedicated woodland variants and passed the bright outdoor render gate.
