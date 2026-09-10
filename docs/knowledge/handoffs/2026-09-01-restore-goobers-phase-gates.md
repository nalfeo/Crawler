# 2026-09-01 restore Goobers phase gates

## Summary

Restored the legacy CI mutation bridge as the rollback path while Goobers does
not yet own reconciliation, review-thread, or merge-train mutation lanes.
Reopened Phase 4 and enforced the ordered Phase 0 → Phase 1 → Phase 2 →
Phase 3 → Phase 4 dependency chain.

## Systems touched

ci-policy, docs-tooling

## What changed

- set `LEGACY_CI_MUTATION_BRIDGE_ENABLED=true` so existing lifecycle automation
  remains available until its Goobers replacements are implemented and soaked;
- reopened Phase 4 (#3839), removed its Goobers approval/in-review labels, and
  marked it `goobers/status:needs-remediation`;
- removed accidental dependency edges and verified only the intended phase
  predecessor edges remain;
- added a fail-closed dependency check to `goobers-run.yml` before Goobers
  claim or repository mutation;
- corrected the README description of automatic Goobers dispatch.

## Verification

- `npm run test:unit -- tests/unit/goobers-run-workflow.test.ts --run`
- `npm run format:check`
- `bash scripts/agent/verify-fast.sh`
