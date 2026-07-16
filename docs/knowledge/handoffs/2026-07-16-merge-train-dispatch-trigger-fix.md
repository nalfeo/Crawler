# Session Handoff: Merge-train post-validation promotion trigger fix

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact)

## Problem

`.github/workflows/merge-train.yml` declares a `workflow_run` trigger on
`'Merge Train Validation'` (`types: [completed]`) as its intended post-validation
completion signal, plus a `*/5` cron schedule as a fallback. Production evidence
showed the `workflow_run` trigger has **never fired**, including after three real
successful validation runs (29460650109, 29460650185, 29460995287). The `*/5`
schedule was also observed arriving ~hourly in practice (GitHub throttles cron
schedules under load), so neither trigger reliably promoted a validated candidate
into the `reconcile` job. The only safe workaround was manual `workflow_dispatch`.

A second, related production finding: manual reconcile run 29461261403 correctly
**paused** PR #1163 with `paused merge train; full-CI run for current main
b9668f... is still in_progress`. Once that push's CI run finishes, the train needs
a reliable wake-up too — but the only trigger that had already fired (`push`) ran
_before_ CI resolved, so nothing re-invoked `reconcile` once CI completed. The
existing `workflow_run` entry only named `'Merge Train Validation'`, and (as above)
schedules were arriving ~hourly, not every 5 minutes.

## What Was Done

Two independent wake-ups were added, covering both gaps:

1. `.github/workflows/merge-train-validate.yml`'s `publish` job now explicitly
   dispatches `merge-train.yml` (`workflow_dispatch` on the default branch) right
   after publishing the immutable `merge-train-candidate` check, for **every**
   publish outcome (`if: always()` — success, failure, or cancelled), so
   `reconcile` promptly consumes/retries/bisects instead of waiting on an
   unreliable trigger. Publication of the check remains authoritative; the
   dispatch is purely a completion signal.
   - Added `actions: write` to the `publish` job's `permissions:` block so the
     job's built-in `GITHUB_TOKEN` can call the Actions dispatch endpoint.
2. `.github/workflows/merge-train.yml`'s `workflow_run` trigger now ALSO lists
   `'CI'` (in addition to `'Merge Train Validation'`), with `branches: [main]`
   added at the trigger level, so a completed push-to-main CI run wakes
   `reconcile` once it resolves. `'CI'` also runs on every PR and on an hourly
   schedule, so without a filter this would storm `reconcile` on every PR-CI
   completion. `branches: [main]` alone is **not** sufficient (GitHub's
   documented `workflow_run` branch filter matches a PR's _base_ branch too, not
   just push branches), so the `reconcile` job's `if:` gained an additional
   guard: `workflow_run.name != 'CI' || workflow_run.event == 'push'` — this
   mirrors the identical, already-shipped storm guard in
   `.github/workflows/deploy.yml` (see `tests/unit/deploy-workflow-gating.test.ts`
   for the precedent). The guard deliberately does **not** check
   `workflow_run.conclusion` (unlike `deploy.yml`), because `reconcile` must wake
   and re-evaluate on **any** CI completion — success, failure, or cancelled — to
   preserve fail-closed semantics (pause/retry/bisect decisions all happen inside
   `reconcile.mjs`, not the trigger gate). The 'Merge Train Validation' wake-up is
   left completely unrestricted by this new guard (`workflow_run.name != 'CI'`),
   since Validation is only ever `workflow_dispatch`'d against `ref: main`.

Common to both:

- Kept `workflow_run` / `schedule` / `workflow_dispatch` / push /
  `pull_request_target` triggers on `merge-train.yml` as defense-in-depth, per the
  task's own instruction — no evidence was gathered to justify removing them,
  only that they aren't sufficient alone.
- Did **not** touch `MERGE_TRAIN_ENABLED`, the ruleset, or branch protection.
- Did **not** use GitHub's native merge queue.
- Added deterministic tests:
  - `tests/unit/merge-train-validate-publish.test.ts` parses the real workflow
    YAML and executes the real dispatch step's script (with
    `github.rest.actions.createWorkflowDispatch` stubbed) to assert: the step
    exists and runs after the check-publish step, has `if: always()`, uses the
    correct token, and dispatches `workflow_id: 'merge-train.yml'` with the
    dynamic default-branch `ref` — not a hardcoded value.
  - `tests/unit/merge-train-workflow-triggers.test.ts` (new, 10 tests) parses the
    real `merge-train.yml` YAML to assert the `workflow_run` trigger lists both
    workflows with `branches: [main]`, asserts the exact `reconcile` job `if:`
    string, and re-transcribes the gate's boolean logic in JS to truth-table it
    against representative payloads (ordinary push/schedule/dispatch; fork vs.
    same-repo `pull_request_target`; CI workflow_run with `event` = push/
    pull_request/schedule; Merge Train Validation workflow_run).

## Key Decision: deviated from "use the App token" to the built-in `GITHUB_TOKEN`

The requesting session's brief specified using "the generated Crawler CI App
token" for this dispatch. I deviated from that literal instruction and used the
job's built-in `GITHUB_TOKEN` instead, because this repo already has **documented,
empirically-verified evidence** that the App token 403s on Actions
`workflow_dispatch` endpoints: `.github/scripts/merge-train/reconcile-lib.mjs`'s
`buildDispatchBindings` factory (shipped in PR #1144,
`docs/knowledge/handoffs/2026-07-14-merge-train-rollout-fix.md`) exists
specifically because both other dispatch call sites in this repo
(`ci-recovery.yml`'s dispatch and `merge-train-validate.yml`'s own trigger from
`reconcile.mjs`) originally used the App token and got 403s, and had to switch to
the workflow's built-in Actions token. Reusing the App token here would very
likely reintroduce the exact bug this task is trying to fix (a dispatch that
silently never lands). A separate-model plan review confirmed this deviation was
correct and did not identify any reason the App token would behave differently
for this third call site.

## Validation

- `npx vitest run tests/unit/merge-train-validate-publish.test.ts` — 11/11 passed.
- `npx vitest run tests/unit/merge-train-workflow-triggers.test.ts` — 10/10 passed.
- `npm run verify:fast` — passed (typecheck, lint, unit tests, physics-defs/size/
  weight coverage checks).
- Parsed both real workflow YAMLs with the `yaml` npm package directly to confirm
  they still parse correctly (permissions, step ordering, script content, trigger
  wiring, job `if:` conditions).
- Separate-model **plan review** (rubber-duck agent, `claude-opus-4.7`):
  confirmed the token deviation, the `GITHUB_TOKEN` workflow_dispatch recursion
  exception, and `queue: max` concurrency safety; flagged two refinements
  (hard-cancellation caveat below, live acceptance check) — both addressed.
- Separate-model **code review** (code-review agent, 2 rounds): round 1 covered
  the validation-dispatch wake-up (no concerns); round 2 covered the CI-completion
  wake-up (no concerns) — confirmed expression precedence, that CI's own triggers
  (push/schedule/pull_request, no workflow_dispatch) make the push-only guard
  exhaustive and correct, that Validation's wake-up is unaffected, that omitting a
  `conclusion` check is deliberate/correct here (unlike `deploy.yml`), and that the
  pre-existing `queue: max` concurrency coalesces bursts safely.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-16-merge-train-dispatch-trigger-fix.review-ledger.json`
  (3🍎, `plan_review` + `code_review` with 2 clean rounds, both complete/clean).

