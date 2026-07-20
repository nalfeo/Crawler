# ADR 0067: CI Conflict Coordinator

## Status

Accepted

## Date

2026-07-20

## Estimated Complexity

4 apples — cross-system orchestration layer that must compose with both
ci-recovery and merge-train without bypassing either system's invariants.

## Context

The repository runs two independent automation systems:

- **ci-recovery** (`ci-recovery.yml`) — detects CI failures on individual PRs
  and drives them toward green by dispatching a Shepherd or Automation recovery
  agent per PR.
- **merge-train** (`merge-train.yml`) — serializes merge candidates into an
  ordered queue and promotes the head entry once CI is green.

When three or more open PRs modify overlapping CI paths (workflows, scripts,
actions, agent automation), they form a _conflict cluster_: each PR's CI run
can invalidate the others' green state, causing repeated re-dispatch and
priority inversions where whichever PR merges first forces all others to
re-run. Neither existing system is designed to reason across PR boundaries, so
they fight each other rather than cooperate.

## Decision

Introduce a third, cross-PR coordination layer — the **CI conflict coordinator**
(`ci-conflict-coordinator.yml`) — that:

1. **Detects clusters** of 3+ open PRs that transitively overlap on CI paths
   (union-find on shared `.github/` file sets).
2. **Selects a canonical leader** deterministically (green status, fewest files,
   oldest creation) and an explicit linear merge order.
3. **Fences non-leader members** with a `ci-conflict-order-wait` label that the
   merge-train reads as a pre-promotion gate (`shouldWaitForCiConflictOrder`).
4. **Serializes recovery dispatch** through the existing ci-recovery workflow
   rather than performing direct merges or branch-protection bypasses.
5. **Proves supersession** before closing any duplicate: a full-tree diff is
   computed against current `main` plus every ordered predecessor head; a PR is
   only closed when the diff is provably empty (no unique changes survive).
6. **Escalates** ambiguous or conflicting clusters (and shepherd-owned active
   slots) rather than guessing.

### How fences compose with existing systems

| Existing invariant | Coordinator behaviour |
|---|---|
| ci-recovery dispatches per-PR independently | Coordinator dispatches _only_ the active (leader) slot; order-wait members are skipped by ci-recovery's `shouldWaitForCiConflictOrder` fence |
| merge-train promotes head queue entry on green CI | `queueEntries()` excludes `ci-conflict-order-wait` PRs; non-leader slots never reach promotion |
| Shepherd leases protect active recovery work | Coordinator detects healthy shepherd ownership via `hasHealthyRecoveryOwner`; keeps the active slot fenced and escalated while the lease is live |
| ci-recovery owns automation state per PR | Coordinator never writes ci-recovery state directly; it only dispatches the workflow that creates it |

### Dispatch deduplication and bounded lease

Dispatch is deduped by a content-addressed key (`dispatchKey`) that covers the
active PR head, base SHA, and merge order. This prevents repeated dispatches on
back-to-back five-minute backstop runs when nothing has changed.

However, a persisted key would suppress re-dispatch _forever_ if the dispatched
workflow run was cancelled or failed before the ci-recovery workflow wrote any
state. To bound this, the coordinator also persists `lastDispatchAt`. Once
`DISPATCH_LEASE_MS` (30 minutes) has elapsed with the same key and no healthy
owner is found, re-dispatch is permitted. Legacy states without `lastDispatchAt`
retain the old behaviour (key match suppresses indefinitely) to avoid spurious
re-dispatches during rollout.

### Failure and recovery boundaries

- **Coordinator run fails / is cancelled**: no state is mutated; the next
  scheduled or event-driven run retries from scratch. The five-minute cron
  backstop bounds maximum staleness.
- **Dispatch lease expires with no healthy owner**: coordinator redrives the
  active slot on the next backstop run.
- **Supersession proof becomes stale** (predecessor PR force-pushed or closed):
  `duplicateProofStillMatches` detects the mismatch on the next run; stale
  proofs are not acted upon.
- **Group shrinks below 3 members** (PRs merged/closed): coordinator continues
  managing the group until all managed members are resolved, ensuring
  order-wait labels are not orphaned.
- **Ambiguous or human-approval-blocked PRs**: escalated via label and open
  comment; coordinator does not close or reorder them.

## Consequences

### Positive

- Stops repeated cross-PR CI invalidation loops that waste CI minutes.
- All closure decisions are based on deterministic full-tree diff evidence,
  not coordinator opinion.
- Composes with existing merge-train and ci-recovery without modifying their
  core logic.

### Negative

- Adds a third orchestration layer that operators must understand when
  debugging stuck PRs.
- The five-minute backstop means ordering decisions can lag by up to five
  minutes after a cluster forms.

### Risks

- A bug in the supersession proof could close PRs with unique changes. Mitigated
  by: proof revalidation immediately before closure, predecessor-head guard,
  healthy-ownership check, and `duplicateProofStillMatches` on every run.

## Alternatives Considered

1. **Extend ci-recovery to be cluster-aware**: rejected because ci-recovery
   operates per-PR by design; adding cross-PR state would violate its single
   responsibility and complicate the shepherd protocol.
2. **Extend merge-train to block cluster members**: rejected because the train
   only sees queue candidates, not all open PRs, and lacks the diff machinery to
   prove supersession.
3. **Manual process / convention**: rejected as insufficient — the problem only
   manifests under concurrent agent activity and requires sub-minute reaction
   time.
