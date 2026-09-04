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
