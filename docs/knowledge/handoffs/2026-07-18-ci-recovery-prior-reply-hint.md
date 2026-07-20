# Handoff: CI Recovery — prior non-marker reply hint

**Date:** 2026-07-18  
**Branch:** `copilot/fix-ci-recovery-loop-1623`  
**PR:** fixes CI recovery loop on PR #1623 (issue #1626)

## Systems touched

ci-policy

## Problem

The automated CI recovery pipeline failed to converge on PR #1623 after 2 attempts. Root cause: when a Copilot recovery agent replied to a review thread without posting an `✅ Addressed` marker (e.g. a "Blocked outside this branch" diagnostic comment), subsequent recovery dispatches saw only the original reviewer complaint with no context that a prior attempt had already tried and failed. The agent would re-post an identical reply, which changed the comment digest, reset the stall attempt counter, and delayed loop-incident detection indefinitely.

## Changes

### `.github/scripts/ci-recovery/reconcile.mjs`

1. **`KNOWN_RECOVERY_REPLY_LOGINS`** — new constant (Set) restricted to known Copilot recovery bot logins (`copilot`, `copilot[bot]`, `copilot-swe-agent`, `copilot-swe-agent[bot]`, `app/copilot`, `app/copilot-swe-agent`). This is intentionally narrower than `TRUSTED_ASSOCIATIONS` which covers any MEMBER/COLLABORATOR — a MEMBER reviewer who adds a follow-up comment must not be mistaken for a prior recovery dispatch.

2. **`priorUnresolvedReplyByThread`** — detection loop (mirrors `staleAddressedMarkerByThread` pattern): after the stale-marker loop, identifies unresolved threads whose last comment is from `KNOWN_RECOVERY_REPLY_LOGINS` but carries no `✅ Addressed` marker and where at least 2 comments exist (original reviewer + reply).

3. **Blocker summary ternary** — extended to a 3-way: `staleSha → stale-marker hint`, `priorReply → prior-reply hint`, `else → plain summary`. The prior-reply hint format is `[Prior recovery reply (no marker posted — do not re-post an identical reply): <truncated-body>] <reviewer-summary>`.

4. **Task body protocol paragraph** — added after the existing review-thread protocol to instruct recovery agents not to re-post identical replies and to use GitHub API tools for external actions.

### `.github/scripts/ci-recovery/reconcile.test.mjs`

- Added `escapeRegex` helper function.
- **`prior-reply thread includes hint in blocker summary when last trusted comment has no marker`**: Regression test for the PR #1623 scenario. The key assertion checks `[Prior recovery reply...: ${priorBlockedReply}]` inside the hint (anchored to the bracketed format, not loose regexes that could match the unconditional protocol paragraph).
- **`prior-reply hint ignores non-recovery collaborator follow-up comments`**: Confirms that `trusted-maintainer` (not in `KNOWN_RECOVERY_REPLY_LOGINS`) does not trigger the hint.

## Review thread resolution

- **PRRT_kwDOSvo2Ms6SAMzQ** (line 1081 — trust-association breadth): Fixed by using `KNOWN_RECOVERY_REPLY_LOGINS.has(authorLogin)` instead of `TRUSTED_ASSOCIATIONS.has(authorAssociation) || TRUSTED_BOT_LOGINS.has(authorLogin)`.
- **PRRT_kwDOSvo2Ms6SAMzX** (line 6313 — weak test assertions): Fixed by removing the loose `/Prior recovery reply.*no marker posted/i` and `/do not re-post an identical reply/i` regexes (which also matched the unconditional protocol paragraph) and replacing with a single strong assertion that checks `priorBlockedReply` is inside the bracketed hint.

## Verification

- `npm run verify:fast` — all 88 reconcile tests + 1294 unit tests passed
- `parallel_validation` — no issues found
