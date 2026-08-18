# Stacked PR detection: ref-path encoding bug in CI Recovery Router

**Date:** 2026-08-17
**Apples:** 🍎🍎 (tooling-only; no runtime gameplay or shipped game data changed)

## Systems touched

ci-recovery

## Summary

PRs #3027 and #3033 sat as a diverged stack and no automation ever detected or
directed them for reconciliation. Root cause: `ci-recovery/router.mjs` built
ref-bearing GitHub API paths with `encodeURIComponent(baseRef)`. Git refs are
path-shaped, so `copilot/foo` became `copilot%2Ffoo`, and GitHub's `compare` and
`git/ref/heads` endpoints reject that with a 404:

```
GitHub GET /repos/nalfeo/Crawler/compare/copilot%2Fperf-nightly-gameplay-neutral-optimization-pass...main failed (404)
```

Every `copilot/*` branch contains a slash, so the stale-base pass 404'd on its
first candidate and threw out of the loop, aborting the whole router run and
skipping every remaining PR. Stacked PRs were therefore never detected — the
detector had never once succeeded on a real branch name.

Fix: a shared `encodeRefPath()` in `ci-recovery/github.mjs` encodes each path
segment but keeps `/` literal. Applied to the router's `git/ref/heads` and
`compare` calls, and to `review-wake-bridge.mjs`'s `compareCommits` (same latent
bug, not yet observed firing). A failing base `compare` now logs
`reason=base-compare-failed` and `continue`s to the next PR rather than aborting
the batch, matching the pre-existing branch-lookup failure handling.

## Files touched

- `.github/scripts/ci-recovery/github.mjs` — new `encodeRefPath()` helper
- `.github/scripts/ci-recovery/router.mjs` — use it; per-PR compare failure isolation
- `.github/scripts/ci-recovery/review-wake-bridge.mjs` — use it in `compareCommits`
- `.github/scripts/ci-recovery/router.test.mjs` — two regression tests

## Verification run

- `node --test .github/scripts/ci-recovery/router.test.mjs` → 134 pass / 0 fail
- Fail-to-pass confirmed: stashing only `router.mjs` yields 132 pass / **2 fail**,
  so the new tests genuinely cover the bug rather than the fix.
- `node --test .github/scripts/ci-recovery/review-wake-bridge.test.mjs` → 45 pass / 0 fail
- Prettier and ESLint clean on all four changed files.

## Live remediation performed

Both PRs were `MERGEABLE` but `BEHIND`. Note for future automation work: GitHub's
stack feature refuses both remediation paths the router would normally take —

- `PATCH /pulls/3033 base=main` → `422 Cannot change the base branch because the
pull request is part of a stack.`
- `PUT /pulls/3027/update-branch` → `403 Updating a stacked PR's branch via this
endpoint is not supported.`

Unblocked instead by merging forward with a plain git push (main → #3027's branch,
then #3027's branch → #3033's branch). Both moved from `BEHIND` to
`MERGEABLE`/`BLOCKED` (CI pending only).

## Stacked-PR remediation (also fixed in this PR)

Both remediations CI Recovery would normally apply are refused by GitHub's
stacked-pull-request feature (see the two errors above). This path had never been
exercised because detection always 404'd first.

The router now catches that specific `422` (`isStackedRetargetRefusal`, matched on
the "part of a stack" message so a genuine bad-base 422 is not silently
downgraded) and falls back to `mergeMainForward()`:
`POST /repos/{o}/{r}/merges` with `base=<head ref>`, `head=main`. The merges API
is **not** stack-gated, so it is the one automatic path that clears a stacked PR's
`BEHIND` state; it leaves the stack intact rather than unstacking on the human's
behalf. A `409` is reported as `result=conflict` and any other error as
`result=failed`, both explained in the PR comment, so a real conflict routes to
human/conflict-coordinator attention.

Notably, the repo's own `crawler/no-rethrow-in-automation-catch` ESLint rule
caught a defect in the first draft of this fallback: re-throwing a non-stack 422
from inside the per-PR loop would have abandoned every remaining PR in the batch —
the same class of bug that once deadlocked the merge queue. Every failure mode in
this path now logs and `continue`s.

## Unresolved issues

None blocking. The stale-base path now degrades in stages: retarget → merge
forward → conflict/failed comment for a human, and no failure mode aborts the
batch.

## Recommended next steps

1. Consider an assertion or lint rule that flags `encodeURIComponent(<ref>)` in
   API path construction across `.github/scripts/`, since the same bug existed
   independently in two files.
2. Watch the first real `stale-base-stacked ... action=merge-forward` log line in
   production to confirm the merges API behaves as expected against a live stack.
