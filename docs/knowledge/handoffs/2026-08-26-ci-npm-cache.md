# Handoff: Lockfile-keyed npm cache

## Date

2026-08-26

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

Reduced repeated dependency-download work in the shared
`.github/actions/setup-node/action.yml` without restoring the unsafe historical
`node_modules` cache.

- `actions/setup-node@v4` now enables its built-in `npm` cache and explicitly
  keys dependency metadata from `package-lock.json`.
- The cache contains npm's content-addressed download store, not installed
  dependencies.
- `npm ci` still runs on every dependency-installing job and remains the
  authoritative reconstruction and verification of `node_modules`.
- Parsed-YAML regression tests require the lockfile cache configuration, reject
  `node_modules` caching, and require the unconditional `npm ci` install step.

## Review harness

No review ledger or model stages are required at 2🍎.

## Verification

- `npx vitest run --project unit tests/unit/setup-node-playwright-readiness.test.ts --reporter=verbose`
  — 8 tests passed.
- `npx prettier --check .github/actions/setup-node/action.yml tests/unit/setup-node-playwright-readiness.test.ts`
  — passed.
- `npm run verify:fast` — passed.

## Performance evidence

The latest successful `Asset Request Pipeline` run before this change
(`33043183934`) spent 13 seconds in `Run ./.github/actions/setup-node`, consistent
with the measured 11.23-second dependency setup reported for this task.

The deterministic action-level proof verifies that a package-lock-keyed npm cache
is active while `npm ci` remains authoritative. A directly comparable production
after-timing is intentionally deferred to the first normal pipeline run after
merge: manually dispatching the asset pipeline could drain paid generation work,
which is outside this task's safety boundary.

## Real artifact observation

The real artifact is the shared GitHub composite action consumed by Asset Request
Pipeline and CI. Before this change, `actions/setup-node` received only the Node
version and could not restore npm's download cache. After this change, the parsed
action contract supplies `cache: npm` and
`cache-dependency-path: package-lock.json`, then independently executes `npm ci`.

## Unresolved issues

Production after-timing remains to be collected from a normal post-merge Asset
Request Pipeline run; no paid workflow was dispatched solely for measurement.
