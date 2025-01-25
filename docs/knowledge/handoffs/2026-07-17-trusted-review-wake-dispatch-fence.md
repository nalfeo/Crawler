# Handoff: trusted review-wake dispatch fence

## Date

2026-07-17

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 🍎🍎🍎, actual 🍎🍎🍎. Exact: this stayed inside the existing CI-recovery
trust boundary, auto-rebase workflow, and deterministic regression suite.

## Summary

- Hardened the recovery workflow-dispatch sink so trusted metadata is rechecked
  immediately before workflow dispatches when `EXPECTED_HEAD_SHA` is present.
- Threaded `expected_base_ref` through conflict-only auto-rebase dispatches and
  both nested `ci-recovery.yml` callbacks, while keeping a legacy-safe `main`
  fallback for blank/older dispatches.
- Added deterministic regressions for the post-state/pre-dispatch metadata race
  and for the workflow wiring that forwards both expected metadata fields.
- Fixed a follow-up workflow bug from review: blanket auto-rebase sweeps now
  derive `expected_base_ref` per PR instead of forwarding an empty base.
- Fixed a follow-up security issue from review: `expected_base_ref` now enters
  the shell via `env:` rather than inline single-quoted interpolation, closing a
  branch-name shell-injection vector.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `.github/workflows/auto-rebase-prs.yml`
- `tests/unit/auto-rebase-prs-expected-metadata.test.ts`
- `docs/knowledge/review-ledgers/2026-07-17-trusted-review-wake-dispatch-fence.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-17-trusted-review-wake-dispatch-fence.json`

## Verification run

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npx vitest run tests/unit/auto-rebase-prs-expected-metadata.test.ts tests/unit/ci-recovery-review-wake-bridge.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-17-trusted-review-wake-dispatch-fence.review-ledger.json`

## Unresolved issues

- None.

## Recommended next steps

- Reply in the remaining PR review thread with the addressed commit SHA and let
  CI reconverge on the updated head.
