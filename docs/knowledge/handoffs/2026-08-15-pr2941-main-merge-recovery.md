# PR #2941 main-merge recovery

## Summary

Recovered PR #2941 from its conflict with current `main` without rewriting branch history.
The resolution preserves the PR's unified experiment artifacts and early-death scoring while
retaining main's newer fun-telemetry criteria.

## Systems touched

perf-tooling, sweep-results-viewer, ci-policy

## Apples

Estimated 2🍎, actual 2🍎 — the conflict was localized, but the merged viewer test required
one structural repair.

## Changes

- Merged `origin/main` in commit `1af8ada3` with both parents preserved.
- Kept main's dopamine, snowball, meta-progression, and item-viability evaluation behavior.
- Retained `early_death_rate`, the Floor 1/2 challenge-balance penalty, and its unit coverage.
- Moved the generic experiment-envelope viewer test back to top level after automatic merging
  nested it inside another asynchronous test.

## Verification

- `npx vitest run --project unit tests/unit/fun-score-lib.test.ts` — 19/19 passed.
- `node --test .github/extensions/sweep-results-viewer/tests/*.mjs` — 76/76 passed.
- `npx tsc --noEmit --project tsconfig.src.json` — passed.
- `npm run verify:fast` — passed.
- `npm run verify:pr-prereqs` — passed.
- GitHub Actions unit, integration, security, lightweight, advisory, and Floor 1 gates passed
  on the recovered head while the remaining report-only/visual jobs continued.
