# Session Handoff: Pages deploy incident recovery

## Date

2026-08-14

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## What Was Done

- Diagnosed Deploy to GitHub Pages run `31782184123`: the workflow failed before
  any job step ran while `release-gate` remained runner-queued with no failed job
  logs; deploy and the baseline sweep were skipped.
- Confirmed later green deploy-workflow runs can be stale/no-op successes where
  `release-gate` succeeds but the actual `deploy` job is skipped, so incident
  auto-close must not treat every successful Pages workflow as proof of recovery.
- Added a job-level `if:` to `release-gate` so non-deployable CI completions
  (failed CI, scheduled/manual/non-push CI completions) skip before allocating a
  runner. Successful push-triggered CI and manual deploys still run the existing
  stale-main gate.
- Extended `tests/unit/deploy-workflow-gating.test.ts` to lock the new
  release-gate condition alongside the existing deploy/baseline gates.
- Hardened `.github/scripts/ci-recovery/incident.mjs` so Deploy to GitHub Pages
  incidents only auto-close when the later successful workflow has a successful
  `deploy` job and a successful Pages deployment action step. Stale/no-op Pages
  successes, including final latest-tip-guard runs with skipped deployment steps,
  now leave the incident open.

## Evidence

- `npm run test:unit -- tests/unit/deploy-workflow-gating.test.ts --reporter=verbose`
  passed (10 tests).
- `node --test .github/scripts/ci-recovery/incident.test.mjs` passed (10 tests),
  including the final latest-tip-guard no-op regression.
- `npm run verify:fast` passed.

## What's Next / Blockers

No known blockers. The next non-push CI completion should skip the Pages
workflow without needing a runner-backed no-op release-gate job, and stale Pages
successes should no longer auto-close real deploy incidents.
