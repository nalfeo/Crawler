# 2026-07-28 — Nightly bottleneck scan + contamination-detection proposal

## Systems touched: ci-policy

## Summary

Ran the nightly velocity-engineer / bottleneck-scan loop for issue #2192.
Computed the full bottleneck report from 60 recent merged PRs using GitHub MCP REST
endpoints (gh GraphQL blocked in sandbox). Key finding: branch contamination drove a
delivery deadlock affecting 18 PRs for up to 64h; the emergency fix (PR #2168,
coordination default-off) is already in place. Proposed the smallest permanent fix
(effective CI tree-diff admission gate, 2–3🍎) to allow safe re-enablement of conflict
coordination.

**Apple estimate:** 1🍎 (observation/documentation; no code changes). Actual: 1🍎.

## Findings committed

- `docs/knowledge/metrics/velocity/findings/2026-07-28-nightly-scan.md` — human-readable findings
- `docs/knowledge/metrics/velocity/findings/2026-07-28-nightly-scan.report.json` — machine-readable observational report (schema: `crawler-velocity-bottlenecks/observation-v2`)

## Top bottleneck

**Rework stage (first review → last push)** — median 67h for the 7 slowest PRs
(12% of cohort). Root cause: branch contamination + CI conflict coordination deadlock.

- Emergency fix landed: PR #2168 (coordination default-off)
- Remaining gap: contamination not prevented at source; enforcement cannot be re-enabled safely
- Proposed fix: effective CI tree-diff admission gate in `.github/scripts/ci-conflict-coordinator/reconcile.mjs`

## Other findings

- Guard friction: pr-preflight and pr-review-ledger each 5 denies / 3.2% rate — catch-correct, no mis-fires
- Estimation accuracy: 89% exact, median |error| = 0.0 🍎 — excellent
- `authoring-main-sync`: 2,757 allows / 0 denies — nominal

## Verification

No code changes — documentation and JSON data only. `npm run verify:fast` skips
code-touching checks; `npm run format:check` passes.

## Unresolved issues

- Branch contamination fix (effective CI tree-diff admission gate) is proposed but not implemented.
  Estimated 2–3🍎. Should be a separate implementation PR once the emergency period
  has settled.
- The two-week follow-up field monitoring run (`npm run velocity:scan -- --limit 60`
  after the contamination fix lands) cannot happen until the fix is implemented.

## Recommended next steps

1. Implement the effective CI tree-diff admission gate (`.github/scripts/ci-conflict-coordinator/`)
2. Re-enable `CI_CONFLICT_COORDINATION_ENFORCE` once detection is in place
3. Re-run `npm run velocity:scan -- --limit 60` ~2 weeks after the fix to observe whether P90 drops below 24h
