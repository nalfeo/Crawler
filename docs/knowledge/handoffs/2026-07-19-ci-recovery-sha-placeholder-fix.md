# Handoff: CI Recovery — task body SHA placeholder fix

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 1🍎, actual 1🍎.

## Summary

Investigated CI recovery loop incident for PR #1273 (Queen Mab Verdigris Glamour,
issue #1668). Recovery made no progress on review thread `PRRT_kwDOSvo2Ms6R_QOR`
after 2 dispatch attempts. Root cause: the task body instructed agents to post
`` `✅ Addressed in <sha>: <one-line note>` `` but never substituted the concrete
current head SHA for the `<sha>` placeholder. Agents that did not look up the head
SHA posted `✅ Addressed:` (no SHA) or similarly invalid markers. Since
`extractAddressedMarkerSha()` requires the pattern `✅ Addressed in <valid-sha>:`,
the markers never satisfied `shouldResolveThread()`, the thread remained unresolved,
the blocker fingerprint was unchanged across cycles, and after 2 stall retries the
automation exhausted and filed the loop incident.

## Root Cause

```javascript
// Before (line 78):
const ADDRESSED_MARKER_REPLY = '`✅ Addressed in <sha>: <one-line note>`';
// ...used as-is in task body; <sha> was a literal placeholder never substituted
```

The module-level constant `ADDRESSED_MARKER_REPLY` contains the literal string
`<sha>`. The task body at lines 1697/1699 emitted this constant verbatim, so every
dispatched recovery agent saw `` `✅ Addressed in <sha>: <one-line note>` `` in
their instructions. Many agents posted `✅ Addressed: <prose>` without any SHA,
which `extractAddressedMarkerSha()` rejects (the regex `/✅\s*addressed\s+in\s+.../i`
requires the literal word "in").

## Evidence

Thread `PRRT_kwDOSvo2Ms6R_QOR` on PR #1273 accumulated 13 comments, all from
`copilot-swe-agent` trying to address the concern (PR description said "3 rounds,
final round clean" but ledger shows "2 rounds, escalated to human"). Last comment:
`✅ Addressed: corrected review-harness outcome for this PR is **2 multi-model
rounds, non-clean, escalated to human with 1 unresolved concern** (the ledger is
authoritative).` — no SHA. `shouldResolveThread()` returned false on every cycle.

## Fix

In `reconcile.mjs`, immediately before the `taskBody` array, compute a concrete
marker reply that replaces `<sha>` with the actual `headSha`:

```javascript
const concreteMarkerReply = ADDRESSED_MARKER_REPLY.replace('<sha>', headSha);
```

Every addressed-marker instruction in the task body uses `concreteMarkerReply`.
The task body now says e.g.:
`` `✅ Addressed in 2a12315feb55be26270f2024009ec9410e17238b: <one-line note>` ``

Agents only need to fill in `<one-line note>` — the correct SHA is pre-filled.

## Stale-marker fixture reconciliation

Current `main` gained explicit `✅ Not applicable: <reason>` semantics and a guard
that prevents definitively stale markers from being masked by automatic
outdated-thread resolution. The conflict resolution preserves both changes and
updates the stale-marker regression to prove an outdated thread with a
never-pushed marker remains blocked with a targeted recovery hint.

The pre-refresh branch had changed this fixture to `isOutdated: false`. That historical
correction is no longer part of the refreshed PR: the fixture is now `true`, and the test
asserts the existing stale-marker safety behavior instead.

## Files Changed

- `.github/scripts/ci-recovery/reconcile.mjs`: compute `concreteMarkerReply` from
  `ADDRESSED_MARKER_REPLY.replace('<sha>', headSha)` and use it throughout the task body;
  preserve the stale-marker guard and deterministic non-applicability guidance
- `.github/scripts/ci-recovery/reconcile.test.mjs`:
  - Added targeted assertions that actionable instructions contain `HEAD_SHA` and the
    task body does not retain the literal marker placeholder
  - Preserved current-main non-applicability coverage and corrected the stale-marker /
    outdated-thread regression expectations

## Regression Tests Added

1. `top-level-comment warning should contain the concrete current head SHA` — asserts
   the exact-thread instruction embeds `HEAD_SHA`
2. `reply_to_comment instruction should contain the concrete current head SHA` — asserts
   the actionable reply body embeds `HEAD_SHA`

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs .github/scripts/ci-recovery/state.test.mjs` — 122 tests, 0 failed
- `npm run verify:fast` — passed

## Observe Before Done

- Before: task body included `` `✅ Addressed in <sha>: <one-line note>` `` with literal placeholder; agents posted `✅ Addressed:` (no SHA); `shouldResolveThread()` returned false; fingerprint unchanged; loop exhausted.
- After: task body includes `` `✅ Addressed in abc1234def5678901234567890abcdef12345678: <one-line note>` `` (with the concrete head SHA); `extractAddressedMarkerSha()` extracts a valid SHA; `shouldResolveThread()` returns true on the next reconcile cycle.

## Risks / Follow-up

- The underlying concern on PR #1273 (PR description inaccurately stating "3 rounds, final round clean") is still unresolved. The thread will need a new recovery dispatch with the corrected task body. The next reconcile cycle will generate a task with the concrete head SHA, so the dispatched agent can post a valid `✅ Addressed in <sha>: <note>` after updating the PR description.
- The PR description of PR #1273 needs to be updated to reflect the actual 2-round multi-model review with human escalation.
