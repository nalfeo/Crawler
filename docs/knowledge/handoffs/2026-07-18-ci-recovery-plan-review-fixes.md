# Handoff: CI recovery plan-comment review fixes

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Tightened issue-plan detection in `.github/scripts/ci-recovery/issue-intake-lib.mjs` so only trusted recovery markers or structured Copilot plan comments satisfy the intake requirement.
- Expanded retroactive plan generation to include the required high-level design, key decisions, and checklist content instead of linking back to the PR description alone.
- Moved the reconciler's retroactive issue-plan posting behind review-thread blocker classification and added an `EXPECTED_HEAD_SHA` metadata fence before each issue-comment POST.
- Merged `origin/main` into the branch and kept the newer stale-marker reconciler coverage from main alongside the new retroactive-plan regression tests.

## Observe before done

- Before: any non-intake Copilot comment could suppress the retroactive plan post, untrusted users could spoof the recovery marker, the posted issue comment lacked substantive plan content, and the write ran before blocker classification / stale-metadata fencing.
- After: only trusted, dedicated plan evidence suppresses the post; the retroactive comment carries the required plan sections; and the write now happens only for dispatched missing-plan review blockers after a fresh metadata check.
- Verified with targeted and full ci-recovery test suites plus repository fast verification.

## Verification run

- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs`
- `node --test --test-name-pattern "retroactive plan|stale-marker|transient compare" .github/scripts/ci-recovery/reconcile.test.mjs`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None.
