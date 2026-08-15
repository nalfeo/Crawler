# Unified experiment result artifacts

## Summary

Introduced the `crawler.experiment.v1` result fields and a shared local
artifact directory so weapon, AI, persona, and future experiments can be
loaded through one viewer discovery path.

## Systems touched

perf-tooling, sweep-results-viewer

## Changes

- Added shared TypeScript result types, weapon conversion, RunStats conversion,
  and collision-safe artifact writing.
- Weapon sweep output now writes to `artifacts/experiments` while retaining its
  legacy top-level projection.
- AI/win-rate output now appends the same generic envelope to release-baseline
  JSON.
- Viewer discovery and validation now accept generic experiment envelopes and
  project dimensions/metrics into the existing UI.
- Added a generic-envelope viewer regression test and ADR 0047.
- Added the `early_death_rate` fun criterion (dying on Floor 1 or 2 is
  explicitly un-fun) and a matching `challenge_balance` penalty for
  tutorial-phase deaths in `fun-score-lib.ts`, per direct user feedback.
- Removed the expired, obsolete `brace-expansion` npm-audit exception:
  `brace-expansion@5.0.9` (via minimatch@10.2.6, overridden) is already
  installed and patches the advisory, so no exception is needed.

## Verification

- `npx vitest run --project unit tests/unit/fun-score-lib.test.ts` — 12/12
  passed (includes 2 new `early_death_rate` assertions).
- `npx vitest run --project unit tests/unit/weapon-sweep-output.test.ts
tests/unit/weapon-sweep-results.test.ts` — 14/14 passed.
- `node --test .github/extensions/sweep-results-viewer/tests/*.mjs` — 56/56
  passed.
- `npx tsc --noEmit --project tsconfig.src.json` — clean.
- `npx eslint scripts/agent/health/fun-score-lib.ts
tests/unit/fun-score-lib.test.ts` — clean.
- `npm run verify:fast` — passed (including `health-allowlist-expiry`, which
  had been failing due to the now-removed expired audit exception).

## Apple estimate

Tooling-only work is capped at 3🍎 by repository policy. Actual estimate: 3🍎.
