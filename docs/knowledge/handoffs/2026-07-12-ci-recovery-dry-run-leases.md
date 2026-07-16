# Session Handoff: CI Recovery Dry-Run Leases

## Date

2026-07-12

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

- Made explicit shepherd acquire, heartbeat, and release operations persist while
  automated CI recovery remains in `dry-run`.
- Kept automated reconciliation shadow-only and preserved `off` mode.
- Added regression coverage for every mode and lease operation.

## Verification

- The referenced run failed because a dry-run lease acquisition could not persist
  the ownership label or sticky state, so its later heartbeat had no matching lease.
- `node --test ".github/scripts/ci-recovery/*.test.mjs"` passed.
- `npm run verify:fast` passed.

## Retrospective

### Lessons Learned

The recovery rollout mode and explicit lease ownership are separate concerns:
shadowing automated repair must not disable the ownership primitive that prevents
automation and shepherds from racing.

### Mistakes Made

The dry-run mode accidentally blocked lease persist operations, causing heartbeat
failures for leases that were never successfully acquired under dry-run, because
the ownership primitive was gated on the same rollout flag as automated repair.

### Opportunities for Future Improvement

Add explicit rollout-mode matrix tests verifying each lease operation (acquire,
heartbeat, release) independently across all three modes (off / dry-run / on) to
catch similar regressions before they reach production.
