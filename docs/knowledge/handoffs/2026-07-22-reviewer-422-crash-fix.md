# 2026-07-22 — Stop reconcile crashing when Copilot reviewer request 422s

## Systems touched

ci-policy

## Apple estimate

2🍎 (CI-tooling-only, single-function surgical fix, capped ≤3🍎 per policy). No
review-harness stages required at this tier; a valid ledger was still recorded
(`docs/knowledge/review-ledgers/2026-07-22-reviewer-422-crash-fix.review-ledger.json`).

## Problem

`.github/scripts/ci-recovery/reconcile.mjs` was crashing uncaught (exit 1) with
a 422 whenever it tried to request `copilot-pull-request-reviewer` as a PR
reviewer via `POST /pulls/{n}/requested_reviewers`:

```
Error: GitHub POST /repos/nalfeo/Crawler/pulls/<n>/requested_reviewers failed (422):
Reviews may only be requested from collaborators. One or more of the users or
teams you specified is not a collaborator of the nalfeo/Crawler repository.
    at requestReviewer (reconcile.mjs:1761)
    at executeReviewDecision (review-request.mjs:162)
```

Root cause: `copilot-pull-request-reviewer` (the `REVIEWER_LOGIN` constant in
`review-request.mjs`) is not a repo collaborator on `nalfeo/Crawler` (confirmed
via `gh api repos/nalfeo/Crawler/collaborators/copilot-pull-request-reviewer` →
404). Any review decision with `requestReviewer:true` (the `conflict-resolved`
or `synchronize` paths in `shouldRequestReview`) would hit this 422.

In `executeReviewDecision`'s catch block, the failure was correctly classified
as _not_ one of the genuinely-ambiguous outcomes (408/409/429/5xx/non-finite
status), so the marker was rolled back (`deleteMarker`) — but the function then
unconditionally re-threw the error. `reconcile.mjs`'s caller only special-cases
`ExpectedMetadataChangedError`, so the 422 propagated all the way up and
crashed the process **before** reconcile wrote its converged CI-state comment
or attached the `merge-train` label. Net effect: ci-recovery could never label
any PR that reached a reviewer-request decision (i.e. every rebased PR with a
conflict/synchronize episode), starving the merge train of labeled cargo.

This is **distinct** from issue #1783 / PR #1784, which fixes a different 422
on the outdated-marker _reply_ path (`POST /pulls/{n}/comments/{id}/replies`,
"user can only have one pending review per pull request") in
`reconcile.mjs`/`router.mjs`. Confirmed by reading both code paths directly —
this fix touches only `review-request.mjs` and should not conflict with #1784.

## Fix

`.github/scripts/ci-recovery/review-request.mjs` — in `executeReviewDecision`'s
catch block, after `deleteMarker` succeeds, treat HTTP 422 and 403 (statuses
that mean "this reviewer request can never succeed," not an ambiguous/transient
failure) as **non-fatal**: log
`review-request-skipped reason=reviewer-not-requestable status=<code>` to
stderr and `return` normally instead of re-throwing. All other statuses still
re-throw exactly as before. The pre-existing `ambiguousMutationOutcome` check
(408/409/429/5xx/non-finite → immediate re-throw _before_ rollback) is
untouched, as is the `!decision.requestReviewer` early return. If `deleteMarker`
itself fails while unwinding a 422, the existing `AggregateError`/throw
behavior is preserved (an un-rollback-able marker is still a genuinely
ambiguous state).

## Observe before / after

- **Before**: reproduced the exact crash via a standalone repro harness driving
  `executeReviewDecision`/`reconcile.mjs` against a mock server that returns
  422 for `requested_reviewers` — process crashed with exit 1, no converged
  state comment, no `merge-train` label attached.
- **After**: same repro — process logs
  `review-request-skipped reason=reviewer-not-requestable status=422` to
  stderr, continues, writes the converged state comment, attaches the
  `merge-train` label, exits 0.

## Tests added

- `.github/scripts/ci-recovery/review-request.test.mjs`:
  - `'swallows a 422 reviewer-not-a-collaborator failure after rolling back the marker'`
  - `'swallows a 403 reviewer-request failure after rolling back the marker'`
  - `'still raises an AggregateError when a 422 failure cannot have its marker rolled back'` (negative case, protection preserved)
  - Pre-existing `'keeps marker on ambiguous reviewer-request failures'` (502) still passes — confirms 5xx/429/408/409 still re-throw.
- `.github/scripts/ci-recovery/reconcile.test.mjs`:
  - `'reconcile does not crash when the Copilot reviewer cannot be requested (422 not-a-collaborator)'` — full child-process-level regression proving reconcile reaches converged state + label attach instead of crashing. Required adding a new 40-hex-char `PRIOR_MARKER_HEAD_SHA` constant (the pre-existing `STALE_REVIEWED_SHA` constant is only 39 hex chars and doesn't match the marker `SHA_PATTERN` regex, so it can't be reused as a marker headSha — see inline comment).

## Test results

- `node --test .github/scripts/ci-recovery/review-request.test.mjs` — 21/21 pass.
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — 102 pass, 0 fail, 10 skipped (pre-existing Windows-only `UV_HANDLE_CLOSING` flake skips, unrelated to this change).
- `node --test .github/scripts/ci-recovery/*.test.mjs` (full ci-recovery suite) — 312 pass, 0 fail, 18 skipped (same Windows-only flakes).
- `npm run verify:fast` — passed (no TS unit tests cover `.github/scripts/**`; regression coverage is via the `node --test` files above).

## Follow-ups / notes for future sessions

- None outstanding. The fix is fully scoped to `review-request.mjs`'s error
  classification; no changes to `shouldRequestReview`'s decision logic or to
  `reconcile.mjs`.
- If `copilot-pull-request-reviewer` is ever added as a real collaborator, this
  swallow path simply becomes dead code (harmless) since the POST would then
  succeed.
