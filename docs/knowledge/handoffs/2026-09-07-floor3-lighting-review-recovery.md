# Session Handoff: Floor 3 lighting review recovery

## Date

2026-09-07

## Persona

QA Engineer

## Systems touched

lighting

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

Recovered PR #4433 from two review blockers. `floorConfigSchema` now accepts
the manifest-supported `lighting.sourceIntensity` override, and the contract
test exercises that strict schema path directly. The Floor 3 real-scene e2e
test now captures a no-torch dark control and the shipped daylight/no-torch
scene, then asserts the rendered outdoor terrain remains visibly bright.
Follow-up CI recovery renamed the FloorConfig derivation helpers to
underscore-prefixed test exports so `check:test-only-exports` accepts the direct
schema contract test.

## Files touched

- `src/shared/floor-config.ts`
- `tests/unit/floor1-config.test.ts`
- `tests/e2e/lighting-defaults.test.ts`

## Validation

- `npm run test:unit -- tests/unit/floor1-config.test.ts tests/unit/floor-manifests-lighting.test.ts`
- `npm run test:e2e -- tests/e2e/lighting-defaults.test.ts`
- `npm run check:test-only-exports`
- `npm run verify:fast`

## Follow-up

None.
