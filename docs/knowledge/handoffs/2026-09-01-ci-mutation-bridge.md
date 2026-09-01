# 2026-09-01 ci-mutation-bridge

## Summary

Disabled the legacy CI lifecycle mutation bridge by default and documented the emergency-only fallback path. The steady-state workflow now leaves direct mutation work skipped until `LEGACY_CI_MUTATION_BRIDGE_ENABLED=true` is explicitly set for an incident or rollback drill.

## Systems touched

ci-policy, docs-tooling

## What changed

- added `LEGACY_CI_MUTATION_BRIDGE_ENABLED` as a repo-level CI knob defaulting to `false`;
- gated the direct `ci-recovery`, `merge-train`, auto-rebase, and `ci-recovery-router` mutation-dispatch steps behind that switch;
- documented the bounded emergency-only bridge in `docs/runbooks/ci-mutation-bridge-runbook.md`;
- extended workflow-gating regression coverage to enforce the new bridge contract.

## Verification

- `node --test .github/scripts/merge-train/workflow-gating.test.mjs`
- `npm run test:unit -- tests/unit/merge-train-workflow-wakeups.test.ts`

## Soak + drill evidence (2026-09-01)

- **Steady-state soak observation window:** 2026-09-01T10:34:33Z → 2026-09-01T10:40:37Z
  - Auto-rebase run `33498115463` (`rebase-prs`) completed success while train-enabled conflict-only guard left blanket lifecycle mutation disabled (`Merge train enabled; blanket rebase sweep disabled.`).
  - Merge Train run `33498627349` (`reconcile`) completed skipped for PR #4026.
- **Rollback drill control-plane evidence:** CI Recovery run `33498624200` (job `99826538774`) executed with `CI_RECOVERY_MODE=live` and `RECOVERY_TRIGGER=workflow_run:completed` for PR #4026; decision log recorded `lifecycle no-op` / `skip-duplicate-fingerprint` at head `55b8d903d84757e02beee0c25dab4f04d46e0c1c`.
- **Required-check contexts observed on PR #4026 head during this window:** `ci` (failed on unit tests), `Security checks` (success), `Merge gate` (failure inherited from `ci`).

## Notes

The bridge stays available as a controlled rollback lane, but the default path is Goobers-only lifecycle orchestration.
