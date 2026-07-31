# 2026-07-31 — PR #2193 velocity report recovery

## Systems touched

ci-policy

## Summary

Recovered PR #2193 by correcting the observational velocity artifacts rather than forcing
through the original unreviewed claims. The branch itself was still relevant: the scan and
follow-up proposal remain useful, but the report needed to stop presenting unsupported
full-cohort stage medians, stop labeling the long post-review interval as active rework,
and replace the unsafe reachability-based proposal with an effective CI tree-diff gate.

**Apple estimate:** 1🍎 (docs/data recovery only). Actual: 1🍎.

## Files changed

- `docs/knowledge/metrics/velocity/findings/2026-07-28-nightly-scan.md`
- `docs/knowledge/metrics/velocity/findings/2026-07-28-nightly-scan.report.json`
- `docs/knowledge/handoffs/2026-07-28-nightly-bottleneck-scan.md`

## What changed

- Reframed stage analysis around the **observed slow-tail subset (n=5)** instead of
  unsupported “all 60 PRs” stage medians.
- Renamed the 67h `first review → last push` bucket to a **post-review interval** and
  explicitly documented that the incident evidence points to queueing behind coordination,
  not proven active rework.
- Corrected the repeated contamination statistics to match the cited evidence:
  `8/11 PRs touching reconcile.mjs`, plus `#1976` as `28/30` subject-matched duplicates
  and `45/48` patch-identical commits by `git cherry`.
- Converted the machine-readable report from the misleading
  `crawler-velocity-bottlenecks/v1` contract to an explicit observational schema
  (`crawler-velocity-bottlenecks/observation-v2`) and restored structured slowest-entry
  timing fields alongside the explanatory notes.
- Replaced the unsafe “reachable commits / cherry-only exclusion” proposal with a safer
  **effective CI tree-diff admission gate**, while relegating patch-equivalence to
  diagnostics only.
- Reworded the two-week follow-up as **field monitoring**, not causal A/B validation.

## CI / validation

- Initial `npm run verify:fast` failed because this sandbox lacked installed dependencies;
  `npx` fell back to unrelated packages (`tsc@2.0.4`, ESLint 10.8.0) and could not resolve
  repo deps.
- `npm ci` initially failed because several `package-lock.json` tarball URLs pointed at
  unreachable Azure Artifacts mirrors. I temporarily rewrote those URLs to
  `registry.npmjs.org`, installed dependencies successfully, then restored
  `package-lock.json` from git before validation so the lockfile was not committed.
- Final validation:
  - `npm run verify:fast` ✅
  - `npm run verify:pr-prereqs` ✅

## Merge / recovery status

- The old failing CI runs were not code regressions; the sampled failing
  `Lightweight Checks` run failed at the explicit human-approval gate
  (`APPROVED FOR CHECK-IN`), not at a project test/build step.
- PR still needs thread-marker replies on the six review comments and then a fresh push so
  CI Recovery can reconcile them.
