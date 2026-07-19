# Session Handoff: epic-status CI recovery

**Date:** 2026-07-18  
**Session slug:** epic-status-ci-recovery  
**Branch:** copilot/add-durable-speculative-tracking  
**PR:** #1284  
**Apples:** 🍎🍎 estimated → 🍎🍎 actual (exact)

## Systems touched

ci-policy, docs-tooling

## What Was Done

- Restored the missing schema-derived `EvidenceRecord` alias in `scripts/agent/epics/epic-status-lib.ts`, clearing the repo-wide TypeScript failure that was breaking advisory checks.
- Updated `.github/workflows/ci.yml` so the `Unit Tests` and `Unit Tests (coverage)` jobs fetch full git history before running `epic-status.test.ts`; this keeps the historical-object merge test reproducible in CI.
- Refreshed the Floor 2 epic state's `offline-validator-and-focused-tests` evidence commit to the current branch head commit that already contains the recorded test-file hash, so offline epic validation is immutable and green again.

## Validation

- `npm run typecheck`
- `npm run test:unit -- tests/unit/agent/epic-status.test.ts`
- `npm run epic:status -- floor-2-equipment`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Notes

- `files/guard-telemetry.jsonl` was not present, so no telemetry capture was required.
