# Enforce human approval for nightly balance PRs

## Date

2026-07-16

## Persona

DevOps Engineer, coordinated by Producer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact). The change added one deterministic policy
module, wired it through both merge paths and required CI, and added focused
regression coverage.

## What changed

- Added a durable `human-approval-required` policy. A PR is gated when the PR
  carries that label, a closing issue carries it, or the PR uses the nightly
  balance agent's `copilot/balance-telemetry-driven-improvement-sweep` branch
  prefix. The branch fallback matters because the first real generated PR did
  not link its source issue or apply the requested labels.
- Approval is valid only when the repository owner authors a PR comment whose
  trimmed body is exactly `APPROVED FOR CHECK-IN`. Other users, quoted text,
  and longer comments do not count.
- CI recovery now evaluates the gate before its merge-train-owned exit. While
  approval is pending it adds/preserves the blocking labels, removes
  `merge-train`, disables armed auto-merge, and does not clear the block after
  pushes. Approval-derived aggregate check failures are not dispatched as
  Copilot repair work, while unrelated CI and review failures remain repairable.
- Merge-train admission and every fresh promotion eligibility check independently
  reject gated, unapproved PRs.
- The required `ci` status now includes a Human approval job, preventing GitHub
  auto-merge from completing even in the interval between reconciliation runs.
  An exact owner approval comment waits for an in-progress CI run to finish and
  reruns it once, so approval unlocks without requiring another commit/comment.
- Updated the app-scheduled nightly filer to label future issues and require the
  generated PR to link the issue and carry both protective labels.

## Live observation

- The first scheduled run had already created issue #1190 and draft PR #1191.
  PR #1191 had no source-issue reference, no approval label, and no merge-train
  block.
- Applied `human-approval-required` to issue #1190 and PR #1191, applied
  `merge-train-blocked` to PR #1191, removed any train admission, and confirmed
  auto-merge was disabled. PR #1191 remains open and blocked.

## Review harness

- Plan review: `gpt-5.4`, five concerns resolved, `plan_divergence: minor`.
  The plan added fail-closed branch/label identification, moved enforcement
  before early exits, paginated closing issues/comments, and separated the
  durable approval label from the transient train block.
- Code review round 1: `claude-sonnet-4.6`, three concerns resolved. The
  reconciler now ignores only approval-derived aggregate failures while still
  repairing unrelated failures, and the approval rerun handles in-progress CI.
- Code review round 2: `claude-sonnet-4.6`, clean.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-16-enforce-balance-human-approval.review-ledger.json`.

## Verification

- Automation suites: all merge-train and CI-recovery Node tests passed.
- Focused approval/reconciliation suite: 55/55 passed after review fixes.
- Workflow YAML parsed successfully.
- `npm run verify:fast` passed under the repository's Node 22 runtime.

## Notes

- The guarantee covers repository automation: required CI/GitHub auto-merge,
  CI recovery, and merge-train admission/promotion. A repository owner can
  still manually override repository policy by directly merging.
