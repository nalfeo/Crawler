# Handoff: Epic Status PR #1271 Final Review Recovery

**Date:** 2026-07-18  
**Session slug:** epic-status-pr1271-final-review  
**Branch:** nalfeo-floor-2-epic-control  
**PR:** #1271

## Summary

Addressed the final two open review threads from the PR #1271 recovery cycle:

1. **3608351895** (`scripts/agent/epics/epic-status.ts:84`): Extracted `applyGithubAudit` helper from `epic-status.ts` into `epic-status-lib.ts` (exported). The CLI now calls `result = applyGithubAudit(result, audit)` so `release_ready` is correctly suppressed when GitHub audit errors exist. Added a dedicated `describe('applyGithubAudit (release gate)')` suite with 3 tests pinning: (a) `release_ready = false` when audit adds errors even if offline is ready, (b) `release_ready = true` preserved when both are clean, and (c) proposal merge correctness.

2. **3608351899** (`tests/unit/agent/epic-status.test.ts:1097`): Restored all removed stacked-work protocol tests covering the full negative space: `stacked.missing-issue`, `stacked.stale-resync`, `stacked.invalid-lane`, `stacked.pr-open-missing-number`, `stacked.dependency-node-mismatch`, `stacked.dependency-pr-snapshot-mismatch`, `stacked.premature-rebase-complete`, `stacked.duplicate-ownership`, `stacked.dependent-pr-merged` (GitHub audit), and `stacked.dependent-pr-closed` (GitHub audit).

3. **Code review follow-up**: Added `node_id` assertion to the `stacked.missing-issue` test for precision.

Previously addressed (committed in earlier sessions of this recovery cycle):

- **3608166835** (schema): `stacked_work` schema, validator, audit, and tests fully restored
- **3608085312** (TREE_OBJECT_SHA): fallback changed from `'0'.repeat(40)` to `null`, using `it.skipIf(!TREE_OBJECT_SHA)`
- Path traversal fix, DAG completeness checks, not-commit error message, nodesById loop optimization, parent-slice drift test, blocked URL usage

## Systems touched

epics, testing

## Files touched

- `scripts/agent/epics/epic-status-lib.ts` — `applyGithubAudit` exported helper
- `scripts/agent/epics/epic-status.ts` — CLI refactored to use `applyGithubAudit`
- `tests/unit/agent/epic-status.test.ts` — stacked-work protocol tests + release gate tests + node_id assertion

## Verification run

- `npx vitest run --project unit tests/unit/agent/epic-status.test.ts`: 54/54 tests passing
- `npm run verify:fast`: 1260/1260 tests passing, all 4 steps clean

## Unresolved issues

None.

## Recommended next steps

- Arm auto-merge on PR #1271 once CI is green
