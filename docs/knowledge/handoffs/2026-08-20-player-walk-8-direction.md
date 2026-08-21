# 2026-08-20 - Player walk 8-direction support

## Systems touched

rendering, sprite-pipeline

## Apples

3🍎 estimated / 3🍎 actual

## What changed

- Extended the shared generated-animation manifest contract with optional
  eight-direction clip ranges.
- Registered one Phaser walk animation per compass direction and quantized
  player velocity to the nearest direction at runtime. Legacy single-row strips
  keep the existing `:walk` key and behavior.
- Added directional animation regression tests and updated the art-wiring guard.
- Marked the current male walk strip as a temporary directional placeholder by
  mapping all eight clips to its existing south-facing frames.
- Added `player-walk-cycle-male-south-baseline.yaml` and
  `player-walk-8-direction-process.md`. The baseline brief locks identity,
  proportions, palette, floor line, and pivot before the other seven views are
  generated.

## Verification

- `npm run typecheck`
- `npx vitest run --project unit tests/unit/generated-asset-animations.test.ts tests/unit/generated-asset-registry.test.ts tests/unit/entity-sprite-mapping-art-wiring.test.ts`
- `bash scripts/agent/verify-fast.sh`
- Loaded the new baseline brief through `scripts/sprites/load-brief.ts`; defaults
  and palette resolved successfully.

## Follow-up

Run the baseline brief through the sprite generation/approval flow, then use its
approved frame 0 as the seed reference for the remaining seven directions.