## Known limitation (flagged by plan review, not fixed here)

`if: always()` on the new dispatch step guarantees it fires whenever the
`verify` job reaches a terminal `success`/`failure`/`cancelled`/`skipped`
result (the normal completion paths). It does **not** guarantee dispatch if the
entire validation **workflow run** (not just the `verify` job) is forcibly
cancelled/terminated externally (e.g. GitHub infra outage killing the runner
before any job reaches a terminal state) — GitHub can, in rare cases, terminate
remaining steps of an already-terminated run before they execute. This is an
inherent limit of any in-job completion signal and is not solvable without an
external, wall-clock-based watchdog. The retained `schedule` trigger is the
existing (if currently unreliable) mitigation for this specific edge case; not
addressed further in this PR.

## Follow-ups (not blocking, recommended)

- **Live rollout acceptance check** (per plan review): after this PR merges, run
  one real `Merge Train Validation` dispatch and confirm a `Merge Train` run
  appears promptly afterward with `event: workflow_dispatch` on the default
  branch, sourced from this new step (not the pre-existing `workflow_run`/
  `schedule` triggers). Record the result as a follow-up handoff or in the next
  live-ops handoff, similar to `2026-07-15-merge-train-live-cutover-verified.md`.
- Consider, in a future session with more evidence, whether the `workflow_run`
  trigger should be actively debugged/fixed or removed once the explicit dispatch
  has enough live-fire history to be trusted as the sole primary trigger — out of
  scope here since the task explicitly asked to retain it as defense-in-depth
  absent contrary evidence.
