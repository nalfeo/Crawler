# 2026-09-01 coverage release workflow

## Summary

Moved unit coverage reporting out of PR CI and into the release deploy workflow so
pull requests no longer spend runner time generating coverage data that is only
used for reporting.

## Systems touched

ci-policy

## What changed

- Removed the `ci-coverage` advisory job from `.github/workflows/ci.yml`, including
  the PR-time `vitest-coverage-report-action` comment.
- Added release-time unit coverage generation to `.github/workflows/deploy.yml`
  after dependencies install and before the release PR comment step.
- Uploaded the release coverage summary as `release-coverage-summary`.
- Appended coverage percentages to the existing released-PR comment, using
  `scripts/agent/ci/format-release-coverage-comment.mjs` so the comment is
  posted at the same time as the release notification.
- Updated workflow regression tests to pin the new contract: PR CI must not run
  or comment code coverage, and deploy must own release-time coverage reporting.

## Verification

- `npx vitest run --project unit tests/unit/ci-gating-policy.test.ts tests/unit/deploy-workflow-gating.test.ts tests/unit/ci-knobs-guard.test.ts --reporter=verbose`
- `npx eslint tests\unit\ci-gating-policy.test.ts tests\unit\deploy-workflow-gating.test.ts tests\unit\ci-knobs-guard.test.ts scripts\agent\ci\format-release-coverage-comment.mjs --max-warnings 0`
- `npm run verify:fast`
