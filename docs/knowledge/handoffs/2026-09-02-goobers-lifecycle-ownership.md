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

Alternatives rejected were coupling the lease to CI Recovery's larger legacy
state machine, using labels without lease metadata, relying on workflow
serialization without an owner fence, and adding an external persistence
service before a cross-repository lock is required.

## Verification

- `npm run test:unit -- tests/unit/goobers-lifecycle-ownership.test.ts tests/unit/goobers-run-workflow.test.ts tests/unit/goobers-shadow.test.ts` — 25 passed before the type-boundary fix; the ownership suite then passed 7/7.
- `node --test .github/scripts/merge-train/workflow-gating.test.mjs` — 7 passed.
- `node .github/scripts/validate-goobers-contracts.mjs` — 8/8 workflows and 19/19 fixtures passed.
- Direct `lifecycle-ownership.mjs` CLI acquire exercise — `status=acquired`, `writeAction=create`.
- `npm run typecheck` — passed after converting the test to the repository's dynamic `.mjs` import pattern.

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
