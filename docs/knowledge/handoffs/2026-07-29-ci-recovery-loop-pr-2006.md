# Handoff: CI recovery loop incident — PR #2006

## Date

2026-07-29

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

- Investigated loop incident #2287 and fetched the linked CI + review-thread evidence directly.
- Confirmed recovery attempts were repeatedly consumed by a review-thread blocker whose digest kept changing after non-marker recovery replies, while the underlying blocker stayed unresolved.
- Landed a deterministic fix in `.github/scripts/ci-recovery/state.mjs`: review-thread digests now ignore known recovery-agent replies that do **not** contain a resolution marker (`✅ Addressed in …` or `✅ Not applicable: …`), so attempt accounting no longer resets on repeated non-progress diagnostics.
- Added focused regression coverage in `state.test.mjs` to prove:
  - non-marker recovery replies do not change digest/fingerprint;
  - marker-bearing recovery replies still change digest/fingerprint.

## Files touched

- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-29-ci-recovery-loop-pr-2006.review-ledger.json`

## Verification run

- `node --test .github/scripts/ci-recovery/state.test.mjs`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-29-ci-recovery-loop-pr-2006.review-ledger.json`
- `npm run verify:pr-prereqs` (passes after this handoff was added)

## Unresolved issues

- Could not post the requested pre-coding issue plan comment from this session: direct GitHub API issue-comment POSTs returned HTTP 403 with both `GITHUB_TOKEN` and `CRAWLER_CI_PAT`.

## Recommended next steps

- Run one CI recovery sweep for PR #2006 and verify attempts no longer churn from non-marker in-thread recovery replies.
