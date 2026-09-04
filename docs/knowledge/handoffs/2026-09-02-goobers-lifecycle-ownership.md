# Goobers lifecycle ownership cutover

## Systems touched

ci-policy

## Summary

Added the Phase 2 single-writer boundary for PR lifecycle claim/lease decisions.
Goobers now produces deterministic acquire, heartbeat, release, contention, and
takeover decisions for a repository/PR/head-SHA lease. A trusted base-repository
workflow persists the decision only after rechecking the live head, repository,
owner selector, bridge setting, and current managed comment.

All overlapping legacy mutation entry points now require the exact rollback
pair `LIFECYCLE_MUTATION_OWNER=legacy` and
`LEGACY_CI_MUTATION_BRIDGE_ENABLED=true`. Goobers requires the inverse exact
pair. Invalid or partially applied configuration disables both writers, while
legacy workflows retain explicit observe-only paths.

## Files touched

- `.github/scripts/lifecycle-ownership.mjs`
- `.github/workflows/goobers-lifecycle-owner.yml`
- `.goobers/gaggles/crawler/workflows/crawler-lifecycle-owner.yaml`
- legacy lifecycle workflow gates and their contract tests
- Goobers and CI ownership documentation

## Key decisions

- Reused PR comments as the durable lifecycle state surface instead of adding an
  external lock service.
- Used an explicit owner enum plus the existing bridge authorization rather
  than treating an unset boolean as Goobers ownership.
- Shared non-cancelling per-PR workflow concurrency with CI Recovery, then
  repeated repository-variable, trust, head, and lease checks immediately
  before persistence.
- Kept merge-train promotion, review-thread closure, CI Recovery state
  mutation, and auto-rebase lane migration out of Phase 2.
- Counted only trusted-author lease comments (registry-defined marker) so a
  drive-by comment cannot forge or permanently poison lease state, and made the
  owner/bridge and TTL parsers reject any non-literal value.
- Made the live PR head part of the decision input so a stale caller head emits
  an observable `reason=stale-head` rejection in the artifact instead of only
  being dropped by the apply-time fence.

Alternatives rejected were coupling the lease to CI Recovery's larger legacy
state machine, using labels without lease metadata, relying on workflow
serialization without an owner fence, and adding an external persistence
service before a cross-repository lock is required.

## Verification

- `npm run test:unit -- tests/unit/goobers-lifecycle-ownership.test.ts tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-shadow.test.ts` — 25 passed before the type-boundary fix; the ownership suite then passed 7/7.
- `node --test .github/scripts/merge-train/workflow-gating.test.mjs` — 7 passed.
- `node --test .github/scripts/ci-recovery/router.test.mjs` — 149 passed
  (managed-marker inventory covers the lease marker and its data prefix).
- `node .github/scripts/validate-goobers-contracts.mjs` — 8/8 workflows and 19/19 fixtures passed.
- Direct `lifecycle-ownership.mjs` CLI acquire exercise — `status=acquired`, `writeAction=create`.
- `npm run typecheck` — passed after converting the test to the repository's dynamic `.mjs` import pattern.
- `tests/unit/ci-knobs-guard.test.ts` — operational lease TTL registered and
  documented after the first `verify:fast` correctly rejected an unregistered
  file-scope constant.

## Parked PR freshness intervention

On 2026-09-02, PR #4091 was intentionally parked behind
`human-approval-required` until Goobers shadow mode is unblocked and produces
hosted data. The PR was otherwise mergeable, had no unresolved review threads,
and was cleanly `BEHIND` current `main` at head
`af0b96ba1a9bfbeb8c945c032410b358395fae7d`.

The limited shepherding intervention:

- retained the existing human approval gate and `merge-train-blocked` state;
- did not synthesize `APPROVED FOR CHECK-IN`, add `merge-train`, arm
  auto-merge, or attempt a merge;
- heartbeated shared lease
  `shepherd-4091-cd5931aa-84a3-4086-a22a-7977e081cbaa` in CI Recovery run
  `33720106335`;
- fetched current `main` and merged it without conflicts, producing local
  reconciliation commit `fb6aaca95`;
- left the feature's Phase 2 scope and operational cutover requirements
  unchanged.

Automation did not refresh the parked branch because the blanket freshness path
in `auto-rebase-prs.yml` treats `human-approval-required` as an automation
opt-out, while `merge-train.yml` only handles PRs already carrying or
transitioning the `merge-train` queue label. That leaves intentionally parked,
approval-gated PRs outside both branch-update paths.

The permanent fix candidate is to separate branch freshness from merge
admission. A trusted scheduled lane should update same-repository,
clean-`BEHIND` parked PRs with an expected-head fence while preserving
`human-approval-required`, never adding `merge-train`, and never granting or
inferring approval. It should remain lease-aware, emit durable update/skip
telemetry, and route `DIRTY` branches to explicit conflict recovery instead of
force-pushing. This keeps long-lived evaluation PRs current without weakening
their human gate.

