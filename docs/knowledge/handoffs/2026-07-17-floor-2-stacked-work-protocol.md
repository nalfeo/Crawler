# Session Handoff: Durable speculative stacked-work protocol

**Date:** 2026-07-17  
**Session slug:** floor-2-stacked-work-protocol  
**Branch:** copilot/add-durable-speculative-tracking  
**PR base:** nalfeo-floor-2-epic-control  
**Issue:** #1282 (closes)  
**Apples:** 🍎🍎🍎 estimated → 🍎🍎🍎 actual (exact)

## Systems touched

epics

## What Was Done

Added the durable speculative stacked-work protocol to the Floor 2 equipment epic
control plane (`scripts/agent/epics/epic-status-lib.ts`). This allows nodes that are
lifecycle `blocked` to track speculative work proceeding on an exact stacked branch,
without weakening lifecycle status, dependency validation, or downstream readiness.

### Schema changes

- Added `stackedWorkSchema` Zod schema (nullable) to each node
- Fields: `status` (`stacked_in_progress` | `stacked_pr_open`), `owner` (claimant/session/branch/claimed_at), `dependency` (node_id/pr_number/repository/branch/head_sha), `dependent` (head_sha/pr_number), `resync` (head_sha/at), `rebase_to_main` (state/completed_at), `material_drift`, `block_reason`
- Updated `epic-state.schema.json` with `stackedWork` JSON Schema definition
- Added `stacked_work: null` to all 37 nodes in `epic-state.json`

### Offline validation (7 rules)

| Code                                        | Rule                                             |
| ------------------------------------------- | ------------------------------------------------ |
| `stacked.non-blocked-status`                | stacked_work only while lifecycle is blocked     |
| `stacked.missing-issue`                     | requires materialized child issue                |
| `stacked.stale-resync`                      | resync must be within 48 hours                   |
| `stacked.invalid-lane`                      | verification lane forbidden                      |
| `stacked.dependency-node-mismatch`          | dependency.node_id must be in node.dependencies  |
| `stacked.dependency-pr-snapshot-mismatch`   | pr_number must match tracked dep PR if present   |
| `stacked.premature-rebase-complete`         | complete only when all deps are merged/validated |
| `stacked.rebase-complete-missing-timestamp` | completed_at must be non-null when complete      |
| `stacked.pr-open-missing-number`            | stacked_pr_open requires dependent.pr_number     |

Plus cross-node: `stacked.duplicate-ownership` (one stacked-work slot per session).

### GitHub audit extension

For nodes with `stacked_work`, `auditGithub()` now:

- Audits the dependency PR: proposes head_sha patch + operator action on advancement/merge
- Audits the dependent PR (stacked_pr_open): proposes head_sha patch; errors on unexpected merge or close

### Recovery documentation

Created `docs/knowledge/epics/floor-2-equipment/STACKED-WORK-RECOVERY.md` covering:

- Preconditions for starting stacked work
- Resync cadence (48h window)
- Rebase-to-main steps (after dependency merges)
- Normal-lifecycle handoff steps (after dependency validates)
- Abandonment procedure
- GitHub audit signal table
- Complete invariants table

### Tests

31 total tests (16 new stacked-work focused tests), all passing.

## Key Design Decisions

1. **Nullable sub-object (not new top-level status)** — stacked work is orthogonal to lifecycle. Status stays `blocked`. No risk of false readiness.
2. **`merged` is sufficient for rebase gate** — Matches the recovery doc and practical workflow (rebase on merge, not after full CI validation).
3. **`dependency.node_id` required** — Ties the stacked work explicitly to one of the node's listed dependencies; enables cross-validation with the dep node's tracked PR.
4. **`verification` lane forbidden** — Can't verify speculatively.
5. **Read-only GitHub audit** — Proposes patches, never writes completion state.

## Code Review

Round 1 (rubber-duck plan review): 5 concerns → 5 resolved
Round 1 (code review): 2 bugs → 2 fixed (premature-rebase gate allowed `merged`; missing null `completed_at` check)
Round 2 (code review): 3 style/doc issues → 3 resolved

Ledger: `docs/knowledge/review-ledgers/2026-07-17-floor-2-stacked-work-protocol.review-ledger.json`

## Files Changed

- `scripts/agent/epics/epic-status-lib.ts` — Core schema + validation + audit
- `docs/knowledge/epics/floor-2-equipment/epic-state.json` — stacked_work: null on all nodes
- `docs/knowledge/epics/floor-2-equipment/epic-state.schema.json` — stackedWork def
- `docs/knowledge/epics/floor-2-equipment/STACKED-WORK-RECOVERY.md` — Recovery doc
- `tests/unit/agent/epic-status.test.ts` — 16 new focused tests

## Lessons

- When gating on "dependency landed," use `merged OR validated` rather than `dependenciesSatisfied()` (which requires `validated`). The latter is the right predicate for readiness; the former is the right predicate for rebase timing.
- Always cross-check recovery doc semantics against validation code during plan review.
