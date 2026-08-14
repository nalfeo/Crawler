# Session Handoff: Planner Deadline PR Recovery

## Date

2026-08-13

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance, ci-policy

## Apples

Estimated 🍎🍎, actual 🍎🍎 (exact).

## What changed

- Preserved safe-room pause credit when resolving the Floor 1 active-time planning deadline.
- Kept the nav-wedge, park-watchdog, and size/weight observation slices on the production planning horizon.
- Made the shared timing constants production-consumed and pinned transitive `nanoid` to 3.3.18 to clear CI blockers.

## Real-pipeline evidence

The production `BehaviorTreeAI` and `runHeadless` bow-21 paired replay still passes after the repair. The nav-wedge regression now retains the production 23,760-frame planning horizon while observing only its 12,000-frame slice.

## Validation

- `tests/unit/floor1-run-budget.test.ts` and `tests/unit/floor1-gate-sample.test.ts`: 7 passed.
- `tests/headless/nav-wedge-repro.test.ts`: 9 passed.
- `tests/headless/floor1-planning-deadline.test.ts`: passed.
- `npm run check:size-coverage`, `npm run check:weight-coverage`, `npm run security:audit`, and `npm run check:test-only-exports`: passed.
- `npm run verify:fast`: 2,257 tests passed.
- Automated code review: clean.
