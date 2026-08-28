# 2026-08-28 — Goobers Phase 0 contract repass

## Systems touched

ci-policy, agent-tooling

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## What changed

- Replaced manual contract checks in `.github/scripts/validate-goobers-contracts.mjs` with real JSON Schema validation using Ajv against `invocationV1` and `outputV1`, plus fail-closed semantic rules and fixture coverage.
- Converted `.github/scripts/validate-goobers-contracts-schema.js` to ESM exports and kept schema ownership in one canonical file used by the validator.
- Removed the silent pass fallback from `.github/workflows/goobers-contract-validation.yml` so missing/invalid validation now fails the gate.
- Completed all missing `TBD` mutation-path references in `docs/knowledge/handoffs/goobers-phase0-mutations-and-contracts.md` with concrete file + line mappings for all six required workflows and transitive mutators.
- Added deterministic invariant coverage in the claimed suites:
  - `tests/unit/goobers-run-workflow.test.ts` (single-writer lease-field wiring)
  - `.github/scripts/ci-recovery/reconcile.test.mjs` (duplicate authoritative state-comment fail-closed + expected head/base guard wiring)
  - `.github/scripts/ci-recovery/router.test.mjs` (no in-process retry on non-idempotent workflow_dispatch)
  - `.github/scripts/merge-train/reconcile.test.mjs` (fingerprint idempotency payload + clean-behind FIFO rebinding guard)
- Removed the duplicate `describe("PR State Comment Invariants")` block from `tests/unit/goobers-contracts.test.ts`.
- Updated outdated workflow expectation in `tests/unit/goobers-run-workflow.test.ts` to current `implement -> review`/`push-branch -> local-ci` flow so the suite matches current workflow contracts.

## Verification run

- `node .github/scripts/validate-goobers-contracts.mjs`
- `npx vitest run --project unit tests/unit/goobers-contracts.test.ts tests/unit/goobers-run-workflow.test.ts tests/unit/merge-train-validate-publish.test.ts tests/unit/ci-recovery-router-run-name.test.ts tests/unit/merge-train-workflow-wakeups.test.ts tests/unit/ci-knobs-guard.test.ts`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs .github/scripts/ci-recovery/router.test.mjs .github/scripts/merge-train/reconcile.test.mjs .github/scripts/merge-train/quarantine-repair.test.mjs`
- `npm run verify:fast`
