---
title: Goobers staged implementation timeout and resume contract
date: 2026-09-09
status: complete
---

## Systems touched

ci-policy

## Summary

Implemented issue #4444's staged Goobers timeout and recovery contract. The
reserve job remains bounded at 20 minutes, while the run job derives each lane
deadline with a separate 50-minute implementation cap inside the 90-minute
host budget and cleanup reserve.

Timeout handling now discovers the actual Goobers git worktree, commits tracked
and untracked changes when possible, and writes a versioned resume contract
with branch, checkpoint SHA or an explicit no-checkpoint reason, latest failure,
terminal status, and artifact URL into the uploaded slot diagnostics. Manual
resumes must provide branch, checkpoint SHA when available, and actionable
failure inputs; the workflow refuses partial contracts or dirty worktrees.

## Verification

- `npm test -- --run tests/unit/goobers-run-workflow.test.ts`
- `npm test -- --run tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts`

## Risk

The timeout checkpoint commit runs only in the isolated Goobers worktree and
only on the deadline teardown path. A missing or uncommittable worktree is
reported as an explicit no-checkpoint contract, so recovery cannot silently
pretend that a patch was preserved.
