# Handoff: Generic Floor Objective System — 2026-06-14

## Systems touched

quests

## Apple Estimate

- Declared: 🍎🍎 (Small)
- Actual: 🍎🍎
- Verdict: **on-estimate**

## Summary

Refactored `floor1ObjectiveSystem` into a generic `floorObjectiveSystem` so
that future floors don't need their own named system slot.

## What Changed

- `src/core/world.ts` — added `floorObjectiveTick: ((world) => void) | null`
- `src/game/floor1Scenario.ts` — `floor1ObjectiveSystem` → unexported
  `floor1ObjectiveTick`; `initializeFloor1Scenario` registers it on
  `world.floorObjectiveTick`; new exported `floorObjectiveSystem` delegates to it
- `src/game/index.ts` — exports `floorObjectiveSystem` (removed `floor1ObjectiveSystem`)
- `src/main.ts`, `src/labs/floor1-lab/index.ts`, `tests/game/floor1-scenario.test.ts`,
  `src/shared/floor1.ts` — updated to use `floorObjectiveSystem`

## Pattern for Future Floors

```typescript
// In initializeFloor2Scenario:
world.floorObjectiveTick = floor2ObjectiveTick;
```

No changes to `postSystems` in `main.ts` needed.

## Verification

- `npm run verify:fast` — 1161 tests, all pass
