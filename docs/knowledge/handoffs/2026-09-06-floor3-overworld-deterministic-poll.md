# Handoff: Floor 3 overworld deterministic render polling

## Date

2026-09-06

## Verdict

Recommended. The review fix removes wall-clock dependence from the real-scene
terrain guard without changing its observation contract.

## Persona

Producer

## Systems touched

testing, lighting, sprite-pipeline

## Apples

Estimated 3🍎, actual 3🍎.

## What Was Done

- Replaced all `Date.now()` deadline polling in the terrain render guard with a
  bounded 50-attempt polling helper.
- Preserved the existing Floor 1, Floor 2, and Floor 3 terrain observations,
  including the woodland-source and bright-outdoor assertions.

## Review Finding Addressed

The review identified wall-clock polling in
`tests/e2e/terrain-generated-tiles.test.ts`. The helper now has a fixed attempt
bound and remains deterministic under delayed scheduling.

## Observe Before Done

The real `MainGameScene` probe passed all four terrain E2E tests, including
Floor 3 companion-overworld stamping, woodland variants, and the bright outdoor
pixel comparison against Floor 2.

## Validation

- `npm run terrain-packs:validate`
- `npm run test:unit -- tests/unit/floor3-overworld.test.ts tests/unit/floor-manifests-lighting.test.ts tests/unit/sprites/terrain-pack-companion-overworld-committed.test.ts`
- `npm run test:e2e -- tests/e2e/terrain-generated-tiles.test.ts`
- `npm run verify:fast`
