# Handoff: PR #1603 CI recovery test repair

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-recovery

## Apples

Estimated 1 apple, actual 1 apple.

## What changed

- Updated `.github/scripts/ci-recovery/reconcile.test.mjs` so the live-task-comment coverage matches the current reconciler contract: outdated review threads are auto-marked and auto-resolved before the task comment is posted, so only still-open review blockers retain reply-target instructions in the task body.
- Narrowed the stale-marker blocker coverage to the still-actionable case (`isOutdated: false`), because outdated threads are now deterministically resolved by the reconciler instead of being handed back as stale-marker blockers.

## Observe before done

- Before: PR #1603's latest `Format & Labs` check failed on current head `3d8b172` because two `reconcile.test.mjs` expectations lagged behind the newer outdated-thread auto-resolution behavior.
- After: the repaired tests pass locally, `npm run test:guards` is green again, and `npm run verify:fast` plus `npm run verify:pr-prereqs` both pass on the same head.

## Verification run

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs --test-name-pattern='live reconcile auto-resolves outdated threads and keeps reply targets on remaining review-thread blockers|non-outdated stale-marker thread includes recovery hint in blocker summary'`
- `npm run test:guards`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Review thread `PRRT_kwDOSvo2Ms6R-rQq` remains substantively applicable, which is why it is still tracked in this test-repair handoff: even after the CI regression was fixed, PR #1603 cannot be fully recovered until the maintainer decides how to handle the unmet issue-#1595 pre-code plan-comment requirement.
