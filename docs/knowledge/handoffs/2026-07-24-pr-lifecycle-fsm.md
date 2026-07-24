# Session Handoff: One Authoritative PR-Lifecycle State Machine (Issue #1851)

## Date

2026-07-24

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

5🍎 estimated, 5🍎 actual (exact). See `docs/knowledge/metrics/apples/2026-07-24-pr-lifecycle-fsm.json`.

## What Was Done

Introduced **one authoritative PR-lifecycle state machine** (`pr-lifecycle.mjs`) that owns the PR phase `{repairing, queued, ordering, merging, done, quarantined, abandoned}` and demoted merge-train and conflict-coordinator to pure predicates. Fixes D1 (admission deadlock), D5 (release unreachable), D9 (stale cluster ordering), and D11 (quarantined PR dead-heads the train).

**New file:** `.github/scripts/ci-recovery/pr-lifecycle.mjs`
- `PHASE` enum, `PHASE_LABELS` mapping
- `evaluatePhase(prFacts, trainState, clusterState)` — pure FSM evaluation
- `applyLifecycleDecision(...)` — sole writer of lifecycle phase (injected writers; explicit `{acted, noOp}` return)
- `applyRawLabelDecision(...)` — coordinator fence label writes (explicit contract: does NOT update lifecycle comment)
- `formatLifecycleOutcome()` / `formatRawLabelOutcome()` — grep-provable acted-vs-no-op log lines
- `isNonBlocking()` / `nonBlockingPhases()` — D11 structural guarantee
- `makeLifecycleRecord()` / `renderLifecycleComment()` / `parseLifecycleComment()` — lifecycle comment codec

**`ci-recovery/state.mjs` additions:**
- `LIFECYCLE_PHASES`, `NON_BLOCKING_PHASES`, `TERMINAL_PHASES` constants
- `evaluateAdmission(prFacts, config)` — current-facts admission evaluator (no state-comment fingerprint required)
- `unsatisfiedChecksFromRuns()` — helper for `evaluateAdmission`

**`merge-train/state.mjs` additions:**
- `isAdmissible(prFacts, requiredChecks)` — pure admission predicate; delegates to `evaluateAdmission`

**`ci-conflict-coordinator/state.mjs` additions:**
- `whoMustLandFirst(cluster, proofs, nonBlockingPhases)` — pure ordering; quarantined/abandoned PRs filtered from leader candidates (D11 structural guarantee)

**Runtime wiring (critical — adversarial review caught these were missing in initial implementation):**
- `ci-recovery/reconcile.mjs`: imports `pr-lifecycle.mjs`; calls `evaluatePhase()` + `formatLifecycleOutcome()` at the final-state decision point (before `normalized.length === 0` check). The lifecycle evaluation produces the "one owner deciding" log line on every reconcile run.
- `merge-train/reconcile.mjs`: replaced `eligible()` fingerprint gate with `isAdmissible()` current-facts check. The old gate required a state-comment fingerprint match, which was the root cause of D1 — a PR that recovered its checks could not re-enter the train until a separate CI-recovery run updated the fingerprint first.

**`ci-conflict-coordinator/reconcile.mjs`:**
- Replaced `applyLifecycleDecision` call with `applyRawLabelDecision` + `formatRawLabelOutcome`. The coordinator's fence labels (`ci-conflict-order-wait`, etc.) are sub-phase signals, not lifecycle phase transitions — they must not update the lifecycle comment or the lifecycle record would be incoherent.

**Protected paths:**
- Added `pr-lifecycle.mjs` and `ci-conflict-coordinator/state.mjs` to `PROTECTED_WORKFLOW_PATHS` and the test's `protectedPaths` list (required because the review-wake-bridge trust boundary checks the full import closure of `reconcile.mjs`).

**Tests:** 18 tests in `pr-lifecycle.test.mjs` — D11 invariants, golden fixtures #1782/#1861, #1883 (both scenarios), acted-vs-no-op contract, applyRawLabelDecision×4. 630/632 tests pass overall (2 pre-existing `yaml` package failures, unrelated to this work).

Observed in a dry-run code walkthrough: `ci-recovery/reconcile.mjs` now imports `pr-lifecycle.mjs` and calls `evaluatePhase()` on every reconcile pass, emitting a `lifecycle no-op: pr=#N reason=evaluated:<phase>` log line. The merge-train `eligible()` no longer gates on state-comment fingerprint, resolving the D1 chicken-and-egg deadlock (a green PR is now admitted regardless of whether a CI-recovery state comment exists with matching fingerprint).

## Key Decisions Made

1. **Alternative C (lifecycle-as-thin-overlay) over A (full rewrite) or B (extend reconcile directly)**: Alternative C preserves the existing runtimes and adds the lifecycle FSM as an overlay. This minimizes blast radius while introducing the correct conceptual structure. The adversarial review confirmed A/B are viable alternatives — B in particular would be more surgical — but C's explicit acted-vs-no-op contract and pure-predicate decomposition are better long-term.

