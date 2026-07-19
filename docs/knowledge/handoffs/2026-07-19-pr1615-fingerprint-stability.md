# PR #1615 outdated-thread fingerprint stability

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 1 apple, actual 1 apple. Exact: the final change is one production expression plus focused regression coverage.

## Summary

Narrowed PR #1615 to the compatible delta that remains after canonical stale-marker fix PR #1665: unresolved outdated review threads stay blockers, but their unstable GraphQL `line` value is omitted from blocker normalization so line churn cannot reset CI-recovery attempt fingerprints.

## Scope cleanup

- Restored unrelated issue-intake formatting, handoffs, index churn, review metadata, and sprite-catalog changes to `main`.
- Removed earlier #1615 behavior that conflicted with #1665's stale-marker auto-resolution guard.
- Kept one subprocess regression that runs reconciliation with the same outdated thread at two line values and requires identical task fingerprints.

## Verification

- `node --test --test-name-pattern "outdated no-reply-target thread keeps a stable fingerprint when its line changes" .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Dependency

PR #1665 remains the canonical stale-marker behavior change. #1615 is compatible and independently limited to fingerprint stability.
