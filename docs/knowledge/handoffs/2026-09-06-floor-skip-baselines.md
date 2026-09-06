# Session Handoff: Floor Skip Baselines

## Date

2026-09-06

## Persona

Game Designer

## Systems touched

inventory, weapons, ai-combat-balance

## Apples

2🍎 estimated, 2🍎 actual.

## Verdict

Recommended. Direct floor starts were underpowered because skipped floors could
start the player below the progression, equipment, skill, and ability state that
normal floor completion would have accumulated.

## Summary

Added manifest-driven direct-start baselines for floors 2-6 and routed each
no-carryover scenario start through a shared helper. Carryover snapshots remain
authoritative and are not replaced by the direct-start baseline.

## Files touched

- `src/shared/floor-manifest.ts`
- `src/shared/data/floors/floor2.manifest.json`
- `src/shared/data/floors/floor3.manifest.json`
- `src/shared/data/floors/floor4.manifest.json`
- `src/shared/data/floors/floor5.manifest.json`
- `src/shared/data/floors/floor6.manifest.json`
- `src/game/scenarios/floorSkipBaseline.ts`
- `src/game/floor2Scenario.ts`
- `src/game/floor3Scenario.ts`
- `src/game/floor4Scenario.ts`
- `src/game/floor5Scenario.ts`
- `src/game/floor6Scenario.ts`
- `tests/game/floor-skip-baseline.test.ts`

## Verification

- `npx vitest run tests/game/floor-skip-baseline.test.ts`
- `npm run typecheck`
- `npm run lint:game -- --no-cache tests/game/floor-skip-baseline.test.ts src/game/scenarios/floorSkipBaseline.ts src/game/floor2Scenario.ts src/game/floor3Scenario.ts src/game/floor4Scenario.ts src/game/floor5Scenario.ts src/game/floor6Scenario.ts`
- `npm run ai:headless:tsx -- --floor floor3 --seed 42 --max-frames 1 --max-time-ms 60000`
  - Expected timeout due to the one-frame observation run.
  - Confirmed Floor 3 direct start now reports `Final Level: 8` and `Total XP: 135`
    instead of the previously observed level 0 / XP 0 startup.

## Unresolved issues

- None known.

## Recommended next steps

- If later floor balance targets need tighter tuning, run a Playtester-backed
  direct-start sweep and adjust the manifest baseline values from measured
  evidence.
