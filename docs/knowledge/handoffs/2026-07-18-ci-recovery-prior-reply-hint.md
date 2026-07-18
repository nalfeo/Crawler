# Handoff: fix(ci-recovery): add prior-unresolved-reply hint to task body

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-recovery

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Investigated CI recovery loop incident #1622 filed for PR #1265. Found that
the ci-review-validator replied to review thread `PRRT_kwDOSvo2Ms6R2xH6` with
a non-marker comment ("Blocked outside this branch") because the thread
required posting a plan comment on a linked issue (#1264). The reply changed
the thread's comment digest, which changed the blocker fingerprint, which was
correctly detected as "progress" and reset the attempt counter. On subsequent
dispatches, the task body only showed the original reviewer's complaint (via
`root?.body`) — it had NO information about the prior "Blocked" reply. The
recovery agent had no context that a prior attempt had already tried and
failed, which either causes the agent to re-investigate fruitlessly or to
re-post an identical reply (which would again change the digest, reset the
attempt counter, and delay loop-incident detection).

**Root cause**: The blocker summary for unresolved review threads only included
the original reviewer comment (`root?.body`). When a trusted recovery agent
replied without an `✅ Addressed` marker, subsequent dispatches had no
knowledge of the prior failed attempt. This is the same class of gap fixed for
stale markers (#PR-1266 handoff 2026-07-18-ci-recovery-stale-marker.md), but
for the "no marker" case rather than the "stale SHA" case.

**Fix**: After the existing `staleAddressedMarkerByThread` detection loop,
added a new `priorUnresolvedReplyByThread` loop that detects threads where:

1. The last trusted comment is NOT an `✅ Addressed` marker
2. The last comment is from a trusted author (MEMBER/COLLABORATOR/OWNER or
   trusted bot)
3. There are at least 2 comments (original reviewer + subsequent reply)
4. The thread is not already handled by the stale-marker path

When detected, the blocker summary is prefixed with:
`[Prior recovery reply (no marker posted — do not re-post an identical reply): <reply text>]`

Additionally, updated the task body review-thread protocol instructions to:

- Explain what to do when the prior-reply hint is present
- Explicitly mention using GitHub API tools (not `gh` CLI) for external
  mutations like posting to a linked issue

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs` — prior-reply detection + blocker annotation + protocol instructions
- `.github/scripts/ci-recovery/reconcile.test.mjs` — regression test

## What changed

- Added `priorUnresolvedReplyByThread` map populated after the stale-marker
  detection loop
- Updated review-thread blocker summary generation to include the prior-reply
  hint (ternary: staleSha hint → priorReply hint → plain reviewerSummary)
- Updated task body to include instructions for handling prior-reply hints

## Observe before done

- Before: `reviewerSummary` only used `root?.body`; subsequent dispatches saw
  only the reviewer's original concern with no knowledge of the prior "Blocked"
  reply
- After: blocker summary includes `[Prior recovery reply (no marker posted
— do not re-post an identical reply): ...]` when a trusted non-marker reply
  already exists, giving the next dispatch targeted context
- Real artifact: regression test `prior-reply thread includes hint in blocker
summary when last trusted comment has no marker` in
  `.github/scripts/ci-recovery/reconcile.test.mjs` (test 87, passes)

## Verification

- `node --test --test-name-pattern "prior-reply" .github/scripts/ci-recovery/reconcile.test.mjs` — 1/1 pass
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — 87/87 pass
- `node --test .github/scripts/ci-recovery/state.test.mjs` — 31/31 pass
- `npm run verify:fast` — 1294/1294 tests pass
- `npx prettier --check` — clean

## Recommended next steps

After this PR merges, trigger the CI recovery for PR #1265 so the updated
reconciler can generate an annotated task body that includes the prior-reply
hint for thread `PRRT_kwDOSvo2Ms6R2xH6`. The next dispatch will then know:

1. A prior attempt already replied with "Blocked outside this branch"
2. It should NOT re-post an identical reply
3. It should use GitHub API tools (MCP, not `gh` CLI) to post the required
   plan comment to issue #1264, then mark the thread as addressed
