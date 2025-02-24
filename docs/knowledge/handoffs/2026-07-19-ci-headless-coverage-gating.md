# Session Handoff: Gate headless and coverage jobs by change impact

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact).

## What changed

Implemented nalfeo/Crawler#1696: gating CI headless and coverage jobs by direct
change-impact signals rather than broad negative exclusion lists.

### `scripts/agent/ci/detect-art-only.sh`

Added two new fail-closed outputs emitted alongside the existing flags:

- **`sim_touched`** – `true` when any changed file is in the simulation-critical surface
  (`src/core/**`, `src/game/**`, `src/shared/**` non-data, `src/bootstrap/**`, `tests/headless/**`).
  Unknown/unclassified paths → `true` (fail-closed). Safe surfaces: engine, labs, e2e, unit tests,
  integration tests, docs, public, .github, scripts, \*.md/txt.

- **`coverage_touched`** – `true` when any changed file is in the unit-coverage surface
  (`src/core/**`, `src/game/**`, `src/shared/**` non-data, `src/bootstrap/**`,
  `tests/unit/**` except sprite tests). Unknown paths → `true`. Safe surfaces include
  everything sim-safe PLUS `tests/headless/**` and `tests/unit/sprites/**`.

Both flags use the fail-closed pattern (start `false`, break to `true` on unsafe or unknown)
as opposed to `gameplay_safe` which uses the fail-open pattern (start `true`, break to `false`).

Fail-safe calls updated from 5 to 7 args; the new args are `true true` (run full suite).

### `scripts/agent/ci/local-scope.sh`

Updated `emit_all_false()` to include `sim_touched=true` and `coverage_touched=true`
to mirror `detect-art-only.sh`'s fail-safe output contract exactly.

### `.github/workflows/ci.yml`

- **`changes` job**: exposed `sim_touched` and `coverage_touched` as job outputs;
  wired them from the `detect` step through the `scope` step; schedule event forces
  both to `true` (backstop).

- **`test-headless`**: replaced `gameplay_safe`-based gating with `sim_touched`-based
  gating. New condition: skip on PR only when `sim_touched != 'true'`. Non-PR events
  (main-push, schedule) always run it as a backstop.

- **`test-unit-coverage`**: added PR gating on `coverage_touched`. New condition: skip
  on PR when `coverage_touched != 'true'`. Non-PR events always run it as a backstop.

- **merge-gate**: replaced the generic `allow_skipped=true` for headless with an
  explicit check that accepts a skip only when `docs_only=true` or `sim_touched=false`.
  A blank/missing `sim_touched` when headless was skipped on a PR causes the gate to
  fail with a diagnostic message, satisfying the "classifier failure cannot silently
  skip the gate" requirement.

### Tests

- **`tests/unit/detect-change-scope.test.ts`**: extended `Scope` interface, `run()`,
  and `F()` with `sim_touched` and `coverage_touched`; updated all 35 existing test
  cases; added 15 new cases covering runtime, CI-only, docs, asset, dependency, unknown,
  headless-test, unit-test, bootstrap, integration, and handoff scenarios.

- **`tests/unit/ci-gating-policy.test.ts`** (new): 15 structural YAML-parse tests
  asserting that `test-headless` uses `sim_touched`, `test-unit-coverage` uses
  `coverage_touched`, both have non-PR backstop conditions, the merge gate checks
  `sim_touched` for skips, and the `changes` job exposes both new outputs.

## Verification

- `npx vitest run --project unit tests/unit/detect-change-scope.test.ts tests/unit/ci-gating-policy.test.ts` → 65 tests passed
- `npm run verify:fast` → 4521 unit + 1297 integration tests passed

## Acceptance criteria status

- ✅ PR headless jobs start only when `sim_touched=true`
- ✅ PR coverage jobs start only when `coverage_touched=true`
- ✅ Classifier failure cannot silently skip either gate (changes job checked in merge gate; missing sim_touched on a skip is rejected)
- ✅ Main-push and scheduled behavior remains a documented backstop (non-PR condition in both jobs)
- ✅ Merge gate accepts intentional scope skips (sim_touched=false) and rejects failed scope detection
- ✅ Representative workflow-policy tests cover runtime, CI-only, docs, asset, dependency, and unknown changes
- ✅ No gameplay logic or test assertions weakened

## Unresolved issues

None.

## Recommended next steps

- `gameplay_safe` output remains in `changes` job for backward compatibility with local tooling
  (`verify-fast.sh`, `npm run scope`). It can be retired in a future session once consumers migrate.
- If `#1688` lands additional orthogonal flags (`visual_touched`, `dependencies_touched`, etc.),
  they can follow the same fail-closed pattern established here.
