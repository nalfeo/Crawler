# Handoff: PR #1630 merge-conflict recovery

## Date

2026-07-19

## Persona

Producer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Merged `origin/main` into `copilot/nalfeo-d1-deterministic-equipment-generator-another-one` to clear PR #1630's `mergeable_state: dirty` blocker without rewriting branch history.
- Resolved the lone textual conflict in `.github/scripts/ci-recovery/reconcile.mjs` by preserving both behaviors: outdated threads with a current trusted marker are left alone, while outdated threads whose prior trusted marker SHA is definitively stale still get a fresh reconciler-authored outdated marker and self-resolve.
- Fixed the stale-marker regression fixture in `.github/scripts/ci-recovery/reconcile.test.mjs` so the mock thread matches the scenario the test describes (`isOutdated: true`).

## Observe before done

- Before: GitHub reported PR #1630 as `mergeable_state: dirty` on head `4cdeff1`, and a local `git merge --no-commit --no-ff origin/main` reproduced a conflict in `.github/scripts/ci-recovery/reconcile.mjs`.
- After: the conflict markers are gone, the merge tree validates, and the dedicated reconciler regression suite passes against the merged result.

## Verification run

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`

## Unresolved issues

- None locally. GitHub will clear the merge-conflict blocker after the merge commit is pushed to the PR branch.
