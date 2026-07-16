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

3. **Gap found by automated PR review, fixed in this session**:
   `reconcile.mjs`'s `mainHealthAllowsPromotion()`/`mainHealthReason()`
   (`reconcile-lib.mjs`) treat whichever CI run for the current main SHA is
   _newest by `created_at`_ as authoritative health evidence — regardless of
   whether it was `push`- or `schedule`-triggered. If a scheduled CI run for
   the same SHA starts after the push run and is still `in_progress` when
   `reconcile` wakes on the push run's completion, `reconcile` pauses citing
   the schedule run — and (2) above only allowed `workflow_run.event ==
'push'` to wake `reconcile`, so nothing would re-wake it when that
   schedule run later completes. That reproduces the original ~hourly-cron
   fallback bug for exactly this case. Fixed by adding the identical
   `(workflow_run.event == 'schedule' && vars.MERGE_TRAIN_ENABLED == 'true')`
   carve-out already proven in `.github/workflows/ci-recovery-incidents.yml`
   (lines 38-42) to `merge-train.yml`'s `reconcile` job `if:`, gating the
   schedule wake-up on the train actually being enabled (this only _reads_
   `vars.MERGE_TRAIN_ENABLED`; it does not set or alter it). PR-triggered CI
   completions remain blocked in all cases (no storm regression).

Common to both:

- Kept `workflow_run` / `schedule` / `workflow_dispatch` / push /
  `pull_request_target` triggers on `merge-train.yml` as defense-in-depth, per the
  task's own instruction — no evidence was gathered to justify removing them,
  only that they aren't sufficient alone.
- Did **not** touch `MERGE_TRAIN_ENABLED`, the ruleset, or branch protection.
- Did **not** use GitHub's native merge queue.
- Added deterministic tests:
  - `tests/unit/merge-train-validate-publish.test.ts` (16 tests total: 6 for the
    verify-result -> check-conclusion mapping, 5 for the bot-added failed-publish
    recovery step below, 5 for the explicit dispatch) parses the real workflow
    YAML and executes the real dispatch step's script (with
    `github.rest.actions.createWorkflowDispatch` stubbed) to assert: the step
    exists and runs after the check-publish step, has `if: always()`, uses the
    correct token, and dispatches `workflow_id: 'merge-train.yml'` with the
    dynamic default-branch `ref` — not a hardcoded value.
  - `tests/unit/merge-train-workflow-triggers.test.ts` (12 tests) parses the
    real `merge-train.yml` YAML to assert the `workflow_run` trigger lists both
    workflows with `branches: [main]`, asserts the exact `reconcile` job `if:`
    string (including the schedule/`MERGE_TRAIN_ENABLED` carve-out), and
    re-transcribes the gate's boolean logic in JS to truth-table it against
    representative payloads (ordinary push/schedule/dispatch; fork vs.
    same-repo `pull_request_target`; CI workflow_run with `event` = push/
    pull_request/schedule, both with the train enabled and disabled; Merge
    Train Validation workflow_run).

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

- `npx vitest run tests/unit/merge-train-validate-publish.test.ts` — 16/16 passed.
- `npx vitest run tests/unit/merge-train-workflow-triggers.test.ts` — 12/12 passed.
- `npm run verify:fast` — passed (typecheck, lint, unit tests, physics-defs/size/
  weight coverage checks).
- Parsed both real workflow YAMLs with the `yaml` npm package directly to confirm
  they still parse correctly (permissions, step ordering, script content, trigger
  wiring, job `if:` conditions).
- Separate-model **plan review** (rubber-duck agent, `claude-opus-4.7`):
  confirmed the token deviation, the `GITHUB_TOKEN` workflow_dispatch recursion
  exception, and `queue: max` concurrency safety; flagged two refinements
  (hard-cancellation caveat below, live acceptance check) — both addressed.
- Separate-model **code review** (code-review agent, 3 rounds, 2 distinct
  models): round 1 (`gpt-5.4-mini`) covered the validation-dispatch wake-up (no
  concerns); round 2 (`gpt-5.4-mini`) covered the CI-completion wake-up (no
  concerns) — confirmed expression precedence, that CI's own triggers
  (push/schedule/pull_request, no workflow_dispatch) make the push-only guard
  exhaustive and correct, that Validation's wake-up is unaffected, that omitting a
  `conclusion` check is deliberate/correct here (unlike `deploy.yml`), and that the
  pre-existing `queue: max` concurrency coalesces bursts safely; round 3
  (`gpt-5.4`, raised by automated PR review threads on #1166) covered both the
  bot-added "Recover failed check publication" step and this session's
  schedule/`MERGE_TRAIN_ENABLED` carve-out — confirmed the recovery step's
  `checks.create` (same `external_id`/fingerprint) necessarily gets a higher
  check-run id than the original `in_progress` check so `latestChecksByName`'s
  highest-id selection correctly shadows it, confirmed no race with the
  unconditional `if: always()` dispatch step, confirmed `vars.MERGE_TRAIN_ENABLED`
  is readable in job-level `if:` per the working `ci-recovery-incidents.yml`
  precedent, and confirmed no storm-risk reintroduction. No concerns in any
  round.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-16-merge-train-dispatch-trigger-fix.review-ledger.json`
  (3🍎, `plan_review` + `code_review` with 3 clean rounds, all complete/clean).

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

## Concurrent automation on this branch (informational)

While this session was in progress, the repo's own review-comment-reconciliation
automation (`copilot-swe-agent[bot]`, per `.github/workflows/ci-recovery.yml`)
pushed a commit directly to this PR's branch responding to a review thread:
"fix(ci): recover failed check publication to unblock reconcile immediately". It
adds a `publish` job fallback step (`if: failure() && steps.app-token.outcome ==
'success'`) to `merge-train-validate.yml` that force-completes a stale
`in_progress` `merge-train-candidate` check as `cancelled` if `checks.create`
itself fails, so `trainCheckState()` returns `'missing'` (immediately retryable)
instead of `'pending'` (blocking `reconcile` for up to 40 minutes). It shipped
with its own tests in `tests/unit/merge-train-validate-publish.test.ts`. This
session rebased cleanly on top of it (`git pull --rebase`) and fixed one
strict-null typecheck error (`TS2532`) in its new test assertions
(`calls[0].status` → `expect(calls[0]).toEqual(expect.objectContaining(...))`,
matching an existing pattern already used elsewhere in the same file). The
recovery step is complementary to — not overlapping with — the two wake-ups
this session added, and is included in this PR's final diff. It received its
own separate-model code-review round (round 3 above) since it had not been
covered by rounds 1-2.

## Automated PR review threads (copilot-pull-request-reviewer) resolved

The GitHub Copilot automated PR reviewer opened 4 review threads on #1166
(this repo enforces `required_conversation_resolution` in branch protection,
so these block merge even with all status checks green):

1. **Schedule/`mainHealthReason` gap** — genuine, fixed (see item 3 under "What
   Was Done" above).
2. **PR description staleness** — description re-synthesized to cover both
   wake-ups, the schedule/`MERGE_TRAIN_ENABLED` carve-out, and the bot's
   recovery step.
3. **Recovery step lacked its own review round** — added (round 3 above).
4. **Stale test counts in PR body/handoff** — corrected here and in the PR
   description (16 and 12, not 11 and 10).

Each thread was replied to in-place with a `✅ Addressed in <sha>: <note>`
marker per the repo's review-thread-resolution protocol so the
`ci-recovery.yml` reconciler auto-resolves them on its next sweep.

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
