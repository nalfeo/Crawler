# Handoff: PR #1604 merge-conflict recovery

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Initially estimated 🍎🍎🍎, rescored to 🍎🍎, actual 🍎🍎. The resulting merge-conflict diff was limited to reconciling two existing CI-recovery files and their existing deterministic tests; it added no module, subsystem, or architectural decision.

## What changed

- Merged `origin/main` into `copilot/fix-ci-recovery-loop-1350` as merge commit `079a2e1c`.
- Preserved the PR #1604 retroactive-plan helpers while also taking `main`'s newer issue-assignee helper refactor in `.github/scripts/ci-recovery/issue-intake-lib.mjs`.
- Combined the corresponding issue-intake tests so the merged branch covers both the retroactive-plan logic and the newer assignee-helper contract.
- Updated one stale `reconcile.test.mjs` expectation to match current `main` behavior for outdated-thread auto-resolution, and one missing-plan fixture so it still exercises the intended retroactive-plan path after the merge.

## Observe before done

- Before: PR #1604 was `mergeable_state=dirty`, and merging `origin/main` conflicted in `issue-intake-lib.mjs` and `issue-intake.test.mjs`.
- After: the branch contains a clean two-parent merge commit, the issue-intake/reconcile subprocess harness passes on the merged branch, and `verify:fast` / `verify:pr-prereqs` both pass.
- Real artifact: `.github/scripts/ci-recovery/reconcile.mjs` and `.github/scripts/ci-recovery/issue-intake-lib.mjs` exercised via the Node subprocess test harness plus repository fast verification.

## Verification

- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs`
- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Risks

- The merge commit also brings in the latest `origin/main` content across many unrelated files; only the CI-recovery conflict points and the repo fast gates were revalidated in this session.
- The original feature retains its independent 2-apple ledger. This merge-recovery session has a separate 2-apple ledger recording its downward rescore from the initial 3-apple estimate.
