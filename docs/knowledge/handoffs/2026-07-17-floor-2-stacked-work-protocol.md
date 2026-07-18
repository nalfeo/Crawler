# Handoff: Floor 2 Speculative Stacked-Work Protocol

**Date:** 2026-07-17
**Session slug:** floor-2-stacked-work-protocol
**Apple estimate:** 3🍎
**PR:** TBD (base: `nalfeo-floor-2-epic-control`)
**Closes:** nalfeo/Crawler#1285

## Summary

Implements speculative stacked-work metadata for the Floor 2 equipment epic control plane (child issue #1282 of epic #1264). The work allows otherwise-unblocked dependent nodes to track active speculative development on branches stacked from in-review dependency PRs, without weakening any existing lifecycle invariants.

The key design principle: **node `status` remains `blocked` while `stacked_work` tracks orthogonal speculative progress**. These two concerns are completely separate — speculative metadata never enters the ready queue and is never visible to the normal lifecycle promotion path.

## Systems touched

`epic-control-plane`

## What was changed

### `scripts/agent/epics/epic-status-lib.ts`

- Added `SPECULATIVE_MODES` constant set (`stacked_in_progress`, `stacked_pr_open`)
- Added `stackBaseSchema` Zod schema: one entry per unvalidated direct dependency, recording `dependency_node_id`, `dependency_pr_number`, `dependency_branch`, `last_resynced_head`, `requires_main_rebase`
- Added `stackedWorkSchema` Zod schema: `mode`, `issue`, `session`, `branch`, `pr` (nullable), `stack_bases` array
- Added optional `stacked_work` field to `nodeSchema`
- Added `STACKED-WORK` to `epicStateSchema.claim_policy.protocol_headings` tuple (minItems 5→6)
- Updated `validateCommittedSchema`: minItems check 5→6, added `stackBase`/`stackedWork` `$defs` presence checks
- Updated `computeReady`: blocks nodes with any `stack_base.requires_main_rebase === true` from entering `ready_queue`
- Added `validateStackedWork(node, allNodes, errors)`: ~100 lines of deterministic validation covering all stale/missing/invalid configurations
- Updated `validateDuplicateOwnership`: checks `stacked_work.session` and `stacked_work.issue.number` uniqueness across nodes
- Added speculative PR audit block in `auditGithub`: validates open speculative PRs, proposes head SHA updates, emits operator actions for merged/closed speculative PRs

### `docs/knowledge/epics/floor-2-equipment/epic-state.schema.json`

- Added `STACKED-WORK` to `protocol_headings` prefixItems (minItems 5→6)
- Added optional `stacked_work` property to `node` definition (not in `required`)
- Added `stackBase` and `stackedWork` `$defs` (~130 lines)

### `docs/knowledge/epics/floor-2-equipment/epic-state.json`

- Added `"STACKED-WORK"` to `claim_policy.protocol_headings` (between `"CLAIMED"` and `"BLOCKED"`)

### `docs/knowledge/epics/floor-2-equipment/PLAN.md`

- Updated Lifecycle section: added rule 6 for `requires_main_rebase`, added speculative note
- Updated Progress protocol section: added `STACKED-WORK` heading
- Added full "Speculative stacked-work protocol" section (~80 lines) with tables and subsections
- Updated Cold-start runbook with stacked-work steps

### `tests/unit/agent/epic-status.test.ts`

Added `describe('speculative stacked-work metadata', ...)` block with 11 tests:

1. Accepts a valid `stacked_work` block on a blocked node with `pr_open` dep
2. Node with `stacked_work` remains lifecycle-blocked and absent from `ready_queue`
3. `ready_queue` stays clear even when all deps would otherwise be validated (`requires_main_rebase`)
4. Rejects stale dep head: `last_resynced_head` does not match dep PR `head_sha`
5. Rejects speculative work on a dep that is not `pr_open` (e.g. blocked)
6. Rejects `stacked_work` on a non-blocked node
7. Rejects missing `stack_base` for an unvalidated dependency
8. Rejects `stack_base` referencing a dep that is not an unvalidated direct dependency
9. Rejects duplicate `stacked_work` session across nodes
10. Requires `requires_main_rebase=true` when dep is merged/validated and `stacked_work` is present
11. Proposes speculative PR head reconciliation via GitHub audit

## Error codes added

| Code                                 | Meaning                                        |
| ------------------------------------ | ---------------------------------------------- |
| `stacked.not-blocked`                | `stacked_work` on non-blocked node             |
| `stacked.pr-open-missing-pr`         | `stacked_pr_open` mode without PR ref          |
| `stacked.base-not-dependency`        | `stack_base` dep not an unvalidated direct dep |
| `stacked.missing-base`               | unvalidated dep has no `stack_base`            |
| `stacked.duplicate-base`             | duplicate `dep_node_id` in `stack_bases`       |
| `stacked.dep-not-pr-open`            | dep is not `pr_open`/`merged`/`validated`      |
| `stacked.dep-missing-pr`             | `pr_open` dep has no PR ref                    |
| `stacked.stale-dep-head`             | dep PR head advanced since last resync         |
| `stacked.merged-dep-rebase-required` | dep is merged but `requires_main_rebase=false` |
| `stacked.requires-main-rebase`       | `requires_main_rebase=true`, rebase not done   |
| `stacked.duplicate-session`          | same session on two `stacked_work` nodes       |
| `stacked.duplicate-issue`            | same issue on two `stacked_work` nodes         |
| `github.stacked-pr-audit`            | GitHub audit failure for speculative PR        |

## Key design decisions

1. **Orthogonal fields**: `status` stays `blocked`, `stacked_work` is a parallel optional field — never promoted into the lifecycle proper.
2. **All-deps-pr_open gate**: Speculative work is only permitted when every unvalidated direct dependency is at least `pr_open`. If any dep is still `blocked` or `in_progress`, no stacked work allowed.
3. **Exact stack-base facts**: One `stack_base` entry per unvalidated dep records the precise state: PR number, branch, last-resynced head SHA. Stale detection is offline (cached vs dep `github.pr.head_sha`).
4. **Post-merge rebase gate**: When a dep transitions to `merged`/`validated`, `requires_main_rebase` must flip to `true`. When true, the node is excluded from `ready_queue` and emits a blocking error until an explicit Producer reconciliation clears the field.
5. **Producer as sole writer**: child agents report progress via their issue/handoff; Producer performs the `stacked_work` field updates in `epic-state.json`.

## Test results

- 33 tests in `tests/unit/agent/epic-status.test.ts` — all pass
- `npm run verify:fast` — all 1260 tests pass, typecheck + lint clean

## Invariants preserved

- Existing 37 nodes in `epic-state.json` are unaffected (no `stacked_work` field added, optional field absent = no speculative work)
- EPIC-CONTRACT sha256 hash unchanged (additions to PLAN.md are outside the `<!-- EPIC-CONTRACT:BEGIN -->...<!-- EPIC-CONTRACT:END -->` markers)
- No existing tests modified or removed
