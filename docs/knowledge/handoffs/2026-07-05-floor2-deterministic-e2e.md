# Floor 2 Deterministic E2E

## Date

2026-07-05

## Persona

Producer

## Systems touched

hud-ux, mapgen

## Apples

3🍎 estimated, 3🍎 actual (exact)

## What Was Done

Added deterministic E2E coverage for the Floor 2 HUD relationships widget and minimap territory tint. The lab now builds a synthetic Floor 2 `FloorMap`, spawns a player, reveals the map, and waits for the first HUD sync before the probe reports ready. The E2E suite now checks both the family panel repaint path and a territory marker tint/grayscale transition driven by boss-defeat state. Also extended the Floor 2 cave-map integration timeout to match the actual runtime cost of the full-size sweep.

Observed in `npm run test:e2e -- tests/e2e/hud-family-relationships.deterministic.test.ts` — before: the lab could not exercise the minimap territory path because it had no `floorMap`; after: the new real-HUD territory tint assertions pass deterministically.

## Key Decisions Made

- Kept the test anchored to existing pixel/probe helpers instead of introducing new harness code.
- Used a synthetic Floor 2 lab map rather than altering production minimap rendering.
- Derived the expected territory colors from shared family data and tint helpers instead of hardcoding magic values.

## What's Next / Blockers

No blockers. The branch still needs PR creation and auto-merge arming.

## Retrospective

### Lessons Learned

- The relationships widget lab is not enough by itself for minimap coverage; the HUD path needs a real `world.floorMap`.
- First-frame readiness is more reliable when the probe waits for an actual HUD sync instead of scene creation alone.

### Mistakes Made

- Initially the lab scaffolding omitted a map, which made the minimap path unreachable.

### Opportunities for Future Improvement

- Add a reusable Floor 2 synthetic-map helper for HUD labs so future territory/minimap tests do not need to duplicate the same setup.
