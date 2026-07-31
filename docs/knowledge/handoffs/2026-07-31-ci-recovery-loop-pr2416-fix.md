# Handoff: Fix CI recovery loop stall on PR #2416

**Date:** 2026-07-31  
**Session slug:** ci-recovery-loop-pr2416-fix  
**Apple estimate:** 🍎  
**Systems touched:** ci-recovery

## Summary

Incident #2420: the CI recovery automation stalled on PR #2416 after 2 failed
recovery attempts and filed an incident. Root cause was a missing `✅ Addressed in
<sha>` reply on 7 review threads; the fix was to post those replies and re-land the
feature work on a clean branch.

## Root cause

PR #2416 (`feat(sprites): harvest orphaned assets/checkin-* branches`) had 7
unresolved review-thread findings. A previous Copilot session (commit `179554a7`,
pushed 2026-07-31T03:49:52Z) addressed ALL 7 findings in the code, but **never
posted `✅ Addressed in <sha>` replies** to the review threads.

As a result:
1. `shouldResolveThread()` in `state.mjs` always returned `false` — the marker
   parser found no trusted comment containing `✅ Addressed in 179554a7...`
2. The blocker fingerprint was unchanged across 2 stale 30-minute windows
3. `automationStallAction()` returned `'release'` when `stallAttempt >= 2` and
   filed incident #2420

The automation itself (state machine, marker parser, permission grant) had **no
code defect** — it worked exactly as designed. The failure was purely process:
the fixing session omitted the required thread replies.

## Fix

1. Posted `✅ Addressed in 179554a71407ba80a97de0ea5504bbfa442f73bf` replies to
   all 7 unresolved review threads on PR #2416 via `engine-tools-reply_to_comment`.
2. The CI recovery reconciler auto-resolved all 7 threads on its next sweep (within
   ~10 minutes).
3. PR #2416's CI checks are all passing; the reconciler dispatched a prefix
   validation to arm auto-merge.
4. Cherry-picked all 5 commits from PR #2416's branch onto
   `copilot/fix-ci-recovery-loop-pr-2416` (PR #2421) as a clean re-land of the
   feature work.

## Key finding: no code defect in CI recovery automation

The `shouldResolveThread` → `markerNamesHead` → `extractAddressedMarkerSha`
pipeline in `state.mjs` is correct. `'179554a71407ba80a97de0ea5504bbfa442f73bf'
.startsWith('179554a7')` is `true`, so markers with short SHA `179554a7` work
correctly once posted.

The `automationStallAction` stall/release logic at `stallAttempt >= 2` is also
correct — two stale windows is the right escalation threshold.

**No regression test was added to the CI recovery automation** because there is no
code defect to test.

## No regression test needed

The failure mode (agent addresses code but omits thread replies) is a process
failure, not a code defect. The correct remediation is operational awareness:
when posting fixes to a PR review, **always post `✅ Addressed in <sha>` replies
to every addressed thread** in the same session.

## Remaining work

- **PR #2421** is in draft state (engine-tools created it as `[WIP]`). The GitHub
  API is blocked in the sandbox environment, so it could not be converted to
  non-draft programmatically. @nalfeo should click "Ready for review" to convert
  it, OR close it if PR #2416 successfully merges first (both contain the same
  feature work; only one should land).
- **PR #2416** should auto-merge via CI recovery once the prefix validation
  completes. If it does, **close PR #2421** to avoid a duplicate merge conflict.

## Files touched

- `scripts/sprites/asset-pr.ts` (cherry-pick from #2416)
- `scripts/sprites/reconcile-queue.ts` (cherry-pick from #2416)
- `tests/unit/sprites/reconcile-queue.test.ts` (cherry-pick from #2416)
- `.github/skills/asset-pr/SKILL.md` (cherry-pick from #2416)
- `.github/skills/asset-pr/references/playbook.md` (cherry-pick from #2416)
- `docs/knowledge/handoffs/2026-07-31-asset-pr-orphaned-branch-pickup.md` (cherry-pick)
- `docs/knowledge/review-ledgers/2026-07-31-asset-pr-orphaned-branch-pickup.review-ledger.json` (cherry-pick)
