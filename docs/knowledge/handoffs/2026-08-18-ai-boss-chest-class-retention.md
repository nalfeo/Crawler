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

## Validation

- `npx vitest run tests/game/equipment-loadout-evaluator.test.ts tests/game/settlement-maintenance-planner.test.ts tests/unit/weapon-personas.test.ts` — 68 passed.
- `npm run typecheck` — passed.
- `npm run verify:fast` — passed (139 files, 2295 tests).
- `npm run scope` confirms sim-touched changes; the pre-existing 25-seed CI gate is left to
  GitHub rather than running a broad local sweep.

## CI / review

- Run 32072746735’s `ci` and `Merge gate` failed downstream because `Lightweight Checks` was
  cancelled; the actionable Floor 1 gate reported a 76% win rate.
- The retained-class defect explains the cross-class follow-up swap path. The repaired
  two-step eager-maintenance test proves that path locally; CI must re-run the broader gate.
- Review feedback was addressed with targeted tests. The review ledger records the completed
  4-apple review stages.
