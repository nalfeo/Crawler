# Session Handoff: CI Recovery Review Approval

## Date

2026-07-11

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 exact

## What Was Done

- Added a fail-closed workflow approval policy keyed by exact workflow path and
  event pairs.
- Allowed same-repository `CI Recovery Router` runs triggered by
  `pull_request_review` and `pull_request_review_comment`.
- Preserved `CI` and `commit-lint` pull-request approvals while rejecting forks,
  unrelated PRs, unknown workflows, mismatched events, display-name spoofing,
  and PRs that modify the workflow being approved.
- Removed the runtime name-based approval override.
- Documented that blocked router runs are handled by the next trusted
  event-driven or scheduled reconciliation pass.

## Files Touched

- `.github/scripts/ci-recovery/approval.mjs`
- `.github/scripts/ci-recovery/approval.test.mjs`
- `.github/scripts/ci-recovery/reconcile.mjs`
- `docs/guides/ci-recovery.md`
- `docs/knowledge/review-ledgers/2026-07-11-ci-recovery-review-approval.review-ledger.json`

## Verification

- Observed five existing `action_required` router runs across PRs #1038, #1045,
  and #1046. Their workflow paths, review events, head SHAs, and PR associations
  match the new eligible policy.
- `node --test ".github/scripts/ci-recovery/*.test.mjs"` passed with regression
  coverage for every approval and rejection boundary.
- `npm run verify:fast` passed after each implementation round.
- Separate-model plan review and two code/security review rounds completed. The
  security review found the mutable-workflow risk; the final implementation
  rejects PRs that modify the matched workflow, and round two was clean.

## Unresolved Issues

- Existing blocked runs cannot be approved by branch-local code. The fix must
  reach the trusted default branch before a reconciliation pass can apply it.
- The three affected PR titles still require Conventional Commit prefixes; this
  change intentionally does not rewrite unrelated PR metadata.

## Recommended Next Steps

1. Merge this change.
2. Confirm the next event-driven or scheduled reconciliation approves the five
   eligible router runs.
3. Correct the Conventional Commit prefixes on PRs #1038, #1045, and #1046.
