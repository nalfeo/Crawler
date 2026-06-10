# Handoff: Harness Gaps 2–6

**Date:** 2026-06-09
**Session type:** Infrastructure / DevOps

## What was done

Implemented five harness improvements identified in the prior research session, corresponding to gaps 2–6.

---

### Gap 5 — `verify:flash` (sub-5 s local feedback)

Added `"verify:flash": "vitest run --changed --project unit --reporter=dot"` to `package.json`. Only runs unit tests whose dependency graph was touched by the current changes. Falls back to the full unit suite when git can't narrow the set. Agents should call this during tight edit-test cycles instead of `verify:fast`.

---

### Gap 4 — Composite Node setup action + node_modules caching

Created `.github/actions/setup-node/action.yml` — a composite action that:

1. Installs Node 22 via `actions/setup-node@v4`
2. Restores `node_modules` from an `actions/cache@v4` layer keyed on `runner.os + hash(package-lock.json)`
3. Runs `npm ci` only on a cache miss

Updated `ci.yml`, `test-health.yml`, and `security-review.yml` to use `uses: ./.github/actions/setup-node` instead of the previous three-step setup block. Saves ~45 s per job on cache hits (~3 min per CI run across the four parallel jobs).

---

### Gap 3 — Coverage PR comments

Modified `ci.yml` `test-unit` job to:

- Run with `--coverage --coverage.reporter=json-summary --coverage.reporter=text` (was reporter=verbose only)
- Upload `coverage/coverage-summary.json` as an artifact (retained 7 days)
- Post a coverage diff comment on PRs via `davelosert/vitest-coverage-report-action@v2`

The coverage comment only fires on `pull_request` events. Added `pull-requests: write` permission to the `test-unit` job. Vitest coverage thresholds in `vitest.config.ts` are now also enforced on every PR (previously only run during `verify` and health loops).

---

### Gap 2 — vitest bench + weekly bench regression tracking

**New files:**

- `tests/bench/core-systems.bench.ts` — benchmarks for `SpatialHashGrid` (insert+queryPairs at 50 and 200 entities, queryRadius), `movementSystem` (100 entities), and `collisionSystem` (1 player + 20 enemies)
- `scripts/agent/health/bench-regression.ts` — reads `coverage/bench-results.json`, compares against baseline, reports regression > 15% in ops/sec
- `docs/knowledge/metrics/bench-baseline.json` — empty baseline (bootstrapped on first run)

**Modified:**

- `vitest.config.ts` — added `benchmark.include` and `benchmark.outputFile.json` config
- `package.json` — added `"bench": "vitest bench"` script; added `bench-regression.ts` to `health:check`
- `test-health.yml` — added `bench-regression` job (new Job 6); updated `aggregate-results` `needs` list

Run benchmarks locally: `npm run bench`. Results land in `coverage/bench-results.json`.

---

### Gap 6 — Nightly mutation testing (Stryker.js)

**New files:**

- `stryker.config.json` — targets `src/core/systems/*.ts` and `src/game/**/*.ts`, uses `@stryker-mutator/vitest-runner`, `coverageAnalysis: perTest`, JSON + clear-text reporters
- `scripts/agent/health/mutation-score.ts` — parses `reports/mutation/mutation.json`, computes killed+timeout/total score, compares against baseline (threshold: −5%)
- `docs/knowledge/metrics/mutation-baseline.json` — empty baseline (bootstrapped on first run)
- `.github/workflows/nightly-mutation.yml` — runs at 02:00 UTC nightly; two jobs: `mutation-run` (Stryker, 60 min timeout) → `mutation-score` (compare + auto-PR for baseline update + issue on regression)

**Modified:**

- `package.json` — added `@stryker-mutator/core@^9.6.1`, `@stryker-mutator/typescript-checker@^9.6.1`, `@stryker-mutator/vitest-runner@^9.6.1` to devDependencies
- `scripts/agent/security/check-deps.ts` — added `@stryker-mutator/` to `TRUSTED_SCOPES`

Two moderate-severity transitive vulnerabilities exist in Stryker's `typed-rest-client → qs` dependency tree. These are below the `--audit-level=high` CI threshold and do not affect production builds (devDependency only).

---

## What still needs to be done

- **Establish baselines**: run `npm run bench` once on main to populate `bench-baseline.json`, then run `npx stryker run` once to populate `mutation-baseline.json`. Both scripts auto-bootstrap on first run.
- **Tune Stryker scope**: `src/game/**` is broad. If nightly run exceeds 60 min, narrow `mutate` in `stryker.config.json` to specific subsystems.
- **Coverage comment base**: `davelosert/vitest-coverage-report-action` will show "no base to compare" on the first few PRs until a reference run exists in the artifact store.
- **Extend composite action to remaining workflows**: `commit-lint.yml` and `docs-update.yml` still use the old `setup-node@v4 + npm ci` pattern. Low priority since they run infrequently.

## Key files changed

```
package.json
vitest.config.ts
scripts/agent/security/check-deps.ts
scripts/agent/health/bench-regression.ts    (new)
scripts/agent/health/mutation-score.ts      (new)
tests/bench/core-systems.bench.ts           (new)
docs/knowledge/metrics/bench-baseline.json  (new)
docs/knowledge/metrics/mutation-baseline.json (new)
stryker.config.json                         (new)
.github/actions/setup-node/action.yml       (new)
.github/workflows/ci.yml
.github/workflows/test-health.yml
.github/workflows/security-review.yml
.github/workflows/nightly-mutation.yml      (new)
```
