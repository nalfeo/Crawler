# Fix: Asset PR admission policy — substantive-copilot-review stall + art_only classification gap

**Date**: 2026-08-01
**Session**: fix-asset-pr-admission-policy
**Branch**: nalfeo-fix-asset-pr-admission-policy
**Apple estimate**: 2🍎 (tooling-only, cap 3🍎)

## Systems touched

ci-recovery, merge-train

## Problem

PR #2358 (`assets/promote` art-batch branch) stalled in the merge train with
`State: waiting / Detail: ci, substantive-copilot-review` because:

1. **Copilot reviewer always emits "wasn't able to review any files"** for
   PNG-heavy asset PRs. `isSubstantiveCopilotReview` rejects this body, so
   `admissionWaitReasons` unconditionally appended `'substantive-copilot-review'`
   as a permanent blocker — no escape hatch existed for asset PRs.

2. **CI Recovery had previously added a handoff + review-ledger file** to the
   same asset PR. Because `docs/*` was not in the `art_only` allowlist in
   `detect-art-only.sh`, the PR was classified `art_only=false`, triggering
   the Headless Floor-1 gate and integration tests on an asset-only diff.

## Fixes

### `state.mjs` — `skipSubstantiveReview` option

`admissionWaitReasons(requiredChecks, reviews, opts?)` now accepts an optional
third argument `{ skipSubstantiveReview: boolean }`. When `true`, the
`'substantive-copilot-review'` reason is not appended regardless of review
state.

`evaluateAdmission(prFacts, config?)` now reads `skipSubstantiveReview` from
`prFacts` (destructured with default `false`), falling back to
`config.skipSubstantiveReview`. Both call sites (merge-train reconciler and
`pr-lifecycle.mjs`) transparently inherit the behavior.

### `reconcile.mjs` — asset-branch detection

`eligible()` in the merge-train reconciler now sets
`prFacts.skipSubstantiveReview = pr.head?.ref === 'assets/promote'`.
Art-batch PRs bypass the Copilot review gate; all other PRs are unaffected.

### `detect-art-only.sh` — `docs/*` added to `art_only` allowlist

`docs/*` is now an allowed file in the `art_only` loop. A mixed art + docs diff
(e.g. CI Recovery appending a handoff) still yields `art_only=true` and skips
the heavy sim gates. A file outside the allowlist (e.g. `set-pieces.json`)
still correctly breaks `art_only=false`.

## Tests updated

- `state.test.mjs`: added `skipSubstantiveReview` unit tests covering the
  with/without CI-blocker combinations.
- `detect-change-scope.test.ts`: updated 3 existing `docs/*` expectations
  from `art_only: false` to `art_only: true`; added art+docs mixed-diff case.

## What was NOT changed

- `pr-lifecycle.mjs` does not need an explicit change — `evaluateAdmission`
  reads `skipSubstantiveReview` from the `prFacts` it receives; callers that
  don't set it get `false` (existing behavior).
- CI Recovery routing: preventing CI Recovery from bundling `set-pieces.json`
  into asset PRs is a separate, larger concern and was not addressed here.
  The `art_only` allowlist fix mitigates the CI-cost side of that problem for
  pure-docs additions, but if a real code bug is legitimately fixed in an asset
  PR the heavy gates will correctly run.
