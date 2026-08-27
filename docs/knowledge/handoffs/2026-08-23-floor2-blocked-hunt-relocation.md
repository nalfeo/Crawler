# Floor 2 blocked hunt relocation

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

3🍎 estimated / 3🍎 actual → 🎯 Exact.

## Summary

- Persisted blocked family-enemy quarantine until patrol arrival, family transition,
  reset, or the specific enemy's defeat.
- Prevented unrelated same-family kills from making a still-blocked target eligible.
- Added deterministic lifecycle coverage and retained the existing seed 3, seed 107,
  and chained seed 27 headless regressions.
- Completed the required 3-apple review ledger.

## Validation

- `tests/game/behavior-tree-ai.test.ts`: 141/141 passed.
- Floor 2 seed 107, Floor 2 seed 3, and chained seed 27: 6/6 passed.
- `npm run verify:fast`: 144 files / 2368 tests passed.
- `npm run review:ledger -- validate`: passed.
- Code review: clean.
- CodeQL: 0 alerts.

## Real pipeline observation

The deterministic `runHeadless` and `runProgression` regressions observed the real
headless pipeline. Seed 107 and the existing seed 3 completed Floor 2, while chained
seed 27 reached final victory after clearing Floors 1 and 2.
