# CI mutation bridge runbook

## Purpose

This runbook documents lane ownership and the emergency rollback bridge for
Crawler's automation during the Goobers migration.

The migration is **hybrid by design and has no downtime phase.** Ownership is
tracked per lane, and every lane always has exactly one writer:

| Lane                                     | Phase 2 owner | Selector                         | Phase 3 status                |
| ---------------------------------------- | ------------- | -------------------------------- | ----------------------------- |
| Implementation claim (approved issue→PR) | **Goobers**   | `LIFECYCLE_MUTATION_OWNER`       | n/a (Phase 2 lane)            |
| CI Recovery router + reconciliation      | legacy        | `LIFECYCLE_OWNER_CI_RECOVERY`    | not yet migratable            |
| Review-thread reply/resolve              | legacy        | `LIFECYCLE_OWNER_REVIEW_THREADS` | **migratable (Lane A, live)** |
| Auto-rebase branch updates               | legacy        | `LIFECYCLE_OWNER_BRANCH_UPDATE`  | not yet migratable            |
| Merge-train admission + promotion        | legacy        | `LIFECYCLE_OWNER_MERGE_TRAIN`    | not yet migratable            |

## The ownership boundary

Goobers owns **approved-issue intake and implementation, up to and including PR
creation, publication, and readiness.** The moment a PR is published, the claim
is handed off and legacy automation owns the PR lifecycle end to end.

```
approved issue ──► Goobers claims ──► implementation ──► PR published
                                                             │
                                                   claim released (handoff)
                                                             │
                                                             ▼
                          legacy: CI Recovery · review threads · rebase · merge train
```

The claim lease exists only to stop two implementers picking up the same
approved issue. It is keyed by the **issue** (`<owner>/<repo>#issue-<n>`), never
by a PR or head SHA, and **no PR-lifecycle lane consults it**. That is what
guarantees there is no gap: legacy automation is live for a published PR whether
or not a claim ever existed.

## Fail directions (deliberately opposite)

- **Claim lane fails closed.** `LIFECYCLE_MUTATION_OWNER` must be exactly
  `goobers` or `legacy`. Any other value — unset, misspelled, wrong case,
  padded — disables _both_ claim writers. Duplicate implementation work is the
  expensive failure, so ambiguity means nobody writes.
- **PR-lifecycle lanes fail operational.** A lane selector migrates only on the
  literal `goobers`; unset or malformed leaves **legacy** in charge. A typo can
  never silently take CI Recovery, review threads, rebasing, or the merge train
  offline.

`LEGACY_CI_MUTATION_BRIDGE_ENABLED` is the **global emergency kill switch for
legacy mutation** and is independent of Goobers. It stays `true` in steady
state. Cutting the claim lane over to Goobers does **not** require changing it —
that decoupling is what removed the old global-shutdown behavior.

## Cut over the claim lane to Goobers

No drain and no bridge change is required, because no legacy lane is affected.

> **Required after merging the Phase 2 PR.** `LIFECYCLE_MUTATION_OWNER` starts
> unset, and `goobers-run.yml` is gated on the literal `goobers`. Until the
> variable is set, approved-issue intake routes to **legacy** — a safe,
> single-writer state with no gap, but Goobers stays idle.

```bash
gh variable set LIFECYCLE_MUTATION_OWNER -R nalfeo/Crawler --body 'goobers'
```

Verify:

1. Dispatch `Goobers Lifecycle Owner` with `operation=acquire` and the approved
   `issue_number`; the artifact reports `status=acquired` and the managed
   comment names the same issue.
2. Publish a PR that closes that issue and confirm the run reports
   `status=handed-off` and the claim comment is gone.
3. Confirm CI Recovery, auto-rebase, and the merge train **still mutate as
   normal** — they must not log `observe-only`.

## Migrate one PR-lifecycle lane (Phase 3)

Move lanes one at a time; each lane is independent and never dual-written.

```bash
gh variable set LIFECYCLE_OWNER_MERGE_TRAIN -R nalfeo/Crawler --body 'goobers'
```

The legacy workflow for that lane immediately reports `observe-only` while every
other lane keeps running. Roll a lane back by deleting the variable or setting
it to `legacy`.

**Lane A — review-thread reply/resolve** is the first lane migratable this way:

```bash
gh variable set LIFECYCLE_OWNER_REVIEW_THREADS -R nalfeo/Crawler --body 'goobers'
```

`reconcile.mjs` immediately stops posting generic outdated-marker replies and
resolving generic trusted-marker threads itself, and instead dispatches
`goobers-review-threads.yml` once per reconcile run. Follow-up-backlog
threads remain legacy-owned for now because the marker body depends on the
issue(s) reconcile.mjs just created or reused. The hosted workflow re-derives
the generic decision deterministically (`crawler-review-threads` via
`.github/scripts/goobers-review-threads.mjs`) and applies it after re-validating
that the thread state has not changed. Roll it back the same way as any other
lane:

