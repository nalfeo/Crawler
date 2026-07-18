# Handoff: Fix CI recovery loop blocking on outdated review threads

**Date:** 2026-07-18  
**Branch:** fix/ci-recovery-outdated-thread-blocker  
**Issue:** #1611 (CI recovery loop: PR #1503)  
**PR:** closes #1611

## Systems touched

ci-recovery

## What was broken

The CI recovery automation looped indefinitely on PR #1503 because it treated an
`isOutdated: true` review thread as an active blocker. Thread 2
(`PRRT_kwDOSvo2Ms6R9SwG`) was a cosmetic YAML line-wrapping comment made by
`copilot-pull-request-reviewer`; a subsequent commit modified the file, making the
thread outdated. Despite this, `reconcile.mjs` filtered threads only by
`!isResolved`, not `!isOutdated`, so the thread remained a blocker indefinitely.

There were two concrete symptoms:

1. **Spurious task dispatches** — The recovery automation posted `@copilot` task
   comments for a thread whose code no longer exists at that location. The agent
   could not deterministically address the thread, so no progress was made.

2. **Fingerprint instability** — The GraphQL `thread.line` field for outdated threads
   is non-deterministic (returned `10` on the first read of PR #1503, then `null` on
   subsequent reads). This caused the `blockerFingerprint` to change between reconciler
   runs, triggering the "active-copilot-progress backpressure" code which silently
   reset the attempt counter and updated state without posting a new task. This
   compounded the stall.

## Root cause

`reconcile.mjs` line 1264 (before fix):

```javascript
for (const thread of review.threads.filter((candidate) => !candidate.isResolved)) {
```

The filter excluded resolved threads but **not outdated threads**. Outdated threads
(`isOutdated: true`) represent code that no longer exists at that diff location.
GitHub's branch protection rules do not treat outdated threads as merge blockers;
the CI recovery automation should not either.

## Fix

Exclude `isOutdated: true` threads from the blocker list (one-line change):

```javascript
for (const thread of review.threads.filter(
  (candidate) => !candidate.isResolved && !candidate.isOutdated,
)) {
```

The `unresolvedThreads` variable used for marker-based auto-resolution (line 937)
is intentionally left unchanged: outdated threads that have a trusted `✅ Addressed`
marker should still be eligible for cleanup resolution, but they no longer contribute
to the blocker list or the `blockerFingerprint`.

## Tests added

Two regression tests in `.github/scripts/ci-recovery/reconcile.test.mjs`:

1. **"outdated review thread is not treated as a blocker — no task dispatch when only
   blocker is outdated"** — Verifies that a PR with only an outdated thread reaches
   the admission-wait path rather than dispatching a recovery task.

2. **"outdated thread does not affect fingerprint when line field is non-deterministic"**
   — Runs two reconciler instances with `line: 10` and `line: null` on the same
   outdated thread, confirms both produce identical `blockerFingerprint` values and
   that the outdated thread ID never appears in the dispatched task comment.

## Verification

- All 86 reconcile tests pass (84 pre-existing + 2 new).
- All 31 state tests pass.
- `verify:fast` passes (one pre-existing `epic-status.test.ts` failure due to
  missing git history in shallow clone is unrelated to this change).
