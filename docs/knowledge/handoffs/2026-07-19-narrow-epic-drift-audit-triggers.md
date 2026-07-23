# Session Handoff: Narrow Epic Drift Audit triggers to validated inputs

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy, docs-tooling

## Apples

1🍎 estimated, 1🍎 actual (exact).

## Summary

- Narrowed `Epic Drift Audit` pull-request and push path filters from broad epic/docs + package manifest triggers to focused Floor 2 equipment control-plane inputs only.
- Kept scheduled and manual drift audits unchanged.
- Added deterministic workflow regression coverage to lock in trigger relevance and prevent reintroducing broad paths.

## Files touched

- `.github/workflows/epic-drift-audit.yml`
- `tests/unit/epic-drift-audit-workflow.test.ts`
- `docs/knowledge/review-ledgers/2026-07-19-narrow-epic-drift-audit-triggers.review-ledger.json`

## Verification run

- `npx vitest run tests/unit/epic-drift-audit-workflow.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-narrow-epic-drift-audit-triggers.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Could not post the pre-implementation plan comment to issue #1691 from this session environment: `gh` authentication is invalid for `github.com`, and the configured `origin` points to a localhost mirror not recognized by `gh`.

## Recommended next steps

- None for code changes; CI should now run this workflow only when focused control-plane inputs change.
