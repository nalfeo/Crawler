# Persistent CI recovery blocker attempts

## Date

2026-08-14

## Persona

Velocity Engineer / DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎 — exact.

## Summary

- Deterministic telemetry identified PR #2823 as the top live delivery bottleneck: 56.5 hours open and at least 12 CI-recovery dispatches against one unresolved review thread.
- A live recovery run recorded `stateAttempt: 1` despite the unchanged blocker, confirming that head-only commits repeatedly reset the retry ceiling.
- CI recovery now treats blocker-fingerprint changes as progress, preserves attempts across head-only drift and interrupted releases, and reaches the existing loop-incident path after exhaustion.

## Evidence

- Merged-PR sample: 1.04h median lead time; review queue 0.09h, active rework 0.49h, merge queue 0.27h.
- Guard telemetry: `pr-review-ledger` 8/216 denials (3.7%); `pr-preflight` 7/240 (2.9%).
- Apple telemetry since August 1: 23/24 exact, zero underestimated.
- CI Recovery run `31786065094`, job `94722125874`: same blocker fingerprint, `progressKeyMatches: true`, `stateAttempt: 1`, then another dispatch.

## Before / after

- Before: every ineffective recovery commit advanced the head and reset the retry attempt to 1 indefinitely.
- After: an unchanged blocker carries the retry count across head changes; attempt 2 files/updates the loop incident and releases ownership. A changed blocker fingerprint still receives a fresh budget.

## Verification

- `node --test .github/scripts/ci-recovery/*.test.mjs` — 721 passed.
- ESLint on the five touched CI-recovery files — passed.
- `bash scripts/agent/verify-fast.sh` — passed.
- Independent grade — pass (5/4/5/5/5).

## References

Refs nalfeo/Crawler#2914
