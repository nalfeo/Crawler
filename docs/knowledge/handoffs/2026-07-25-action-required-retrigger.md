# Handoff: Action-required CI retrigger consult

## Systems touched

ci-policy

## Summary

DevOps consult for velocity scan follow-up. Recomputed recent merged-PR timing from
per-branch `gh run list` history instead of `statusCheckRollup`. The unsound
“open → first CI” signal is not a bottleneck: median first workflow creation and
start are effectively immediate after PR open/head push.

## Corrected timing evidence

- 60 merged PRs; median lead time: 1.96h.
- Median open → first workflow created: 0.00h.
- Median open → first workflow started: 0.00h.
- Median last commit → first workflow after last commit: 0.00h.
- Median last workflow completion → merge: 0.05h.
- Median last commit → merge: 0.27h.
- Runs sampled: 2,544; `action_required`: 212; `skipped`: 680.

## Size inversion explanation

The ≤100-line bucket is not slow because small diffs run slowly. It is enriched
for unattended housekeeping/security/docs PRs with few or zero reviews and long
calendar gaps after the last commit. Examples:

- #1883: 72 lines, 1 commit, 0 reviews, 15.70h lead, 10 parked runs.
- #1889: 56 lines, 4 commits, 13.65h lead, 14 skipped train runs.
- #1848/#1828/#1869/#1874: archive/index chores with 0 workflow runs in the
  sampled branch history, indicating lifecycle/calendar waiting rather than CI
  execution.

Large PRs tend to be actively shepherded feature work with more reviews and
commits, so they receive continuous agent attention and merge quickly once green.

## Change made

Added `.github/workflows/action-required-retrigger.yml` and
`.github/scripts/ci-recovery/action-required-retrigger.mjs`. When CI or Security
Review Loop completes as `action_required`, the workflow verifies the parked run
is:

- a latest, required PR workflow run;
- same-repository, open PR only;
- still on the live PR head SHA;
- targeting the default branch.

It then pushes one empty commit to the PR branch with `CRAWLER_CI_PAT`, which is
the documented safe human-token retrigger path for bot-pushed parked checks.

## Measurement plan

This is explicitly **unmeasured** by the velocity lab. Field signal:

1. Re-run `npm run velocity:scan -- --limit 60` after 7 days and again after the
   next 60 merged PRs.
2. Compare:
   - count of required CI/Security Review Loop `action_required` runs per 60 PRs;
   - P95 lead time for ≤100-line PRs;
   - median last workflow completion → merge (should remain ~0.05h);
   - any increase in empty retrigger commits per PR (risk signal).

Expected result: catastrophic 6–15h `action_required` tails disappear. Median
idle share may not improve much because the median drag is mostly agent
attention/calendar delay, not CI scheduling.

## Validation

- `npm test -- tests/unit/ci-action-required-retrigger.test.ts` ✅
- `npm run verify:fast` ✅
- Review ledger: `docs/knowledge/review-ledgers/2026-07-25-action-required-retrigger.review-ledger.json` ✅
