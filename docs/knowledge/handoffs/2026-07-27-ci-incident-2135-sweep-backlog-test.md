# Handoff: CI incident #2135 sweep-backlog test recovery

## Date

2026-07-27

## Systems touched

ci-policy

## Summary

Diagnosed repository CI run `30314056069` failure via GitHub Actions logs and traced the root cause to two stale assertions in `.github/scripts/sweep-budget.test.mjs`. The implementation in `.github/scripts/sweep-budget.mjs` intentionally counts externally blocked PRs (`merge-train-blocked`) as latent demand, but tests still expected those PRs to be excluded from the latent backlog count. Updated test expectations and test wording only; production logic was unchanged.

## Files touched

- `.github/scripts/sweep-budget.test.mjs` — adjusted latent-backlog expectations/comments to match current latent-demand contract.
- `docs/knowledge/review-ledgers/2026-07-27-ci-incident-2135-sweep-backlog-test.review-ledger.json` — 2🍎 review ledger.

## Verification run

- `node --test .github/scripts/sweep-budget.test.mjs` ✅
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-27-ci-incident-2135-sweep-backlog-test.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅

## Unresolved issues

- None in local validation.

## Recommended next steps

1. Let CI rerun on the PR branch and confirm `Lightweight Checks`/`Merge gate`/`ci` are green.
2. Merge with squash once required checks pass.