## Phase 2 redesign: hybrid ownership, no downtime (2026-09-04)

The repository owner added a hard requirement after the first implementation was
already green: **there must be no migration phase where pipeline pieces stop
working.** The original design failed that requirement and was rebuilt.

### What was wrong

Every legacy PR-lifecycle workflow was gated on the single global pair
`LIFECYCLE_MUTATION_OWNER == 'legacy' && LEGACY_CI_MUTATION_BRIDGE_ENABLED ==
'true'`, and the Goobers claim required `owner=goobers` **plus** the bridge set
to `false`. Those two conditions are mutually exclusive, so selecting Goobers
necessarily turned CI Recovery, review threads, auto-rebase, and the merge train
observe-only at the same instant — a full PR-automation outage for the whole of
Phase 2.

Worse, `LIFECYCLE_MUTATION_OWNER` is **unset** in this repository today. The
gates would have evaluated false on merge, so legacy automation would have gone
dark the moment the PR landed, before anyone ran a cutover.

### The revised design

Ownership is now resolved **per lane**, and the two lane families fail in
deliberately opposite directions:

| Lane                                | Phase 2 owner | Selector                         | Invalid config |
| ----------------------------------- | ------------- | -------------------------------- | -------------- |
| Implementation claim (issue → PR)   | Goobers       | `LIFECYCLE_MUTATION_OWNER`       | fails closed   |
| CI Recovery router + reconciliation | legacy        | `LIFECYCLE_OWNER_CI_RECOVERY`    | stays legacy   |
| Review-thread reply/resolve         | legacy        | `LIFECYCLE_OWNER_REVIEW_THREADS` | stays legacy   |
| Auto-rebase branch updates          | legacy        | `LIFECYCLE_OWNER_BRANCH_UPDATE`  | stays legacy   |
| Merge-train admission + promotion   | legacy        | `LIFECYCLE_OWNER_MERGE_TRAIN`    | stays legacy   |

The claim lane fails closed because duplicate implementation work is the
expensive failure. Every PR-lifecycle lane fails _operational_ because those
lanes are required for PRs to move at all — a typo must never take one dark.
`LEGACY_CI_MUTATION_BRIDGE_ENABLED` is now purely the global emergency kill
switch for legacy mutation and is fully decoupled from Goobers, so the cutover
no longer touches it.

### The handoff

The lease is no longer a PR lifecycle lease. It is scoped to the **approved
issue** (`<owner>/<repo>#issue-<n>`) and covers only pre-PR implementation. At
PR publication the workflow resolves the closing issue from GitHub's own
`closingIssuesReferences` and performs a deterministic `handoff` that deletes
the claim marker. No PR-lifecycle lane consults the claim, so legacy automation
is live for the published PR either way — the handoff is an audit record, not a
gate. A replayed publication event is idempotent.

`goobers-lifecycle-owner.yml` therefore no longer triggers on `synchronize` or
`closed`, and its concurrency group moved from the shared PR group to
`crawler-implementation-claim-*` so the claim lane can never serialize behind or
stall PR automation. `ci-recovery.yml` returns to its original
`crawler-ci-pr-*` group.

### Proof

`tests/unit/goobers-lifecycle-ownership.test.ts` asserts the full matrix:
Phase 2 steady state (Goobers claim + legacy on every PR lane); exactly one
writer per lane; malformed claim config failing closed _while every PR lane
keeps its legacy writer_; each Phase 3 lane migrating independently with no dual
writer; rollback restoring legacy claim ownership; the kill switch stopping all
legacy lanes without promoting Goobers; and the end-to-end handoff contract
including idempotent replay and rejection of out-of-repository handoff targets.
`workflow-gating.test.mjs` asserts each legacy workflow is gated on its own lane
variable and that the claim selector appears in none of them.

### Independent review round (2 reviews, per 4🍎 review harness)

Two independent post-diff reviews ran on different models (GPT-5.6 Sol and
Claude Opus 4.8). Both independently identified the same critical
`pull_request_target` vulnerability, which is strong signal it was real.

Validated findings and their fixes:

1. **Critical — a fork PR could delete a legitimate implementation claim.**
   `goobers-lifecycle-owner.yml` runs on `pull_request_target` with
   `issues: write`, which grants base-repository write even for fork PRs. The
   re-scoping had dropped the old fork fence, so an outside contributor could
   open a fork PR whose body said `Fixes #N` and make the publication handoff
   delete the active claim on that issue — re-opening it for duplicate
   implementation, repeatedly. Fixed by resolving `headRepository` from the PR
   and rejecting any head outside this repository with `reason=fork`.
2. **The handoff URL check was bypassable.** A `startsWith` prefix test accepts
   `.../pull/1/../../../attacker/...` and look-alike hosts. Replaced with
   `isRepositoryPullRequestUrl`, which parses the URL and matches scheme, host,
   and exact path segments.
