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

The recovery rollout mode and explicit lease ownership are separate concerns:
shadowing automated repair must not disable the ownership primitive that prevents
automation and shepherds from racing.