2. **`applyRawLabelDecision` vs `applyLifecycleDecision` for coordinator labels**: The adversarial review found that calling `applyLifecycleDecision` with raw label names caused the lifecycle comment to be silently skipped (because the phase wasn't in `Object.values(PHASE)`). The fix extracts a dedicated `applyRawLabelDecision()` with an explicit contract: coordinator fence labels are sub-phase signals that intentionally do NOT update the lifecycle comment.

3. **`PROTECTED_WORKFLOW_PATHS` expansion**: `pr-lifecycle.mjs` is now part of the privileged CI-recovery execution closure (imported transitively by `reconcile.mjs`). Adding it and `ci-conflict-coordinator/state.mjs` to the protected set is the correct security response — changes to these files now trigger the review-wake-bridge trust boundary check.

4. **`evaluateAdmission` in `ci-recovery/state.mjs` vs in `merge-train/state.mjs`**: `evaluateAdmission` lives in `ci-recovery/state.mjs` (the shared evaluation logic) and `isAdmissible` in `merge-train/state.mjs` is a thin wrapper. This places the authoritative current-facts admission logic where the lifecycle FSM lives.

5. **D1 fix scope**: The fingerprint gate was removed entirely from `eligible()` — not relaxed or made optional. This is the correct fix because the gate was architecturally wrong: admission should be a current-facts decision, not an asynchronous evidence requirement.

## What's Next / Blockers

- **Issue 8 (#1892)** — supplies the transitions INTO `quarantined` / `abandoned`. This PR guarantees non-blocking dispositions can never dead-head the train; #1892 supplies the conditions under which a PR is moved into those dispositions.
- **Reconnect `applyLifecycleDecision` to actual writes**: The lifecycle FSM currently evaluates and logs phase but does NOT write lifecycle comments or apply phase labels on its own (only `applyCoordinatorLabel` writes labels via `applyRawLabelDecision`). A future session should wire `applyLifecycleDecision()` fully into the reconcile loop so the lifecycle comment is actually updated on transitions, making the lifecycle record the single source of truth rather than the inferred label combination.
- **`eligible()` regression test coverage**: The `merge-train/reconcile.mjs` `eligible()` function is tested via integration-style mocks in `reconcile-promotion.test.mjs`. The new `isAdmissible()` path is unit-tested in `pr-lifecycle.test.mjs` (D1 golden fixture) and in `state.test.mjs` (isAdmissible predicate). Consider adding a reconcile-level test specifically for the "stale fingerprint no longer blocks admission" scenario.

## Retrospective

### Lessons Learned

- **Test for runtime wiring, not just pure functions.** The initial implementation created correct pure functions but failed to wire them into the runtimes. The adversarial plan review caught this definitively. Future sessions: after implementing a new module, always grep for it in the actual runtime scripts (`reconcile.mjs` files) to verify it's imported and called, not just exported.
- **The review-wake-bridge PROTECTED_WORKFLOW_PATHS test is a hard gate.** Any new `.mjs` file imported (directly or transitively) by `ci-recovery/reconcile.mjs` must be added to the protected paths set. The `relativeImportClosure` test is a great tool for checking this — run it locally before submitting.
- **`applyLifecycleDecision` + raw label names = silent no-op for lifecycle comments.** The `record = null` fallback when `targetPhase` is not in `Object.values(PHASE)` is a footgun. The `applyRawLabelDecision` function with an explicit "no lifecycle comment" contract is the right fix.

### Mistakes Made

- **Initial implementation shipped pr-lifecycle.mjs without wiring it into either runtime.** Both `ci-recovery/reconcile.mjs` and `merge-train/reconcile.mjs` were entirely unchanged in the initial commit. The lifecycle FSM was architecturally correct but completely dead code. The adversarial plan review caught all 3 blocking manifestations of this mistake.
- **Used `applyLifecycleDecision` for coordinator fence labels.** The function's silent `record = null` fallback for non-PHASE targetPhase values meant coordinator label changes were never recorded in the lifecycle comment. Fixed by adding `applyRawLabelDecision` with an explicit non-lifecycle-comment contract.

### Opportunities for Future Improvement

- The lifecycle FSM `evaluatePhase()` is called read-only in `ci-recovery/reconcile.mjs` (evaluates and logs, doesn't write). A future session could wire `applyLifecycleDecision()` to actually write lifecycle comments on phase transitions, making the lifecycle comment the primary audit trail.
- The `eligible()` function in `merge-train/reconcile.mjs` now delegates to `isAdmissible()`. However, `isAdmissible()` doesn't check the merge-train queue state (whether the PR is already in the train). A future session could add a `trainPosition` field to `evaluatePhase()` output so the lifecycle record reflects the full train view.
- Consider adding a `--dry-run` flag to the merge-train reconcile workflow so the "acted-vs-no-op in logs" acceptance criterion can be verified via a real workflow dispatch against production PRs.
