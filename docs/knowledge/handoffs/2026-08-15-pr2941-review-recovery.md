# PR #2941 review recovery

## Summary

Addressed the four validated review blockers on the unified experiment artifact PR.

## Systems touched

perf-tooling, sweep-results-viewer, ci-policy

## Apples

Estimated 2🍎, actual 2🍎 — four localized findings shared one experiment projection path.

## Changes

- Made generic experiment record IDs unique when dimensions reuse a seed.
- Projected `startingWeapon`, `playerPersona`, and `weaponPersona` dimensions in the viewer.
- Preserved outcome-less records as unmeasured and rendered their win rate and outcome as N/A.
- Updated active guidance to the canonical `artifacts/experiments/` directory.

## Verification

- `npx vitest run --project unit tests/unit/weapon-sweep-output.test.ts`
- `node --test .github/extensions/sweep-results-viewer/tests/*.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