3. **`LIFECYCLE_OWNER_REVIEW_THREADS` was a dead knob.** It was passed as an env
   var that no script read, so migrating the lane would have silently produced a
   dual writer, while migrating the CI-recovery lane would have taken review
   threads dark. Now enforced inside `reconcile.mjs` at all three review-thread
   mutation sites via `legacyReviewThreadWritesEnabled()`, making the lane
   genuinely independent.
4. **Rollback did not restore approved-issue intake.** Legacy intake refused
   every `goobers:approved` issue unconditionally (pre-existing on `main`), so
   `LIFECYCLE_MUTATION_OWNER=legacy` would have left approved issues with no
   intake owner at all — the exact gap this work exists to prevent. The three
   deferral sites are now conditional on `goobersOwnsImplementationClaim()`.
5. **Publication considered only the first closing issue.** A PR closing several
   issues could leave the actual claim leased. Now every closing reference is
   scanned for a trusted claim; multiple claims are refused as ambiguous rather
   than guessed.
6. **An expected no-op failed the workflow.** The skip path returned before
   creating `.goobers-lifecycle/`, while the artifact upload uses
   `if-no-files-found: error`. The skip path now writes an observe-only decision
   artifact.

One finding was **not** actioned by design: a reviewer argued that an unset
`LEGACY_CI_MUTATION_BRIDGE_ENABLED` taking all legacy lanes dark violates the
fail-operational rule. That default is pre-existing on `main`, the second
reviewer explicitly assessed it as not a regression, and inverting an existing
emergency control without the owner's agreement would itself be a silent
weakening. It is instead documented as the one deliberate global kill switch,
with the runbook noting that a PR lane reporting `observe-only` when it was not
migrated is a misconfiguration. **Operational note for the owner: keep that
variable set to `true`; deleting it stops all legacy PR automation.**

## Merge-train shepherd intervention (2026-09-03)

Shepherded under shared lease
`phase2-cutover-a167fa3c-8226-4527-a065-5a239663b17b` after the repository owner
approved the Phase 2 cutover.

- Reconciled the branch with `main` (21 commits behind → 0). The silent
  merge-revert guard confirmed no surviving reverts across the two merge
  commits, and all six previously-resolved review-thread fixes were verified
  still present in the merged tree (trusted-author marker filtering, registry
  marker sourcing, strict TTL parsing, literal owner/bridge gates, `queue: max`
  concurrency, and the `liveHeadSha` stale-head rejection).
- Diagnosed CI run `33720282498`: the `E2E Visual — Game/UI` job was
  `cancelled` by concurrency, which is what failed the `Merge gate`/`ci`
  aggregate. No real defect; superseded by the branch update.

### Real blocker found: the owner workflow could not start

`goobers-lifecycle-owner.yml` was authored from the pre-fix `goobers-shadow`
template and reintroduced the exact defect class fixed on `main` by PR #4132 and
PR #4157. Run `33823932907` was a zero-job failure named by the workflow file
path — the invalid-workflow-file signature — because a `runner.temp` expression
sat in `jobs.<id>.env`, where the `runner` context is unavailable.

This mattered beyond a red check: cutting lifecycle ownership over to a workflow
that GitHub refuses to start would have left PR lifecycle handling with no
writer at all. Fixed by mirroring main's proven shape:

- resolve `GOOBERS_INSTANCE` at runtime from `$RUNNER_TEMP` in each consuming
  step instead of job-level `env`;
- create the `config/` directory Goobers v0.3.3 requires at materialization;
- materialize an isolated `workflowSource` containing only
  `crawler-lifecycle-owner.yaml`, rather than the whole checked-out `.goobers`
  tree, so unrelated feature workflows do not enter model-harness preflight;
- enable `include-hidden-files` for the `.goobers-lifecycle/` artifact.

Regression coverage for the rejected-expression class, the three runtime
assignments, isolated materialization, and hidden artifact upload was added to
`tests/unit/goobers-lifecycle-ownership.test.ts`, mirroring the equivalent
`goobers-shadow` assertions so the template defect cannot silently return.

No gate was weakened, no requirement relaxed, and auto-merge was never armed.

## Unresolved issues

The repository variables still require the documented drain-first operational
cutover after this change lands. Phase 3 mutation lanes must not start until
the Goobers ownership workflow and rollback drill have run successfully in the
hosted environment.

## Recommended next steps

1. Follow the runbook to select `off`, drain legacy runs, then select Goobers.
2. Exercise acquire, contention, expiry/takeover, release, and the rollback
   drill on a controlled same-repository PR plus the fork rejection case.
3. Begin Phase 3 only after those hosted artifacts show one writer per PR/head.

## Planning metrics

- Contract: ready; hard gate and dependency DAG required no human correction.
- Slices: one DevOps implementation slice; no cross-persona dependency.
- Rework: one pre-implementation design correction and one TypeScript import
  correction from deterministic verification.

## Apples

Estimated 3, actual 3 — exact. The work added one automation subsystem, its
trusted workflow boundary, focused tests, and operator documentation within the
tooling-only ceremony cap.
