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
- `ci-recovery-review-wake-bridge.yml` is a trusted `workflow_run` bridge for
  router runs that GitHub parks as `action_required` when Copilot authors a
  review event. It re-fetches the immutable run, accepts only the exact router
  path and review events from the production-proven `Copilot` bot identity
  (`id=175728472`), and binds recovery to one source PR through an independent,
  trusted signal rather than treating the `workflow_run.pull_requests`
  association as provenance. GitHub documents that array as open PRs that merely
  match the run's head SHA or head branch and warns that they did not
  necessarily trigger the run, so it is never used to _select_ the PR. Instead
  the router encodes the trusted `github.event.pull_request.number` webhook
  field into its `run-name` (surfaced back on the run object as `display_title`).
  Before parsing that title, the bridge requires the router workflow Git blob at
  the run head to exactly equal the default-branch blob
  (`router-workflow-untrusted` on mismatch), so PR-modified workflow code cannot
  forge the binding. The bridge then evaluates only that source PR and
  cross-checks it against three immutable run attributes: it must
  appear in `workflow_run.pull_requests` (`source-pr-not-associated` otherwise),
  its head SHA must equal the run head SHA, and its head ref must equal
  `run.head_branch` (an unconditionally GitHub-set run attribute, so branch reuse
  by an unrelated PR cannot substitute). It fails closed when the run-name
  binding is absent (`missing-source-pr-binding`) or the association is empty
  (`no-associated-pr`). The protected-workflow gate compares the Git blob for
  every workflow in the recovery chain at immutable `run.head_sha` against its
  default-branch blob; any changed or missing definition fails closed as
  `protected-workflow-modified`. It deliberately does not trust
  `/pulls/{number}/files`, because that endpoint follows the PR's current head
  and could supply unrelated evidence during an A→B→A force-push race. It
  threads the validated run head SHA into the dispatch (`expected_head_sha`) so
  recovery is bound to the exact reviewed commit. Read-only inspection and
  `actions: write` dispatch are separate jobs.
- `ci-recovery.yml`'s optional `expected_head_sha` input closes a
  time-of-check/time-of-use race: the bridge validates one head (including the
  protected-workflow-file gate that only the bridge performs), but reconcile
  re-fetches the live PR head, which a synchronize could move to a commit that
  now edits a protected workflow. `reconcile.mjs` checks the input once against
  the opening PR fetch, and then — because several read phases (comments, labels,
  closing issues, review threads, commit compares, check runs, workflow runs) run
  before the first write — re-fetches the live head and compares again
  immediately before every mutation phase (state comment, labels, recovery task
  comment, Copilot assignment, thread resolution, merge-train queueing, and
  auto-merge). When the input is set and the live head no longer matches at any
  of those points, reconcile fails closed — it skips without that mutation
  (`reason=head-sha-moved` at the opening guard, or
  `reason=head-sha-moved-before-mutation phase=<phase>` at a per-phase recheck).
  `enablePullRequestAutoMerge` additionally carries an `expectedHeadOid` fence.
  GitHub exposes no atomic conditional metadata mutation, so the per-phase
  recheck narrows but cannot fully eliminate the sub-second window between a
  recheck and its immediately following write. An empty input is a no-op that
  preserves normal manual/router/scheduled/lease behavior and adds no extra API
  calls.
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
- Non-required infrastructure runs other than the exact trusted review-wake
  case are logged and skipped. A parked CI Recovery Router review wake is
  recovered by one targeted `ci-recovery.yml` dispatch for its exact PR; the
  bridge never dispatches the router or a sweep.
- The system has no Azure dependency.

The bridge intentionally uses `GITHUB_TOKEN` for the final dispatch. GitHub
allows `workflow_dispatch` as an exception to `GITHUB_TOKEN` recursion
suppression, the existing router uses the same path, and this repository's
GitHub App token receives 403 responses from workflow-dispatch endpoints. The
write-capable token is unavailable to the inspection job. Recursion is excluded
by workflow identity: the bridge listens only to `CI Recovery Router`, while it
dispatches `CI Recovery`, and bridge completion does not match its own trigger.

`workflow_run` listeners are registered only from the default branch. After this
workflow reaches `main`, the first live `action_required` Copilot review run is
the platform-delivery smoke proof; branch-local testing cannot register that
listener. If GitHub does not deliver that event, or if GitHub delivers the event
but the bridge fails closed on it — for example an empty
`workflow_run.pull_requests` (`reason=no-associated-pr`), an absent run-name
source-PR binding (`reason=missing-source-pr-binding`), or a source PR that is
not in the association (`reason=source-pr-not-associated`), or an untrusted
router/protected workflow blob (`reason=router-workflow-untrusted` or
`reason=protected-workflow-modified`) — use the narrow operator fallback instead
of waiting for cron:

```powershell
gh workflow run ci-recovery.yml --repo nalfeo/Crawler --ref main `
  -f operation=reconcile -f pr_number=<PR> `
  -f trigger=operator:parked-review-wake -f lease_id=
```

Never invoke `ci-recovery-router.yml` manually for this case because its
`workflow_dispatch` entry point is a sweep.

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
