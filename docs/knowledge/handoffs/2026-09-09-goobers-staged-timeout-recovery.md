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

Timeout handling now tears down only the launched slots that are still alive,
then discovers the actual Goobers git worktree, commits tracked and untracked
changes when possible, pushes the checkpoint to the recovery branch, and writes
a versioned resume contract with branch, checkpoint SHA or an explicit
no-checkpoint reason, latest failure, terminal status, and artifact URL into the
uploaded slot diagnostics. Unsafe teardown writes an explicit unsafe-to-checkpoint
reason instead of snapshotting a live writer.

Resume contracts are now assignment-scoped: only `cohort: resume` assignments
require the contract, the reserve job binds branch/checkpoint/failure to the
selected issue and PR, and the run job verifies the fetched checkpoint in the
per-slot resume checkout before launching Goobers. The Goobers workflow also
passes checkpoint/failure context through the resumed issue context and pins the
actual agentic task budgets (`plan: 20`, `implement: 50`).

## Verification

- `npm test -- --run tests/unit/goobers-run-workflow.test.ts`
- `npm test -- --run tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-run-slot-cleanup.test.ts`
- `npm test -- tests/unit/goobers-run-workflow.test.ts`
- `npm test -- tests/unit/goobers-run-slot-cleanup.test.ts`
- `npm run verify:fast`

## Risk

The timeout checkpoint commit runs only in the isolated Goobers worktree and
only on the deadline teardown path. A missing or uncommittable worktree is
reported as an explicit no-checkpoint contract, so recovery cannot silently
pretend that a patch was preserved.
