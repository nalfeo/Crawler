# Handoff: velocity bottleneck scan — actionable guard-specific remediation hints

## Date

2026-08-02

## Persona

DevOps Engineer / Velocity Engineer

## Systems touched

tooling

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Added guard-specific remediation hints to `deriveFindings` in the bottleneck scan and
exported the `GUARD_REMEDIATION` map. Added 3 unit tests covering the new behavior.

## Bottleneck evidence (from committed telemetry)

**Source**: `docs/knowledge/metrics/guard-telemetry/*.json` (all non-quarantined sessions)

| Guard              | Allow | Deny  | Estimated avoidable tool calls |
| ------------------ | ----- | ----- | ------------------------------ |
| `pr-review-ledger` | ~900+ | **8** | 16+                            |
| `pr-preflight`     | ~900+ | **6** | 12+                            |

Total: **14 denials → 28+ avoidable tool calls** across the captured session window.

Every denial creates a minimum 2-step retry loop (denial → create ledger / fix prereqs →
retry `create_pull_request`). The `pr-review-ledger` guard is the top friction point.

### Previous scan signal (2026-07-25 handoff)

The 2026-07-25 velocity engineer handoff (written after running `velocity:scan --limit 60`)
noted: "median PR is 86% idle between open and final push — that is agent attention, not
infrastructure." This is consistent with the guard data: agents are not running
`verify:pr-prereqs` before `create_pull_request`, so the guard fires and forces a retry.

## Fix

**Before** (`deriveFindings` guard friction finding):

```
Guard "pr-review-ledger" denied 8 call(s) across captured sessions. Each denial is a
retry loop; check whether the guard is catching real violations or mis-firing.
```

**After**:

```
Guard "pr-review-ledger" denied 8 call(s) across captured sessions (estimated 16+
avoidable extra tool calls). Each denial is a retry loop. Suggested fix: run
`npm run verify:pr-prereqs` before `create_pull_request` to surface missing or
incomplete ledger files early and avoid the denial loop.
```

The change:

- Quantifies the estimated overhead (N×2 avoidable tool calls)
- Replaces the generic "check whether it's mis-firing" fallback with a specific command
  for the two known friction guards (`pr-review-ledger`, `pr-preflight`)
- Falls back to the generic message for any unknown guard

### Files changed

- `scripts/agent/velocity/bottleneck-scan.ts` — added `GUARD_REMEDIATION` exported const,
  updated `deriveFindings` guard friction block
- `tests/unit/velocity/bottleneck-scan.test.ts` — 3 new tests:
  1. Known guard (`pr-review-ledger`) → specific remediation + overhead estimate
  2. Unknown guard → generic fallback, no false remedy
  3. First-in-list guard is reported (callers pre-sort by deny count)

## Measurable before/after

| Metric              | Before                             | After                                |
| ------------------- | ---------------------------------- | ------------------------------------ |
| Finding specificity | Generic "check if mis-firing"      | Specific `verify:pr-prereqs` command |
| Overhead quantified | No                                 | Yes — `N×2+` avoidable tool calls    |
| Test coverage       | 0 tests for guard friction finding | 3 new tests                          |

Expected outcome: agents reading the scan output now know exactly which command to run
to prevent the denial on the next PR. The next scan (re-run with `velocity:scan --limit
60` after 7+ days) should show reduced `pr-review-ledger` deny counts if agents act on
the finding.

## Verification

- `npx vitest run tests/unit/velocity/bottleneck-scan.test.ts` → 33 tests, all passing ✅
- `npx tsc --noEmit --project tsconfig.json` → 0 errors ✅
- `npx prettier --check scripts/agent/velocity/bottleneck-scan.ts tests/unit/velocity/bottleneck-scan.test.ts` → formatted ✅
- `npx eslint scripts/agent/velocity/bottleneck-scan.ts tests/unit/velocity/bottleneck-scan.test.ts` → 0 errors ✅

## Refs

Refs nalfeo/Crawler#2686

## Recommended next steps

1. Re-run `npm run velocity:scan -- --limit 60` after 7+ days of PRs to compare guard
   deny counts. Expect `pr-review-ledger` to trend down as agents act on the finding.
2. Consider adding the `pr-review-ledger` remediation hint to the `pr-review-ledger`
   guard's own denial message (it already includes `npm run review:ledger -- init ...`
   but does not mention `verify:pr-prereqs`). This would be a separate 1🍎 change.
3. If the `open → first review` QUEUE stage continues to dominate (86% idle), investigate
   whether the merge-train or review-routing automation can surface priority signal earlier.
