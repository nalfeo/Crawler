# Goobers backlog instance-root recovery

## Systems touched

agent-tooling, ci

## Apples

Estimated: 3🍎, rescored to 2🍎 after diagnosis — actual: 2🍎. The live journal
reduced the fix to one missing path binding plus contract coverage.

## Summary

- Passed the hosted `GOOBERS_INSTANCE` path into deterministic stages.
- Made fresh `backlog-query --claim` calls use that explicit instance root.
- Added contract coverage for both the environment binding and command argument.

## Evidence

- Before: Goobers run `33279340571` failed in `query-backlog` with
  `provider_error: read instance.yaml: open instance.yaml: no such file or directory`.
- Issue `#3798` remained open, unassigned, and labeled only `goobers:approved`.
- After: the workflow contract deterministically requires the fresh-claim command
  to receive the materialized instance path.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts`
- `bash scripts/agent/verify-fast.sh`
