# Intro flow CI timeout recovery

## Systems touched

ci-policy

## Apples

Estimated: 2🍎 — actual: 2🍎.

## Summary

- Diagnosed CI run `33340318461` and confirmed the repository-level failure was in `E2E Visual — Game/UI`.
- Isolated the failing test: `tests/e2e/intro-scene-flow.test.ts` timing out in `waitForFloorDebug` at 30s.
- Applied the smallest deterministic fix by increasing that wait timeout to 45s and documenting the expected nominal runtime vs CI load.

## Files touched

- `tests/e2e/intro-scene-flow.test.ts`

## Verification

- `npx vitest run --project e2e-game tests/e2e/intro-scene-flow.test.ts` (repeated)
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None.

## Recommended next steps

- Let CI rerun full `E2E Visual — Game/UI` on the PR to confirm the timeout no longer flakes under full suite load.
