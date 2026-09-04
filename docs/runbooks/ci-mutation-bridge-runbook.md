# CI mutation bridge runbook

## Purpose

This runbook documents lane ownership and the emergency rollback bridge for
Crawler's automation during the Goobers migration.

The migration is **hybrid by design and has no downtime phase.** Ownership is
tracked per lane, and every lane always has exactly one writer:

| Lane                                     | Phase 2 owner | Selector                         |
| ---------------------------------------- | ------------- | -------------------------------- |
| Implementation claim (eligible issue→PR) | **Goobers**   | `LIFECYCLE_MUTATION_OWNER`       |
| CI Recovery router + reconciliation      | legacy        | `LIFECYCLE_OWNER_CI_RECOVERY`    |
| Review-thread reply/resolve              | legacy        | `LIFECYCLE_OWNER_REVIEW_THREADS` |
| Auto-rebase branch updates               | legacy        | `LIFECYCLE_OWNER_BRANCH_UPDATE`  |
| Merge-train admission + promotion        | legacy        | `LIFECYCLE_OWNER_MERGE_TRAIN`    |

## The ownership boundary

Goobers owns **issue intake and implementation, up to and including PR
creation, publication, and readiness.** The moment a PR is published, the claim
is handed off and legacy automation owns the PR lifecycle end to end.

The transferred intake cohort is the **union** of the maintainer-approved queue
and the legacy issue-intake eligibility cohort — Goobers must process at least
every issue the legacy reconciler would have. Membership is decided by one
canonical function (`goobersIntakeEligibility` /
`legacyIntakeCohortEligibility` in
`.github/scripts/ci-recovery/issue-intake-lib.mjs`), consumed by both the
Goobers dispatcher and legacy intake, so the two can never disagree:

| Issue class                                                | `LIFECYCLE_MUTATION_OWNER=goobers` | rollback (`legacy`/malformed) |
| ---------------------------------------------------------- | ---------------------------------- | ----------------------------- |
| `goobers:approved` (any opener)                            | Goobers                            | legacy                        |
| Opened by `nalfeo` / Actions / Copilot, unassigned         | Goobers                            | legacy                        |
| `telemetry` labeled, not approved                          | nobody (excluded by policy)        | nobody                        |
| Untrusted opener, not approved                             | nobody (excluded by policy)        | nobody                        |
| `automation` labeled, not opened by Actions, not approved  | nobody (excluded by policy)        | nobody                        |
| Already assigned (e.g. stale Copilot session restart lane) | legacy                             | legacy                        |
| `goobers/status:in-review` / `completed-existing-work`     | Goobers (in flight / terminal)     | legacy                        |

```
eligible issue ──► Goobers claims ──► implementation ──► PR published
                                                             │
                                                   claim released (handoff)
                                                             │
                                                             ▼
                          legacy: CI Recovery · review threads · rebase · merge train
```

The claim lease exists only to stop two implementers picking up the same
issue. It is keyed by the **issue** (`<owner>/<repo>#issue-<n>`), never
by a PR or head SHA, and **no PR-lifecycle lane consults it**. That is what
guarantees there is no gap: legacy automation is live for a published PR whether
or not a claim ever existed.

## Fail directions (deliberately opposite)

- **Claim lane fails closed against dual writers, not against automation.**
  `LIFECYCLE_MUTATION_OWNER` migrates the lane to Goobers only on the literal
  `goobers`. Any other value — unset, misspelled, wrong case, padded, or the
  literal `legacy` — leaves the whole transferred cohort with **legacy**, the
  same as an explicit rollback (see the table above). Duplicate implementation
  work is the expensive failure, so ambiguity means exactly one writer
  (legacy), never zero and never two.
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
7. Verify a malformed selector (for example `goobrs`) leaves the claim with
   legacy (same as `legacy`, not disabled) and leaves all PR lanes running.

Document the run IDs, timestamps, and the exact mutated PR in the incident or
drill record.

## Known limitations

Phase 2 transfers **only** the pre-PR implementation claim. Merge-train
promotion, review-thread closure, auto-rebase, and CI Recovery state mutations
all remain legacy-owned and fully operational; each moves independently in
Phase 3 via its own lane selector.

## Post-incident review checklist

- What failed in Goobers?
- Was any lane left without a writer at any point?
- Was the emergency bridge enabled only for the shortest possible window?
- Did the system return to `LIFECYCLE_MUTATION_OWNER=goobers` with
  `LEGACY_CI_MUTATION_BRIDGE_ENABLED=true` and all PR lanes on legacy?
- Was the root cause recorded and fixed before closing the incident?