```bash
gh variable set LIFECYCLE_OWNER_REVIEW_THREADS -R nalfeo/Crawler --body 'legacy'
```

## Roll back claim ownership

```bash
gh variable set LIFECYCLE_MUTATION_OWNER -R nalfeo/Crawler --body 'legacy'
```

Goobers claim runs then report `observe-only`. PR-lifecycle lanes are unaffected
because they were never gated on this selector.

## Emergency kill switch

Only for a bounded incident, and understanding that it stops **all** legacy
mutation at once:

```bash
gh variable set LEGACY_CI_MUTATION_BRIDGE_ENABLED -R nalfeo/Crawler --body 'false'
```

Restore with `true` as soon as the incident is contained. If it stays off beyond
a short window, fix the root cause rather than leaving PR automation dark.

## Goobers claim-lease contract

- Scope: one lower-cased `repository#issue-<n>` key.
- Operations: `acquire`, `heartbeat`, `handoff`, `release`.
- TTL: `LIFECYCLE_LEASE_TTL_SECONDS` (120–3600, default 300), measured from the
  GitHub API server timestamp refreshed immediately before the decision.
- Persistence: one `<!-- crawler-lifecycle-lease:v1 -->` comment, registered in
  `.github/scripts/ci-recovery/markers.mjs` with every other managed marker.
- Trust boundary: only comments from trusted authors (automation bots, owners,
  members, collaborators) are counted, so a drive-by comment can neither forge
  an active claim nor poison claim state.
- Contention: an unexpired different lease wins; the contender emits
  `status=contended` and does not write.
- Takeover: an expired claim is replaced deterministically.
- Corruption: malformed or duplicate managed comments disable writes.
- Handoff: requires a PR URL in this repository; anything else is rejected with
  `reason=invalid-handoff-target`. A replayed publication event is idempotent
  and reports `status=handed-off`, `reason=already-released`.

Each run uploads its input and decision artifact, and the apply step logs a
`LIFECYCLE_OWNERSHIP_DECISION` JSON record with status, reason, and lock key.

## Monitoring and operational checks

Monitor these signals during active incidents:

- `LIFECYCLE_OWNERSHIP_DECISION` status/reason counts, especially contention;
- malformed or duplicate claim-marker warnings;
- merge-train and ci-recovery workflow success rate;
- PR mutation latencies;
- branch update or label application failures;
- any repeated "stalled PR" or recovery queue backlog signals.

A PR-lifecycle lane logging `observe-only` when you did **not** migrate it is a
misconfiguration, not expected behavior — check that lane's selector.

## Rollback drill sequence

1. Record the test issue number and the PR it produces.
2. Acquire a claim for the issue and verify `status=acquired`.
3. Publish the PR; verify `status=handed-off` and that the claim comment is
   deleted.
4. Verify CI Recovery, auto-rebase, and the merge train act on that PR normally
   during and after the handoff — this is the no-gap proof.
5. Set `LIFECYCLE_MUTATION_OWNER=legacy`; verify a Goobers acquire reports
   `observe-only` while every PR lane still mutates.
6. Restore `LIFECYCLE_MUTATION_OWNER=goobers` and re-verify one acquire.
7. Verify a malformed selector (for example `goobrs`) disables both claim
   writers and leaves all PR lanes running.

Document the run IDs, timestamps, and the exact mutated PR in the incident or
drill record.

## Known limitations

Phase 2 transfers **only** the pre-PR implementation claim. Merge-train
promotion, auto-rebase, and CI Recovery state mutations remain legacy-owned and
fully operational. Phase 3 review-thread reply/resolve (Lane A) is now
migratable via `LIFECYCLE_OWNER_REVIEW_THREADS` for generic outdated-marker and
trusted-marker resolution. Follow-up-backlog thread replies/resolves remain
legacy-owned until a later contract can pass the created/reused follow-up issue
mapping into Goobers. The hosted wrapper conservatively passes an empty
reachable-commit-SHA set rather than reproducing reconcile.mjs's full
stale-marker lineage/near-typo-promotion logic — a documented limitation, not
a silent gap. Lanes B (CI Recovery reconciliation), C (merge-train admission),
and D (merge-train promotion) remain legacy-owned; each moves independently in
a later Phase 3 slice via its own lane selector.

## Post-incident review checklist

- What failed in Goobers?
- Was any lane left without a writer at any point?
- Was the emergency bridge enabled only for the shortest possible window?
- Did the system return to `LIFECYCLE_MUTATION_OWNER=goobers` with
  `LEGACY_CI_MUTATION_BRIDGE_ENABLED=true` and all PR lanes on legacy?
- Was the root cause recorded and fixed before closing the incident?
