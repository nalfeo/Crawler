# Crawler Goobers Configuration

This directory is Crawler's versioned Goobers desired-state source. It defines
the `crawler-feature-pr` workflow, dispatched automatically by GitHub Actions
for every issue in the Goobers intake cohort and rediscovered by an hourly
recovery sweep:

```text
eligible issue (approved, or the legacy intake cohort)
  -> producer plan
  -> implementer
  -> independent reviewer
  -> npm run verify:fast
  -> ready-for-review PR
```

The intake cohort is the union of two sets, decided by the single canonical
selector in `.github/scripts/ci-recovery/issue-intake-lib.mjs` (wrapped for the
CLI by `.github/scripts/goobers/intake-selection.mjs`):

- **approved** — any open, unassigned issue labeled `goobers:approved`,
  regardless of who opened it; and
- **legacy-parity** — every issue the legacy Issue Copilot Intake reconciler
  would have picked up: opened by `nalfeo`, `github-actions[bot]`, or a
  recognized Copilot identity, not labeled `telemetry`, and `automation`-labeled
  only when GitHub Actions opened it.

Issues already assigned, already carrying `goobers/status:in-review`, or
dispositioned `goobers/status:completed-existing-work` are excluded. While
`LIFECYCLE_MUTATION_OWNER=goobers`, the trusted Issue Copilot Intake workflow is
observe-only for exactly that cohort, so there is one intake owner and no
no-work gap; on rollback, legacy resumes the whole cohort and Goobers claims
nothing at all.

One legacy behavior is a deliberate carve-out, not a parity gap: the unblock
sweep (`intakeUnblockedDependents`) bypasses the `automation`-label
restriction for a dependent whose blocker just closed, on the theory that a
human who wired up the `blocked_by` chain already meant for Copilot to pick it
up. Goobers has no equivalent dependency-unblock trigger — its cohort is
computed from `issues` events and the hourly sweep, never from a _blocker_
closing — so that specific dependent is never a candidate `goobersIntakeEligibility`
would independently claim, and it stays with legacy rather than becoming
ownerless or dual-claimed.

The workflow never merges a PR. Plan, implementation, and review each allow at
most two attempts, and the run
allows at most two gate repasses. After implementation commits, the workflow
checkpoints the branch before review so partial progress survives a failed run.
When an issue is linked to an open PR, the hosted wrapper passes its validated
head branch to Goobers. The workflow's claim stage emits Goobers'
`workspaceBranch` output, rebinding every subsequent managed worktree to that
branch instead of creating a duplicate. Manual dispatches can set
`issue_number` to select the issue, or `abandon_existing` to close the attached
open PR and intentionally start over.

Shadow mode is a read-only parity path used during Goobers Phase 1. Its
scheduled workflow reads only the resolved UTC report day's completed CI
Recovery and Merge Train runs, then downloads the immutable PR/head decision
records captured by those legacy runs. Each record includes the actual legacy
outcome plus the contemporaneous lifecycle and review-thread inputs loaded
through CI Recovery's authoritative paginated reader. A capability-empty
`crawler-lifecycle-shadow` Goobers workflow produces the independent dry-run
decisions. The comparison emits stable per-run decisions plus a
`daily-report.json` artifact with an idempotency key. Missing requested workflow
coverage and marker-resolution differences are explicit parity divergences.
The workflow has no write-capable permissions and makes no repository, issue,
or PR mutation call.

Phase 2 adds `crawler-lifecycle-owner`, the authoritative deterministic
acquire/heartbeat/handoff/release decision path for the **pre-PR implementation
claim**. The boundary is explicit:

- **Goobers owns** approved-issue intake and the implementation work, up to and
  including PR creation, publication, and readiness.
- **At PR publication the claim is handed off.** The claim lease is deleted and
  legacy automation owns the PR lifecycle from that moment: CI Recovery and
  reconciliation state, review-thread reply/resolve, auto-rebase branch updates,
  and merge-train admission plus promotion/eviction.

The claim lease exists only to stop two implementers claiming the same approved
issue. It is deliberately **not** a PR-lifecycle lease, it is keyed by the issue
(`<owner>/<repo>#issue-<n>`), and no PR-lifecycle lane consults it. The hosted
`goobers-lifecycle-owner.yml` wrapper supplies a GitHub workflow-run timestamp,
serializes on its own `crawler-implementation-claim-*` group (never the PR
group, so it cannot stall PR automation), and revalidates the owner selector and
current marker before persisting the decision in one managed comment. The
Goobers workflow itself has no GitHub mutation capability. Contention and
malformed or duplicate marker state fail closed and stay visible in the uploaded
decision artifact.

