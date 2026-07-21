# Handoff: Stop irrelevant PR validation

**Date:** 2026-07-19  
**Session slug:** stop-irrelevant-pr-validation  
**Apple estimate:** 5🍎 (Massive) → actual 5🍎  
**Status:** Implementation complete, PR open

## Systems touched

ci, classifier, workflows

## What was done

Implemented the five rollout issues of the "Stop irrelevant PR validation" Epic (#1685). The epic has a sixth child, #1702 (post-rollout PR CI resource-efficiency measurement), which is intentionally out of scope for this PR: it requires at least seven representative post-rollout days of data, so its measured success gate remains pending until that observation window closes. Do not treat this handoff as authority to close #1685 before that measurement is done. The five rollout issues covered here:

- **#1688** — Impact classifier foundation: added 5 new orthogonal flags to `detect-art-only.sh`
- **#1689** — Superseded-run cancellation: added `concurrency` blocks to `ci.yml` and `security-review.yml`
- **#1696** — Headless and coverage gating: `test-headless` gated on `sim_touched`, `ci-coverage` gated on `coverage_touched`
- **#1697** — Security path gating: wired `dependencies_touched` into the `npm audit` + dependency-allowlist steps. The remaining #1697 acceptance criteria (per-surface routing for CODEOWNERS / dynamic-execution / AI-prompt, docs/asset no-Node, and removing the duplicate advisory audit) stay open in #1697.
- **#1698** — Visual surface routing: wired `visual_touched` to gate `test-e2e`. The remaining #1698 criterion (a targeted asset/manifest visual smoke path and runtime/devtool suite partitioning) stays open in #1698.

## Files changed

- `scripts/agent/ci/detect-art-only.sh` — Added 5 new flag computation blocks (`visual_touched`, `sim_touched`, `coverage_touched`, `sprite_pipeline_touched`, `dependencies_touched`). Updated fail-safe calls to emit `true` for positive-signal flags. Lockfile changes fail closed across gameplay, simulation, visual, and coverage gates because resolved runtime and test dependencies can change behavior.
- `scripts/agent/ci/local-scope.sh` — Updated `emit_all_false()` to emit ten output fields.
- `tests/unit/detect-change-scope.test.ts` — Expanded `Scope` interface to 10 fields, rewrote `F()` helper, updated all 34 existing tests plus 7 new test cases (45 total).
- `.github/workflows/ci.yml` — Added concurrency block, 5 new `changes` outputs, gated `test-headless`/`test-unit-coverage`/`test-e2e` and npm audit step.
- `.github/workflows/security-review.yml` — Added concurrency block, `dependencies_touched` output, gated npm audit and dep allowlist steps.

## Key design decisions

- **Fail-safe**: Unknown/blank change sets emit `true` for every positive-signal flag — `sprites_touched`, `visual_touched`, `sim_touched`, `coverage_touched`, `sprite_pipeline_touched`, and `dependencies_touched` — while the negative-signal flags (`art_only`, `docs_only`, `gameplay_safe`, `sprites_only`) stay `false` (fail-closed). The local wrapper (`local-scope.sh` `emit_all_false`) mirrors this exact shape, so no local consumer is silently skipped when scope is unknowable. `sprites_touched` and its documented `sprite_pipeline_touched` alias are always identical, including on every fail-safe path.
- **`sim_touched` is independent of `gameplay_safe`**: Broader safe list; script changes produce `sim_touched=false` even when `gameplay_safe=false`.
- **`src/labs/**`is NOT safe for`visual_touched`**: E2E tests import directly from labs paths. Also NOT safe for `sim_touched` (headless tests import from labs).
- **Concurrency groups are workflow-namespaced**: `${{ github.workflow }}-pr-N` prevents ci.yml cancelling security-review.yml.
- **Merge-gate compatibility**: headless skips are accepted only for docs-only changes or an explicit `sim_touched=false`; missing classifier output fails closed. Other scope-gated jobs retain their existing skip handling.

## Review harness

- Adversarial plan review (GPT-5.4): 7 concerns, all resolved
- Code review round 1 (claude-opus-4.8): 1 finding (engine/labs in sim_touched), fixed
- Multi-model review (GPT-5.6-luna + gemini-3.1-pro-preview): 1 finding both found (labs in visual_touched), fixed
- Final-head review (Claude Sonnet 4.6 + Gemini 3.1 Pro, GPT-5.4 adjudication): 1 valid finding (lockfile changes skipped simulation/coverage gates), fixed; remaining suggestions rejected with source/policy evidence
- Current-main conflict resolution re-review (Claude Sonnet 4.6): clean across the five-flag contract, lockfile fail-closed behavior, non-PR backstops, and aggregate-gate semantics
- Post-merge review-thread validation (Claude Opus 4.8 + GPT-5.6 Sol): corrected fail-safe sprite flags, added deterministic workflow-routing coverage, fixed durable scope claims, and assigned four independently estimated #1697/#1698 findings to their still-open child issues
- Final review-thread validation (Claude Sonnet 4.6): preserved both endpoints for cross-surface renames, made dependency consumers fail closed on missing output and classifier-job failure, and corrected the `sim_touched` contract comment
- Follow-up review-thread validation (Claude Sonnet 4.6): made E2E and the advisory dependency audit skip only on explicit false, updated policy tests, and narrowed the ledger title to the reviewed foundation scope
- Ledger: `docs/knowledge/review-ledgers/2026-07-19-stop-irrelevant-pr-validation.review-ledger.json`
