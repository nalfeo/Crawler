# AI boss-chest class-retention recovery

## Date

2026-08-18

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

4 apples estimated, 4 apples actual. This recovery completed the review coverage for the
static-equipment evaluator and fixed the generated-occupant class-retention regression.

## Summary

- Rebuilt the committed weapon-class map from currently equipped generated weapon snapshots
  as well as modelled static weapons, so maintenance cannot cross classes after a valid
  starter-to-generated upgrade.
- Added deterministic evaluator coverage for static score/displacement behavior and malformed
  baselines; added generated-weapon persona fallback coverage.
- Added an eager-maintenance two-step regression: equip a same-class generated pistol, then
  reject a later cross-class fireball while retaining the pistol.
- Gated generated Floor 1 equipment on the equipment feature unlock and deferred boss-chest
  maintenance until the shopkeeper charm has been bought and equipped.
- Made the shopkeeper stage recognize only the charm, avoiding false progress from a displaced
  starter weapon in the bag.

## Validation

- `npx vitest run tests/ecs/equipment.test.ts tests/game/equipment-loadout-evaluator.test.ts tests/game/settlement-maintenance-planner.test.ts tests/unit/weapon-personas.test.ts tests/headless/floor1-boss-chest-equip.test.ts` — 125 passed.
- `npm run typecheck` — passed.
- `npm run verify:fast` — passed (1796 tests).
- `npx vitest run tests/headless/floor1-completion.test.ts` — passed (25-seed gate).

## CI / review

- PR #3040 was closed as superseded after its substantive implementation and tests were
  ported to a fresh branch.
- The retained-class defect explains the cross-class follow-up swap path, while the progression
  gate fixes the shopkeeper deadlock that previously prevented the staircase boss from starting.
- The review ledger records the completed 4-apple review stages for the retained implementation.
