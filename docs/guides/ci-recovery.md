# CI Recovery

Crawler's CI recovery automation consolidates PR conflicts, failed checks,
workflow approvals, and review threads into one deduplicated Copilot task.
Repository-level workflow failures use one deduplicated incident issue per
workflow.
Issues opened by `nalfeo` are auto-assigned to Copilot with an instruction
kickoff comment that points Copilot at the normal repo instructions.

## Trust boundary

- `ci-recovery-router.yml` has no PAT. It translates events and the 10-minute
  backstop into per-PR `workflow_dispatch` runs.
- `ci-recovery.yml`, `ci-recovery-incidents.yml`, and `issue-copilot-intake.yml`
  are the workflows that receive `CRAWLER_CI_PAT`.
- Explicit shepherd lease operations persist even while automated recovery is in
  `dry-run`; repository write permission to dispatch the trusted workflow is the
  authorization boundary.
- `issue-copilot-intake.yml` also receives `CRAWLER_CI_PAT`, but only for
  owner-opened issue assignment + kickoff-comment mutation. Issues that carry
  the `automation` label are skipped to avoid double-handling CI-created issues.
- PAT-bearing jobs check out only the default branch with credentials disabled.
  They never check out or execute pull-request code.
- Fork PRs are ineligible, and fork workflow runs are never approved.
- GitHub's workflow-approval endpoint applies only to fork-PR workflow runs; CI
  recovery never calls it. Required-check runs (`CI`, `commit-lint`) whose
  `action_required` conclusion indicates a same-App-push stall are classified
  against an exact path/event allowlist and then escalated as `ci-retrigger`
  blockers. Display names and environment overrides cannot extend this allowlist,
  and a PR that modifies a matched workflow definition is skipped rather than
  escalated. The retrigger fix is one commit under a different identity (e.g.
  `git commit --allow-empty -m "chore: retrigger CI"`).
- Non-required infrastructure runs (e.g. the CI Recovery Router) in
  `action_required` are logged and skipped; they re-trigger naturally on the
  next qualifying review or scheduled event.
- The system has no Azure dependency.

## State

Each PR has one concurrency group, `crawler-ci-pr-N`, with `queue: max`. Recovery
and shepherd lease operations therefore execute one at a time in FIFO order.

An atomically created temporary label, `ci-owner-pr-N`, is the ownership bit.
Exactly one `<!-- crawler-ci-state:v1 -->` comment stores the complete state.
Zero or multiple state comments while ownership is active, or any label/comment
disagreement, fails closed.

The task fingerprint hashes the latest head SHA and normalized complete blocker
set. The same fingerprint is never assigned twice.

When `MERGE_TRAIN_ENABLED=true`, the router orders non-ready PRs by creation time
and keeps at most six in the repair window. Active recovery/shepherd ownership
counts toward the window; a ready `merge-train` PR leaves it and immediately
opens the next slot through the trusted fill-window dispatch. PR-scoped events
route only their represented PRs; schedule/manual fills, closed-PR fills, and
default-branch CI events without an associated PR may scan the bounded window.
Recovery and train sticky comments are rejected before runner allocation and
ignored again by the router script, so state persistence cannot dispatch more
recovery work. Owned slots are rechecked only for their own direct PR events and
bounded global sweeps, which lets completed or expired ownership advance without recreating the
event fan-out.

Green evidence is bound to the PR head SHA plus its latest required-check and
review-thread fingerprint. Advancing `main` alone does not expire it. A textual
conflict does: recovery dispatches a targeted rebase, and the changed head must
pass the normal heavy PR gates before re-entering the train.

## Rollout

1. Leave `CI_RECOVERY_MODE` unset. The reconciler defaults to `dry-run`.
2. Merge the workflows and inspect router/reconciler output for at least one
   event-driven pass and one scheduled pass.
3. Open a disposable same-repository PR and produce, one at a time:
   - a failed check;
   - an unresolved review thread;
   - a merge conflict;
   - repeated identical events for one fingerprint;
   - an active shepherd lease.
4. Confirm dry-run output identifies every blocker, emits no duplicate task for
   repeated events, and skips the leased PR.
5. Set live mode:

   ```powershell
   gh variable set CI_RECOVERY_MODE --repo nalfeo/Crawler --body live
   ```

6. Repeat the disposable-PR cases. Confirm Copilot receives one consolidated
   task, exact thread IDs appear in the task, marker-confirmed threads resolve,
   and auto-merge is armed only after `ci` and `commit-lint` are green.
7. Disable ghost workflow registrations after live recovery is proven:

   ```powershell
   gh workflow disable copilot-review-ping.yml --repo nalfeo/Crawler
   gh workflow disable copilot-session-guard.yml --repo nalfeo/Crawler
   gh workflow disable coverage-gap-copilot.yml --repo nalfeo/Crawler
   gh workflow disable auto-resolve-review-threads.yml --repo nalfeo/Crawler
   ```

If live behavior is unsafe, immediately return to shadow mode:

```powershell
gh variable set CI_RECOVERY_MODE --repo nalfeo/Crawler --body dry-run
```

## Shepherd lease

Shepherds acquire, heartbeat, and release ownership through `ci-recovery.yml`;
they never edit the label or sticky comment directly. The lease ID is visible
and is not a secret. Lease mutations remain live while automated reconciliation
is in `dry-run`; repository write permission is the trust boundary.

Heartbeat after meaningful activity and at least every 20 minutes. The lease is
takeover-eligible after 30 minutes without activity, plus five minutes of
queue-jitter grace.

## Failure handling

- Missing/duplicate/inconsistent state: fail closed and repair state manually.
- Copilot actor unavailable to the PAT: mark the state escalated and fail.
- Substantive disagreement with review feedback: leave the thread unresolved and
  escalate with second-model evidence.
- PAT unavailable: dry-run can inspect with `GITHUB_TOKEN`; live mode fails.
- Queue saturation: inspect the per-PR concurrency group and event source before
  re-dispatching. Never bypass the fingerprint guard.
