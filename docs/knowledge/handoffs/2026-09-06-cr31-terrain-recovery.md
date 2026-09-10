# cr31 terrain-pack recovery

## Verdict

Recommended. The review blockers identified real atlas-slot and edge-Wang
regressions from the first cr31 migration pass, and the repair keeps blob47 mask
IDs canonical without preserving a legacy conversion API.

## Apple estimate

2 apples.

## Changes

- Converted wall-autotile manifest mask IDs in place so each existing frame index
  keeps its prior PNG slot while using cr31 IDs.
- Restored the wall/accent PNG bytes that were changed by the sorted-slot rebuild.
- Split compact edge-Wang bits from blob47 cr31 bits so linework masks remain
  valid 16-frame atlas indices.
- Removed the legacy mask conversion exports and the migration-only test.
- Taught terrain-pack recomposition helpers to preserve explicit manifest
  mask/frame assignments.

## Validation

- `npm run terrain-packs:validate -- --quiet`
- `npx vitest run tests/unit/terrain-pack-mask.test.ts tests/unit/terrain-linework-placement.test.ts tests/unit/sprites/terrain-pack-build.test.ts tests/unit/sprites/terrain-pack-committed.test.ts tests/unit/sprites/terrain-pack-corners.test.ts --reporter=dot`
- `npx vitest run tests/unit/sprites/terrain-pack-floor1-committed.test.ts --reporter=dot`
- `npm run format:check`
- `npm run test:sprites`
- `npm run verify:fast`
- `npx vitest run --project e2e tests/e2e/floor2-terrain-variance.test.ts --reporter=dot`

## Systems touched

sprite-pipeline, mapgen
