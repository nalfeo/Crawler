# Stacked-Work Recovery Protocol

**Epic:** floor-2-equipment  
**Applies to:** Nodes with `stacked_work != null` in `epic-state.json`

---

## Overview

A node with `stacked_work` is proceeding speculatively on an exact stacked branch
while its lifecycle status remains `blocked`. This protocol defines:

1. **Rebase-to-main**: what to do when the dependency PR merges.
2. **Normal-lifecycle handoff**: how to promote stacked work into the official lifecycle.
3. **Abandonment**: how to cleanly clear stacked work that is no longer viable.

The **Producer** is the sole writer of global epic state. Child agents update only their
child issue and handoff file; they never write `epic-state.json` directly.

---

## Preconditions for Starting Stacked Work

Before recording `stacked_work` on a node, the Producer must confirm:

- The node's lifecycle `status` is `blocked`.
- The node has a materialized child issue (`github.issue != null`).
- The node's execution lane is not `verification`.
- The dependency whose PR the stacked branch targets is tracked in `stacked_work.dependency`.
- If the dependency node has a tracked `github.pr`, the `stacked_work.dependency.pr_number`
  must match.
- `rebase_to_main.state` starts as `pending`.
- `resync.at` is within the last 48 hours.

---

## Resync Cadence

The stacked branch **must be rebased onto the dependency branch at least every 48 hours**.
After each rebase:

1. Update `stacked_work.resync.head_sha` to the dependency branch's current head SHA.
2. Update `stacked_work.resync.at` to the current timestamp.
3. Update `stacked_work.dependent.head_sha` to the stacked branch's new head SHA.

Failure to resync within 48 hours triggers a `stacked.stale-resync` validation error.

---

## Rebase-to-Main (Dependency Merges)

When the dependency PR merges into main:

### Step 1 — Confirm merge facts

```
git fetch origin main
git log origin/main -1 --oneline   # note the merge commit SHA
```

Confirm the merge commit matches the dependency node's eventual `merge.commit` in the state.

### Step 2 — Rebase stacked branch onto main

```
git fetch origin main
git checkout <stacked-branch>
git rebase origin/main
```

Resolve any conflicts. Force-push the branch when clean.

### Step 3 — Update `stacked_work.rebase_to_main`

Only after ALL of the node's dependencies satisfy the same readiness contract as the epic
itself — `validated`, or `superseded` with a `validated` replacement:

```json
"rebase_to_main": {
  "state": "complete",
  "completed_at": "<ISO-8601 timestamp>"
}
```

Premature completion (dependencies not yet validated) is rejected by
`stacked.premature-rebase-complete` validation.

### Step 4 — Run offline validation

```
npm run epic:status -- floor-2-equipment
```

Confirm no `stacked.*` errors.

---

## Normal-Lifecycle Handoff (After Prerequisite Merges or Validates)

When the dependency node reaches `merged` status (PR landed on main), the stacked branch may
perform the git rebase from Step 2. The state must remain
`stacked_work.rebase_to_main.state = "pending"` until the dependency reaches `validated`
status. Once the dependency reaches `validated` status, the stacked node is eligible to mark
rebase-to-main complete and continue through the full normal lifecycle. The Producer
executes:

### Step 1 — Confirm readiness

Run `npm run epic:status -- floor-2-equipment`.  
The target node should appear in `ready_queue` after its dependency reaches `validated` status.

### Step 2 — Promote stacked work into normal lifecycle

The Producer updates `epic-state.json`:

```json
"status": "claimed",           // or "in_progress", depending on work state
"stacked_work": null,          // clear the stacked_work field
"ownership": {
  "claimant": "<same claimant from stacked_work.owner.claimant>",
  "session": "<same session>",
  "source": "child-issue-comment",
  "scope": "<scope>",
  "claimed_at": "<ISO-8601>",
  "lease_expires_at": "<ISO-8601, +24h>",
  "heartbeat_at": "<ISO-8601>",
  "base_commit": "<HEAD of stacked branch after rebase>"
},
"github": {
  "issue": { ... },            // retain existing issue ref
  "pr": null                   // set to the PR number once opened, or null if still WIP
}
```

The claimant must post a `CLAIMED` comment on the child issue to establish authority
per the standard protocol (`claim_policy.protocol_headings`).

### Step 3 — If stacked_pr_open: update PR base

Change the speculative PR's base branch from the (now-merged) dependency branch to `main`
via the GitHub UI or API. The PR's head is already rebased from Step 2 of rebase-to-main.

### Step 4 — Final verification

```
npm run epic:status -- floor-2-equipment
```

Confirm:

- No `stacked.*` errors
- The node is no longer in `stacked_work` state
- The normal lifecycle fields (`ownership`, `github.pr`) are populated correctly

---

## Abandonment

If speculative work is abandoned before the dependency merges:

1. The Producer sets `stacked_work: null` on the node.
2. The stacked branch is deleted or archived.
3. If a stacked PR was open (`stacked_pr_open`), close it without merging and note the
   reason in the PR description.
4. The node remains `blocked` with no active work.

Post a `BLOCKED` comment on the child issue with a brief explanation.

---

## GitHub Audit

`npm run epic:status -- floor-2-equipment --github` audits stacked PRs:

| Condition                                | Response                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Dependency PR head advanced              | Proposes `stacked_work.dependency.head_sha` patch + rebase operator action |
| Dependency PR merged                     | Operator action: execute rebase-to-main immediately                        |
| Dependent PR head advanced               | Proposes `stacked_work.dependent.head_sha` patch                           |
| Dependent PR merged (node still blocked) | Error: `stacked.dependent-pr-merged` — execute recovery handoff            |
| Dependent PR closed without merge        | Error: `stacked.dependent-pr-closed` — investigate                         |

The audit is **read-only**. It never writes completion state.

---

## Invariants

These must hold at all times and are enforced by `npm run epic:status`:

- `stacked_work != null` iff `status === 'blocked'` (`stacked.non-blocked-status`)
- `stacked_work` requires `github.issue != null` (`stacked.missing-issue`)
- `resync.at` within 48 hours (`stacked.stale-resync`)
- `execution_lane !== 'verification'` (`stacked.invalid-lane`)
- `dependency.node_id` in `node.dependencies` (`stacked.dependency-node-mismatch`)
- `dependency.pr_number` matches dependency node's tracked PR if present (`stacked.dependency-pr-snapshot-mismatch`)
- `rebase_to_main.complete` only after all deps satisfied (`stacked.premature-rebase-complete`)
- One stacked-work slot per claimant/session (`stacked.duplicate-ownership`)
- `stacked_pr_open` requires `dependent.pr_number != null` (`stacked.pr-open-missing-number`)
