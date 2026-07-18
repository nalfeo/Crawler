# Asset automation ownership split

**Date:** 2026-07-18  
**Session:** asset-automation-ownership  
**Apple estimate:** 3  
**Actual:** 3 — exact; the change required workflow, issue-intake, asset-consolidator, tests, and review-gate coordination as estimated.

## Systems touched

sprite-workflow, ci-policy

## Summary

Separated asset-request generation from official game-art ingestion. Asset-request
issues now receive `no-copilot` alongside `asset-request`, and issue intake
rejects them while removing any Copilot assignment if a label race occurred.
Added a dedicated hourly workflow with non-overlapping concurrency that invokes
the existing asset-checkin consolidator in a narrowly authorized main-repository
CI context.

The consolidator now marks its PR body for active-run detection, refuses mixed
base branches and base/request mismatches, and remains local-only outside the
dedicated workflow.

## Files touched

- `.github/ISSUE_TEMPLATE/asset-request.yml`
- `.github/workflows/issue-copilot-intake.yml`
- `.github/workflows/asset-pr.yml`
- `.github/scripts/ci-recovery/issue-intake-lib.mjs`
- `.github/scripts/ci-recovery/issue-intake.mjs`
- `.github/scripts/ci-recovery/issue-intake.test.mjs`
- `scripts/sprites/asset-pr.ts`
- `scripts/sprites/asset-pr-cli.ts`
- `tests/unit/sprites/asset-pr.test.ts`
- `docs/knowledge/review-ledgers/2026-07-18-asset-automation-ownership.review-ledger.json`

## Verification

- `bash scripts/agent/preflight.sh`
- `npm run verify:fast`
- `npm run typecheck`
- `npm run lint`
- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs`
- `npx vitest run tests/unit/sprites/asset-pr.test.ts --project sprites --reporter=dot`
- `parallel_validation` — CodeQL reported no alerts; applicable review findings resolved.
- Secret scanning passed for all changed files.

## Review

- Plan review: approved with minor changes; five concerns resolved.
- Code review: clean after one remediation round.
- Pre-existing `tests/integration/generated-manifest-engine.test.ts` async-warning
  feedback was outside this change.

## Unresolved issues

None.
