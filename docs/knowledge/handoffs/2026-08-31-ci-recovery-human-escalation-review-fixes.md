# Session Handoff: CI recovery human escalation review fixes

## Date

2026-08-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact (tooling-only CI recovery logic, tests, and handoff)

## Summary

Addressed follow-up review blockers on the human-escalation CI recovery quarantine PR.

## What changed

- Tightened `isHumanEscalationDeclaration()` so a human hand-off phrase and an unresolved-thread
  phrase must appear in the same non-conditional clause. This rejects repairable/future wording such
  as "If this recurs we should escalate to a human. Leaving this thread unresolved until the rebase
  lands."
- Added review-comment `createdAt` to the CI recovery GraphQL query so the reconciler can compare a
  human-escalation declaration with owner disposition comments.
- Scoped the human-escalation `KEEP` override to comments posted after the newest escalation
  declaration. A historical `KEEP` no longer suppresses later valid escalations.
- Added targeted `state.test.mjs` and `reconcile.test.mjs` coverage for conditional escalation
  wording, stale `KEEP`, and post-escalation `KEEP`.

## Files touched

- `.github/scripts/ci-recovery/github.mjs`
- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/handoffs/2026-08-31-ci-recovery-human-escalation-review-fixes.md`

## Verification

- `node --test .github/scripts/ci-recovery/state.test.mjs --test-name-pattern='human escalation'`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs --test-name-pattern='human-escalation|KEEP after|stale KEEP'`
- `npm run format:check -- .github/scripts/ci-recovery/github.mjs .github/scripts/ci-recovery/state.mjs .github/scripts/ci-recovery/reconcile.mjs .github/scripts/ci-recovery/state.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`

## Unresolved issues

- None known.

## Recommended next steps

- Let CI run the full PR gate, including the full-history silent merge-revert guard that local
  `verify:fast` skipped because the checkout is shallow.
