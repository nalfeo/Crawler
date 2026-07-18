# Handoff: Fix CI recovery loop blocking on outdated review threads

**Date:** 2026-07-18  
**Branch:** fix/ci-recovery-outdated-thread-blocker  
**Issue:** #1611 (CI recovery loop: PR #1503)  
**PR:** closes #1611

## Systems touched

ci-recovery

## What was broken

The CI recovery automation looped indefinitely on PR #1503 because an unresolved
outdated review thread stayed in the blocker set, but its GraphQL `thread.line`
metadata was non-deterministic (`10` on one read, `null` on another). That let the
same logical blocker hash differently across runs, which tripped the
"active-copilot-progress backpressure" path and silently churned attempts without
stable progress.

The first attempted fix on this branch was too broad: it removed unresolved
outdated threads from the blocker set entirely. Review correctly flagged that as a
policy violation because merge-train still blocks on every unresolved review
thread, outdated or not. Excluding them would have made ci-recovery claim
convergence while downstream admission still rejected the PR.

## Root cause

The blocker fingerprint included `thread.line` for every unresolved review thread,
including outdated ones. For stale threads GitHub can return that field
non-deterministically, so identical unresolved review state produced different
`blockerFingerprint` values across runs.

## Fix

- Keep **all unresolved review threads** in ci-recovery blockers so the reconcile
  path stays aligned with merge-train / ADR 0058 review-resolution policy.
- Canonicalize stale-thread metadata by omitting `line` from the blocker record
  when `thread.isOutdated === true`. The blocker still exists, but its fingerprint
  no longer depends on unstable GraphQL line data.
- Make the focused `epic-status` unit test shallow-clone safe by using the
  existing injected `GitReader` seam instead of shelling out to
  `git rev-parse <hardcoded-sha>^{tree}`.
- Refresh the Floor 2 equipment epic-state fixture's
  `offline-validator-and-focused-tests` SHA so it matches the updated test file.

## Tests added / updated

Two regression tests in `.github/scripts/ci-recovery/reconcile.test.mjs` now cover
the correct policy:

1. **"outdated review thread still dispatches a recovery task when it is the only
   blocker"** — Verifies that an unresolved outdated thread still blocks recovery
   and produces a repair task.

2. **"outdated thread does not affect fingerprint when line field is non-deterministic"**
   — Runs two reconciler instances with `line: 10` and `line: null` on the same
   outdated thread, confirms both produce identical `blockerFingerprint` values,
   and confirms both the active and outdated review-thread blockers remain present
   in the dispatched task comment.

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run test:unit -- tests/unit/agent/epic-status.test.ts`
- `npm run verify:fast`
