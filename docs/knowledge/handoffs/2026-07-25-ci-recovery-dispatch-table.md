# Session Handoff: CI-recovery dispatch table replaces 2,541-LOC cascade

## Date

2026-07-25

## Persona

Producer → CI Infrastructure

## Systems touched

ci-policy

## Apples

5🍎 estimated, 5🍎 actual (exact). Full JSON: docs/knowledge/metrics/apples/2026-07-25-ci-recovery-dispatch-table.json

## What Was Done

Replaced the 2,541-LOC linear decision cascade in `.github/scripts/ci-recovery/reconcile.mjs` with a data-driven dispatch table in a new file `.github/scripts/ci-recovery/dispatch-table.mjs`. The key structural fix (D5): RELEASE rows (R04/R05) are now guaranteed by a runtime assertion to appear before OWNER-BLIND SKIP rows (R06/R07), making it structurally impossible for a stale automation lock to be stranded behind an owner-blind early exit.

The implementation uses a multi-pass pipeline pattern:
- **Phase A** evaluates early rows (R03-R12) using only cheap PR+state facts (no thread fetch needed). R08-R11 conflict-rebase dispatch moved here from a later location.
- **Terminal dispatch** (R26-R34+GC) dispatches the final recovery action from the admission blockers after all side-effect passes complete.

`reconcile.mjs` is now a thin driver over `dispatch-table.mjs`. The 29 `process.exit(0)` calls that lived above the GC/release logic have been replaced by a structured switch over `DISPATCH_ACTION` constants.

All 127 existing reconcile tests pass, all 5 characterization tests pass, and 29 new dispatch-table-specific tests were added. Observed in CI tests: characterization suite produces identical verdicts to the frozen baseline.

## Key Decisions Made

1. **Multi-pass pipeline over a single flat table**: A single table with full upfront context was rejected because it wastes API calls for early-exit PRs. The multi-pass pipeline (cheap facts → early dispatch → expensive thread fetch → side-effects → terminal dispatch) preserves the existing short-circuit performance while making the decision structure explicit.

2. **R04 non-terminal re-evaluation**: R04 (expired shepherd) releases ownership then re-evaluates the early table rather than falling through blindly. After release, `earlyCtx` is rebuilt with `owner:'none'` so later R03/R05 rows correctly won't match.

3. **conflict-episode recording before Phase A**: The `unrecordedConflictEpisode()` recording block was moved to before Phase A, ensuring the episode marker is always persisted even when R08/R11 exits before the main pipeline's recording point. This preserves the `conflict-resolved` review-request path after auto-rebase succeeds.

4. **D5 invariant assertion**: `assertEarlyTableInvariant()` in `dispatch-table.mjs` verifies at module load that all RELEASE rows precede all OWNER-BLIND SKIP rows in the early table, making the structural guarantee machine-checked.

5. **PROTECTED_WORKFLOW_PATHS**: Added `dispatch-table.mjs` to `PROTECTED_WORKFLOW_PATHS` in `review-wake-bridge.mjs` since `reconcile.mjs` imports it, bringing it into the privileged execution closure.

## What's Next / Blockers

- **Issue 1850 epic**: This was issue #4 in the CI-harness redesign epic. Issues #5+ remain.
- **Terminal dispatch completeness**: The current terminal dispatch table covers the R26-R34 decision set. As the reconcile pipeline evolves, new admission blocker types should be added as explicit table rows rather than new if-chains.
- **Integration test coverage for conflict-episode**: The `conflict-resolved` review-request path (episode marker → rebase succeeds → review requested) has no reconcile.test.mjs coverage. A future session should add integration tests covering the full conflict → auto-rebase → conflict-resolved flow.

## Retrospective

### Lessons Learned

- **Adversarial plan review caught 8 architectural concerns** before implementation started, preventing several structural mistakes (e.g. ownership cleanup rows accidentally in the dispatch table, pendingHumanApproval not available before Phase A). The adversarial review cost is well worth it for 5🍎 changes.
- **Both multi-model reviewers independently found the same High bug** (conflict episode ordering) that all 127 tests missed because the interaction isn't unit-tested at the reconcile level. This validates the value of multi-model review — a single code review round would likely catch it, but having two independent models converge on the same root cause increases confidence.
- **Side-effect ordering is the hardest invariant to maintain** when restructuring a monolithic script. Moving R08/R11 before the episode recording was an ordering regression that required careful auditing of every statement's dependency graph.

### Mistakes Made

- **Moved dispatch before conflict episode recording**: The initial implementation moved R08/R11 (conflict-rebase dispatch) into Phase A without realizing the conflict episode recording pass at line ~1700 would then be skipped on the R08 dispatch path. Both multi-model reviewers caught this. Early signal: before moving any block to Phase A, trace all downstream blocks that depend on context set by that block — here, the episode comment is what makes post-rebase `conflict-resolved` review work.
- **Forgot review-wake-bridge PROTECTED_WORKFLOW_PATHS**: Adding a new file that `reconcile.mjs` imports extends the privileged import closure. Always check `review-wake-bridge.mjs` when adding new imports to `reconcile.mjs`.

### Opportunities for Future Improvement

- **Unit-test the conflict episode → review-request pipeline end-to-end**: The `unrecordedConflictEpisode` → `shouldRequestReview('conflict-resolved')` path has no integration coverage in `reconcile.test.mjs`. Adding a fixture for a PR that starts conflicted, gets auto-rebased, then re-enters reconcile with the marker in comments would catch the ordering regression earlier.
- **Terminal dispatch table is currently inline in reconcile.mjs**: The terminal table rows (R26-R34+GC) are evaluated by `selectTerminalAction()` in `dispatch-table.mjs` but the terminal table itself is constructed inside the function. A future session could make the terminal table a top-level constant (like the early table) for even clearer data-driven structure.
