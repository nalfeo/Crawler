# PR #2941 second main-merge recovery

## Summary

Merged current `main` into PR #2941 after release-sweep failure deduplication
overlapped the experiment-envelope changes in `winrate-sweep.ts`.

## Systems touched

perf-tooling, sweep-results-viewer, ci-policy

## Apples

Estimated 2🍎, actual 2🍎 — one import conflict joined two independently required
output paths.

## Changes

- Merged `main` commit `69ada7c5` in a true two-parent merge.
- Preserved generic experiment-envelope attachment from the PR.
- Preserved deterministic release-failure signatures from `main`.

## Verification

- `npx vitest run --project unit tests/unit/baseline-regression-check.test.ts tests/unit/weapon-sweep-output.test.ts`
- `node --test .github/extensions/sweep-results-viewer/tests/*.mjs`
- `npx tsc --noEmit --project tsconfig.src.json`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
