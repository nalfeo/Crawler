# Handoff: Merge-train reliable wake-ups

## Date

2026-07-15

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated and actual — two workflow-trigger changes with deterministic
workflow tests; no review-harness stages are required at this tier.

## What changed

- `Merge Train Validation` now dispatches `merge-train.yml` after its immutable
  candidate check is written. The dispatch uses the existing trusted Crawler CI
  App token and explicitly targets `context.payload.repository.default_branch`.
- `Merge Train` now subscribes to completed default-branch `CI` workflows. Its
  trigger-level `branches: [main]` filter prevents pull-request and
  other-branch CI completions from creating workflow records; its reconcile job
  retains a matching event/name guard as defense-in-depth.
- Existing push, candidate `workflow_run`, schedule, and manual triggers remain
  as defense-in-depth. The existing `crawler-merge-train` concurrency queue
  serializes duplicate wake-ups.
- Added deterministic workflow coverage that executes the real publish script
  to verify App-token/default-branch dispatch ordering and evaluates the real
  reconcile condition for default-branch push, pull-request CI, and
  other-branch CI completions.

## Validation

- `npx vitest run --project unit tests/unit/merge-train-validate-publish.test.ts tests/unit/merge-train-workflow-wakeups.test.ts`
- `npm run verify:fast`

## Runtime observation

Before this change, production candidate validations `29460650109`,
`29460650185`, and `29460995287` did not produce a `workflow_run` reconcile
and required manual dispatch. Reconcile `29461261403` correctly waited for
main CI, but its completion did not reliably wake the train; manual run
`29461378449` was required for #1163. The new event paths cannot be
production-observed until this workflow change merges to `main`; the
deterministic workflow tests cover the intended before/after routing.

## Follow-up

After merge, observe one candidate validation and one completed default-branch
CI run in Actions to confirm each produces a queued Merge Train reconcile with
no reconcile from a pull-request CI completion.
