# Handoff: PR #1630 merge recovery round 3

## Date

2026-07-20

## Persona

Producer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Recovered PR #1630 from a fresh merge-drift conflict against `origin/main` and pulled in the default-branch fix for the unrelated `PR Ready/Reviewer Guard` failure that had been sweeping other open PRs during event-triggered runs.

## What changed

- Merged `origin/main` into `copilot/nalfeo-d1-deterministic-equipment-generator-another-one`.
- Resolved the remaining content conflicts in `.github/scripts/ci-recovery/reconcile.mjs`, `scripts/agent/verify-fast.sh`, and `tests/unit/verify-fast-typecheck.test.ts` by keeping the newer default-branch recovery + verifier behavior while preserving this PR's equipment-scoring work.
- Added a 2🍎 review ledger for this merge-recovery session: `docs/knowledge/review-ledgers/2026-07-20-pr1630-merge-recovery-round3.review-ledger.json`.

## CI investigation

- Investigated `Enforce ready + reviewer cleanup` job `88250512058` from workflow run `29709094118`.
- The failure was not caused by PR #1630 itself: the job successfully removed `@nalfeo` from PR #1630, then failed the whole sweep on an unrelated transient `GET /pulls/1278` `503` while scanning other open PRs.
- `origin/main` already contains the follow-up fix that scopes `pull_request_target` runs of `pr-ready-reviewer-guard` to the triggering PR instead of sweeping every open PR, so merging main is the repair for this blocker.

## Observe before done

- Before: `git merge --no-commit --no-ff origin/main` reported dirty merge state with conflicts in the CI recovery reconciler and fast-verifier files, and the guard workflow log showed the event-triggered cleanup run sweeping unrelated PRs until a transient API `503` failed the whole job.
- After: the merge commit applies cleanly, `pr-ready-reviewer-guard`'s targeted tests pass on the merged branch, and the reconciler + fast-verifier regression suites still pass with the merged script behavior.

## Verification

- `npx vitest run tests/unit/verify-fast-typecheck.test.ts`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `node --test .github/scripts/pr-ready-reviewer-guard.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-20-pr1630-merge-recovery-round3.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Fresh CI had not completed yet at handoff time; the next external step is to let GitHub rerun the PR checks on the merged head.
