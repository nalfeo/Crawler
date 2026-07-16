# 2026-07-16 — Automation ownership cleanup

## Systems touched

ci-policy

## Summary

Removed stale closed-PR queue state from the merge-train model and extended issue
intake to exact trusted GitHub Actions/Copilot identities. Closed PRs no longer
retain `merge-train`; temporary landed-proof read failures move to the dedicated
`merge-train-recovery-pending` marker so truthful recovery remains retryable
without presenting a closed PR as queued.

The issue-opened workflow now delegates eligibility to one tested script policy.
It accepts the configured maintainer, exact `github-actions[bot]`, and exact
known Copilot aliases. Actions-authored `automation` issues are eligible;
arbitrary bots and automation-labelled maintainer/Copilot issues remain
ineligible.

## Implementation

- `.github/scripts/ci-recovery/issue-intake-lib.mjs`
  - Added pure, case-insensitive event eligibility.
  - Added exact Copilot opener/assignee aliases.
  - Fixed assignment persistence validation for GitHub's discovered
    `copilot-swe-agent` versus returned `Copilot` alias mismatch.
- `.github/scripts/ci-recovery/issue-intake.mjs`
  - Uses the shared eligibility decision and deterministic skip reason.
- `.github/workflows/issue-copilot-intake.yml`
  - Removed the maintainer-only workflow condition so script policy is the
    single trust source.
- `.github/scripts/merge-train/state.mjs`
  - Added `merge-train-recovery-pending`.
- `.github/scripts/merge-train/reconcile-lib.mjs`
  - Distinguishes retryable incomplete proof facts from terminal stale closure.
  - Applies deterministic cleanup ordering without fabricating landed metadata.
- `.github/scripts/merge-train/reconcile.mjs`
  - Reconciles closed PRs carrying either queue or recovery-pending state.
  - Clears `merge-train` from terminal closed PRs.
  - Moves indeterminate recovery to the retry marker before queue cleanup.
- `docs/guides/merge-train.md`
  - Documents closed-PR cleanup and the retry marker.

## Live reconciliation

- The seven historical closed PRs previously reported with stale
  `merge-train` labels (#1160, #1147, #1141, #1140, #1099, #1092, #1087)
  were already label-clean when rechecked.
- Reconciled all seven open Actions-created issues (#1073, #1117, #1120,
  #1121, #1142, #1150, #1169). Each now has canonical `Copilot` assignment
  and exactly one `crawler-issue-intake:v1` kickoff.
- The #1169 canary exposed the Copilot alias mismatch: assignment persisted
  but the old exact-login check treated it as failure and removed the kickoff.
  The alias-aware persistence fix was applied and the canary rerun
  idempotently before processing the remaining backlog.

## Verification

- Focused Node tests: 59/59 passed.
- `npm run verify:fast`: passed.
- Live #1169 canary: assignment persisted and kickoff count equals one.
- Live Actions backlog: seven of seven issues have Copilot and one kickoff.

## Review harness

- Estimate/actual: 3🍎 / 3🍎.
- Plan review (`gpt-5.4`): three concerns resolved; divergence `minor`.
  The workflow-level blocker was removed, indeterminate landed-proof reads
  gained a separate retry marker, and queue cleanup ordering was hardened.
- Code review (`claude-sonnet-4.6`): clean in round one.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-16-automation-ownership-cleanup.review-ledger.json`.

## Follow-up

No known follow-up is required for this scope.
