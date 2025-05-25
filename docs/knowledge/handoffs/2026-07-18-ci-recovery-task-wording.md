# Handoff: CI Recovery task-body wording fix — review-thread reply placement

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎 exact (single-function wording patch + targeted test)

## What Was Done

Investigated CI recovery loop incident #1583 (PR #1507 — merchant-sandals brief).

### Root cause

The CI recovery reconciler dispatched a Copilot agent to fix five unresolved review
threads on PR #1507. The agent replied `✅ Addressed in 6b4f10f` to the **CI
recovery task comment** (issue comment ID 5010488834) rather than to each individual
**review thread** via `reply_to_comment`.

`shouldResolveThread` only scans `thread.comments.nodes` (review-thread replies) for
the marker. A regular PR issue comment is invisible to this function. The threads
stayed unresolved, the `progressKey` never changed (head SHA and blocker fingerprint
were both stable), and after two stall cycles (`stallAttempt >= 2`) the automation
exhausted and filed loop incident issue #1583.

Evidence trail (PR #1507 comments):

- `5010488834` — CI recovery task dispatch (fingerprint `7d9d147c`)
- `5010511825` — Copilot's reply `✅ Addressed in 6b4f10f` → **wrong target**
- `5010654429`, `5010829252` — two more task dispatches with the same fingerprint,
  confirming the automation detected zero progress

### Fix

Updated the "when addressed" instruction at the bottom of `taskBody` in
`reconcile.mjs` to be unambiguous:

- Must call `reply_to_comment` with the per-thread **Reply target comment ID**
  listed in the task (not the task comment's own ID)
- Explicitly states that replying to the task comment itself is NOT recognised
- Clarifies that the **reconciler** resolves the thread automatically; the agent
  does not need to call `resolveReviewThread`

Added two regression assertions to the existing
`live reconcile task comment includes explicit review-thread reply comment IDs` test
in `reconcile.test.mjs`:

1. Task body must include "not the ID of this task comment"
2. Task body must include "a marker reply on the review-thread comment is the only
   form recognised by the reconciler"

## Key Decisions Made

- Smallest possible change: one line in `taskBody`, two new assertions. No changes
  to `shouldResolveThread`, `extractAddressedMarkerSha`, or any state schema.
- The marker parser is correct — `✅ Addressed in 6b4f10f: ...` parses fine. The
  bug was placement (wrong GitHub comment type), not format.
- No data-migration or state migration needed: the CI recovery state for PR #1507 is
  already idle after the exhaustion release; the next reconcile cycle will dispatch a
  fresh task with the updated wording.

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs .github/scripts/ci-recovery/state.test.mjs`
  — 115 tests, 0 failed
- `npm run verify:fast` — passed (4255 tests, all green after unshallowing to fix the
  pre-existing `epic-status.test.ts` shallow-clone failure)

## Observe before done

The "✅ Addressed" marker was placed in issue comment 5010511825 (visible in PR
#1507's comment list) instead of in each review thread. `shouldResolveThread` in
`state.mjs` reads `thread.comments.nodes` and never reaches issue comments, so the
marker was silently ignored. After the fix the task body explicitly names the right
target (review-thread comment ID), preventing the same mismatch.

## Risks / Follow-up

- The fix closes the ambiguity but does not retroactively resolve the five open threads
  on PR #1507. The next CI recovery dispatch to that PR will carry the clearer
  wording, and the responsible Copilot session should address the two still-applicable
  threads:
  1. `PRRT_kwDOSvo2Ms6R8xe1` (line 16, `briefs/items/merchant-sandals.yaml`) —
     "ankle wrap" vs. "no visible ankle" conflicting constraint.
  2. `PRRT_kwDOSvo2Ms6R8xek` (line 52, handoff) — environment-specific
     "token is invalid" language.
