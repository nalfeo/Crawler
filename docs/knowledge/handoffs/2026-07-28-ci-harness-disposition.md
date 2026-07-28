# Handoff: Non-blocking PR disposition (CI harness redesign Issue 8)

**Date:** 2026-07-28  
**Branch:** `copilot/ci-harness-redesign-8-non-blocking-pr-disposition`  
**PR:** Closes #1892  
**Apple estimate:** 4🍎 (actual: 4🍎)  
**Review ledger:** `docs/knowledge/review-ledgers/2026-07-28-ci-harness-disposition.review-ledger.json`

## Systems touched

ci-recovery, lifecycle-fsm, merge-train

## Summary

Implements the first-class **disposition path** for non-viable PRs in the CI harness.  
Before this change, a provably-redundant or likely-abandoned PR could occupy a blocking
cluster-leader slot indefinitely (worked incident: PR #1630 dead-headed #1782 and #1861 for 2 days).

Two disposition transitions:

1. **Auto-close provable duplicates** (deterministic only): `duplicate-detect.mjs` implements
   two proof rules — `LINKED_ISSUE_SIBLING` (closing issue CLOSED + merged sibling closes same) and
   `EMPTY_DIFF` (zero diff against base). `SIBLING_MERGED` was demoted from proof to quarantine-evidence
   after adversarial plan review identified it as too aggressive (two PRs can legitimately reference the
   same issue). A separate `detectQuarantineEvidence()` function returns SIBLING_MERGED suspicion for the
   quarantine path.

2. **Quarantine abandon-candidates** (non-blocking): lifecycle FSM QUARANTINED phase, evicted from
   every blocking slot via `NON_BLOCKING_PHASES`. Human resolves via exact-match `KEEP`/`ABANDON` comment
   posted AFTER the quarantine comment. KEEP: removes quarantine, human-approval-required, abandon-candidate
   labels, revives to QUEUED. ABANDON: closes permanently.

## Files changed

| File | Change |
|------|--------|
| `.github/scripts/ci-recovery/duplicate-detect.mjs` | NEW — 2 proof rules + quarantine evidence helper |
| `.github/scripts/ci-recovery/duplicate-detect.test.mjs` | NEW — 26 tests including #1630/#1575/#1568 golden |
| `.github/scripts/ci-recovery/state.mjs` | QUARANTINED removed from TERMINAL_PHASES; added ABANDON_CANDIDATE_LABEL, QUARANTINE_COMMENT_MARKER, parseDispositionCommand |
| `.github/scripts/ci-recovery/state.test.mjs` | +11 tests for parseDispositionCommand |
| `.github/scripts/ci-recovery/pr-lifecycle.mjs` | Added makeQuarantineComment, makeDuplicateCloseComment |
| `.github/scripts/ci-recovery/pr-lifecycle.test.mjs` | +7 tests for QUARANTINED revivable + helpers |
| `.github/workflows/ci-pr-disposition.yml` | Complete rewrite: 3-step workflow with blocking-concern fixes |
| `.github/workflows/ci-liveness-sweep.yml` | Removed optional 404 guard (workflow is permanent) |
| `docs/knowledge/review-ledgers/2026-07-28-ci-harness-disposition.review-ledger.json` | 4🍎 ledger |

## Key decisions

- **SIBLING_MERGED demoted**: adversarial plan review correctly identified that shared closing issue is not deterministic proof. Demoted to quarantine evidence (adds `abandon-candidate` label for step 2).
- **EMPTY_DIFF fixed**: `pulls.list` API doesn't return `additions`/`deletions`; calls `pulls.get` for each in-scope PR.
- **Scope expanded**: all open non-quarantined/non-abandoned PRs checked, not just labeled ones.
- **Revival anchored**: KEEP/ABANDON honored only if posted AFTER the latest quarantine comment.
- **Trust model broadened**: OWNER/MEMBER/COLLABORATOR can issue KEEP/ABANDON (not just PR opener), so humans can act on Copilot-authored PRs.
- **abandon-candidate cleanup on KEEP**: without this, step 2 would re-quarantine the revived PR on the next sweep.

## Non-blocking invariant (D11)

QUARANTINED is in `NON_BLOCKING_PHASES` in `state.mjs`. `whoMustLandFirst()` never selects QUARANTINED
as leader. `isAdmissible()` returns false. Both tested in existing D11 tests in pr-lifecycle.test.mjs.

## Tests

All 110 CI-harness tests pass. 28 new tests added.
