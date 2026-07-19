# Handoff: Stop irrelevant PR validation

**Date:** 2026-07-19  
**Session slug:** stop-irrelevant-pr-validation  
**Apple estimate:** 5🍎 (Massive) → actual 5🍎  
**Status:** Implementation complete, PR open

## Systems touched

ci, classifier, workflows

## What was done

Implemented the full "Stop irrelevant PR validation" Epic (#1685), covering all five child issues:

- **#1688** — Impact classifier foundation: added 5 new orthogonal flags to `detect-art-only.sh`
- **#1689** — Superseded-run cancellation: added `concurrency` blocks to `ci.yml` and `security-review.yml`
- **#1696** — Headless and coverage gating: `test-headless` gated on `sim_touched`, `test-unit-coverage` gated on `coverage_touched`
- **#1697** — Security path gating: `npm audit` + dependency allowlist steps gated on `dependencies_touched`
- **#1698** — Visual surface routing: `test-e2e` gated on `visual_touched`

## Files changed

- `scripts/agent/ci/detect-art-only.sh` — Added 5 new flag computation blocks (`visual_touched`, `sim_touched`, `coverage_touched`, `sprite_pipeline_touched`, `dependencies_touched`). Updated fail-safe calls to emit `true` for positive-signal flags. Added `package-lock.json` to `gameplay_safe` safe list.
- `scripts/agent/ci/local-scope.sh` — Updated `emit_all_false()` to 10 params.
- `tests/unit/detect-change-scope.test.ts` — Expanded `Scope` interface to 10 fields, rewrote `F()` helper, updated all 34 existing tests plus 7 new test cases (45 total).
- `.github/workflows/ci.yml` — Added concurrency block, 5 new `changes` outputs, gated `test-headless`/`test-unit-coverage`/`test-e2e` and npm audit step.
- `.github/workflows/security-review.yml` — Added concurrency block, `dependencies_touched` output, gated npm audit and dep allowlist steps.

## Key design decisions

- **Fail-safe**: Unknown/blank change sets emit `true` for all positive-signal flags (fail-closed). Local wrapper emits `false` (never affects local consumers).
- **`sim_touched` is independent of `gameplay_safe`**: Broader safe list; script changes produce `sim_touched=false` even when `gameplay_safe=false`.
- **`src/labs/**`is NOT safe for`visual_touched`**: E2E tests import directly from labs paths. Also NOT safe for `sim_touched` (headless tests import from labs).
- **Concurrency groups are workflow-namespaced**: `${{ github.workflow }}-pr-N` prevents ci.yml cancelling security-review.yml.
- **Merge-gate compatibility**: `test-headless` and `test-e2e` already have `allow_skipped=true`; new skip conditions are safe.

## Review harness

- Adversarial plan review (GPT-5.4): 7 concerns, all resolved
- Code review round 1 (claude-opus-4.8): 1 finding (engine/labs in sim_touched), fixed
- Multi-model review (GPT-5.6-luna + gemini-3.1-pro-preview): 1 finding both found (labs in visual_touched), fixed
- Ledger: `docs/knowledge/review-ledgers/2026-07-19-stop-irrelevant-pr-validation.review-ledger.json`
