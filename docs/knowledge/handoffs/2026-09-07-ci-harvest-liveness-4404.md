# CI harvest liveness incident follow-up

**Date:** 2026-09-07
**Verdict:** Recommended
**Apples:** 3 estimated

## Systems touched

ci-policy, ci-recovery, merge-train

## Summary

Confirmed the reported cancellation burst by inspecting run 34073228341 and
the subsequent successful recovery runs. The existing non-cancelling,
per-PR queue contract is present on the trusted workflow path. Added a
deterministic regression fixture for the observed cancelled-run burst so
cancelled harvests cannot satisfy the liveness gate.

## Verification

- `node --test .github/scripts/ci-recovery/harvest-liveness.test.mjs`
- `npm exec vitest run tests/unit/ci-liveness-sweep-workflow.test.ts`

## Runtime observation

Before: runs 34073228341, 34073621157, 34074487834, 34074704677, and
34075081544 were cancelled while six PRs waited. After: runs 34084731976 and
34084735250 completed successfully, with populated PR inputs and successful
decision-artifact capture.
