# Shepherd PR #1778 — conflict resolution + review-finding fixes

Date: 2026-07-22
Persona: Producer (PR Shepherd)
Apple estimate: 2🍎 (actual 2🍎) — ci-recovery tooling only, capped at 3🍎.

## Systems touched

ci-policy

## Summary

Shepherded PR #1778 (`feat(ci): load-aware CI Recovery dispatch budget`,
branch `copilot/feat-ci-make-ci-recovery-throttle-dynamic`) as the 3rd slot in
an escalated conflict cluster with authoritative order **1231 → 1784 → 1778**.

Work landed on the branch this session:

1. **Merge-conflict resolution vs current `main`.** The PR was DIRTY/CONFLICTING
   on `.github/scripts/ci-recovery/router.mjs` + `router.test.mjs`. Resolved by
   keeping the PR's load-aware budget constants (the durable fix `main`'s interim
   emergency cap-raise explicitly defers to, #1776 which this PR closes) while
   preserving `main`'s auto-merged additions (`eligibleTrainRecoveryPulls`,
   `recoveryBacklogEntries`, `hasHealthyOwnerForSweep`, `collectPrNumbers`
   refactor). Per-hunk accept-ours on the test file (NOT `checkout --ours`, which
   would have dropped main's `recoveryBacklogEntries` import + test that live in
   auto-merged regions). Merge commit `4d7092bd0`.

2. **Copilot review findings addressed** (commit `2765a2dc0`):
   - **Finding 1 (VALID, fixed):** `weapon-sweep.yml` (runs-on ubuntu-latest,
     ~24-job weapon×shard matrix) was absent from `SWEEP_WORKFLOW_FILES`, so its
     runner pressure was uncounted. Added it to the sweep-pressure list + a
     regression test asserting all three sweep workflows are measured.
   - **Finding 3 (VALID, fixed):** the `global backpressure applied` and
     `dispatch cap applied` log lines omitted the configured `maxDispatchPerRun`
     limiter, hiding the real cap when `collectPrNumbers` truncated. Added
     `cap=${maxDispatchPerRun}` to both lines.
   - **Finding 2 (Not applicable, fact-grounded reply):** reconcile.mjs imports
     only `GLOBAL_TRAIN_DISPATCH_CAP` (busy cap). Current `main` already sets it
     to 5 (interim emergency raise). This PR keeps it 5→5, so reconcile's gate is
     unchanged vs integrated `main`; the 1→5 jump the finding describes is main's
     pre-existing change. Full reconcile pressure-awareness is the documented
     cross-workflow-reservation follow-up (see router `runFromEnv` comment) —
     out of scope here.

All 3 review threads replied to and resolved via GraphQL `resolveReviewThread`.

## Validation

- `node --test .github/scripts/ci-recovery/*.test.mjs` → 322 pass / 0 fail / 15 skipped.
- `npm run verify:fast` → passed (both after merge and after review-fix).
- `npm run verify:pr-prereqs` → satisfied; valid 2-apple review ledger.

## State at handoff

- Head: `2765a2dc0`. `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED`.
- Labels: `ci-conflict-escalation`, `ci-conflict-coordinated`,
  `ci-conflict-order-wait`, `ci-owner-pr-1778`.
- Lease held (`shepherd-75e3de5e-...`), heartbeated.
- Predecessors #1231 and #1784: both `MERGEABLE`/`BLOCKED`, still OPEN
  (not merged). #1778 is order-gated behind them.

## Gated next steps (do NOT arm until predecessors merge)

Only after #1231 AND #1784 merge and the conflict coordinator clears
`ci-conflict-order-wait` (promotes #1778 to active slot):

1. Dispatch `ci-recovery.yml operation=lease-release`.
2. `gh pr merge 1778 --auto --squash`.
3. Verify `state=MERGED` + non-null `mergeCommit`.
4. Report merge SHA to parent session `d014bdcd-ea9f-4393-a2f2-a667927d2e51`.

No asset/Azure mutations performed (per task constraint).
