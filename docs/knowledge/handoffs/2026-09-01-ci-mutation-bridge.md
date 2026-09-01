# 2026-09-01 ci-mutation-bridge

## Summary

Disabled the legacy CI lifecycle mutation bridge by default and documented the emergency-only fallback path. The steady-state workflow now leaves direct mutation work skipped until `LEGACY_CI_MUTATION_BRIDGE_ENABLED=true` is explicitly set for an incident or rollback drill.

## Systems touched

ci-policy, docs-tooling

## What changed

- added `LEGACY_CI_MUTATION_BRIDGE_ENABLED` as a repo-level CI knob defaulting to `false`;
- gated the direct `ci-recovery`, `merge-train`, and auto-rebase mutation steps behind that switch;
- documented the bounded emergency-only bridge in `docs/runbooks/ci-mutation-bridge-runbook.md`;
- extended workflow-gating regression coverage to enforce the new bridge contract.

## Verification

- `node --test .github/scripts/merge-train/workflow-gating.test.mjs`

## Notes

The bridge stays available as a controlled rollback lane, but the default path is Goobers-only lifecycle orchestration.
