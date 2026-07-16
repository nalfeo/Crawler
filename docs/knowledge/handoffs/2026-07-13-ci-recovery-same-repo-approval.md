# Handoff: Same-repository CI recovery approval

## Date

2026-07-13

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact)

## What Was Done

- Classified allowlisted same-repository `action_required` workflow runs as
  non-approvable after the existing association, event, changed-file completeness,
  and workflow-modification checks.
- Removed the unreachable workflow-approval POST and blocker path. CI recovery
  still rejects fork PRs before reconciliation and does not execute PR code.
- Escalated required `CI` and `commit-lint` runs parked in `action_required` as
  actionable `ci-retrigger` blockers while continuing to ignore non-required
  router runs.
- Updated ADR 0058 and the CI recovery guide to match GitHub's fork-only workflow
  approval API and the retrigger behavior.
- Added a live-mode subprocess regression based on rollout run `29220010234`.
  It proves the reconciler logs `reason=same-repository`, makes no mutating API
  calls, creates no recovery blocker, and waits for required checks.

## Verification

- Before: disposable PR #1083 reached POST
  `/actions/runs/29220010234/approve`, received GitHub's fork-only 403, and
  produced a spurious `workflow-approval` blocker.
- After: the Node 22 CI-runtime recovery suite passes all 18 focused tests,
  including the live-mode no-approval/no-dispatch regression and required-check
  retrigger escalation.
- `npm run verify:fast` passed.

## Review

- The separate-model plan review converged with minor test-fixture and dead-code
  cleanup adjustments.
- The code-review loop found no implementation defect; its only finding was the
  pending ledger stage, which was recorded and validated.
- Two post-PR review findings were independently validated and fixed: required
  checks no longer wait permanently, and operator documentation matches runtime
  behavior. The final review round found no remaining concerns.

## Retrospective

### Lessons Learned

GitHub's workflow-run approval endpoint is fork-only, but CI recovery
intentionally excludes fork PRs. Security checks must run ahead of any benign
same-repository disposition so forensic rejection reasons are preserved and
recovery is never dispatched for an unfixable 403.

### Mistakes Made

Treating a same-repository `action_required` conclusion as approval-capable
inverted the fork/same-repo security boundary, allowing a path that would have
dispatched recovery for a non-recoverable workflow failure.

### Opportunities for Future Improvement

Add explicit coverage for each GitHub event category (fork vs. same-repo) against
the security precondition checks so future changes to the recovery logic cannot
accidentally re-invert the boundary.
