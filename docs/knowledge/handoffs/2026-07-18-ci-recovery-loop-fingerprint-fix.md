# Session Handoff: CI recovery loop fix — remove `line` from blocker fingerprint

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

Removed `line` (diff-position line number) from `normalizeBlockers` in
`.github/scripts/ci-recovery/state.mjs` and added a regression test.

**Root cause:** `normalizeBlockers` included `line` (GitHub review-thread diff position)
in the `blockerFingerprint`. GitHub updates this field whenever surrounding code is
modified — e.g. when `INDEX.md` is regenerated, line numbers shift. Including `line`
in the hash caused a new fingerprint on every line-shift, which `automationStallAction`
interpreted as 'progressed' and reset the attempt counter to 0, granting a fresh retry
budget for the same underlying blocker. This created an infinite recovery loop:

1. Handoff used invalid slug `sprites` → landed in `_unclassified_` in INDEX.md
2. Reviewer flagged it → CI recovery sent 2 Copilot tasks → Copilot failed
3. Commit `dad5f4e` fixed the slug → INDEX.md regenerated → thread line shifted 488 → 497
4. New fingerprint → attempt counter reset → 2 more Copilot tasks → still failed
5. Exhausted again → loop incident #1616 filed

**Fix:** Remove `line` from `normalizeBlockers`. The thread's identity is already fully
captured by its stable `id` field (`review-thread:{threadId}:{commentDigest}`). `line`
is display-only metadata that should not affect fingerprint stability.

A `✅ Addressed` reply may still be required on PR #1569's blocking review thread to unblock it.

Observed: all 116 CI recovery tests pass.

## Key Decisions Made

1. **Remove `line` only (not `path`)**: `path` (file path) is stable for a thread's
   lifetime — it doesn't change when surrounding code moves. `line` is the only
   unstable field. Minimal change.

2. **Don't auto-resolve outdated threads**: A previous PR (#1299) tried to auto-resolve
   all `isOutdated: true` threads but was reverted for being too broad. The correct fix
   is to prevent false "progress" signals from resetting the attempt budget, not to
   bypass the marker requirement.

## What's Next / Blockers

- PR #1569 still needs a trusted `✅ Addressed in <sha>` thread reply on the blocking review
  comment before `shouldResolveThread` can auto-resolve it.
- No further blockers on this session.

## Retrospective

### Lessons Learned

- `normalizeBlockers` is used for BOTH fingerprinting and state serialization; fields
  in it affect the attempt-reset logic in `automationStallAction`. Unstable positional
  fields (like line numbers) must never be included.
- The `progressKey = automationProgressKey(headSha, fingerprint)` means EITHER a head
  SHA change OR a fingerprint change triggers a "progressed" reset. Fingerprint stability
  is critical for correct stale-detection.

### Mistakes Made

None — diagnosis and fix were direct once the fingerprint change was traced.

### Opportunities for Future Improvement

- Consider whether `path` should also be excluded from `normalizeBlockers` for the same
  reasons (file renames could reset the budget), though this is lower risk since file
  renames are less common than line-number drift.
- The loop incident workflow could include the computed fingerprint diff to make it
  easier for future investigators to spot fingerprint-reset loops.
