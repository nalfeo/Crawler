# CI mutation bridge runbook

## Purpose

This runbook documents lane ownership and the emergency rollback bridge for
Crawler's automation during the Goobers migration.

The migration is **hybrid by design and has no downtime phase.** Ownership is
tracked per lane, and every lane always has exactly one writer:

| Lane                                     | Phase 2 owner | Selector                         | Phase 3 status                |
| ---------------------------------------- | ------------- | -------------------------------- | ----------------------------- |
| Implementation claim (eligible issue→PR) | **Goobers**   | `LIFECYCLE_MUTATION_OWNER`       | n/a (Phase 2 lane)            |
| CI Recovery router + reconciliation      | legacy        | `LIFECYCLE_OWNER_CI_RECOVERY`    | not yet migratable            |
| Review-thread reply/resolve              | legacy        | `LIFECYCLE_OWNER_REVIEW_THREADS` | **migratable (Lane A, live)** |
| Auto-rebase branch updates               | legacy        | `LIFECYCLE_OWNER_BRANCH_UPDATE`  | not yet migratable            |
| Merge-train admission + promotion        | legacy        | `LIFECYCLE_OWNER_MERGE_TRAIN`    | not yet migratable            |

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

## Phase 4 — decommission the legacy mutation paths

Phase 4 retires the legacy lifecycle mutation paths and leaves Goobers as the
sole orchestration writer. Removal is **data-gated, not a judgement call**:

```bash
npm run check:legacy-decommission
```

That command reads the committed evidence record
`.github/lifecycle/decommission-state.json` and reports two independent things:

1. **Readiness** — every blocker still standing between today and removal.
2. **Surface** — every live legacy mutation step, and whether it is gated.

The surface scan exits non-zero (`2`) on either state that is never safe:

- `ungated-legacy-mutation` — a legacy mutation step not gated on **its own**
  lane selector plus `LEGACY_CI_MUTATION_BRIDGE_ENABLED`. That is a dual writer
  the moment the lane migrates.
- `decommissioned-without-migration` — a registered legacy mutation entrypoint is
  gone while the readiness decision is not yet `ready`. That leaves the lane
  short a writer and can take PR automation dark. This is the mistake Phase 4
  must not make, so it is enforced deterministically rather than reviewed by eye.
  Two properties matter here:
  - Presence is tracked **per registered entrypoint**, not as an aggregate step
    count, so deleting `merge-train/reconcile.mjs` is reported even though
    `merge-train/quarantine-repair.mjs` still matches in the same workflow.
  - Removal is licensed by the **full readiness decision**, not by lane ownership
    alone. Flipping a lane selector to `goobers` does not by itself permit
    deleting its fallback while the soak, rollback drill, or branch-protection
    update are still outstanding.

The `review-threads` lane has no workflow-level surface entry because its gate
lives inside `reconcile.mjs` (`legacyReviewThreadWritesEnabled`); it is covered
by `.github/scripts/ci-recovery/reconcile.test.mjs`.

### Decommission preconditions

`npm run check:legacy-decommission` reports `ready` only when **all** hold:

| Blocker                                       | Cleared by                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lane-not-migrated:<lane>`                    | Every PR-lifecycle lane selector observed as the literal `goobers`, recorded per lane.                                                                                                  |
| `invalid-state:<field>:<reason>`              | The record conforms to the versioned schema: `version` is `1`, IDs/checks are non-empty strings, and no past-event timestamp is later than now. Any violation short-circuits readiness. |
| `soak-not-started` / `soak-incomplete`        | `soak.startedAt` set at full migration, and `requiredDays` (default 14) elapsed.                                                                                                        |
| `rollback-activation:<at>`                    | No rollback activation at or after `soak.startedAt` — a rollback restarts the soak.                                                                                                     |
| `rollback-drill-*`                            | A `pass` drill completed **after** the soak start, with its workflow run IDs recorded.                                                                                                  |
| `emergency-bridge-not-retained` / `-window-*` | `LEGACY_CI_MUTATION_BRIDGE_ENABLED` retained with a declared, unexpired `boundedUntil`.                                                                                                 |
| `branch-protection-not-updated`               | Branch-protection required checks updated to the final Goobers contexts and recorded.                                                                                                   |

Update the record in a PR as each precondition is met. The live source of truth
for a lane owner remains its repository variable; the record is the durable,
reviewable attestation that the variable was observed in that state, which is
what makes the gate auditable after the fact.

### Phase 4 rollback drill

Run this **inside** the soak window and after every lane is on Goobers. It
proves the fallback still works before the fallback is deleted.

1. Pick one live, non-urgent PR and record its number and head SHA.
2. Roll one lane back: `gh variable set LIFECYCLE_OWNER_MERGE_TRAIN -R nalfeo/Crawler --body 'legacy'`.
3. Confirm the legacy job for that lane resumes mutating (it must **not** log
   `observe-only`) and the Goobers workflow for the lane no-ops.
4. Restore the lane: `gh variable set LIFECYCLE_OWNER_MERGE_TRAIN -R nalfeo/Crawler --body 'goobers'`,
   and confirm ownership flips back on the next event.
5. Repeat 2–4 for each remaining lane selector.
6. Exercise the global kill switch once: set
   `LEGACY_CI_MUTATION_BRIDGE_ENABLED=false`, confirm **every** legacy lane
   reports `observe-only` while Goobers keeps writing, then restore `true`.
7. Record the drill in `.github/lifecycle/decommission-state.json` with
   `result: "pass"`, `completedAt`, and every workflow `runIds` entry.

A drill that required an unplanned rollback to recover is a **failed** drill:
record `result: "fail"`, fix the root cause, restart the soak.

### Steady-state operations (post-decommission)

- Goobers is the only writer for every lifecycle lane. Lane selectors stay on
  `goobers`; a selector reverting to `legacy` after decommission is a
  misconfiguration, not a rollback, because the legacy path is gone.
- The surface property is enforced in CI by
  `.github/scripts/lifecycle-decommission.test.mjs`, which runs under
  `npm run test:guards` (the `ci.yml` guard job and `scripts/agent/verify.sh`):
  a legacy mutation path that returns ungated, or is removed while its lane is
  still legacy-owned, fails the build. `npm run check:legacy-decommission` is
  the operator-facing view of the same evaluation and is run manually.
- Branch-protection required checks name the final Goobers contexts recorded in
  `branchProtection.requiredChecks`.

### Emergency operations (post-decommission)

The minimal emergency bridge is retained only for the bounded window recorded in
`emergencyBridge.boundedUntil`. Within that window, restoring a lane is exactly
the Phase 3 rollback: set the lane selector to `legacy` and confirm
`LEGACY_CI_MUTATION_BRIDGE_ENABLED=true`. After the window closes and the
fallback code is removed, the only recovery is a revert of the removal PR —
which is why the drill must pass **before** removal, not after.

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
a later Phase 3 slice via its own lane selector. Phase 4 removal of any legacy
lane is gated on `npm run check:legacy-decommission` reporting `ready`, which no
lane can reach until it is migrated, soaked, and drilled.

## Post-incident review checklist

- What failed in Goobers?
- Was any lane left without a writer at any point?
- Was the emergency bridge enabled only for the shortest possible window?
- Did the system return to `LIFECYCLE_MUTATION_OWNER=goobers` with
  `LEGACY_CI_MUTATION_BRIDGE_ENABLED=true` and all PR lanes on legacy?
- Was the root cause recorded and fixed before closing the incident?
