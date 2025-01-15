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

The burst test exposed a second ownership bug: the ready/reviewer guard
published empty draft shells, which triggered automatic Copilot review before
GitHub had any files to review. All 13 test PRs received the no-files response,
and #1171 merged because admission treated zero unresolved threads as sufficient.
Draft publication now requires at least one changed file, while merge-train
admission requires a substantive Copilot review anywhere in PR history. Review
evidence is intentionally not tied to current head; significant-change
re-review policy remains separate.

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
- `.github/workflows/pr-ready-reviewer-guard.yml`
  - Keeps zero-file PRs in draft.
  - Publishes after an authoritative `pulls.get` reports changed files.
  - Retries the triggering PR's fresh synchronize read with bounded backoff.
- `.github/scripts/ci-recovery/github.mjs`
  - Independently paginates review threads and complete PR review history.
- `.github/scripts/ci-recovery/state.mjs`
  - Recognizes only submitted terminal reviews from the exact Copilot code
    reviewer identities.
  - Rejects blank and known no-files review bodies; accepts a substantive body
    or inline comment.
- `.github/scripts/ci-recovery/reconcile.mjs`
  - Waits before admission when no substantive historical Copilot review exists.
  - Does not create a recovery blocker or impose current-head review matching.
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
- Full CI-recovery/ready-guard Node suite: 89 tests, 67 passed, 22 skipped by
  the existing Windows `UV_HANDLE_CLOSING` subprocess workaround, 0 failed.
- Deterministic publish, review-classification, admission-wait, and independent
  pagination tests all executed and passed outside the skipped subprocess set.
- `npm run verify:fast`: passed.
- Live #1169 canary: assignment persisted and kickoff count equals one.
- Live Actions backlog: seven of seven issues have Copilot and one kickoff.

## Review harness

- Estimate/actual: 3🍎 / 3🍎.
- Two plan reviews (`gpt-5.4`): seven concerns resolved; divergence `minor`.
  The second review added inline-review support, terminal-state filtering,
  independent review pagination, admission-wait semantics, and bounded
  changed-files retry.
- Code review (`claude-sonnet-4.6`): clean in rounds one and two.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-16-automation-ownership-cleanup.review-ledger.json`.

## Follow-up

No known follow-up is required for this scope.
