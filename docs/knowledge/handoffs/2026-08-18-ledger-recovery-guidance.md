# Handoff — Ledger recovery guidance

## Systems touched

ci-policy

## Summary

- Recovered PR #3113 from the ledger-thread review blocker by clarifying CI recovery task-comment guidance for review-ledger threads.
- `npm run review:ledger -- validate` is now framed as schema/validator evidence, not as automatic proof that policy findings are non-applicable.
- Marker-bearing `✅ Not applicable` replies remain allowed only when validation output or the current diff deterministically proves the exact finding inapplicable; substantive policy disagreements are directed to human escalation.
- Updated the reconcile regression test to assert the safer validator-evidence and escalation wording.

## Apples

- Estimated: 2🍎
- Actual: 2🍎

## Validation

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run review:ledger -- validate`
- `npm run verify:fast`
- Secret scan: `.github/scripts/ci-recovery/reconcile.mjs`, `.github/scripts/ci-recovery/reconcile.test.mjs`
- Automated code review: no comments
- CodeQL checker: no analyzable CodeQL language changes

## Notes

- A second-model `ci-review-validator` run classified the original thread as substantive disagreement and left it unresolved, but the primary repair still narrowed the generated guidance to avoid unsafe auto-resolution for validator-unenforced policy findings.
- Posted `✅ Addressed in 7b12ff53ae8329443d1c9b500035ef781c2ebd6f` to review comment `3808489668` after the consolidated code repair push.