**Ownership is per lane, so a cutover has no downtime.**
`LIFECYCLE_MUTATION_OWNER` selects the owner of the implementation-claim lane
**only**, and migrates it to Goobers only on the exact literal `goobers`.
Every other value — unset, malformed, or the literal `legacy` — leaves legacy
in charge of the whole transferred cohort (rollback), the same one-writer
behavior as every other lane selector below: fail closed against a _dual_
writer, never fail closed against automation entirely. Every PR-lifecycle lane
has its own selector
(`LIFECYCLE_OWNER_CI_RECOVERY`, `LIFECYCLE_OWNER_REVIEW_THREADS`,
`LIFECYCLE_OWNER_BRANCH_UPDATE`, `LIFECYCLE_OWNER_MERGE_TRAIN`) that defaults to
`legacy` and only migrates on the literal `goobers`. A misconfigured or unset
lane selector therefore leaves legacy in charge rather than silently taking a
required lane offline. `LEGACY_CI_MUTATION_BRIDGE_ENABLED` remains the global
emergency kill switch for legacy mutation and is independent of Goobers, so
selecting Goobers for the claim lane never requires disabling it. See
[`docs/runbooks/ci-mutation-bridge-runbook.md`](../docs/runbooks/ci-mutation-bridge-runbook.md)
for the cutover, per-lane Phase 3 migration, and rollback procedure.
Runtime journals remain outside this source tree; only retries within one
Actions job share its throwaway instance.

Phase 3 migrates PR-lifecycle lanes one at a time behind their own selector.
Lane A (review-thread reply/resolve) is now live for generic review-thread
markers: `crawler-review-threads` deterministically decides which unresolved
threads get an outdated-marker reply or a resolve, reproducing reconcile.mjs's
own two-phase behavior with no network calls of its own. The hosted
`goobers-review-threads.yml` wrapper only runs when
`LIFECYCLE_OWNER_REVIEW_THREADS` is the literal `goobers`, re-fetches each
thread immediately before writing so a stale decision can never mutate, and
posts/resolves with the job's own installation token (a first-party bot reply
already satisfies the marker-trust check in `ci-recovery/state.mjs`, so no
elevated PAT is required). Follow-up-backlog thread replies/resolves remain
legacy-owned for now because that path depends on the issue(s) reconcile.mjs
just created or reused, and the Goobers contract intentionally does not carry
that mapping yet. It conservatively passes an empty reachable-commit-SHA set
rather than reproducing reconcile.mjs's full stale-marker lineage/near-typo
logic — a documented limitation, not a silent gap. Lanes B (CI Recovery
reconciliation), C (merge-train admission), and D (merge-train promotion)
remain legacy-owned and move independently in later Phase 3 slices.

## Contract Versions

All invocations and outputs between GitHub Actions and Goobers workflows
conform to versioned schemas documented in
[`docs/knowledge/handoffs/goobers-phase0-mutations-and-contracts.md`](../docs/knowledge/handoffs/goobers-phase0-mutations-and-contracts.md)
and enforced by
[`.github/scripts/validate-goobers-contracts-schema.js`](../.github/scripts/validate-goobers-contracts-schema.js).

**Current version**: `v1`

- **Invocation schema** (`crawler.goobers.invocation/v1`): Workflow dispatch inputs
- **Output schema** (`crawler.goobers.output/v1`): Goobers workflow result payloads
- **Validation**: CI job `.github/workflows/goobers-contract-validation.yml` enforces schema conformance

**Upgrading to v2 (future)**:
When the contract must change, increment to `v2` in the schema definition and
add bidirectional compatibility handling in CI Recovery and Merge Train scripts.
Old invocations in flight will continue using v1 until their workflow runs
complete; new invocations can opt into v2. Validation gates fail closed on
unknown versions.

## Runtime boundary

Do not put tokens, journals, workcopies, scheduler state, or telemetry in this
directory. They belong in the external instance root, currently
`C:\goobers\crawler`.

After this source is merged, stop the Goobers daemon and migrate the external
instance through guided source setup. Validate the source before materializing:

```powershell
Q:\src\Goobers\bin\goobers.exe validate --source-tree .goobers
```

The source gaggle key is `crawler`. Before materializing it, archive or remove
the external instance's legacy `example` gaggle runtime state so the new source
has no stale claims or journals to inherit.

Before applying `goobers:approved`, ensure the issue is not already assigned to
Cloud Copilot. The default-branch intake guard prevents new Cloud Copilot
assignments after the label is present, but it cannot retroactively revoke an
existing Cloud Copilot assignment.
