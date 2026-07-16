# 2026-07-16 — Merge train wake-up gaps (fail-closed dispatch + scheduled-CI wake)

## Systems touched

merge-automation, ci-infra

## Summary

Focused follow-up fix on top of already-merged PR #1165 ("fix(merge-train): add
reliable reconciliation wake-ups"). #1165 shipped the core idea (explicit
`workflow_dispatch` of `merge-train.yml` from `merge-train-validate.yml`'s
`publish` job, plus a CI-completion wake-up with a push/default-branch storm
guard) but had two remaining gaps versus the original task's explicit
requirements. This PR closes both:

1. **Fail-closed dispatch regression**: `merge-train-validate.yml`'s "Wake
   merge-train reconciliation" step had **no `if:` condition**, which GitHub
   Actions defaults to implicit `success()`. That meant the wake-up dispatch
   was silently skipped whenever the prior "Publish immutable candidate
   result" step itself failed (e.g. a transient `checks.create` API error) —
   directly violating the task requirement that dispatch happen for
   success/failure/cancelled publication so `reconcile` can consume, retry, or
   bisect. Fixed by adding `if: always()` (matching the sibling `publish` job's
   own `if: always()`).

   **Follow-up fix from code review**: `if: always()` alone made the wake
   _dispatch_ fire on a failed publish step, but did not make the wake
   _effective_. The fingerprinted check stayed whatever the original
   `dispatchValidation()` (reconcile.mjs) posted — `in_progress` — and
   `trainCheckState()` (state.mjs) only demotes a stuck in_progress check to
   retryable (`missing`) after `CANDIDATE_VALIDATION_STALE_MS` (40 minutes);
   before that it reports `pending`, which `planPrefixPromotion()` maps to the
   `wait` action. So the immediate wake would just see `pending` and do
   nothing — no better than the unreliable schedule fallback it exists to
   replace. Added a new "Mark candidate check retryable if publishing failed"
   step (`if: failure()`, runs after the publish step and before the wake
   dispatch) that posts a `cancelled` conclusion for the fingerprinted check —
   mirroring `reconcile.mjs`'s own `dispatchValidation` catch block — so the
   woken reconciliation redispatches validation immediately instead of waiting
   on staleness.

   **Second follow-up fix**: the retryable-check step initially reused
   `steps.app-token.outputs.token` (the original mint step's output). If the
   ROOT failure was that original "Generate repository app token" step itself
   (e.g. a transient GitHub Apps auth error), that output is empty, and
   `checks.create` requires a token from the trusted App identity —
   `trainCheckState()` filters check runs by `app.id`, so a
   `GITHUB_TOKEN`-authored check would never be recognized as authoritative
   anyway. Added a dedicated "Generate recovery app token" step
   (`if: failure()`, mints independently via
   `actions/create-github-app-token@v1`) between the publish step and the
   retryable-check step, and rewired the retryable-check step to use this
   recovery token instead. Since the recovery mint also runs on `failure()`,
   it gets an independent chance to succeed even when the original mint step
   is what failed — closing the gap rather than just falling back to the
   40-minute staleness bound for that failure mode.

   The terminal-check publication itself now retries transient Checks API
   failures up to three times (immediately, then after 1 second and 2 seconds)
   before failing closed. This prevents a momentary failure of the recovery
   call from recreating the 40-minute stall the fallback is intended to avoid.

2. **Scheduled-CI wake-up gap**: `merge-train.yml`'s `reconcile` job guard for
   `workflow_run` events named `'CI'` only allowed
   `event == 'push' && head_branch == default_branch`. But
   `mainHealthReason()` (`.github/scripts/merge-train/reconcile-lib.mjs`)
   treats whichever CI run for the current main SHA is newest by `created_at`
   as authoritative, regardless of push vs. schedule trigger. Production
   evidence (manual reconcile run 29461261403) showed a real pause citing an
   in-progress full-CI run for main; once that run completes, nothing
   previously re-woke `reconcile` unless it happened to be push-triggered —
   falling back to the empirically-unreliable ~hourly cron. Fixed by adding
   `|| (github.event.workflow_run.event == 'schedule' && vars.MERGE_TRAIN_ENABLED == 'true')`,
   an exact structural mirror of the already-shipped, already-proven identical
   carve-out in `.github/workflows/ci-recovery-incidents.yml` (~lines 38-42).
   PR-triggered CI completions remain rejected regardless (no storm
   regression); fails closed when the var is unset/false.

## Context: why this is a _second_ PR, not the original one

The coordinating session's original two-part request was implemented in full
on branch `nalfeo-fix-merge-train-dispatch-trigger` (PR #1166): both wake-ups,
plus a schedule/`MERGE_TRAIN_ENABLED` carve-out, fully reviewed (plan review +
3 code-review rounds) and tested (16+12 tests). While that PR's automated
review threads were being resolved, an independent concurrent effort merged
**PR #1165** into main with an overlapping-but-subtly-different implementation
of the _same two wake-ups_ in the _same two files_, making #1166 conflicting
and redundant. #1166 was closed as superseded (with an explanatory comment)
rather than resolving extensive merge conflicts for duplicate content. This PR
rebuilds only the two genuine gaps left open by #1165's version, off current
main.

## Files touched

- `.github/workflows/merge-train-validate.yml` — added `if: always()` to the
  "Wake merge-train reconciliation" step, plus a new "Generate recovery app
  token" step (`if: failure()`) and "Mark candidate check retryable if
  publishing failed" step (`if: failure()`, uses the independently-minted
  recovery token) that posts a `cancelled` conclusion for the fingerprinted
  check before the wake dispatches, with bounded retry for transient Checks
  API failures.
- `.github/workflows/merge-train.yml` — added the schedule/`MERGE_TRAIN_ENABLED`
  carve-out to the `reconcile` job's `if:` guard, with an explanatory comment
  describing the `mainHealthReason()` race scenario it closes.
- `tests/unit/merge-train-validate-publish.test.ts` — added:
  - a step-ordering assertion (wake step must run after the publish step)
  - an `if: always()` assertion on the wake step
  - a `describe` block covering the new retryable-check fallback step: its
    `if: failure()` condition and App-token wiring, its ordering (after
    publish, before the wake dispatch), its bounded retry behavior, and that
    its script actually posts a `cancelled` conclusion with the right
    `head_sha`/`external_id`
- `tests/unit/merge-train-workflow-wakeups.test.ts` — parameterized the
  existing `evaluatesReconcileCondition()` YAML-condition-evaluator helper with
  a `mergeTrainEnabled` substitution, and added:
  - schedule+enabled=true → wakes reconcile
  - schedule+enabled=false → fails closed
  - PR-triggered CI even with enabled=true → still rejected (storm-guard lock)
  - non-CI `workflow_run` names (e.g. `'Merge Train Validation'`) unaffected
    regardless of event/enabled state

## Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- Targeted tests: `npx vitest run tests/unit/merge-train-validate-publish.test.ts tests/unit/merge-train-workflow-wakeups.test.ts` — **22/22 passed** (17 + 5)
- Both modified workflow YAML files parse cleanly via the `yaml` package (same
  parser the tests use) — confirmed no syntax breakage.
- `npm run verify:fast` — passed (typecheck + lint + changed unit tests +
  physics-defs/size/weight coverage checks)
- `npm run verify:pr-prereqs` — passed after this handoff + ledger + telemetry
  capture were added

## Review harness (3🍎)

- Plan review (separate model, `gpt-5.4`): verdict **convergent**, no blocking
  concerns. Two non-blocking suggestions (a test locking in that non-CI
  `workflow_run` names still pass through, and a wake-step-ordering
  regression test) were incorporated as new tests before implementation was
  considered final.
- Code review (separate model, `gemini-3.1-pro-preview`): **no significant
  issues found** — verified GitHub Actions expression precedence/semantics,
  storm-guard non-regression, safety of `if: always()` given the `publish`
  job's own `actions: write` permission and `if: always()`, and correctness of
  the test helper's string-substitution approach.
- Ledger: `docs/knowledge/review-ledgers/2026-07-16-merge-train-wakeup-gaps.review-ledger.json`
  (valid 3-apple ledger).

## Apple estimate

3🍎 (production-critical merge automation change touching two workflow files
plus their guard logic; consistent with the original task's criticality
assessment). Recorded via `apples:record`:
`docs/knowledge/metrics/apples/2026-07-16-merge-train-wakeup-gaps.json`
(3🍎 estimated → 3🍎 actual, exact).

## Unresolved issues / recommended next steps

- None outstanding for this fix's scope. `workflow_run`/schedule triggers are
  intentionally retained as defense-in-depth per the original task instruction
  (evidence shows they're unreliable as a _primary_ trigger, not that they
  never fire).
- **Process note for the coordinator**: two independent sessions implemented
  overlapping fixes for the same request concurrently (#1165 and the now-closed
  #1166), wasting one session's review/implementation effort. Worth
  deduplicating future multi-session dispatches for the same production
  incident/request, or having sessions check for in-flight PRs touching the
  same files before starting significant implementation work.
- Follow-up idea (raised in code review, non-blocking, not implemented here):
  bounded retry/backoff around the `actions.createWorkflowDispatch` call itself,
  in case the dispatch API call transiently fails. Left as a future
  enhancement since it wasn't part of the original task's explicit scope.

## Shepherd-round follow-up (post-PR review)

Three `copilot-pull-request-reviewer` findings on the opened PR were validated
and fixed:

1. The wake-dispatch-ineffective-on-publish-failure gap described above (added
   the "Mark candidate check retryable if publishing failed" step + 3 new
   regression tests).
2. This handoff's apple-estimate section incorrectly claimed `apples:record`
   was skipped because actual == estimated — the policy
   (`docs/agent-os/policies/complexity-policy.md`) requires it for every
   ≥3🍎 session regardless of delta. Recorded:
   `docs/knowledge/metrics/apples/2026-07-16-merge-train-wakeup-gaps.json`.
3. The stated test counts (8+9=17) were wrong; the actual counts were
   12+5=17 (now 17+5=22 after the fallback, recovery-token, and retry tests).
   Corrected above.

## Second shepherd-round follow-up (recovery-token gap)

Two more `copilot-pull-request-reviewer` findings on the fallback step landed
by the first shepherd round were validated and fixed:

1. **Recovery step reused the possibly-failed original App token**: the "Mark
   candidate check retryable if publishing failed" step used
   `steps.app-token.outputs.token`. If the ROOT failure was the "Generate
   repository app token" step itself (transient GitHub Apps auth error), that
   output is empty/unusable, and the fallback's `checks.create` call would
   fail before posting the `cancelled` conclusion — `trainCheckState()`
   filters check runs by trusted `app.id`, so a `GITHUB_TOKEN`-authored check
   is not a substitute. Fixed by adding a dedicated "Generate recovery app
   token" step (`if: failure()`, mints independently via
   `actions/create-github-app-token@v1`) and rewiring the fallback step to use
   `steps.recovery-app-token.outputs.token` instead. Since this new mint step
   also runs on `failure()`, it gets an independent chance to succeed even
   when the original mint step is what failed. Added 2 new regression tests
   asserting the fallback step's token wiring and the recovery-token step's
   existence/ordering/condition.
2. **PR description staleness**: updated to describe all three operational
   behaviors now shipped (fail-closed `if: always()` dispatch, retryable-check
   fallback with independently-minted recovery token, scheduled-CI wake-up
   carve-out) and the corrected test count.

**Note on a superseded alternative**: a separate autonomous commit
(`b7c1fab7`) proposed gating the retryable-check step on
`steps.app-token.outcome == 'success'` instead of adding a recovery mint —
i.e., accepting the app-token-mint-failure gap and just not attempting a
doomed call. That approach was superseded when reconciling this branch: the
recovery-app-token fix above actually _closes_ the gap (the retryable-check
step gets a real, independent chance to post its cancelled conclusion even
when the original mint failed) rather than accepting it as a residual
limitation, so the outcome-gating condition was removed in favor of the
recovery-token wiring.
