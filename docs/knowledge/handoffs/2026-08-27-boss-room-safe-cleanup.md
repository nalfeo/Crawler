# Session Handoff: Boss Room Safe Cleanup

## Date

2026-08-27

## Persona

Game Designer

## Systems touched

boss-rooms

## Apples

2🍎 estimated, 2🍎 actual (exact). A localized Floor 1 lifecycle cleanup and regression test.

## Summary

When a Floor 1 boss room becomes safe, living non-spawner enemies whose centers are
inside that room now emit the existing `corpseExplode` event and are immediately
removed. Direct removal bypasses the drop system, so the cleanup cannot award XP or
leave loot in the new safe room. The defeated boss remains excluded by its
`DeathTimer`, preserving its existing death animation and reward handling.

## Real pipeline observation

The supplied pre-fix run bundle could not be fetched in this sandbox because Azure
blob DNS was unavailable. The issue report identifies the prior behavior: enemies
could remain trapped in a boss room after it became safe.

Post-fix behavior was observed deterministically through the real shared headless
pipeline, `src/game/ai/simulation-step.ts::runSimulationStep`, with the canonical
Floor 1 system slots from `createFloor1MainSceneOptions`. The regression starts a
Slime Rat encounter, transitions it to defeated, and confirms that an in-room enemy
is removed with a `corpseExplode` event and zero `XpGem` entities, while an
out-of-room enemy remains.

## Files touched

- `src/game/floorScenario.ts`
- `tests/game/floor1-boss-defeat-drops.test.ts`

## Verification

- Focused Floor 1 boss-defeat regression: 4/4 passed.
- `npm run verify:fast`: 144 files / 2,368 tests passed.

## Follow-up

None.
