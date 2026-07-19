# Stacked-Work Recovery Protocol

**Epic:** floor-2-equipment  
**Applies to:** Nodes with non-null `stacked_work` in `epic-state.json`

## Authority and invariants

The Producer is the sole writer of global epic state. Child agents publish
trusted `STACKED-WORK`, `BLOCKED`, and `HANDOFF` comments and never edit
`epic-state.json` directly.

Stacked work is orthogonal to the normal lifecycle:

- The node remains `status: blocked` and never enters `ready_queue`.
- The node must use an execution lane listed in
  `stacked_work_policy.allowed_execution_lanes`.
- `stacked_work.owner.issue` must equal the node's materialized child issue.
- One live trusted `STACKED-WORK` comment must match the cached owner, session,
  branch, and prerequisite head.
- Every incomplete direct prerequisite must have one exact entry in
  `dependency_pull_requests`. Exactly one entry is the immediate stack base.
- `last_resynced_dependency_head_sha` must match that stack base and
  `last_resynced_at` must satisfy
  `stacked_work_policy.maximum_without_resync_hours`.
- A dependent PR is required when `state` is `stacked_pr_open`.

Run both audits before changing state:

```text
npm run epic:status -- floor-2-equipment
npm run epic:status -- floor-2-equipment --github --reconcile
```

The GitHub audit is read-only. Review every proposed `repo_patch` and
`operator_action`; it never applies them automatically.

## Refreshing an active stack

1. Fetch every recorded prerequisite branch and verify its open PR number,
   branch, base, and full head SHA.
2. Rebase or merge the latest immediate stack-base branch into the dependent
   branch.
3. Push the dependent branch.
4. Post one fresh trusted `STACKED-WORK` comment with the owner identity,
   dependent branch, exact prerequisite head, claim time, lease expiry, and
   heartbeat.
5. As Producer, apply the reviewed audit proposals for:
   - `stacked_work.owner.claimed_at`
   - `stacked_work.owner.lease_expires_at`
   - `stacked_work.owner.heartbeat_at`
   - prerequisite `observed_*` facts
   - dependent `observed_*` facts
6. Update `last_resynced_dependency_head_sha` and `last_resynced_at` only after
   the exact remote prerequisite head has been observed.
7. Re-run both audits. Do not advance lifecycle.

## Prerequisite merge and rebase to main

When a recorded prerequisite PR merges:

1. Record the GitHub-observed merge facts on its
   `dependency_pull_requests` entry.
2. Set:

   ```json
   "rebase_to_main": {
     "pending": true,
     "pre_rebase_dependent_head_sha": "<GitHub-observed dependent head before rebase>",
     "prerequisite_merge_commit": "<GitHub-observed prerequisite merge commit>"
   }
   ```

3. Fetch `origin/main`, rebase the dependent branch onto it, resolve conflicts,
   and push the new dependent head.
4. Retarget the dependent PR to `main`.
5. Run the GitHub reconciliation audit. Completion requires GitHub to observe:
   - a dependent head different from `pre_rebase_dependent_head_sha`;
   - the recorded dependent branch;
   - `base: main`;
   - the exact prerequisite merge commit.
6. Revalidate the dependent work and its evidence.
7. Only after those observations, clear `stacked_work`. Normal readiness may
   then move the node from `blocked` to `ready`; establish ordinary ownership
   with a separate trusted `CLAIMED` comment.

Do not clear `rebase_to_main.pending` while retaining stacked metadata.
`stacked_work` is removed as one reviewed Producer update after the remote
rebase and retarget are proven.

## Abandonment

1. Post a trusted `BLOCKED` comment on the stacked owner's issue. This revokes
   live normal and stacked claims for that node.
2. Close the dependent PR without merging when appropriate and record the
   reason.
3. Archive or delete the dependent branch according to repository policy.
4. As Producer, clear `stacked_work` while leaving lifecycle `blocked`.
5. Run offline and GitHub reconciliation audits again.

## Diagnostic map

| Condition                                                    | Diagnostic                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node is not lifecycle-blocked                                | `stacked.lifecycle-not-blocked`                                                                                                                                   |
| Execution lane is not allowed                                | `stacked.lane-not-allowed`                                                                                                                                        |
| Owner issue is missing or wrong                              | `stacked.missing-issue-owner`                                                                                                                                     |
| Cached owner identity conflicts                              | `stacked.owner-mismatch`                                                                                                                                          |
| Lease or heartbeat is stale                                  | `stacked.owner-expired`, `stacked.owner-heartbeat-stale`                                                                                                          |
| Prerequisite coverage or exact stack base is wrong           | `stacked.dependency-coverage`, `stacked.stack-base-count`                                                                                                         |
| Auxiliary stack base lacks its required tracking issue       | `stacked.auxiliary-base-authority`                                                                                                                                |
| Prerequisite PR identity is missing or not open              | `stacked.dependency-pr-missing`, `stacked.dependency-not-open`, `stacked.dependency-pr-closed`                                                                    |
| Cached prerequisite PR facts drift                           | `stacked.dependency-snapshot-stale`, `stacked.dependency-head-stale`, `stacked.dependency-branch-drift`, `stacked.dependency-base-drift`                          |
| Merged prerequisite lacks complete merge observations        | `stacked.dependency-merge-facts`                                                                                                                                  |
| Resync facts are stale                                       | `stacked.resync-head-stale`, `stacked.resync-stale`                                                                                                               |
| Dependent branch is not based on the exact stack-base branch | `stacked.wrong-base-branch`                                                                                                                                       |
| Dependent PR is missing, premature, closed, or drifted       | `stacked.dependent-pr-missing`, `stacked.dependent-pr-premature`, `stacked.dependent-pr-closed`, `stacked.dependent-branch-drift`, `stacked.dependent-base-drift` |
| Prerequisite merged but rebase transition is incomplete      | `stacked.rebase-to-main-required`, `stacked.rebase-base-not-observed`, `stacked.rebase-not-pushed`                                                                |
| Rebase transition is asserted too early                      | `stacked.unexpected-rebase-to-main`                                                                                                                               |
| Material contract drift or a block is recorded               | `stacked.material-block`                                                                                                                                          |
| Ownership or branch overlaps another node                    | `stacked.duplicate-owner`, `stacked.duplicate-branch`                                                                                                             |

GitHub-specific drift uses the `github.stacked-*` diagnostics and emits reviewed
cache proposals or operator actions. It never changes lifecycle status or marks
the rebase complete.
