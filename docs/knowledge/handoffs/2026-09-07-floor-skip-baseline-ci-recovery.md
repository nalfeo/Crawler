# Session Handoff: Floor Skip Baseline CI Recovery

## Date

2026-09-07

## Persona

Game Designer

## Systems touched

ai-combat-balance

## Apples

2🍎 estimated, 2🍎 actual.

## Summary

Fixed the Floor 3 AI-runner modal-autonomy E2E regression by matching the
production headless runner's initialization order. The lab now applies an
explicit `startPlayerLevel` before scenario configuration, allowing direct-start
baseline logic to observe the override.

Direct-start baselines now auto-spend only stat points introduced by the
baseline itself. Points supplied by an explicit higher start remain unspent,
preserving the caller's progression override.

## Files touched

- `src/game/scenarios/floorSkipBaseline.ts`
- `src/labs/ai-runner-lab/index.ts`
- `tests/game/floor-skip-baseline.test.ts`
- `tests/unit/ai-runner-lab-floor3-wiring.test.ts`

## Verification

- `npx vitest run tests/unit/ai-runner-lab-floor3-wiring.test.ts tests/game/floor-skip-baseline.test.ts tests/unit/floor3-overworld.test.ts tests/headless/floor3-completion.test.ts tests/headless/floor3-poach-loadout.test.ts`
- `npm run test:e2e -- tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts`
- `npm run verify:fast`

## Unresolved issues

- None known.

## Recommended next steps

- Let CI rerun the full E2E Visual job on the consolidated repair commit.
